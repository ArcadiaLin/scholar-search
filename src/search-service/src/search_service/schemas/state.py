"""Pipeline state schemas for SearchState and EvidenceState."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from search_service.schemas.paper import CitationEdge, Paper
from search_service.schemas.requests import Budget


class IssuedQuery(BaseModel):
    """A single query issued to a provider."""

    provider: str = Field(description="Provider name.")
    mode: Literal["aggregated", "passthrough", "rank-only", "expand", "facet"] = Field(
        description="Service mode used for this query.")
    query: str | None = Field(default=None, description="Normalized query string.")
    raw: dict[str, Any] | None = Field(default=None, description="Provider-native payload for passthrough.")
    cost_usd: float | None = Field(default=None, description="Estimated cost of this call.")
    latency_ms: int | None = Field(default=None, description="Observed latency in milliseconds.")
    cached: bool = Field(default=False, description="Whether the result came from cache.")


class CandidateCounts(BaseModel):
    """Candidate set sizes across pipeline stages."""

    recalled: int = Field(default=0, description="Raw candidates from all sources.")
    after_dedup: int = Field(default=0, description="Candidates after cross-source deduplication.")
    after_filter: int = Field(default=0, description="Candidates after L0 filtering.")
    after_rank: int = Field(default=0, description="Candidates entering the final select stage.")
    returned: int = Field(default=0, description="Final number of returned papers.")


class DedupStats(BaseModel):
    """Deduplication statistics."""

    clusters_formed: int = Field(default=0, description="Number of unique clusters produced.")
    by_doi: int = Field(default=0, description="Clusters formed via DOI match.")
    by_arxiv_id: int = Field(default=0, description="Clusters formed via arXiv ID match.")
    by_title_year_first_author: int = Field(default=0, description="Clusters formed via title fallback.")
    source_overlap_counts: dict[str, int] = Field(
        default_factory=dict,
        description="How many clusters each source contributed to.")


class RankingSummary(BaseModel):
    """Summary of the ranking stage."""

    ranker_version: str | None = Field(default=None, description="Ranker version identifier.")
    feature_version: str | None = Field(default=None, description="Feature set version.")
    profile: str | None = Field(default=None, description="Intent profile used.")
    l0_filtered: int = Field(default=0, description="Candidates removed by L0.")
    l1_fused: int = Field(default=0, description="Candidates after RRF.")
    l2_scored: int = Field(default=0, description="Candidates after L2 scoring.")
    l3_scored: int = Field(default=0, description="Candidates after L3 scoring.")


class ExpansionFrontier(BaseModel):
    """State of the citation expansion stage."""

    depth: int = Field(default=0, description="Expansion depth reached.")
    seeds: list[str] = Field(default_factory=list, description="Seed paper IDs.")
    neighbors_visited: int = Field(default=0, description="Total neighbor candidates fetched.")
    neighbors_added: int = Field(default=0, description="Neighbors that survived deduplication/filtering.")


class Failure(BaseModel):
    """A classified pipeline or provider failure."""

    stage: str | None = Field(default=None, description="Pipeline stage where the failure occurred.")
    source: str | None = Field(default=None, description="Provider name, if applicable.")
    error_type: Literal["timeout", "rate_limit", "auth", "http", "parse", "disabled", "unknown", "budget"] = Field(
        description="Failure category.")
    message: str = Field(description="Human-readable error message.")


class SearchState(BaseModel):
    """Observable record of what the search did and what it consumed.

    This is the ``SearchState`` portion of the Public Search Trace ``τ̄_t``.
    """

    issued_queries: list[IssuedQuery] = Field(default_factory=list, description="All provider calls issued.")
    selected_sources: list[str] = Field(default_factory=list, description="Sources selected for this request.")
    filters: dict[str, Any] = Field(default_factory=dict, description="Applied filters (date, type, etc.).")
    candidate_counts: CandidateCounts = Field(default_factory=CandidateCounts, description="Candidate counts.")
    dedup_stats: DedupStats = Field(default_factory=DedupStats, description="Deduplication statistics.")
    ranking_summary: RankingSummary = Field(default_factory=RankingSummary, description="Ranking stage summary.")
    expansion_frontier: ExpansionFrontier = Field(default_factory=ExpansionFrontier, description="Expansion state.")
    budget_spent: Budget = Field(
        default_factory=lambda: Budget(usd=0.0, wall_ms=0, api_calls=0),
        description="Actual budget consumption.")
    skipped_stages: list[str] = Field(default_factory=list, description="Stages skipped due to budget or capability.")
    failures: list[Failure] = Field(default_factory=list, description="Recorded failures.")
    probe_summary: dict[str, Any] | None = Field(default=None, description="Facet probe summary.")


class EvidenceState(BaseModel):
    """Observable record of what evidence the search found.

    This is the ``EvidenceState`` portion of the Public Search Trace ``τ̄_t``.
    """

    papers: list[Paper] = Field(default_factory=list, description="Full paper records in the evidence set.")
    abstracts_or_snippets: dict[str, str] = Field(
        default_factory=dict,
        description="Mapping from paper_id to available abstract or snippet text.")
    citation_edges: list[CitationEdge] = Field(default_factory=list, description="Citation graph edges.")
    bibliometric_fields: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Per-paper bibliometric field values.")
    source_ids: dict[str, list[str]] = Field(
        default_factory=dict,
        description="Mapping from provider name to list of native IDs returned.")
    evidence_ids: list[str] = Field(default_factory=list, description="Ordered list of evidence paper IDs.")
    coverage_signals: dict[str, Any] = Field(
        default_factory=dict,
        description="Signals such as source overlap, topic coverage, etc.")


class Provenance(BaseModel):
    """Provenance metadata attached to a Search Service response."""

    per_paper_sources: dict[str, list[str]] = Field(
        default_factory=dict,
        description="For each paper_id, the providers that contributed.")
    ranker_version: str | None = Field(default=None, description="Ranker version.")
    feature_version: str | None = Field(default=None, description="Feature set version.")
    profile: str | None = Field(default=None, description="Intent profile used.")
    theta_ref: str | None = Field(default=None, description="Running configuration reference.")
