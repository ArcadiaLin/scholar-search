"""Rank-only endpoint."""

from __future__ import annotations

import time

from fastapi import APIRouter

from search_service.features.convert import paper_to_candidate
from search_service.rank import RankRequest as LegacyRankRequest
from search_service.rank import rank as rank_candidates
from search_service.rank.schema import RankedPaper as LegacyRankedPaper
from search_service.schemas import (
    Budget,
    CandidateCounts,
    Paper,
    Provenance,
    RankedPaper,
    RankingSummary,
    RankRequest,
    RankResponse,
    SearchState,
)

router = APIRouter(tags=["rank"])


def _legacy_to_schema_ranked(
    legacy: LegacyRankedPaper,
    candidate_by_id: dict[str, Paper],
) -> RankedPaper:
    """Convert a rank-module RankedPaper back to the unified schema."""
    base = candidate_by_id.get(legacy.paper_id)
    if base is None:
        # Fallback: create a minimal paper if the ID is somehow missing.
        base = Paper(paper_id=legacy.paper_id, title="")

    return RankedPaper(
        **base.model_dump(exclude={"score", "rank", "tier"}),
        score=legacy.score,
        rank=legacy.rank,
        tier=legacy.tier,  # type: ignore[arg-type]
    )


@router.post("/rank", response_model=RankResponse)
async def rank(request: RankRequest) -> RankResponse:
    """Rerank a provided candidate set using the configured ranker."""
    start = time.perf_counter_ns()

    candidate_by_id = {p.paper_id: p for p in request.candidates}
    legacy_candidates = [paper_to_candidate(p) for p in request.candidates]
    legacy_request = LegacyRankRequest(
        query=request.query,
        candidates=legacy_candidates,
        strategy=request.strategy,  # type: ignore[arg-type]
        top_k=request.top_k,
    )

    legacy_response = rank_candidates(legacy_request)
    papers = [
        _legacy_to_schema_ranked(p, candidate_by_id)
        for p in legacy_response.ranked
    ]

    elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000

    search_state = SearchState(
        candidate_counts=CandidateCounts(
            recalled=len(request.candidates),
            after_dedup=len(request.candidates),
            returned=len(papers),
        ),
        ranking_summary=RankingSummary(
            ranker_version="search_service.rank",
            feature_version="f1",
            profile=request.intent,
            l2_scored=len(request.candidates),
        ),
        budget_spent=Budget(usd=0.0, wall_ms=elapsed_ms, api_calls=0),
    )

    provenance = Provenance(
        per_paper_sources={p.paper_id: p.sources for p in papers},
        ranker_version="search_service.rank",
        feature_version="f1",
        profile=request.intent,
        theta_ref=request.theta_ref,
    )

    return RankResponse(
        ranked=papers,
        search_state=search_state,
        provenance=provenance,
        cost_usd=0.0,
        elapsed_ms=elapsed_ms,
    )
