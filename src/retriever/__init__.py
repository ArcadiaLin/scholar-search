"""Local re-ranking support for academic paper candidates."""

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
