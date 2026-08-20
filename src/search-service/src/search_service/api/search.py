"""Aggregated search endpoint.

``POST /search`` distributes the unified query to all selected providers,
merges provider-native parameters, normalizes results, deduplicates by stable
ID, and reranks using Reciprocal Rank Fusion (RRF).
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.aggregator import AggregationError, Aggregator
from search_service.schemas import SearchRequest, SearchResponse

router = APIRouter(prefix="/search", tags=["search"])


def _get_aggregator(request: Request) -> Aggregator:
    """Retrieve the aggregator from application state."""
    return request.app.state.aggregator


@router.post("", response_model=SearchResponse)
async def search(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Aggregate search results from all selected providers."""
    aggregator = _get_aggregator(http_request)

    try:
        papers, search_state, provenance, elapsed_ms = await aggregator.aggregate(
            query=request.query,
            top_k=request.top_k,
            end_date=request.end_date,
            sources=request.sources,
            timeout_ms=request.timeout_ms,
            provider_params=request.provider_params,
        )
    except AggregationError as exc:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": str(exc)},
        )

    return SearchResponse(
        papers=papers,
        search_state=search_state,
        provenance=provenance,
        elapsed_ms=elapsed_ms,
    )


@router.post("/metadata", response_model=SearchResponse)
async def search_metadata(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Aggregate search results from all selected providers (metadata-only alias)."""
    return await search(http_request, request)
