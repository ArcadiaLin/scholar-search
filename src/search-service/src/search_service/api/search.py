"""Aggregated search endpoint.

``POST /search`` distributes the unified query to all selected providers,
merges provider-native parameters, normalizes results, deduplicates by stable
ID, and reranks using Reciprocal Rank Fusion (RRF).
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.aggregator import AggregationError, Aggregator
from search_service.judge import RANKED_TIER_BY_JUDGE_TIER, JudgeOutcome
from search_service.judge.service import build_judge
from search_service.schemas import Failure, JudgeAccount, RankedPaper, SearchRequest, SearchResponse

router = APIRouter(prefix="/search", tags=["search"])


def _get_aggregator(request: Request) -> Aggregator:
    """Retrieve the aggregator from application state."""
    return request.app.state.aggregator


def _apply_judgements(papers: list[RankedPaper], outcome: JudgeOutcome) -> list[RankedPaper]:
    """Re-order and re-tier by the judge's composite score.

    Two properties this keeps, both from ``docs/prototype.md``:

    - **A paper the judge could not read is not penalised.** Unjudged papers keep
      their pre-judge order and follow the judged ones rather than being scored
      zero, so a parse failure costs coverage but not the paper's position among
      its unjudged peers.
    - **Ties break deterministically**, by the pre-judge rank, so the same inputs
      give the same list (§3.7's ordering contract).
    """
    by_id = {judgement.paper_id: judgement for judgement in outcome.judgements}
    if not by_id:
        return papers

    judged: list[tuple[float, int, RankedPaper]] = []
    unjudged: list[RankedPaper] = []
    for paper in papers:
        judgement = by_id.get(paper.canonical_id)
        if judgement is None:
            unjudged.append(paper)
            continue
        judged.append((judgement.score, paper.rank, paper))

    judged.sort(key=lambda entry: (-entry[0], entry[1]))
    ordered: list[RankedPaper] = []
    for position, (score, _, paper) in enumerate(judged, start=1):
        judgement = by_id[paper.canonical_id]
        ordered.append(
            paper.model_copy(
                update={
                    "score": score,
                    "rank": position,
                    "tier": RANKED_TIER_BY_JUDGE_TIER.get(judgement.tier, paper.tier),
                }
            )
        )
    for offset, paper in enumerate(unjudged, start=len(ordered) + 1):
        ordered.append(paper.model_copy(update={"rank": offset}))
    return ordered


@router.post("", response_model=SearchResponse)
async def search(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Aggregate search results from all selected providers."""
    aggregator = _get_aggregator(http_request)
    judge_config = http_request.app.state.config.get_judge_config()
    availability = build_judge(judge_config, http_request.app.state.llm_registry, request.judge_level)

    # When judging runs, recall wider than the caller asked for and truncate after
    # judging. `prototype.md` §6 requires every candidate in scope to be judged
    # *before* the top-k is taken; judging only the top-k would make the judge a
    # re-order of the recall order rather than a filter over the candidate set.
    ceiling = int(judge_config.get("max_papers_l3b", 30))
    effective_top_k = max(request.top_k, ceiling) if availability.strategy is not None else request.top_k

    try:
        papers, search_state, provenance, elapsed_ms = await aggregator.aggregate(
            query=request.query,
            top_k=effective_top_k,
            end_date=request.end_date,
            sources=request.sources,
            timeout_ms=request.timeout_ms,
            provider_params=request.provider_params,
            subqueries=request.subqueries,
        )
    except AggregationError as exc:
        # The classified failures travel with the error. "All providers failed" and
        # "all providers were rate-limited until tomorrow" call for different next
        # moves, and total failure is precisely when the caller most needs to know
        # which one it is (``docs/develop/backlog.md`` F-2).
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "detail": str(exc),
                "failures": [failure.model_dump() for failure in exc.failures],
                "alternative_sources": exc.alternative_sources,
            },
        )

    account = JudgeAccount(
        level=availability.level,
        requested_level=availability.requested_level,
        supported=availability.supported,
    )
    if availability.reason is not None:
        # An unsupported tier is reported, never silently downgraded: an agent that
        # believed it had bought judging would misread the candidate list.
        search_state.failures.append(
            Failure(stage="judge", source="judge", error_type="disabled", message=availability.reason)
        )

    if availability.strategy is not None:
        outcome = await availability.strategy.judge_papers(request.query, list(papers), level=availability.level)
        papers = _apply_judgements(list(papers), outcome)
        search_state.failures.extend(outcome.failures)
        account = JudgeAccount(
            level=availability.level,
            requested_level=availability.requested_level,
            supported=True,
            considered=outcome.requested,
            judged=outcome.judged,
            cache_hits=outcome.cache_hits,
            rubric_version=outcome.rubric_version,
            criteria_version=outcome.criteria_version or None,
            model_version=outcome.model_version,
        )

    search_state.judge = account
    return SearchResponse(
        papers=papers[: request.top_k],
        search_state=search_state,
        provenance=provenance,
        elapsed_ms=elapsed_ms,
    )


@router.post("/metadata", response_model=SearchResponse)
async def search_metadata(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Aggregate search results from all selected providers (metadata-only alias)."""
    return await search(http_request, request)
