"""Local re-ranking support for academic paper candidates.

.. deprecated::

    The ranking utilities in this package have been migrated to
    ``src/search_service/features/`` and ``src/search_service/rank/`` as part
    of the Search Service consolidation. New code should import from
    ``search_service.rank`` and ``search_service.features`` instead.
    This package is kept temporarily for backward compatibility and will be
    removed once all callers are migrated.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

from src.retriever.bm25 import BM25Ranker
from src.retriever.embedding import EmbeddingRanker
from src.retriever.openalex import OpenAlexClient, OpenAlexSearchResult
from src.retriever.provider import EmbeddingProvider, RemoteEmbeddingProvider
from src.retriever.ranker import rank

# Load environment variables from the project root .env file when the module is
# imported. Existing environment variables are not overwritten.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_PROJECT_ROOT / ".env", override=False)

__all__ = [
    "BM25Ranker",
    "EmbeddingProvider",
    "EmbeddingRanker",
    "OpenAlexClient",
    "OpenAlexSearchResult",
    "RemoteEmbeddingProvider",
    "rank",
]
