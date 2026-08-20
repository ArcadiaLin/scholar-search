"""Citation expansion endpoint (Phase 1 placeholder)."""

from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from search_service.schemas import ExpandRequest

router = APIRouter(tags=["expand"])


@router.post("/expand")
async def expand(request: ExpandRequest) -> JSONResponse:
    """Expand around seed papers via references/citations.

    Phase 1 placeholder: accepts the request contract and returns a structured
    501 explaining that expansion is not yet implemented.
    """
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={
            "detail": "Citation expansion is not yet implemented.",
            "seed_ids": request.seed_ids,
            "direction": request.direction,
            "depth": request.depth,
            "fanout": request.fanout,
        },
    )
