"""Public schema exports for the search service.

This module exposes the stable request/response/state contracts used by the
HTTP API and downstream Agent tooling.
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
    merge_papers,
    search_result_item_to_paper,
)
from search_service.schemas.requests import PassthroughRequest, SearchRequest
from search_service.schemas.responses import ProviderInfo, SearchResponse
from search_service.schemas.state import (
    CandidateCounts,
    Failure,
    IssuedQuery,
    Provenance,
    SearchState,
)

__all__ = [
    "Author",
    "BurstPolicy",
    "CandidateCounts",
    "CitationEdge",
    "CostModel",
    "CountsByYear",
    "Failure",
    "FieldProvenance",
    "IssuedQuery",
    "Paper",
    "PassthroughRequest",
    "Provenance",
    "ProviderCapabilities",
    "ProviderInfo",
    "RankedPaper",
    "ReliabilityProfile",
    "SearchRequest",
    "SearchResponse",
    "SearchState",
    "merge_papers",
    "search_result_item_to_paper",
]
