"""Aggregated search endpoint.

``POST /search`` mirrors the OpenAlex ``/works`` endpoint. It forwards the
caller-provided parameters verbatim, applies the service-level ``end_date``
governance, and returns results normalized to the unified ``Paper`` schema.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.plugin_loader import PluginRegistry
from search_service.plugins.openalex import work_to_paper
from search_service.schemas import (
    CandidateCounts,
    IssuedQuery,
    Provenance,
    RankedPaper,
    SearchRequest,
    SearchResponse,
    SearchState,
)

router = APIRouter(prefix="/search", tags=["search"])

# OpenAlex /works parameter names supported by /search.
_OPENALEX_WORKS_PARAMS = {
    "search",
    "search_exact",
    "search_semantic",
    "filter",
    "sort",
    "per_page",
    "page",
    "cursor",
    "select",
    "group_by",
    "sample",
    "seed",
}

# Mapping from SearchRequest snake_case fields to OpenAlex query parameter names.
_PARAM_RENAMES = {
    "search_exact": "search.exact",
    "search_semantic": "search.semantic",
    "per_page": "per-page",
    "group_by": "group-by",
}


def _get_registry(request: Request) -> PluginRegistry:
    """Retrieve the plugin registry from application state."""
    return request.app.state.registry


def _build_openalex_params(request: SearchRequest) -> dict[str, Any]:
    """Build OpenAlex /works query parameters from the search request.

    Service-level fields ``end_date`` and ``top_k`` are excluded. ``end_date``
    is injected into the OpenAlex ``filter`` as ``to_publication_date``.
    """
    params: dict[str, Any] = {}
    for field in _OPENALEX_WORKS_PARAMS:
        value = getattr(request, field)
        if value is not None:
            param_name = _PARAM_RENAMES.get(field, field)
            params[param_name] = value

    # Inject end_date as to_publication_date filter.
    if request.end_date:
        date_filter = f"to_publication_date:{request.end_date}"
        existing_filter = params.get("filter")
        if existing_filter:
            params["filter"] = f"{existing_filter},{date_filter}"
        else:
            params["filter"] = date_filter

    return params


def _build_ranked_paper(paper: Any, rank_idx: int) -> RankedPaper:
    """Wrap a Paper as a RankedPaper with a neutral tier."""
    return RankedPaper(
        **paper.model_dump(exclude={"score", "rank", "tier"}),
        score=1.0 / rank_idx,
        rank=rank_idx,
        tier="partially_relevant",
    )


async def _execute_search(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Search OpenAlex works and return normalized papers."""
    start = time.perf_counter_ns()
    registry = _get_registry(http_request)
    instance = registry.get_plugin("openalex")

    if instance is None or not hasattr(instance, "query"):
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "OpenAlex provider is not enabled or failed to load."},
        )

    params = _build_openalex_params(request)
    try:
        raw_response = await instance.query("works", params)
    except Exception as exc:  # pragma: no cover - provider errors surfaced generically
        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "detail": f"OpenAlex query failed: {exc}",
                "elapsed_ms": elapsed_ms,
            },
        )

    works = raw_response.get("results") or []
    papers = [work_to_paper(work) for work in works]
    papers = papers[: request.top_k]
    ranked = [_build_ranked_paper(p, idx + 1) for idx, p in enumerate(papers)]

    elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
    issued_query = IssuedQuery(
        provider="openalex",
        mode="aggregated",
        query=params.get("search") or params.get("filter"),
        raw=params,
    )
    search_state = SearchState(
        issued_queries=[issued_query],
        selected_sources=["openalex"],
        filters={"end_date": request.end_date} if request.end_date else {},
        candidate_counts=CandidateCounts(recalled=len(works), returned=len(ranked)),
    )
    provenance = Provenance(
        per_paper_sources={p.paper_id: ["openalex"] for p in ranked},
    )

    return SearchResponse(
        papers=ranked,
        search_state=search_state,
        provenance=provenance,
        elapsed_ms=elapsed_ms,
    )


@router.post("", response_model=SearchResponse)
async def search(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Search OpenAlex works and return normalized papers."""
    return await _execute_search(http_request, request)


@router.post("/metadata", response_model=SearchResponse)
async def search_metadata(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Search OpenAlex works and return normalized papers."""
    return await _execute_search(http_request, request)
