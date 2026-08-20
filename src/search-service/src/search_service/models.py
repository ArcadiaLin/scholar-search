"""Pydantic schemas for requests, responses, and result items."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SearchResultItem(BaseModel):
    """A single paper candidate normalized across all source plugins."""

    paper_id: str = Field(description="Stable cross-source identifier (DOI > arXiv ID > source native ID).")
    title: str = Field(description="Paper title.")
    authors: list[str] | None = Field(default=None, description="List of author names, if available.")
    abstract: str | None = Field(default=None, description="Paper abstract, if available.")
    venue: str | None = Field(default=None, description="Publication venue or journal, if available.")
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
