"""Local ranking strategies for the search service.

This module provides BM25, dense embedding, and hybrid ranking entry points.
It is the internal ranker used by the ``POST /rank`` endpoint and by the
aggregated search pipeline.
"""

from __future__ import annotations

from search_service.rank.bm25 import BM25Ranker
from search_service.rank.embedding import EmbeddingRanker
from search_service.rank.ranker import rank
from search_service.rank.schema import PaperCandidate, RankRequest, RankResponse

__all__ = [
    "BM25Ranker",
    "EmbeddingRanker",
    "PaperCandidate",
    "RankRequest",
    "RankResponse",
    "rank",
]
