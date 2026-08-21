"""L3b end to end, against a scripted provider.

The acceptance criteria this file carries (``docs/develop/plan.md`` §5.5):

1. a verdict has the §4.2 shape with all three version fields traceable;
3. **changing one entry in the carrier changes the judge output** - the criterion
   that separates "the file exists" from "the file has an effect".

Scripted provider rather than a live model: what is under test is the strategy
layer, and a live model would make these tests a measurement of the model.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from search_service.exceptions import LLMError
from search_service.judge.criteria import CriteriaDeriver, criteria_version_for, parse_criteria_payload
from search_service.judge.rubric import Criterion
from search_service.judge.strategy import JudgeStrategy, cache_key, evidence_text, parse_judgement_payload
from search_service.llm.base import LLMProvider, LLMResult
from search_service.schemas import Paper

CARRIER = "<!-- npj-version: 1 -->\n- [name-the-task] the task itself is always a criterion.\n"


class ScriptedProvider(LLMProvider):
    """Answers with the next scripted reply and records what it was asked."""

    def __init__(self, replies: list[str], *, model: str = "test-model") -> None:
        super().__init__("scripted", {"model": model})
        self._replies = list(replies)
        self.prompts: list[str] = []
        self.calls = 0

    async def chat(self, messages, *, model=None, temperature=None, max_tokens=None, extra=None) -> LLMResult:
        self.calls += 1
        self.prompts.append("\n".join(m.content for m in messages))
        if not self._replies:
            raise AssertionError("the provider was called more times than the test scripted")
        reply = self._replies.pop(0)
        return LLMResult(
            provider=self.name,
            model=model or "test-model",
            output={"choices": [{"message": {"role": "assistant", "content": reply}}]},
        )


def criteria_reply(*keys: str) -> str:
    return json.dumps({"criteria": [{"key": key, "description": f"about {key}", "weight": 1.0} for key in keys]})


def judgement_reply(grades: dict[str, str], summary: str = "a summary") -> str:
    return json.dumps(
        {
            "criteria": {key: {"relevance": label, "snippet": f"verbatim about {key}"} for key, label in grades.items()},
            "summary": summary,
        }
    )


def paper(**kwargs: Any) -> Paper:
    return Paper(
        paper_id=kwargs.pop("paper_id", "1810.09726"),
        title=kwargs.pop("title", "CEREALS"),
        arxiv_id=kwargs.pop("arxiv_id", "1810.09726"),
        abstract=kwargs.pop("abstract", "We use superpixels for region-based active learning."),
        **kwargs,
    )


def strategy_with(provider: ScriptedProvider, carrier: str = CARRIER, **kwargs) -> JudgeStrategy:
    deriver = CriteriaDeriver(provider, carrier, "1", config_fingerprint="fp", temperature=0.0)
    return JudgeStrategy(provider, deriver, carrier, model_version="scripted/test-model", **kwargs)


async def test_a_verdict_has_the_prototype_shape_with_all_three_versions():
    provider = ScriptedProvider([
        criteria_reply("uses superpixels", "task is semantic segmentation"),
        judgement_reply({"uses superpixels": "Perfectly Relevant", "task is semantic segmentation": "Highly Relevant"}),
    ])
    strategy = strategy_with(provider)

    derived = await strategy.criteria_for("superpixels for semantic segmentation")
    judgement = await strategy.judge_one("superpixels for semantic segmentation", paper(), derived)

    assert set(judgement.criteria) == {"uses superpixels", "task is semantic segmentation"}
    assert judgement.criteria["uses superpixels"]["relevance"] == "Perfectly Relevant"
    assert judgement.criteria["uses superpixels"]["snippet"]
    assert judgement.summary == "a summary"
    # 3/3 * 0.5 + 2/3 * 0.5
    assert judgement.score == pytest.approx(0.8333, abs=1e-3)
    assert judgement.tier == "highly_relevant"
    # All three traceable, which is what makes the number a measurement.
    assert judgement.rubric_version == "r3"
    assert judgement.criteria_version.startswith("cq_")
    assert judgement.model_version == "scripted/test-model"


async def test_changing_one_carrier_entry_changes_the_output():
    """Acceptance criterion 3: the carrier has an effect, not just a presence."""
    edited = CARRIER + "- [wrong-task-is-not-relevant] method right, task wrong is Not Relevant.\n"

    before = ScriptedProvider([criteria_reply("uses superpixels")])
    after = ScriptedProvider([criteria_reply("uses superpixels", "task is semantic segmentation")])

    derived_before = await strategy_with(before).criteria_for("q")
    derived_after = await strategy_with(after, carrier=edited).criteria_for("q")

    # The entries reach the prompt, so the model sees the change...
    assert "wrong-task-is-not-relevant" not in before.prompts[0]
    assert "wrong-task-is-not-relevant" in after.prompts[0]
    # ...and the derived criteria differ, so the verdict rests on different ground.
    assert len(derived_after.criteria) != len(derived_before.criteria)
    # And the version changes with the content, so old and new are not comparable
    # by construction rather than by anyone remembering to say so.
    assert derived_after.criteria_version != derived_before.criteria_version


def test_the_criteria_version_is_content_addressed():
    assert criteria_version_for("q", CARRIER, "fp") == criteria_version_for("q", CARRIER, "fp")
    assert criteria_version_for("q", CARRIER, "fp") != criteria_version_for("q", CARRIER + "x", "fp")
    assert criteria_version_for("q", CARRIER, "fp") != criteria_version_for("other", CARRIER, "fp")
    # Whitespace and case in the query must not split the cache.
    assert criteria_version_for("A Query", CARRIER, "fp") == criteria_version_for("  a   query ", CARRIER, "fp")


async def test_an_incomplete_answer_skips_the_paper_rather_than_scoring_the_gap():
    # §4.2's second constraint. Composing over the gap would score the ungraded
    # criterion as zero, which is a verdict nobody made.
    provider = ScriptedProvider([
        criteria_reply("a", "b"),
        judgement_reply({"a": "Perfectly Relevant"}),
    ])
    strategy = strategy_with(provider)
    derived = await strategy.criteria_for("q")

    with pytest.raises(LLMError, match="was not graded"):
        await strategy.judge_one("q", paper(), derived)


async def test_an_unknown_label_skips_the_paper():
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply({"a": "Quite Relevant"})])
    strategy = strategy_with(provider)
    derived = await strategy.criteria_for("q")

    with pytest.raises(LLMError, match="unknown relevance label"):
        await strategy.judge_one("q", paper(), derived)


async def test_a_second_identical_judgement_comes_from_the_cache():
    # §4.3: determinism by content address is a precondition for training, and the
    # reason an ablation re-run means anything.
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply({"a": "Highly Relevant"})])
    strategy = strategy_with(provider)
    derived = await strategy.criteria_for("q")

    first = await strategy.judge_one("q", paper(), derived)
    second = await strategy.judge_one("q", paper(), derived)

    assert provider.calls == 2, "the second judgement must not have called the provider"
    assert first.cached is False
    assert second.cached is True
    assert (second.score, second.tier) == (first.score, first.tier)


def test_the_cache_key_covers_everything_that_changes_the_answer():
    base = cache_key("q", paper(), "cq_1", "m1")
    assert base != cache_key("q2", paper(), "cq_1", "m1")
    assert base != cache_key("q", paper(arxiv_id="2101.00001", paper_id="2101.00001"), "cq_1", "m1")
    assert base != cache_key("q", paper(), "cq_2", "m1")
    assert base != cache_key("q", paper(), "cq_1", "m2")


async def test_judging_a_batch_reports_what_it_could_not_judge():
    provider = ScriptedProvider([
        criteria_reply("a"),
        judgement_reply({"a": "Perfectly Relevant"}),
        "not json at all",
        judgement_reply({"a": "Not Relevant"}),
    ])
    strategy = strategy_with(provider)
    papers = [
        paper(paper_id="1", arxiv_id="1111.11111"),
        paper(paper_id="2", arxiv_id="2222.22222"),
        paper(paper_id="3", arxiv_id="3333.33333"),
    ]

    outcome = await strategy.judge_papers("q", papers)

    assert outcome.requested == 3
    assert outcome.judged == 2
    assert len(outcome.failures) == 1
    assert outcome.failures[0].error_type == "parse"
    # Naming the paper matters: "one paper failed" is not actionable, "this paper
    # failed" is.
    assert "2222.22222" in outcome.failures[0].message


async def test_the_batch_is_bounded_by_configuration():
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply({"a": "Highly Relevant"})])
    strategy = strategy_with(provider, max_papers=1)

    outcome = await strategy.judge_papers("q", [paper(paper_id=str(i), arxiv_id=f"{i}111.11111") for i in range(5)])

    assert outcome.requested == 1
    assert outcome.judged == 1


async def test_a_criteria_derivation_failure_judges_nothing_and_says_so():
    # Not a verdict of "not relevant" for everything: nothing was judged, and the
    # ranking is recall order. Saying that is the only honest answer.
    provider = ScriptedProvider(["not json"])
    outcome = await strategy_with(provider).judge_papers("q", [paper()])

    assert outcome.judged == 0
    assert len(outcome.failures) == 1
    assert "recall order" in outcome.failures[0].message


def test_the_evidence_text_carries_no_other_candidate():
    text = evidence_text(paper(year=2018, venue="ACCV"))
    assert "CEREALS" in text
    assert "2018" in text
    assert "superpixels" in text
    # One paper, no batch: given a batch the model ranks instead of judging.
    assert text.count("Title:") == 1


def test_a_paper_with_no_abstract_says_so_rather_than_looking_empty():
    assert "(not available)" in evidence_text(paper(abstract=None))


def test_parsing_criteria_rejects_an_empty_or_shapeless_payload():
    with pytest.raises(ValueError, match="no JSON object"):
        parse_criteria_payload("nothing here", 8)
    with pytest.raises(ValueError, match="non-empty 'criteria'"):
        parse_criteria_payload('{"criteria": []}', 8)


def test_parsing_criteria_normalizes_weights_and_honours_the_cap():
    criteria = parse_criteria_payload(criteria_reply("a", "b", "c"), 2)
    assert [c.key for c in criteria] == ["a", "b"]
    assert sum(c.weight for c in criteria) == pytest.approx(1.0)


def test_parsing_a_judgement_tolerates_prose_around_the_json():
    grades, summary = parse_judgement_payload(
        "Here you go:\n" + judgement_reply({"a": "Highly Relevant"}) + "\nHope that helps.",
        [Criterion("a", "", 1.0)],
    )
    assert grades[0].grade == 2
    assert summary == "a summary"


def test_the_shipped_carrier_is_readable_and_versioned():
    from search_service.config import ServiceConfig
    from search_service.judge.criteria import load_np_judge

    path = Path(ServiceConfig().get_judge_config()["carrier_path"])
    assert path.is_file(), f"the configured NP^judge carrier is missing: {path}"
    text, version = load_np_judge(path)
    assert version == "1"
    # The entries are what reach the prompt, so an empty carrier is a silent
    # instrument change.
    assert "derive-from-the-question-not-the-field" in text
