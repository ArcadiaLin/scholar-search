"""Budget status endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from search_service.schemas import BudgetResponse

router = APIRouter(tags=["budget"])


@router.get("/budget", response_model=BudgetResponse)
async def get_budget(trace_id: str | None = None) -> BudgetResponse:
    """Return the current episode budget balance.

    Phase 1: returns a neutral response because global budget tracking is not
    yet wired. The contract shape is stable; future phases will populate
    ``spent`` and ``remaining`` from the governance module.
    """
    return BudgetResponse(
        trace_id=trace_id,
        budget={},
        spent={"usd": 0.0, "wall_ms": 0, "api_calls": 0},
        remaining={},
    )
