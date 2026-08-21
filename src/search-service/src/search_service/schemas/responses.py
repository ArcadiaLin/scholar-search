"""Response schemas for Search Service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from search_service.schemas.paper import CitationEdge, Paper, RankedPaper
from search_service.schemas.state import Failure, Provenance, SearchState


class SearchResponse(BaseModel):
    """Unified response returned by the aggregated search endpoint."""

    papers: list[RankedPaper] = Field(default_factory=list, description="Ranked paper results.")
    search_state: SearchState = Field(default_factory=SearchState, description="What the search did and consumed.")
    provenance: Provenance = Field(default_factory=Provenance, description="Source and version provenance.")
    cost_usd: float = Field(default=0.0, description="Total estimated USD spent.")
    elapsed_ms: int = Field(default=0, description="Wall-clock time in milliseconds.")


class PaperResponse(BaseModel):
    """One resolved paper, with the accounting of how it was resolved.

    ``tried_sources`` and ``failures`` are part of the answer, not debug output:
    lookup routes over several providers, and "arXiv had it" and "arXiv timed out
    but OpenAlex had it" are different facts about the record's provenance.
    """

    paper: Paper = Field(description="The resolved paper in the unified schema.")
    source: str = Field(description="Provider that resolved the ID.")
    tried_sources: list[str] = Field(
        default_factory=list, description="Providers attempted, in order, up to and including the one that answered.")
    failures: list[Failure] = Field(
        default_factory=list, description="Failures from providers tried before this one answered.")


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


class ExpandResponse(BaseModel):
    """Result of a bounded citation-graph walk.

    ``effective_limits`` and ``clamped`` are part of the answer, not diagnostics:
    an expansion that silently used a smaller depth than asked would make a thin
    result look like a thin literature.
    """

    papers: list[Paper] = Field(default_factory=list, description="Papers reached, deduplicated.")
    edges: list[CitationEdge] = Field(default_factory=list, description="Citation edges traversed.")
    direction: str = Field(description="Direction actually walked.")
    effective_limits: dict[str, int] = Field(
        default_factory=dict, description="The bounds this walk actually ran under.")
    clamped: list[str] = Field(
        default_factory=list, description="Which requested bounds were reduced to the configured ceiling.")
    provider_calls: int = Field(default=0, description="Provider calls issued by this walk.")
    failures: list[Failure] = Field(default_factory=list, description="Classified failures during the walk.")


class FacetResponse(BaseModel):
    """Distribution of a query's results over one or more grouping fields."""

    query: str = Field(description="Query that was probed.")
    groups: dict[str, list[dict[str, Any]]] = Field(
        default_factory=dict, description="Per-field group counts, as the provider reported them.")
    source: str = Field(description="Provider that answered.")
    failures: list[Failure] = Field(default_factory=list, description="Providers tried that could not answer.")


class RankResponse(BaseModel):
    """Rank-only result: the supplied candidates, scored and ordered."""

    papers: list[RankedPaper] = Field(default_factory=list, description="Candidates in ranked order.")
    scored: int = Field(default=0, description="Candidates scored.")
    skipped: int = Field(default=0, description="Candidate records that could not be parsed.")
    provider_calls: int = Field(
        default=0, description="Always zero: rank-only never issues a provider call, and this states it.")


class FulltextSection(BaseModel):
    """One section of a paper's full text."""

    title: str = Field(description="Section heading.")
    text: str = Field(description="Section body, bounded by configuration.")
    match_count: int = Field(default=0, description="Query term occurrences, when a query was given.")


class FulltextPaper(BaseModel):
    """Full-text sections retrieved for one paper."""

    paper_id: str = Field(description="Identifier as requested.")
    available: bool = Field(description="Whether full text could be retrieved at all.")
    reason: str | None = Field(default=None, description="Why it was unavailable, when it was not.")
    sections: list[FulltextSection] = Field(default_factory=list, description="Sections, bounded by configuration.")


class FulltextResponse(BaseModel):
    """Full-text evidence for the requested papers."""

    papers: list[FulltextPaper] = Field(default_factory=list, description="Per-paper full-text result.")
    effective_limits: dict[str, int] = Field(default_factory=dict, description="The bounds this call ran under.")
    clamped: list[str] = Field(default_factory=list, description="Which requested bounds were reduced.")


class BudgetResponse(BaseModel):
    """What the agent is allowed to spend, and what has been spent so far.

    Consumption is **process-scoped**, not episode-scoped: the Evidence Store
    that would carry per-episode accounting is not built yet
    (``docs/develop/mapping.md`` §3.2). The field says so rather than implying an
    episode boundary that does not exist.
    """

    limits: dict[str, Any] = Field(default_factory=dict, description="Effective operational bounds (theta^S_k).")
    quotas: dict[str, Any] = Field(default_factory=dict, description="Per-provider cost model and declared quotas.")
    spent: dict[str, int] = Field(default_factory=dict, description="Provider calls this process has issued, by endpoint.")
    scope: str = Field(default="process", description="Scope of `spent`. 'process' until an Evidence Store exists.")


class ReviewConfigResponse(BaseModel):
    """The Sidecar Reviewer's detector thresholds ($HP_k$).

    Returned as an open map rather than as named fields: a detector added later
    needs a threshold added here, and a closed schema would make that a
    coordinated change across two languages for no gain. The extension reads the
    keys it knows and reports the ones it does not.
    """

    thresholds: dict[str, Any] = Field(default_factory=dict, description="Detector thresholds in force (HP_k).")
    provenance: str = Field(description="Where these values come from, and how much they are worth.")
