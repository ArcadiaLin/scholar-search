"""Adapters between legacy ``models`` and the new unified schemas.

These adapters are temporary: they let the HTTP API speak the new contract
while the internal aggregator and providers are still being migrated. They will
be removed once the pipeline natively produces ``Paper``, ``SearchState`` and
``EvidenceState``.
"""

from __future__ import annotations

from search_service.models import SearchResultItem, SourceErrorModel
from search_service.schemas import (
    Author,
    Budget,
    CandidateCounts,
    EvidenceState,
    Failure,
    IssuedQuery,
    Paper,
    Provenance,
    RankedPaper,
    SearchResponse,
    SearchState,
)


def _source_error_to_failure(error: SourceErrorModel) -> Failure:
    """Map legacy source error to a typed Failure."""
    return Failure(
        source=error.source,
        error_type=error.error_type,  # type: ignore[arg-type]
        message=error.message,
    )


def _result_item_to_paper(item: SearchResultItem) -> Paper:
    """Convert a legacy SearchResultItem into a unified Paper."""
    authors = None
    if item.authors:
        authors = [Author(name=name) for name in item.authors]

    return Paper(
        paper_id=item.paper_id,
        title=item.title,
        abstract=item.abstract,
        authors=authors,
        published=item.published,
        year=item.year,
        doi=item.doi,
        arxiv_id=item.arxiv_id,
        openalex_id=item.openalex_id,
        urls=item.urls,
        sources=[item.source],
        raw=item.raw,
    )


def _result_item_to_ranked_paper(item: SearchResultItem, rank_idx: int) -> RankedPaper:
    """Convert a legacy SearchResultItem into a RankedPaper.

    During the transition the legacy aggregator does not produce scores, so we
    use a simple position-based score and a neutral tier.
    """
    paper = _result_item_to_paper(item)
    return RankedPaper(
        **paper.model_dump(exclude={"score", "rank", "tier"}),
        score=1.0 / max(1, rank_idx),
        rank=rank_idx,
        tier="partially_relevant",
    )


def legacy_response_to_search_response(
    legacy_response,
    theta_ref: str | None,
    intent: str | None,
    elapsed_ms: int,
) -> SearchResponse:
    """Convert a legacy ``SearchResponse`` into the new schema.

    Args:
        legacy_response: Legacy response from ``SearchAggregator.search``.
        theta_ref: Configuration reference from the incoming request.
        intent: Intent profile from the incoming request.
        elapsed_ms: Wall-clock time observed by the API layer.
    """
    papers = [
        _result_item_to_ranked_paper(item, idx + 1)
        for idx, item in enumerate(legacy_response.results)
    ]

    issued_queries = [
        IssuedQuery(provider=source, mode="aggregated", query=legacy_response.query)
        for source in legacy_response.source_counts.keys()
    ]

    search_state = SearchState(
        issued_queries=issued_queries,
        selected_sources=legacy_response.selected_sources or list(legacy_response.source_counts.keys()),
        candidate_counts=CandidateCounts(
            recalled=legacy_response.total,
            after_dedup=legacy_response.total,
            returned=legacy_response.total,
        ),
        failures=[_source_error_to_failure(e) for e in legacy_response.errors],
        budget_spent=Budget(usd=0.0, wall_ms=elapsed_ms, api_calls=len(issued_queries)),
    )

    evidence_state = EvidenceState(
        papers=[_result_item_to_paper(item) for item in legacy_response.results],
    )

    provenance = Provenance(
        per_paper_sources={p.paper_id: p.sources for p in papers},
        ranker_version="legacy-aggregator",
        feature_version="f1",
        profile=intent,
        theta_ref=theta_ref,
    )

    return SearchResponse(
        papers=papers,
        search_state=search_state,
        evidence_state=evidence_state,
        provenance=provenance,
        cost_usd=0.0,
        elapsed_ms=elapsed_ms,
        cached=legacy_response.cached,
    )
