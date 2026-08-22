"""Unified Paper schema used across all search service providers and modes."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field

from search_service.identifiers import parse_identifier, strip_arxiv_version
from search_service.models import SearchResultItem


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
    urls: dict[str, str | None] = Field(
        default_factory=dict,
        description="URLs for the paper, e.g. {'paper': ..., 'pdf': ..., 'html': ...}.",
    )

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

    @computed_field(
        description=(
            "Identity of the work, normalized across id spaces. Derived, never supplied: "
            "a caller that could set it could split one paper into two."
        )
    )
    @property
    def canonical_id(self) -> str:
        return canonical_key(self)


class RankedPaper(Paper):
    """A ``Paper`` after ranking, with score and tier annotations."""

    score: float = Field(description="Final ranking score.")
    rank: int = Field(ge=1, description="1-based position in the ranked list.")
    tier: Literal["highly_relevant", "partially_relevant", "not_relevant"] = Field(
        description="Relevance tier assigned by the ranker.")


def canonical_key(paper: Paper) -> str:
    """One key per work, whichever id space the record happens to carry.

    This is the only definition of "the same paper" in the service. It used to be
    an inline expression inside ``Aggregator._deduplicate``, which meant nothing
    outside that method could ask the question and nothing could test the answer
    (``docs/develop/decisions.md`` D-13).

    The precedence is D-13's - DOI, then arXiv id, then OpenAlex id, then whatever
    ``paper_id`` says - with one addition: the chosen id is put through
    ``identifiers.parse_identifier`` first. That matters more than it sounds.
    OpenAlex records an arXiv preprint's DOI as ``10.48550/arxiv.1810.09726``
    while arXiv reports the same work as ``1810.09726``; unnormalized, those are
    two papers. Normalized, they are one, and cross-source duplicates of arXiv
    preprints - which is most of this project's corpus - collapse.

    What it still cannot collapse: a record holding a publisher DOI and a record
    holding only the arXiv id, with no alias linking them. Neither lookup returns
    the other's identifier, so no key function can see that they are one work.
    """
    for raw in (paper.doi, paper.arxiv_id, paper.openalex_id, paper.paper_id):
        if not raw:
            continue
        identifier = parse_identifier(raw)
        if identifier is None:
            return raw
        if identifier.kind == "arxiv":
            return f"arxiv:{strip_arxiv_version(identifier.value)}"
        # DOIs are case-insensitive by specification, and sources disagree on case.
        if identifier.kind == "doi":
            return f"doi:{identifier.value.lower()}"
        return f"{identifier.kind}:{identifier.value}"
    return paper.paper_id


def search_result_item_to_paper(item: SearchResultItem) -> Paper:
    """Convert a plugin-level ``SearchResultItem`` to the unified ``Paper`` schema."""
    return Paper(
        paper_id=item.paper_id,
        title=item.title,
        authors=[Author(name=name) for name in item.authors] if item.authors else None,
        abstract=item.abstract,
        venue=item.venue,
        published=item.published,
        year=item.year,
        doi=item.doi,
        arxiv_id=item.arxiv_id,
        openalex_id=item.openalex_id,
        urls=item.urls,
        sources=[item.source],
        raw=item.raw,
    )


def merge_papers(papers: list[Paper], source_preference: list[str] | None = None) -> Paper:
    """Merge multiple ``Paper`` records describing the same work into one record.

    Fields are taken from the first non-null value according to ``source_preference``.
    The ``sources`` list is the union of all contributing sources.
    """
    if not papers:
        raise ValueError("Cannot merge an empty list of papers")
    if len(papers) == 1:
        return papers[0]

    preference = source_preference or []

    def _source_key(p: Paper) -> int:
        try:
            return preference.index(p.sources[0])
        except (ValueError, IndexError):
            return len(preference)

    ordered = sorted(papers, key=_source_key)
    base = ordered[0]

    def _pick(field: str) -> Any:
        for p in ordered:
            value = getattr(p, field)
            if value is not None and value != [] and value != {}:
                return value
        return None

    all_sources: list[str] = []
    for p in papers:
        for src in p.sources:
            if src not in all_sources:
                all_sources.append(src)

    def _source_key(src: str) -> int:
        try:
            return preference.index(src)
        except ValueError:
            return len(preference)

    all_sources.sort(key=_source_key)

    # Preserve the raw response from the highest-preference source.
    raw = base.raw

    # Merge URLs by taking the first non-null value per key.
    merged_urls: dict[str, str | None] = {}
    for p in ordered:
        for key, value in (p.urls or {}).items():
            if value is not None and key not in merged_urls:
                merged_urls[key] = value

    return Paper(
        paper_id=base.paper_id,
        doi=_pick("doi"),
        arxiv_id=_pick("arxiv_id"),
        openalex_id=_pick("openalex_id"),
        title=_pick("title") or base.title,
        abstract=_pick("abstract"),
        authors=_pick("authors"),
        venue=_pick("venue"),
        published=_pick("published"),
        year=_pick("year"),
        urls=merged_urls,
        citation_count=_pick("citation_count"),
        normalized_impact=_pick("normalized_impact"),
        citation_percentile=_pick("citation_percentile"),
        counts_by_year=_pick("counts_by_year"),
        author_h_index=_pick("author_h_index"),
        references=_pick("references"),
        citations=_pick("citations"),
        is_retracted=_pick("is_retracted"),
        sources=all_sources,
        raw=raw,
    )
