"""Request schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class SearchRequest(BaseModel):
    """Request schema for the aggregated search endpoint.

    Mirrors the OpenAlex ``/works`` endpoint parameters, with the addition of
    service-level governance fields ``end_date`` and ``top_k``.
    """

    # OpenAlex /works parameters, passed through verbatim.
    search: str | None = Field(default=None, description="OpenAlex search parameter.")
    search_exact: str | None = Field(default=None, description="OpenAlex search.exact parameter.")
    search_semantic: str | None = Field(default=None, description="OpenAlex search.semantic parameter.")
    filter: str | None = Field(default=None, description="OpenAlex filter parameter.")
    sort: str | None = Field(default=None, description="OpenAlex sort parameter.")
    per_page: int | None = Field(default=None, ge=1, le=200, description="OpenAlex per-page parameter.")
    page: int | None = Field(default=None, ge=1, description="OpenAlex page parameter.")
    cursor: str | None = Field(default=None, description="OpenAlex cursor parameter.")
    select: str | None = Field(default=None, description="OpenAlex select parameter.")
    group_by: str | None = Field(default=None, description="OpenAlex group-by parameter.")
    sample: int | None = Field(default=None, ge=1, description="OpenAlex sample parameter.")
    seed: int | None = Field(default=None, description="OpenAlex seed parameter.")

    # Service-level governance fields.
    end_date: str | None = Field(
        default=None,
        description="Exclusive upper bound on publication date (ISO 8601).")
    top_k: int = Field(default=20, ge=1, le=200, description="Maximum results to return.")

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
