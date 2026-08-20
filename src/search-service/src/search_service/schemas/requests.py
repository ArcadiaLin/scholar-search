"""Request schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from search_service.schemas.paper import Paper


class Budget(BaseModel):
    """Episode-level budget for a single Service call.

    Service checks these limits at pipeline stage boundaries. Exceeding any
    limit stops the current strategy and returns a partial, explainable result.
    """

    usd: float | None = Field(default=None, ge=0.0, description="Maximum USD to spend.")
    wall_ms: int | None = Field(default=None, ge=0, description="Maximum wall-clock time in milliseconds.")
    api_calls: int | None = Field(default=None, ge=0, description="Maximum provider API calls.")


class SearchRequest(BaseModel):
    """Request schema for aggregated search endpoints.

    Carries explicit episode context so that Service never infers constraints
    from global state.
    """

    query: str = Field(description="Primary search query.")
    subqueries: list[str] = Field(
        default_factory=list,
        description="Optional complementary sub-queries for recall expansion.")
    intent: Literal["overview", "seminal", "frontier", "similar"] | None = Field(
        default=None,
        description="Retrieval intent used to select the ranking profile.")
    end_date: str | None = Field(
        default=None,
        description="Exclusive upper bound on publication date (ISO 8601).")
    top_k: int = Field(default=20, ge=1, le=200, description="Maximum results to return.")
    theta_ref: str | None = Field(
        default=None,
        description="Reference to the running Search Configuration θ^S_k.")
    budget: Budget | None = Field(default=None, description="Budget for this call.")
    trace_id: str | None = Field(
        default=None,
        description="Episode-unique trace identifier (e.g. ep_00123_step_3).")

    @field_validator("end_date")
    @classmethod
    def _validate_end_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) < 4:
            raise ValueError("end_date must be at least a 4-digit year")
        return value


class RankRequest(BaseModel):
    """Request schema for the rank-only endpoint.

    Allows an upstream caller (e.g. Main Agent) to provide a candidate set and
    ask the Service to apply the trainable reranker.
    """

    query: str = Field(description="Original search query.")
    candidates: list[Paper] = Field(description="Candidate papers to rerank.")
    strategy: Literal["bm25", "embedding", "hybrid"] = Field(
        default="bm25",
        description="Ranking strategy to use.")
    intent: Literal["overview", "seminal", "frontier", "similar"] | None = Field(
        default=None,
        description="Ranking intent profile.")
    top_k: int | None = Field(default=None, ge=1, description="Return only the top-k results.")
    theta_ref: str | None = Field(default=None, description="Reference to the running configuration.")
    budget: Budget | None = Field(default=None, description="Budget for this call.")
    trace_id: str | None = Field(default=None, description="Episode-unique trace identifier.")


class ExpandRequest(BaseModel):
    """Request schema for citation expansion.

    Expansion is bounded by depth, fanout, and total candidate count. It feeds
    back into the align/enrich stages.
    """

    seed_ids: list[str] = Field(description="Paper IDs to expand from.")
    direction: Literal["references", "citations", "both"] = Field(
        default="both",
        description="Which citation direction to follow.")
    depth: int = Field(default=1, ge=1, le=2, description="Expansion depth.")
    fanout: int = Field(default=20, ge=1, le=100, description="Maximum neighbors per seed.")
    end_date: str | None = Field(default=None, description="Exclusive publication date upper bound.")
    top_k: int = Field(default=50, ge=1, le=200, description="Maximum expanded candidates to return.")
    theta_ref: str | None = Field(default=None, description="Reference to the running configuration.")
    budget: Budget | None = Field(default=None, description="Budget for this call.")
    trace_id: str | None = Field(default=None, description="Episode-unique trace identifier.")


class PassthroughRequest(BaseModel):
    """Request schema for provider-native query passthrough.

    The Service applies governance (time boundary, budget, rate limiting,
    observability) but does not rewrite the native query expression.
    """

    raw: dict[str, Any] = Field(description="Provider-native query payload.")
    normalize: bool = Field(
        default=False,
        description="If true, map the response to the unified Paper schema.")
    end_date: str | None = Field(default=None, description="Exclusive publication date upper bound.")
    top_k: int | None = Field(default=None, ge=1, description="Hint for result count.")
    theta_ref: str | None = Field(default=None, description="Reference to the running configuration.")
    budget: Budget | None = Field(default=None, description="Budget for this call.")
    trace_id: str | None = Field(default=None, description="Episode-unique trace identifier.")
