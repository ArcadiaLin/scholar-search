"""Unified Paper schema used across all search service providers and modes."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Author(BaseModel):
    """A paper author with optional identifiers."""

    name: str = Field(description="Author display name.")
    orcid: str | None = Field(default=None, description="ORCID identifier, if available.")
    affiliation: str | None = Field(default=None, description="Author affiliation, if available.")
    h_index: float | None = Field(default=None, description="Author h-index, if available.")


class CountsByYear(BaseModel):
    """Citation count for a single year."""

    year: int = Field(description="Year of the citation count.")
    count: int = Field(description="Number of citations in that year.")


class CitationEdge(BaseModel):
    """A directed citation edge between two papers."""

    source_id: str = Field(description="Paper ID at the tail of the edge.")
    target_id: str = Field(description="Paper ID at the head of the edge.")
    edge_type: Literal["references", "cites"] = Field(description="Direction semantics.")


class FieldProvenance(BaseModel):
    """Per-field source attribution.

    Records which provider supplied a given unified field and from which
    provider-side field it was derived. This supports both audit and training
    feature-availability statistics.
    """

    field: str = Field(description="Unified field name.")
    provider: str = Field(description="Provider name that supplied the value.")
    source_field: str | None = Field(default=None, description="Original provider field name.")
    confidence: Literal["high", "medium", "low"] = Field(default="high", description="Mapping confidence.")


class Paper(BaseModel):
    """A single paper normalized across all source providers.

    Fields are grouped by concern (identity, bibliographic, bibliometric,
    graph, quality, provenance) as required by ``search-service.md`` §5.1.
    Missing bibliometric or graph values must be represented as ``None``
    together with their corresponding missing-indicator features; they must
    never be silently coerced to zero.
    """

    # ---- identity ----------------------------------------------------------
    paper_id: str = Field(description="Stable cross-source identifier (DOI > arXiv ID > OpenAlex ID).")
    doi: str | None = Field(default=None, description="Digital Object Identifier.")
    arxiv_id: str | None = Field(default=None, description="arXiv identifier.")
    openalex_id: str | None = Field(default=None, description="OpenAlex short or full identifier.")
    cluster_id: str | None = Field(
        default=None,
        description="Internal cluster ID after cross-source deduplication.")
    external_ids: dict[str, str] = Field(
        default_factory=dict,
        description="Additional source-specific identifiers (e.g. Semantic Scholar CorpusID).",
    )

    # ---- bibliographic -----------------------------------------------------
    title: str = Field(description="Paper title.")
    abstract: str | None = Field(default=None, description="Paper abstract, if available.")
    authors: list[Author] | None = Field(default=None, description="Author list, if available.")
    venue: str | None = Field(default=None, description="Publication venue or journal.")
    year: int | None = Field(default=None, description="Publication year.")
    published: str | None = Field(default=None, description="Publication date in ISO 8601 format.")
    updated: str | None = Field(default=None, description="Last update date (arXiv version / revision).")
    version: str | None = Field(default=None, description="Version string, primarily from arXiv.")
    type: str | None = Field(default=None, description="Work type (article, preprint, etc.).")

    # ---- bibliometric ------------------------------------------------------
    citation_count: int | None = Field(default=None, description="Raw citation count.")
    normalized_impact: float | None = Field(default=None, description="Field-weighted citation impact (e.g. FWCI).")
    citation_percentile: float | None = Field(default=None, description="Citation percentile within field/year.")
    counts_by_year: list[CountsByYear] | None = Field(
        default=None,
        description="Yearly citation counts for velocity computation.")
    author_h_index: list[float] | None = Field(
        default=None,
        description="h-index values for the paper authors.")

    # ---- graph -------------------------------------------------------------
    references: list[str] | None = Field(
        default=None,
        description="Paper IDs cited by this paper (out-edges).")
    citations: list[str] | None = Field(
        default=None,
        description="Paper IDs citing this paper (in-edges).")

    # ---- quality -----------------------------------------------------------
    is_retracted: bool | None = Field(default=None, description="Whether the work has been retracted.")
    record_thinness: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="0 = complete record, 1 = very thin record.")
    citation_confidence: Literal["high", "medium", "low"] | None = Field(
        default=None,
        description="Confidence in the bibliometric fields.")

    # ---- provenance --------------------------------------------------------
    field_provenance: dict[str, FieldProvenance] = Field(
        default_factory=dict,
        description="Field-level source attribution.")
    sources: list[str] = Field(
        default_factory=list,
        description="Provider names that contributed to this record.")

    # ---- raw debugging -----------------------------------------------------
    raw: dict[str, Any] | None = Field(
        default=None,
        description="Raw source response retained for debugging and audit.")


class RankedPaper(Paper):
    """A ``Paper`` after ranking, with score and tier annotations."""

    score: float = Field(description="Final ranking score.")
    rank: int = Field(ge=1, description="1-based position in the ranked list.")
    tier: Literal["highly_relevant", "partially_relevant", "not_relevant"] = Field(
        description="Relevance tier assigned by the ranker.")
