"""Pre-recall probing, rank-only scoring, and budget reporting.

Three endpoints that share a property: none of them is allowed to expand the
candidate set.

- ``POST /facet`` reports how a query's results distribute over grouping fields,
  so the caller can look before it recalls.
- ``POST /rank`` scores candidates it is handed. Rank-only means it issues no
  provider call at all - if ranking could recall, "rank" and "search" would stop
  being separable in the trajectory.
- ``GET /budget`` reports the bounds the caller is subject to and what has been
  spent against them.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.call_ledger import CallLedger
from search_service.exceptions import SourceError
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import (
    BudgetResponse,
    FacetRequest,
    FacetResponse,
    Failure,
    Paper,
    RankedPaper,
    RankRequest,
    RankResponse,
)

router = APIRouter(tags=["probe"])


def _capable(registry: PluginRegistry, capability: str) -> list[SearchProvider]:
    return [
        plugin.instance
        for plugin in registry.list_plugins()
        if plugin.enabled and isinstance(plugin.instance, SearchProvider) and plugin.instance.has_capability(capability)
    ]


@router.post("/facet", response_model=FacetResponse)
async def facet(payload: FacetRequest, request: Request) -> FacetResponse | JSONResponse:
    """Probe how a query's results distribute, before paying for recall."""
    registry: PluginRegistry = request.app.state.registry
    ledger: CallLedger = request.app.state.ledger
    limits = request.app.state.config.get_limits()["facet"]

    providers = _capable(registry, "facet_group_by")
    if not providers:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={
                "detail": (
                    "No enabled provider advertises the facet_group_by capability. "
                    "Check GET /providers for what the configured sources can do."
                )
            },
        )

    group_by = payload.group_by[: int(limits["max_group_by"])]
    failures: list[Failure] = []
    for provider in providers:
        try:
            ledger.record("facet")
            raw = await provider.facet(payload.query, group_by)
        except SourceError as exc:
            failures.append(Failure(stage="facet", source=provider.name, error_type=exc.error_type, message=str(exc)))
            continue
        except NotImplementedError as exc:
            failures.append(
                Failure(
                    stage="facet",
                    source=provider.name,
                    error_type="unknown",
                    message=f"advertises facet_group_by but does not implement it: {exc}",
                )
            )
            continue
        except Exception as exc:  # pragma: no cover - defensive catch
            failures.append(Failure(stage="facet", source=provider.name, error_type="unknown", message=str(exc)))
            continue

        return FacetResponse(
            query=payload.query,
            groups=_extract_groups(raw, group_by),
            source=provider.name,
            failures=failures,
        )

    return JSONResponse(
        status_code=status.HTTP_502_BAD_GATEWAY,
        content={
            "detail": "Every provider advertising facet_group_by failed.",
            "failures": [failure.model_dump() for failure in failures],
        },
    )


def _extract_groups(raw: Any, group_by: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Pull the group counts out of a provider's facet payload.

    OpenAlex answers a `group-by` with a top-level ``group_by`` list rather than
    one list per field, so a single-field probe is the common case and a
    multi-field one is reported under the joined key it was asked as.
    """
    if not isinstance(raw, dict):
        return {}
    groups = raw.get("group_by")
    if isinstance(groups, list):
        cleaned = [entry for entry in groups if isinstance(entry, dict)]
        return {",".join(group_by): cleaned}
    result: dict[str, list[dict[str, Any]]] = {}
    for field in group_by:
        value = raw.get(field)
        if isinstance(value, list):
            result[field] = [entry for entry in value if isinstance(entry, dict)]
    return result


@router.post("/rank", response_model=RankResponse)
async def rank(payload: RankRequest, request: Request) -> RankResponse:
    """Score and order the supplied candidates. Issues no provider call."""
    limits = request.app.state.config.get_limits()["rank"]
    candidates = payload.candidates[: int(limits["max_candidates"])]

    terms = {term for term in payload.query.lower().split() if len(term) > 2}
    scored: list[tuple[float, Paper]] = []
    skipped = 0
    for raw in candidates:
        try:
            paper = Paper.model_validate(raw)
        except Exception:
            skipped += 1
            continue
        scored.append((_relevance(paper, terms), paper))

    scored.sort(key=lambda entry: entry[0], reverse=True)
    top_k = payload.top_k or len(scored)
    ranked = [
        RankedPaper(**paper.model_dump(), score=score, rank=index, tier=_tier(score))
        for index, (score, paper) in enumerate(scored[:top_k], start=1)
    ]
    return RankResponse(papers=ranked, scored=len(scored), skipped=skipped, provider_calls=0)


def _relevance(paper: Paper, terms: set[str]) -> float:
    """Lexical overlap on title and abstract, with a small citation prior.

    Deliberately simple and deliberately not learned: $HP_k$ carries the ranking
    weights, and inventing them here would put a trained parameter inside the
    pipeline. This is the placeholder the ranking stage needs to exist as a
    separable step, not the final ranker.
    """
    if not terms:
        return 0.0
    title = (paper.title or "").lower()
    abstract = (paper.abstract or "").lower()
    title_hits = sum(1 for term in terms if term in title)
    abstract_hits = sum(1 for term in terms if term in abstract)
    score = (2.0 * title_hits + abstract_hits) / (3.0 * len(terms))
    if paper.citation_count:
        # Bounded so a highly cited but off-topic classic cannot outrank a match.
        score += min(paper.citation_count / 10_000.0, 0.1)
    return score


def _tier(score: float) -> str:
    if score >= 0.6:
        return "highly_relevant"
    if score >= 0.2:
        return "partially_relevant"
    return "not_relevant"


@router.get("/budget", response_model=BudgetResponse)
async def budget(request: Request) -> BudgetResponse:
    """Report the effective bounds and what has been spent against them."""
    config = request.app.state.config
    ledger: CallLedger = request.app.state.ledger
    plugins = config.get_plugins_config()
    quotas = {
        name: {"enabled": bool(cfg.get("enabled", False)), "cost_model": cfg.get("cost_model", {})}
        for name, cfg in plugins.items()
    }
    return BudgetResponse(limits=config.get_limits(), quotas=quotas, spent=ledger.snapshot(), scope=ledger.scope)
