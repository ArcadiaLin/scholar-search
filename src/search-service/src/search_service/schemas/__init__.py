"""Public schema exports for the search service.

This module exposes the stable request/response/state contracts used by the
HTTP API, the retrieval pipeline, and downstream Agent tooling.
"""

from __future__ import annotations

from search_service.schemas.capabilities import (
    BurstPolicy,
    CostModel,
    ProviderCapabilities,
    ReliabilityProfile,
)
from search_service.schemas.paper import (
    Author,
    CitationEdge,
    CountsByYear,
    FieldProvenance,
    Paper,
    RankedPaper,
)
from search_service.schemas.requests import (
    Budget,
    ExpandRequest,
    PassthroughRequest,
    RankRequest,
    SearchRequest,
)
from search_service.schemas.responses import (
    BudgetResponse,
    ProviderInfo,
    RankResponse,
    SearchResponse,
)
from search_service.schemas.state import (
    CandidateCounts,
    DedupStats,
    EvidenceState,
    ExpansionFrontier,
    Failure,
    IssuedQuery,
    Provenance,
    RankingSummary,
    SearchState,
)

__all__ = [
    "Author",
    "Budget",
    "BudgetResponse",
    "BurstPolicy",
    "CandidateCounts",
    "CitationEdge",
    "CostModel",
    "CountsByYear",
    "DedupStats",
    "EvidenceState",
    "ExpandRequest",
    "ExpansionFrontier",
    "Failure",
    "FieldProvenance",
    "IssuedQuery",
    "Paper",
    "PassthroughRequest",
    "Provenance",
    "ProviderCapabilities",
    "ProviderInfo",
    "RankRequest",
    "RankResponse",
    "RankedPaper",
    "RankingSummary",
    "ReliabilityProfile",
    "SearchRequest",
    "SearchResponse",
    "SearchState",
]
