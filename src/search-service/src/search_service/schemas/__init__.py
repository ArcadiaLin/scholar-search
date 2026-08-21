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
from search_service.schemas.judge import (
    JudgeRequest,
    JudgeResponse,
    LLMMessage,
    RelevanceJudgeRequest,
    RelevanceJudgeResponse,
)
from search_service.schemas.paper import (
    Author,
    CitationEdge,
    CountsByYear,
    FieldProvenance,
    Paper,
    RankedPaper,
    canonical_key,
    merge_papers,
    search_result_item_to_paper,
)
from search_service.schemas.requests import (
    ExpandRequest,
    FacetRequest,
    FulltextRequest,
    PassthroughRequest,
    RankRequest,
    SearchRequest,
)
from search_service.schemas.responses import (
    BudgetResponse,
    ExpandResponse,
    FacetResponse,
    FulltextPaper,
    FulltextResponse,
    FulltextSection,
    PaperResponse,
    ProviderInfo,
    RankResponse,
    ReviewConfigResponse,
    SearchResponse,
)
from search_service.schemas.state import (
    CandidateCounts,
    Failure,
    IssuedQuery,
    JudgeAccount,
    Provenance,
    SearchState,
)

__all__ = [
    "Author",
    "BudgetResponse",
    "BurstPolicy",
    "CandidateCounts",
    "CitationEdge",
    "CostModel",
    "CountsByYear",
    "ExpandRequest",
    "ExpandResponse",
    "FacetRequest",
    "FacetResponse",
    "Failure",
    "FieldProvenance",
    "FulltextPaper",
    "FulltextRequest",
    "FulltextResponse",
    "FulltextSection",
    "IssuedQuery",
    "JudgeAccount",
    "JudgeRequest",
    "JudgeResponse",
    "LLMMessage",
    "Paper",
    "PaperResponse",
    "PassthroughRequest",
    "Provenance",
    "ProviderCapabilities",
    "ProviderInfo",
    "RankRequest",
    "RankResponse",
    "RankedPaper",
    "RelevanceJudgeRequest",
    "RelevanceJudgeResponse",
    "ReliabilityProfile",
    "ReviewConfigResponse",
    "SearchRequest",
    "SearchResponse",
    "SearchState",
    "canonical_key",
    "merge_papers",
    "search_result_item_to_paper",
]
