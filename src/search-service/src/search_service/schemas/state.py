"""Pipeline state schemas for SearchState and Provenance."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class IssuedQuery(BaseModel):
    """A single query issued to a provider."""

    provider: str = Field(description="Provider name.")
    mode: Literal["aggregated", "passthrough"] = Field(description="Service mode used for this query.")
    query: str | None = Field(default=None, description="Normalized query string, as the caller wrote it.")
    native_query: str | None = Field(
        default=None,
        description=(
            "The provider-native query string actually sent, when the provider rewrites the "
            "normalized one. A rewrite the trajectory cannot see is a rewrite nobody can debug."
        ),
    )
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
    error_type: Literal["timeout", "rate_limit", "auth", "http", "parse", "disabled", "bad_id", "unknown"] = Field(
        description="Failure category. `bad_id` is a caller-fixable input, not a gap in the data.")
    message: str = Field(description="Human-readable error message.")


class JudgeAccount(BaseModel):
    """What the relevance judge actually did, and under which instrument.

    On ``SearchState`` rather than beside the papers because it is a fact about the
    *call*, and because the J axis has no observable without it: "judging was
    requested" and "thirty papers were judged under rubric r3 and criteria
    cq_1a2b" support different conclusions (`docs/develop/plan.md` §5.2).
    """

    level: str = Field(default="off", description="Judging tier actually executed: off / l3a / l3b / l3c.")
    requested_level: str = Field(default="off", description="What the caller asked for, before any forced override.")
    supported: bool = Field(default=False, description="Whether the requested tier is implemented in this build.")
    considered: int = Field(default=0, description="Papers in scope for judging, after the configured ceiling.")
    judged: int = Field(default=0, description="Papers that produced a verdict.")
    cache_hits: int = Field(default=0, description="Verdicts served from the content-addressed cache.")
    rubric_version: str | None = Field(default=None, description="Rubric version behind the verdicts.")
    criteria_version: str | None = Field(default=None, description="Criteria version behind the verdicts.")
    model_version: str | None = Field(default=None, description="Model that produced the verdicts.")


class SearchState(BaseModel):
    """Observable record of what the search did and consumed."""

    issued_queries: list[IssuedQuery] = Field(default_factory=list, description="All provider calls issued.")
    selected_sources: list[str] = Field(default_factory=list, description="Sources selected for this request.")
    filters: dict[str, Any] = Field(default_factory=dict, description="Applied filters (date, type, etc.).")
    candidate_counts: CandidateCounts = Field(default_factory=CandidateCounts, description="Candidate counts.")
    failures: list[Failure] = Field(default_factory=list, description="Recorded failures.")
    judge: JudgeAccount = Field(default_factory=JudgeAccount, description="What the relevance judge did.")


class Provenance(BaseModel):
    """Provenance metadata attached to a Search Service response."""

    per_paper_sources: dict[str, list[str]] = Field(
        default_factory=dict,
        description="For each paper_id, the providers that contributed.")
