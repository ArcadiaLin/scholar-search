"""Judging as the search endpoint exposes it, and as an ablation operates it.

Acceptance criteria carried here (``docs/develop/plan.md`` §5.5):

2. ``judge_level=l3b`` reports supported, and the number actually judged lands in
   ``SearchState`` - which is where the J axis's observable comes from;
4. J0 and J2 are two arms of the same instrument, pinned by configuration rather
   than by asking the agent nicely.

Also here: the property §5.3 says must hold, that nothing registers a judge as an
agent tool.
"""

from __future__ import annotations

import json
from contextlib import ExitStack
from typing import Any
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.llm.base import LLMProvider, LLMResult
from search_service.main import app
from search_service.models import SearchResultItem


class ScriptedProvider(LLMProvider):
    def __init__(self, replies: list[str]) -> None:
        super().__init__("scripted", {"model": "test-model"})
        self._replies = list(replies)

    async def chat(self, messages, *, model=None, temperature=None, max_tokens=None, extra=None) -> LLMResult:
        reply = self._replies.pop(0) if self._replies else '{"criteria": {}, "summary": ""}'
        return LLMResult(provider=self.name, model="test-model", output={"choices": [{"message": {"content": reply}}]})


def criteria_reply(*keys: str) -> str:
    return json.dumps({"criteria": [{"key": k, "description": f"about {k}", "weight": 1.0} for k in keys]})


def judgement_reply(label: str) -> str:
    return json.dumps({"criteria": {"a": {"relevance": label, "snippet": "s"}}, "summary": "sum"})


def item(paper_id: str, rank: int, **kwargs: Any) -> SearchResultItem:
    return SearchResultItem(
        paper_id=paper_id,
        title=f"Paper {paper_id}",
        source="arxiv",
        source_rank=rank,
        arxiv_id=paper_id,
        abstract="an abstract",
        **kwargs,
    )


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _search(client, provider: ScriptedProvider | None, items: list[SearchResultItem], **body: Any):
    with ExitStack() as stack:
        stack.enter_context(
            mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock.AsyncMock(return_value=items))
        )
        stack.enter_context(
            mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock.AsyncMock(return_value=[]))
        )
        if provider is not None:
            stack.enter_context(mock.patch.object(app.state.llm_registry, "get", lambda name=None: provider))
        return client.post("/search/metadata", json={"query": "superpixel segmentation", **body})


def test_judging_off_by_default_reports_off_and_calls_no_model(client):
    response = _search(client, None, [item("1111.11111", 1)])

    assert response.status_code == 200
    account = response.json()["search_state"]["judge"]
    assert account == {
        "level": "off",
        "requested_level": "off",
        "supported": True,
        "considered": 0,
        "judged": 0,
        "cache_hits": 0,
        "rubric_version": None,
        "criteria_version": None,
        "model_version": None,
    }


def test_l3b_reports_supported_and_how_many_it_judged(client):
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply("Perfectly Relevant"), judgement_reply("Not Relevant")])
    response = _search(client, provider, [item("1111.11111", 1), item("2222.22222", 2)], judge_level="l3b")

    assert response.status_code == 200
    account = response.json()["search_state"]["judge"]
    assert account["level"] == "l3b"
    assert account["supported"] is True
    assert account["considered"] == 2
    assert account["judged"] == 2
    # Without these the J axis has no observable: "judging was requested" and
    # "two papers were judged under rubric r3" support different conclusions.
    assert account["rubric_version"] == "r3"
    assert account["criteria_version"].startswith("cq_")
    assert account["model_version"] == "scripted/test-model"


def test_the_judge_reorders_by_composite_score(client):
    # The second paper is graded higher, so it must come first afterwards.
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply("Not Relevant"), judgement_reply("Perfectly Relevant")])
    response = _search(client, provider, [item("1111.11111", 1), item("2222.22222", 2)], judge_level="l3b")

    papers = response.json()["papers"]
    assert [p["arxiv_id"] for p in papers] == ["2222.22222", "1111.11111"]
    assert papers[0]["tier"] == "highly_relevant"
    assert papers[1]["tier"] == "not_relevant"


def test_a_paper_the_judge_could_not_read_keeps_its_place_rather_than_ranking_last(client):
    # `prototype.md` §6: a judge failure must not penalise the paper. Here paper 1
    # fails to parse and paper 2 is judged Not Relevant - the failed one must not be
    # pushed below the one that was actually judged irrelevant... it follows the
    # judged ones, but its own position is preserved and its failure is reported.
    provider = ScriptedProvider([criteria_reply("a"), "not json", judgement_reply("Not Relevant")])
    response = _search(client, provider, [item("1111.11111", 1), item("2222.22222", 2)], judge_level="l3b")

    body = response.json()
    assert body["search_state"]["judge"]["judged"] == 1
    failures = [f for f in body["search_state"]["failures"] if f["stage"] == "judge"]
    assert len(failures) == 1
    assert "1111.11111" in failures[0]["message"]
    assert len(body["papers"]) == 2, "a paper that could not be judged is still a candidate"


def test_an_unimplemented_tier_is_reported_not_approximated(client):
    provider = ScriptedProvider([])
    response = _search(client, provider, [item("1111.11111", 1)], judge_level="l3c")

    body = response.json()
    account = body["search_state"]["judge"]
    assert account["requested_level"] == "l3c"
    assert account["level"] == "off"
    assert account["supported"] is False
    reported = [f for f in body["search_state"]["failures"] if f["stage"] == "judge"]
    # An agent that believed it had bought judging would misread the list.
    assert reported and "not implemented" in reported[0]["message"]


def test_no_provider_means_judging_is_reported_unavailable(client):
    with mock.patch.object(app.state.llm_registry, "get", lambda name=None: None):
        response = _search(client, None, [item("1111.11111", 1)], judge_level="l3b")

    body = response.json()
    assert body["search_state"]["judge"]["supported"] is False
    assert any("unjudged" in f["message"] for f in body["search_state"]["failures"])


def test_a_forced_level_overrides_the_caller_which_is_how_an_ablation_runs(client):
    # J0 and J2 differ by configuration, not by asking the agent to choose
    # differently: the caller's choice is a strategy decision, and an ablation has
    # to hold it fixed across arms.
    provider = ScriptedProvider([])
    original = app.state.config.get_judge_config

    def forced_off():
        return {**original(), "forced_level": "off"}

    with mock.patch.object(app.state.config, "get_judge_config", forced_off):
        response = _search(client, provider, [item("1111.11111", 1)], judge_level="l3b")

    account = response.json()["search_state"]["judge"]
    assert account["requested_level"] == "l3b"
    assert account["level"] == "off"
    assert account["judged"] == 0


def test_the_relevance_endpoint_returns_the_prototype_structure(client):
    provider = ScriptedProvider([criteria_reply("a"), judgement_reply("Highly Relevant")])
    with mock.patch.object(app.state.llm_registry, "get", lambda name=None: provider):
        response = client.post(
            "/judge/relevance",
            json={
                "query": "superpixels for semantic segmentation",
                "paper": {"paper_id": "1810.09726", "title": "CEREALS", "arxiv_id": "1810.09726", "abstract": "x"},
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["paper_id"] == "arxiv:1810.09726"
    assert body["criteria"]["a"]["relevance"] == "Highly Relevant"
    assert body["criteria_definition"][0]["key"] == "a"
    # One criterion at "Highly Relevant" composes to 2/3 = 0.6667, which lands
    # just under §4.2's 0.67 cut. Not a rounding accident to paper over: with a
    # single criterion, only "Perfectly Relevant" reaches the upper tiers.
    assert body["score"] == pytest.approx(0.6667, abs=1e-3)
    assert body["tier"] == "somewhat_relevant"
    for field in ("rubric_version", "criteria_version", "model_version", "carrier_version"):
        assert body[field], f"{field} must be traceable"


def test_the_relevance_endpoint_reports_an_unavailable_judge_as_501(client):
    with mock.patch.object(app.state.llm_registry, "get", lambda name=None: None):
        response = client.post("/judge/relevance", json={"query": "q", "paper": {"paper_id": "x", "title": "t"}})

    assert response.status_code == 501


def test_nothing_registers_a_judge_as_an_agent_tool(client):
    """`skill-decomposition.md` puts judging under SVC, not TOOL.

    A judge the agent could call directly would move the decision into a tool's
    fixed prompt, where it neither enters the trajectory nor responds to the
    agent's preference entries - "the trace still looks like ReAct while the
    decisions happen inside a tool".
    """
    from pathlib import Path

    extension = Path("../../widis/.widi-scholar/extensions/scholar-search/index.ts").read_text(encoding="utf-8")
    registered = set()
    for line in extension.splitlines():
        stripped = line.strip()
        if stripped.startswith("name:") and '"' in stripped:
            registered.add(stripped.split('"')[1])
    assert "judge" not in registered
    assert not any("judge" in name for name in registered), registered
    # The only handle the agent has on judging is a parameter on the search tool.
    assert "judge_level" in extension
