"""L3b: the LLM judge, one paper at a time, against derived criteria.

The whole of ``docs/prototype.md`` §4.2 and §4.3 is implemented here rather than
reinvented, and four of its constraints are the reason this file is not shorter:

- **One paper, no batch.** The input is (criteria, one paper's evidence text) with
  no other candidates present. Given a batch the model produces a ranking, and a
  ranking is not comparable across batches.
- **A failure skips the paper.** A missing criterion or an unparseable answer
  drops that paper into ``failures`` - no guessing, no retrying to the end. And
  crucially: *judging every paper before taking the top-k*, so a paper that failed
  to judge is not penalised for it (§6's note on judge failures).
- **Deterministic by content address.** temperature 0, a fixed prompt, and a cache
  key over (query, paper, text version, rubric, criteria, model). §4.3 calls this a
  precondition for training rather than a cost optimisation, and the same property
  is what lets an ablation re-run mean anything.
- **Versions travel with the verdict.** ``rubric_version`` / ``criteria_version`` /
  ``model_version`` on every judgement, because a judgement whose measurement
  instrument cannot be identified is not a measurement.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from search_service.exceptions import LLMError
from search_service.judge.criteria import CriteriaDeriver, DerivedCriteria, extract_text, normalize_query
from search_service.judge.rubric import (
    RUBRIC_VERSION,
    Criterion,
    CriterionGrade,
    compose_score,
    grade_of,
    tier_of,
)
from search_service.llm.base import LLMProvider
from search_service.schemas import Failure, LLMMessage, Paper

#: Bumped when the per-paper judging prompt changes. Part of the cache key.
JUDGE_PROMPT_VERSION = "jp1"
#: Bumped when the evidence text assembled from a `Paper` changes shape.
EVIDENCE_TEXT_VERSION = "et1"

_MAX_ABSTRACT_CHARS = 4_000


@dataclass
class Judgement:
    """One paper's verdict, in the shape ``prototype.md`` §4.2 specifies."""

    paper_id: str
    criteria: dict[str, dict[str, str]]
    summary: str
    score: float
    tier: str
    rubric_version: str
    criteria_version: str
    model_version: str
    cached: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "paper_id": self.paper_id,
            "criteria": self.criteria,
            "summary": self.summary,
            "score": self.score,
            "tier": self.tier,
            "rubric_version": self.rubric_version,
            "criteria_version": self.criteria_version,
            "model_version": self.model_version,
            "cached": self.cached,
        }


@dataclass
class JudgeOutcome:
    """What a judging pass produced, including what it could not judge."""

    judgements: list[Judgement] = field(default_factory=list)
    failures: list[Failure] = field(default_factory=list)
    requested: int = 0
    judged: int = 0
    cache_hits: int = 0
    criteria_version: str = ""
    rubric_version: str = RUBRIC_VERSION
    model_version: str = ""
    level: str = "off"


def evidence_text(paper: Paper) -> str:
    """The text a judgement is allowed to rest on: title, venue, year, abstract.

    Bounded, and no candidate-set context. A paper with no abstract still gets
    judged on its title - and ``absent-is-not-negative`` in the carrier tells the
    model what to do with that, rather than this code deciding for it.
    """
    parts = [f"Title: {paper.title}"]
    if paper.year is not None:
        parts.append(f"Year: {paper.year}")
    if paper.venue:
        parts.append(f"Venue: {paper.venue}")
    abstract = (paper.abstract or "").strip()
    parts.append(f"Abstract: {abstract[:_MAX_ABSTRACT_CHARS] if abstract else '(not available)'}")
    return "\n".join(parts)


def cache_key(query: str, paper: Paper, criteria_version: str, model_version: str) -> str:
    """``prototype.md`` §4.3's content address, spelled out.

    Every component is a thing that changes the answer: the query, the paper, the
    evidence-text shape, the rubric, the criteria, the model. Leaving any of them
    out would let a stale verdict be served for a changed question.
    """
    digest = hashlib.sha256()
    for part in (
        normalize_query(query),
        paper.canonical_id,
        EVIDENCE_TEXT_VERSION,
        JUDGE_PROMPT_VERSION,
        RUBRIC_VERSION,
        criteria_version,
        model_version,
    ):
        digest.update(str(part).encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


def _judge_messages(query: str, criteria: list[Criterion], paper: Paper, carrier_text: str) -> list[LLMMessage]:
    rendered = "\n".join(
        f'- "{criterion.key}" (weight {criterion.weight:.2f}): {criterion.description}' for criterion in criteria
    )
    return [
        LLMMessage(
            role="system",
            content=(
                "You grade one paper against each criterion of one query, separately.\n\n"
                "The guidance below is the project's judging preference. Follow it; it is not advisory.\n\n"
                f"{carrier_text}\n\n"
                "Answer with JSON only, no prose around it. Grade EVERY criterion, using its key verbatim:\n"
                '{"criteria": {"<criterion key>": {"relevance": '
                '"Perfectly Relevant"|"Highly Relevant"|"Somewhat Relevant"|"Not Relevant", '
                '"snippet": "<verbatim from the evidence, short>"}}, '
                '"summary": "<one sentence on what this paper contributes to the query>"}'
            ),
        ),
        LLMMessage(
            role="user",
            content=f"Query: {query}\n\nCriteria:\n{rendered}\n\nPaper evidence:\n{evidence_text(paper)}",
        ),
    ]


def parse_judgement_payload(text: str, criteria: list[Criterion]) -> tuple[list[CriterionGrade], str]:
    """Parse one paper's graded criteria, or raise.

    Raises when **any** criterion is missing or carries a label the rubric does not
    define. That strictness is §4.2's second constraint: an incomplete answer skips
    the paper. Composing over a gap would score the missing criterion as zero,
    which is a verdict nobody made.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the judgement response")
    payload = json.loads(text[start : end + 1])
    graded = payload.get("criteria")
    if not isinstance(graded, dict):
        raise ValueError("the judgement response has no 'criteria' object")

    grades: list[CriterionGrade] = []
    for criterion in criteria:
        entry = graded.get(criterion.key)
        if not isinstance(entry, dict):
            raise ValueError(f"criterion '{criterion.key}' was not graded")
        relevance = str(entry.get("relevance") or "")
        grade = grade_of(relevance)
        if grade is None:
            raise ValueError(f"criterion '{criterion.key}' has an unknown relevance label {relevance!r}")
        grades.append(
            CriterionGrade(
                key=criterion.key,
                relevance=relevance.strip(),
                grade=grade,
                snippet=str(entry.get("snippet") or "").strip(),
            )
        )
    summary = str(payload.get("summary") or "").strip()
    return grades, summary


class JudgeStrategy:
    """L3b, with its criteria deriver and its content-addressed cache."""

    def __init__(
        self,
        provider: LLMProvider,
        deriver: CriteriaDeriver,
        carrier_text: str,
        *,
        model_version: str,
        temperature: float = 0.0,
        max_papers: int = 30,
    ) -> None:
        self._provider = provider
        self._deriver = deriver
        self._carrier_text = carrier_text
        self._model_version = model_version
        self._temperature = temperature
        self._max_papers = max_papers
        self._cache: dict[str, Judgement] = {}

    @property
    def model_version(self) -> str:
        return self._model_version

    async def criteria_for(self, query: str) -> DerivedCriteria:
        return await self._deriver.derive(query)

    async def judge_one(self, query: str, paper: Paper, derived: DerivedCriteria) -> Judgement:
        """Judge one paper. Raises ``LLMError`` when it cannot be judged."""
        key = cache_key(query, paper, derived.criteria_version, self._model_version)
        cached = self._cache.get(key)
        if cached is not None:
            return Judgement(**{**cached.__dict__, "cached": True})

        result = await self._provider.chat(
            _judge_messages(query, derived.criteria, paper, self._carrier_text),
            temperature=self._temperature,
        )
        text = extract_text(result.output)
        try:
            grades, summary = parse_judgement_payload(text, derived.criteria)
        except (ValueError, json.JSONDecodeError) as exc:
            raise LLMError(f"unparseable judgement: {exc}") from exc

        score = compose_score(derived.criteria, {grade.key: grade.grade for grade in grades})
        judgement = Judgement(
            paper_id=paper.canonical_id,
            criteria={
                grade.key: {"relevance": grade.relevance, "snippet": grade.snippet} for grade in grades
            },
            summary=summary,
            score=score,
            tier=tier_of(score),
            rubric_version=RUBRIC_VERSION,
            criteria_version=derived.criteria_version,
            model_version=self._model_version,
        )
        self._cache[key] = judgement
        return judgement

    async def judge_papers(self, query: str, papers: list[Paper], *, level: str = "l3b") -> JudgeOutcome:
        """Judge up to the configured ceiling, in the order given.

        Every candidate in scope is judged **before** any top-k is taken, so a
        paper the judge could not read is not thereby ranked last: it keeps its
        pre-judge position and its failure is reported.
        """
        outcome = JudgeOutcome(level=level, model_version=self._model_version)
        scope = papers[: self._max_papers]
        outcome.requested = len(scope)
        if not scope:
            return outcome

        try:
            derived = await self.criteria_for(query)
        except (LLMError, Exception) as exc:
            outcome.failures.append(
                Failure(
                    stage="judge",
                    source="judge",
                    error_type="unknown",
                    message=(
                        f"could not derive criteria, so no paper was judged: {exc}. "
                        "The ranking below is recall order, not relevance."
                    ),
                )
            )
            return outcome
        outcome.criteria_version = derived.criteria_version

        for paper in scope:
            try:
                judgement = await self.judge_one(query, paper, derived)
            except LLMError as exc:
                outcome.failures.append(
                    Failure(
                        stage="judge",
                        source="judge",
                        error_type="parse",
                        message=f"paper {paper.canonical_id!r} was skipped: {exc}",
                    )
                )
                continue
            except Exception as exc:  # pragma: no cover - defensive
                outcome.failures.append(
                    Failure(
                        stage="judge",
                        source="judge",
                        error_type="unknown",
                        message=f"paper {paper.canonical_id!r} was skipped: {exc}",
                    )
                )
                continue
            outcome.judgements.append(judgement)
            outcome.judged += 1
            if judgement.cached:
                outcome.cache_hits += 1
        return outcome
