"""Pydantic schemas for requests, responses, and result items."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class SearchResultItem(BaseModel):
    """A single paper candidate normalized across all source plugins."""

    paper_id: str = Field(description="Stable cross-source identifier (DOI > arXiv ID > source native ID).")
    title: str = Field(description="Paper title.")
    authors: list[str] | None = Field(default=None, description="List of author names, if available.")
    abstract: str | None = Field(default=None, description="Paper abstract, if available.")
    published: str | None = Field(default=None, description="Publication date or year in ISO 8601 format.")
    year: int | None = Field(default=None, description="Publication year, if available.")
    doi: str | None = Field(default=None, description="DOI, if available.")
    arxiv_id: str | None = Field(default=None, description="arXiv identifier, if available.")
    openalex_id: str | None = Field(default=None, description="OpenAlex identifier, if available.")
    urls: dict[str, str | None] = Field(
        default_factory=dict,
        description="URLs for the paper, e.g. {'paper': ..., 'pdf': ..., 'html': ...}.",
    )
    source: str = Field(description="Source plugin name that produced this result.")
    source_rank: int | None = Field(default=None, description="Original rank within the source result list.")
    raw: dict[str, Any] | None = Field(default=None, description="Raw source fields retained for debugging.")


class SearchRequest(BaseModel):
    """Request schema for the search endpoints."""

    query: str = Field(description="Search query string.")
    mode: Literal["metadata", "fulltext"] = Field(default="metadata", description="Search mode.")
    top_k: int = Field(default=20, ge=1, le=200, description="Maximum number of results to return.")
    sources: list[str] | None = Field(
        default=None,
        description="Optional list of source plugin names to use. Defaults to all enabled plugins.",
    )
    timeout_ms: int = Field(
        default=15_000,
        ge=500,
        le=60_000,
        description="Total wall-clock budget for the search in milliseconds.",
    )


class SourceErrorModel(BaseModel):
    """Error information for a single source plugin failure."""

    source: str = Field(description="Source plugin name.")
    error_type: str = Field(
        description="Error category: timeout, rate_limit, auth, http, parse, disabled, or unknown."
    )
    message: str = Field(description="Human-readable error message.")


class SearchResponse(BaseModel):
    """Unified response schema returned by all search endpoints."""

    query: str = Field(description="Original search query.")
    mode: str = Field(description="Search mode that was executed.")
    selected_sources: list[str] = Field(
        default_factory=list, description="Sources that were selected for this request.")
    results: list[SearchResultItem] = Field(description="Aggregated and deduplicated result list.")
    total: int = Field(description="Number of deduplicated results.")
    source_counts: dict[str, int] = Field(description="Counts of results contributed per source.")
    errors: list[SourceErrorModel] = Field(default_factory=list, description="Failures from individual sources.")
    elapsed_ms: int = Field(description="Wall-clock time spent in milliseconds.")
    cached: bool = Field(default=False, description="Whether the response was served from cache.")


class SourceHealth(BaseModel):
    """Health status for a single source plugin."""

    name: str = Field(description="Source plugin name.")
    enabled: bool = Field(description="Whether the plugin is enabled.")
    ok: bool = Field(description="Whether the plugin loaded successfully.")
    message: str | None = Field(default=None, description="Optional status message.")


class HealthResponse(BaseModel):
    """Response schema for the /health endpoint."""

    status: str = Field(description="Overall service status.")
    version: str = Field(description="Service version.")
    sources: list[SourceHealth] = Field(description="Health status of each source plugin.")
