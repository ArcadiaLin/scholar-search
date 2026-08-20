"""Single-paper detail endpoint (Phase 1 placeholder)."""

from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

router = APIRouter(tags=["paper"])


@router.get("/paper/{paper_id}")
async def get_paper(paper_id: str) -> JSONResponse:
    """Return enriched details for a single paper.

    Phase 1 placeholder: accepts the paper_id and returns a structured 501
    explaining that single-paper lookup is not yet implemented.
    """
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={
            "detail": "Single-paper lookup is not yet implemented.",
            "paper_id": paper_id,
        },
    )
