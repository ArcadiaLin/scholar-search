"""Deriving a query's weighted criteria, and versioning them.

Two responsibilities, and the second is the one that matters for reproducibility.

**Deriving.** ``docs/prototype.md`` §4.2 has the criteria generated from the query
by an LLM, with human review of roughly one query in five - reviewing criteria,
not per-paper verdicts, which is far cheaper than labelling. So this module asks
the model for criteria, and the guidance it gives the model is $NP_k^{judge}$: the
entries in ``preference/np-judge.md``, loaded through configuration. That is the
$\\mathrm{Configure}$ edge, and it is what makes the carrier have an effect at all -
change an entry and the derived criteria change (``docs/develop/plan.md`` §5.5,
third acceptance criterion).

**Versioning.** ``criteria_version`` is derived from the carrier's content, not
declared by hand. A hand-declared version is a version somebody forgets to bump,
and §4.2 requires the criteria text and weights to be frozen per version -
"changing the criteria means changing the measurement". Content addressing makes
that automatic and makes a stale cache impossible.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from search_service.exceptions import LLMError
from search_service.judge.rubric import Criterion, normalize_weights
from search_service.llm.base import LLMProvider
from search_service.schemas import LLMMessage

#: Bumped when the derivation *prompt* changes, independently of the carrier.
#: Both feed `criteria_version`, because either one changes what comes out.
DERIVATION_PROMPT_VERSION = "cd1"

_MAX_CRITERIA = 8
_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


@dataclass(frozen=True)
class DerivedCriteria:
    """A query's criteria, with everything needed to say where they came from."""

    criteria: list[Criterion]
    criteria_version: str
    #: The carrier's own declared version, for reading by eye. Not the identity.
    carrier_version: str


def load_np_judge(path: Path) -> tuple[str, str]:
    """Read the $NP^{judge}$ carrier: its text, and its declared version.

    A missing carrier is an error rather than an empty string. Judging with no
    guidance would still produce numbers, and numbers produced with silently
    absent preferences are worse than none.
    """
    text = path.read_text(encoding="utf-8")
    match = re.search(r"<!--\s*npj-version:\s*(\S+)\s*-->", text)
    return text, match.group(1) if match else "unversioned"


def criteria_version_for(query: str, carrier_text: str, config_fingerprint: str) -> str:
    """Content-address the criteria: same inputs, same version, always.

    Includes the query because the criteria are derived per query - two queries
    under one version would make the version useless for cache keying.
    """
    digest = hashlib.sha256()
    for part in (DERIVATION_PROMPT_VERSION, normalize_query(query), carrier_text, config_fingerprint):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return f"cq_{digest.hexdigest()[:16]}"


def normalize_query(query: str) -> str:
    """Whitespace- and case-normalised query, for cache keys only."""
    return " ".join(query.lower().split())


def _derivation_messages(query: str, carrier_text: str, max_criteria: int) -> list[LLMMessage]:
    return [
        LLMMessage(
            role="system",
            content=(
                "You derive the criteria a paper must satisfy to answer an academic search query.\n\n"
                "The guidance below is the project's judging preference. Follow it; it is not advisory.\n\n"
                f"{carrier_text}\n\n"
                "Answer with JSON only, no prose around it:\n"
                '{"criteria": [{"key": "<short label, lower case>", '
                '"description": "<what a paper must show to satisfy it>", "weight": <number>}]}\n'
                f"At most {max_criteria} criteria. Weights are relative; they need not sum to anything."
            ),
        ),
        LLMMessage(role="user", content=f"Query: {query}"),
    ]


def parse_criteria_payload(text: str, max_criteria: int) -> list[Criterion]:
    """Parse the model's criteria JSON, or raise.

    Raising rather than degrading to a default set: a default set of criteria
    would be a measurement instrument nobody chose, quietly replacing the one that
    was configured.
    """
    match = _JSON_BLOCK.search(text)
    if match is None:
        raise ValueError("no JSON object in the criteria response")
    payload = json.loads(match.group(0))
    raw = payload.get("criteria")
    if not isinstance(raw, list) or not raw:
        raise ValueError("the criteria response has no non-empty 'criteria' array")

    criteria: list[Criterion] = []
    for entry in raw[:max_criteria]:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or "").strip()
        description = str(entry.get("description") or "").strip()
        if not key or not description:
            continue
        try:
            weight = float(entry.get("weight", 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        criteria.append(Criterion(key=key, description=description, weight=weight))
    if not criteria:
        raise ValueError("no usable criterion in the criteria response")
    return normalize_weights(criteria)


def extract_text(output: Any) -> str:
    """The assistant text out of an OpenAI-compatible completion body."""
    if not isinstance(output, dict):
        return ""
    choices = output.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    text = choices[0].get("text") if isinstance(choices[0], dict) else None
    return text if isinstance(text, str) else ""


class CriteriaDeriver:
    """Derives and caches a query's criteria.

    Cached by content-addressed version, which means the cache cannot go stale
    when the carrier changes: a different carrier is a different key.
    """

    def __init__(
        self,
        provider: LLMProvider,
        carrier_text: str,
        carrier_version: str,
        *,
        config_fingerprint: str,
        max_criteria: int = _MAX_CRITERIA,
        temperature: float = 0.0,
    ) -> None:
        self._provider = provider
        self._carrier_text = carrier_text
        self._carrier_version = carrier_version
        self._config_fingerprint = config_fingerprint
        self._max_criteria = max_criteria
        self._temperature = temperature
        self._cache: dict[str, DerivedCriteria] = {}

    async def derive(self, query: str) -> DerivedCriteria:
        version = criteria_version_for(query, self._carrier_text, self._config_fingerprint)
        cached = self._cache.get(version)
        if cached is not None:
            return cached

        result = await self._provider.chat(
            _derivation_messages(query, self._carrier_text, self._max_criteria),
            temperature=self._temperature,
        )
        text = extract_text(result.output)
        try:
            criteria = parse_criteria_payload(text, self._max_criteria)
        except (ValueError, json.JSONDecodeError) as exc:
            raise LLMError(f"could not derive criteria for the query: {exc}") from exc

        derived = DerivedCriteria(
            criteria=criteria,
            criteria_version=version,
            carrier_version=self._carrier_version,
        )
        self._cache[version] = derived
        return derived
