"""Pipeline state schemas for SearchState and Provenance."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class IssuedQuery(BaseModel):
    """A single query issued to a provider."""

    provider: str = Field(description="Provider name.")
    mode: Literal["aggregated", "passthrough"] = Field(description="Service mode used for this query.")
    query: str | None = Field(default=None, description="Normalized query string.")
    raw: dict[str, Any] | None = Field(default=None, description="Provider-native payload.")
    cost_usd: float | None = Field(default=None, description="Estimated cost of this call.")
    latency_ms: int | None = Field(default=None, description="Observed latency in milliseconds.")


class CandidateCounts(BaseModel):
    """Candidate set sizes."""

    recalled: int = Field(default=0, description="Raw candidates from the provider.")
    returned: int = Field(default=0, description="Final number of returned papers.")


class Failure(BaseModel):
    """A classified pipeline or provider failure."""

    stage: str | None = Field(default=None, description="Pipeline stage where the failure occurred.")
    source: str | None = Field(default=None, description="Provider name, if applicable.")
    error_type: Literal["timeout", "rate_limit", "auth", "http", "parse", "disabled", "unknown"] = Field(
        description="Failure category.")
    message: str = Field(description="Human-readable error message.")


class SearchState(BaseModel):
    """Observable record of what the search did and consumed."""

    issued_queries: list[IssuedQuery] = Field(default_factory=list, description="All provider calls issued.")
    selected_sources: list[str] = Field(default_factory=list, description="Sources selected for this request.")
    filters: dict[str, Any] = Field(default_factory=dict, description="Applied filters (date, type, etc.).")
    candidate_counts: CandidateCounts = Field(default_factory=CandidateCounts, description="Candidate counts.")
    failures: list[Failure] = Field(default_factory=list, description="Recorded failures.")


class Provenance(BaseModel):
    """Provenance metadata attached to a Search Service response."""

    per_paper_sources: dict[str, list[str]] = Field(
        default_factory=dict,
        description="For each paper_id, the providers that contributed.")
