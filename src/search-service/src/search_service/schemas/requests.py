"""Request schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class SearchRequest(BaseModel):
    """Request schema for the aggregated search endpoint.

    ``/search`` accepts a unified query and optionally provider-native parameters
    for each source. The service distributes the query to all selected providers,
    merges provider-native parameters, and aggregates the normalized results.
    """

    query: str = Field(description="Unified search query string.")
    subqueries: list[str] | None = Field(
        default=None,
        max_length=8,
        description=(
            "Additional queries to run alongside `query`, fused into one ranked list. "
            "Bounded: fan-out multiplies provider calls, so the cap is part of the contract."
        ),
    )
    top_k: int = Field(default=20, ge=1, le=200, description="Maximum results to return.")
    end_date: str | None = Field(
        default=None,
        description="Exclusive upper bound on publication date (ISO 8601).")
    sources: list[str] | None = Field(
        default=None,
        description="Selected provider names. Defaults to all enabled providers.")
    timeout_ms: int = Field(
        default=15_000, ge=500, le=60_000, description="Total wall-clock budget in milliseconds.")
    provider_params: dict[str, dict[str, Any]] | None = Field(
        default=None,
        description="Provider-native parameters keyed by provider name.")

    @field_validator("subqueries")
    @classmethod
    def _validate_subqueries(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        # A blank subquery would become an unfiltered provider call: it costs a
        # request and returns noise. Drop them rather than issue them.
        cleaned = [item.strip() for item in value if item and item.strip()]
        return cleaned or None

    @field_validator("end_date")
    @classmethod
    def _validate_end_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) < 4:
            raise ValueError("end_date must be at least a 4-digit year")
        return value


class PassthroughRequest(BaseModel):
    """Request schema for provider-native query passthrough.

    For OpenAlex, ``endpoint`` is the entity path (e.g. ``works``, ``authors``)
    and ``params`` are forwarded verbatim. For arXiv, ``endpoint`` is ignored and
    ``params`` are forwarded to the arXiv Atom API.
    """

    endpoint: str | None = Field(default=None, description="OpenAlex entity endpoint path.")
    params: dict[str, Any] = Field(default_factory=dict, description="Provider-native query parameters.")
