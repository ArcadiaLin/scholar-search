"""Facet exploration endpoint (Phase 1 placeholder)."""

from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

router = APIRouter(tags=["facet"])


@router.get("/facet")
async def facet(query: str) -> JSONResponse:
    """Return facet distribution for a query.

    Phase 1 placeholder: accepts the query parameter and returns a structured
    501 explaining that facet exploration is not yet implemented.
    """
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={
            "detail": "Facet exploration is not yet implemented.",
            "query": query,
        },
    )
