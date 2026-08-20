"""Provider capability declarations used by the search pipeline."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class BurstPolicy(BaseModel):
    """Rate-limit burst policy."""

    max_burst: int = Field(default=1, ge=1, description="Maximum burst size.")
    refill_rate: float = Field(default=1.0, ge=0.0, description="Tokens refilled per second.")


class CostModel(BaseModel):
    """Cost and quota model for a provider endpoint."""

    usd_per_call: float = Field(default=0.0, ge=0.0, description="Estimated USD cost per call.")
    daily_quota: int | None = Field(default=None, ge=1, description="Daily call quota, if known.")
    rate_limit_rps: float = Field(default=1.0, ge=0.0, description="Requests per second limit.")
    burst_policy: BurstPolicy = Field(default_factory=BurstPolicy, description="Burst policy.")


class ReliabilityProfile(BaseModel):
    """Observed reliability profile for a provider."""

    p50_latency_ms: int = Field(default=500, ge=0, description="Median latency in milliseconds.")
    p95_latency_ms: int | None = Field(default=None, ge=0, description="95th percentile latency.")
    error_taxonomy: list[str] = Field(
        default_factory=lambda: ["timeout", "rate_limit", "auth", "http", "parse", "unknown"],
        description="Expected error categories.")
    retry_policy: Literal["fixed", "exponential"] = Field(
        default="exponential", description="Recommended retry policy.")
    max_retries: int = Field(default=3, ge=0, description="Recommended maximum retries.")


class ProviderCapabilities(BaseModel):
    """Capability table for a single source provider.

    The pipeline binds to capabilities, not provider names. If a capability is
    missing, the corresponding stage is skipped and recorded in ``SearchState``.
    """

    name: str = Field(description="Provider name.")

    # Search capabilities
    search_keyword: bool = Field(default=False, description="Keyword / natural language search.")
    search_native_query: bool = Field(default=False, description="Provider-native query expression.")
    search_field_filter: bool = Field(default=False, description="Structured field filtering.")
    facet_group_by: bool = Field(default=False, description="Facet aggregation.")

    # Identity / lookup
    id_lookup: bool = Field(default=False, description="Lookup a single record by ID.")
    id_mapping: bool = Field(default=False, description="External ID mapping service.")

    # Graph
    graph_references: bool = Field(default=False, description="Outgoing references (cited works).")
    graph_citations: bool = Field(default=False, description="Incoming citations (works citing this).")
    recommend_related: bool = Field(default=False, description="Related-work recommendations.")

    # Metrics
    metrics_raw_citations: bool = Field(default=False, description="Raw citation counts.")
    metrics_normalized: bool = Field(default=False, description="Field-normalized impact metrics.")

    # Text
    text_abstract: bool = Field(default=False, description="Abstract text available.")
    text_fulltext: bool = Field(default=False, description="Full text / PDF available.")

    # Cost / reliability / mapping
    cost_model: dict[str, CostModel] = Field(
        default_factory=dict, description="Per-endpoint cost model.")
    field_map: dict[str, str] = Field(
        default_factory=dict, description="Provider field → unified field map.")
    reliability: ReliabilityProfile = Field(
        default_factory=ReliabilityProfile, description="Reliability profile.")
