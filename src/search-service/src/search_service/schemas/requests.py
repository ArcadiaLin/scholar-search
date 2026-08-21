"""Request schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any, Literal

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


class ExpandRequest(BaseModel):
    """Request schema for citation-graph expansion.

    ``depth`` and ``fanout`` are requests, not settings: the service clamps them
    to ``limits.expand`` and reports what it actually used. See
    ``api/expand.py``.
    """

    seed_ids: list[str] = Field(min_length=1, description="Paper IDs to expand from.")
    direction: Literal["backward", "forward"] = Field(
        default="backward",
        description="`backward` follows references (works this cites); `forward` follows citations (works citing this).",
    )
    depth: int | None = Field(default=None, ge=1, description="Hops to walk. Clamped to the configured ceiling.")
    fanout: int | None = Field(
        default=None, ge=1, description="Maximum edges to follow per seed. Clamped to the configured ceiling.")


class FacetRequest(BaseModel):
    """Request schema for pre-recall distribution probing."""

    query: str = Field(min_length=1, description="Query whose result distribution is to be probed.")
    group_by: list[str] = Field(
        min_length=1, description="Provider field names to group by; see the field map from GET /providers.")


class RankRequest(BaseModel):
    """Request schema for rank-only scoring.

    Rank-only means exactly that: it scores and orders the candidates it is
    given and never issues a provider call, so it cannot introduce recall.
    """

    query: str = Field(min_length=1, description="Query the candidates are ranked against.")
    candidates: list[dict[str, Any]] = Field(min_length=1, description="Candidate records to rank.")
    top_k: int | None = Field(default=None, ge=1, le=200, description="How many ranked results to return.")


class FulltextRequest(BaseModel):
    """Request schema for full-text section retrieval."""

    paper_ids: list[str] = Field(min_length=1, description="Papers whose full text should be fetched.")
    query: str | None = Field(
        default=None, description="When given, only sections matching it are returned, ranked by match count.")
    sections: list[str] | None = Field(
        default=None, description="Section-title filters. Omit for all sections, bounded by configuration.")
