"""Aggregated search endpoints."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.aggregator import SearchAggregator
from search_service.api._adapter import legacy_response_to_search_response
from search_service.models import SearchRequest as LegacySearchRequest
from search_service.schemas import SearchRequest, SearchResponse

router = APIRouter(prefix="/search", tags=["search"])


def _get_aggregator(request: Request) -> SearchAggregator:
    """Retrieve the aggregator from application state."""
    return request.app.state.aggregator


def _to_legacy_request(request: SearchRequest, mode: str) -> LegacySearchRequest:
    """Build a legacy request from the new schema.

    The legacy aggregator only understands query, mode, top_k, sources and
    timeout_ms, so we map the available fields and discard advanced knobs for
    now.
    """
    timeout_ms = 15_000
    if request.budget and request.budget.wall_ms:
        timeout_ms = request.budget.wall_ms

    return LegacySearchRequest(
        query=request.query,
        mode=mode,  # type: ignore[arg-type]
        top_k=request.top_k,
        sources=None,
        timeout_ms=timeout_ms,
    )


@router.post("", response_model=SearchResponse)
async def search(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Generic aggregated search endpoint."""
    return await _execute_search(http_request, request, "metadata")


@router.post("/metadata", response_model=SearchResponse)
async def search_metadata(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Search for paper metadata."""
    return await _execute_search(http_request, request, "metadata")


@router.post("/fulltext", response_model=SearchResponse)
async def search_fulltext(http_request: Request, request: SearchRequest) -> SearchResponse | JSONResponse:
    """Search for full-text / PDF links."""
    return await _execute_search(http_request, request, "fulltext")


async def _execute_search(
    http_request: Request,
    request: SearchRequest,
    mode: str,
) -> SearchResponse | JSONResponse:
    start = time.perf_counter_ns()
    aggregator = _get_aggregator(http_request)
    legacy_request = _to_legacy_request(request, mode)
    legacy_response = await aggregator.search(legacy_request)

    elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
    response = legacy_response_to_search_response(
        legacy_response,
        theta_ref=request.theta_ref,
        intent=request.intent,
        elapsed_ms=elapsed_ms,
    )

    # If every requested source failed and we have no results, surface it as a
    # service error while still returning the structured response body.
    if not response.papers and response.search_state.failures:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=response.model_dump(),
        )

    return response
