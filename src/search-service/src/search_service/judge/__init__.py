"""The judge-strategy layer: prompts, rubric, and structured-output parsing.

``api/judge.py`` is transport - it forwards a chat request to a configured LLM
provider and says so in its own docstring. This package is the layer that
docstring says belongs elsewhere: what to ask, how to grade, how to compose, and
how to version the result.

Kept out of the agent's tool set on purpose. ``docs/skill-decomposition.md`` puts
``cf.papers.judge_relevance`` under `SVC`, not `TOOL`, with the note "controlled by
`judge_level`, the Agent does not call it directly" - because a judge the agent can
call directly moves the decision into a tool's fixed prompt, where it neither
enters $\\bar{\\tau}_t$ nor responds to $NP_k^{agent}$. The trajectory would still
look like ReAct while the decisions happened inside a tool.
"""

from __future__ import annotations

from search_service.judge.criteria import CriteriaDeriver, DerivedCriteria, load_np_judge
from search_service.judge.rubric import (
    RANKED_TIER_BY_JUDGE_TIER,
    RUBRIC_VERSION,
    Criterion,
    compose_score,
    normalize_weights,
    tier_of,
)
from search_service.judge.strategy import Judgement, JudgeOutcome, JudgeStrategy

__all__ = [
    "RANKED_TIER_BY_JUDGE_TIER",
    "RUBRIC_VERSION",
    "CriteriaDeriver",
    "Criterion",
    "DerivedCriteria",
    "JudgeOutcome",
    "JudgeStrategy",
    "Judgement",
    "compose_score",
    "load_np_judge",
    "normalize_weights",
    "tier_of",
]
