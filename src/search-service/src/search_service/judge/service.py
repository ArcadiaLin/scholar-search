"""Assembling the judge from configuration, and reporting when it cannot be.

Kept separate from the strategy so that "how a judge is built" and "what a judge
does" fail independently: a missing carrier file, an unconfigured provider and an
unimplemented tier are three different answers, and the caller needs to be able to
tell them apart. The alternative - a judge that quietly does nothing - is the
pattern D-09 records: a capability gap sedimenting as "it looks finished".
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from search_service.judge.criteria import CriteriaDeriver, load_np_judge
from search_service.judge.strategy import JudgeStrategy
from search_service.llm.registry import LLMRegistry

#: Tiers this build implements. Asking for another is answered, not approximated.
IMPLEMENTED_LEVELS = frozenset({"l3b"})
#: What `auto` resolves to when the budget is not being modelled yet.
AUTO_LEVEL = "l3b"


@dataclass
class JudgeAvailability:
    """Whether judging can run, and if not, why - in words a caller can act on."""

    strategy: JudgeStrategy | None
    level: str
    requested_level: str
    supported: bool
    reason: str | None = None


def resolve_level(requested: str, forced: str | None) -> str:
    """The tier that will actually run.

    A configured `forced_level` wins over the caller. That inversion is the point:
    the caller's choice is a strategy decision, and an ablation needs to be able to
    hold it fixed across arms without editing the caller.
    """
    level = forced if forced else requested
    return AUTO_LEVEL if level == "auto" else level


def config_fingerprint(judge_config: dict[str, Any]) -> str:
    """Digest of the judging knobs that change what comes out.

    `forced_level` is excluded on purpose: pinning the tier decides *whether* a
    paper is judged, not *how*, so J0 and J2 must be able to share a cache and a
    `criteria_version`. Including it would make the two arms' criteria versions
    differ and their comparison meaningless.
    """
    parts = [
        str(judge_config.get("temperature")),
        str(judge_config.get("max_criteria_per_query")),
        str(judge_config.get("provider")),
    ]
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:12]


def build_judge(
    judge_config: dict[str, Any],
    llm_registry: LLMRegistry,
    requested_level: str,
) -> JudgeAvailability:
    """Assemble a judge for this request, or explain why there is none."""
    level = resolve_level(requested_level, judge_config.get("forced_level"))
    if level == "off":
        return JudgeAvailability(None, "off", requested_level, supported=True)

    if not judge_config.get("enabled", True):
        return JudgeAvailability(
            None, "off", requested_level, supported=False, reason="judging is disabled in this service's configuration"
        )

    if level not in IMPLEMENTED_LEVELS:
        return JudgeAvailability(
            None,
            "off",
            requested_level,
            supported=False,
            reason=(
                f"tier '{level}' is not implemented in this build (implemented: "
                f"{', '.join(sorted(IMPLEMENTED_LEVELS))}). The candidates below are unjudged; "
                "treat the ranking as recall order, not relevance."
            ),
        )

    provider = llm_registry.get(judge_config.get("provider"))
    if provider is None:
        available = llm_registry.list_provider_names()
        return JudgeAvailability(
            None,
            "off",
            requested_level,
            supported=False,
            reason=(
                f"no LLM provider is available for judging (configured: {available or 'none'}), "
                "so the candidates below are unjudged"
            ),
        )

    carrier_path = judge_config.get("carrier_path")
    if not carrier_path or not Path(carrier_path).is_file():
        return JudgeAvailability(
            None,
            "off",
            requested_level,
            supported=False,
            reason=(
                f"the judging preference carrier is missing ({carrier_path}), so nothing was judged. "
                "Judging without its configured preferences would produce numbers whose instrument is unknown."
            ),
        )
    carrier_text, carrier_version = load_np_judge(Path(carrier_path))

    fingerprint = config_fingerprint(judge_config)
    temperature = float(judge_config.get("temperature", 0.0))
    deriver = CriteriaDeriver(
        provider,
        carrier_text,
        carrier_version,
        config_fingerprint=fingerprint,
        max_criteria=int(judge_config.get("max_criteria_per_query", 8)),
        temperature=temperature,
    )
    strategy = JudgeStrategy(
        provider,
        deriver,
        carrier_text,
        # The provider name plus its configured model: both change the verdict, so
        # both belong in `model_version` and in the cache key.
        model_version=f"{provider.name}/{provider.config.get('model', 'unknown')}",
        temperature=temperature,
        max_papers=int(judge_config.get("max_papers_l3b", 30)),
    )
    return JudgeAvailability(strategy, level, requested_level, supported=True)
