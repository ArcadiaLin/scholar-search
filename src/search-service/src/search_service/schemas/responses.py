"""Response schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from search_service.schemas.paper import RankedPaper
from search_service.schemas.state import EvidenceState, Provenance, SearchState


class SearchResponse(BaseModel):
    """Unified response returned by aggregated search endpoints.

    Contains ranked papers, pipeline state, evidence state, provenance, and
    cost accounting. Every field is machine-readable.
    """

    papers: list[RankedPaper] = Field(default_factory=list, description="Ranked paper results.")
    search_state: SearchState = Field(default_factory=SearchState, description="What the search did and consumed.")
    evidence_state: EvidenceState = Field(
        default_factory=EvidenceState, description="Evidence found by the search.")
    provenance: Provenance = Field(default_factory=Provenance, description="Source and version provenance.")
    cost_usd: float = Field(default=0.0, description="Total estimated USD spent.")
    elapsed_ms: int = Field(default=0, description="Wall-clock time in milliseconds.")
    cached: bool = Field(default=False, description="Whether the response was served from cache.")


class RankResponse(BaseModel):
    """Response from the rank-only endpoint."""

    ranked: list[RankedPaper] = Field(default_factory=list, description="Ranked papers.")
    search_state: SearchState = Field(default_factory=SearchState, description="Ranking stage state.")
    provenance: Provenance = Field(default_factory=Provenance, description="Ranker provenance.")
    cost_usd: float = Field(default=0.0, description="Total estimated USD spent.")
    elapsed_ms: int = Field(default=0, description="Wall-clock time in milliseconds.")
    cached: bool = Field(default=False, description="Whether the response was served from cache.")


class ProviderInfo(BaseModel):
    """Capability and quota information for a single provider."""

    name: str = Field(description="Provider name.")
    enabled: bool = Field(description="Whether the provider is enabled.")
    capabilities: dict[str, bool] = Field(description="Capability flags.")
    cost_model: dict[str, Any] = Field(
        default_factory=dict, description="Cost model per endpoint (nested structure preserved).")
    field_map: dict[str, str] = Field(default_factory=dict, description="Provider field → unified field map.")
    reliability: dict[str, float | int | str | list[str] | None] = Field(
        default_factory=dict, description="Reliability profile.")
    quota_remaining: dict[str, int | float | None] = Field(
        default_factory=dict, description="Best-effort quota remaining estimates.")


class BudgetResponse(BaseModel):
    """Current episode budget balance and usage."""

    trace_id: str | None = Field(default=None, description="Episode trace identifier.")
    budget: dict[str, float | int | None] = Field(default_factory=dict, description="Original budget limits.")
    spent: dict[str, float | int] = Field(default_factory=dict, description="Budget consumed so far.")
    remaining: dict[str, float | int | None] = Field(default_factory=dict, description="Remaining budget.")
