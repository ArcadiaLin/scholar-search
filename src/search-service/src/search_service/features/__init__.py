"""Shared feature utilities for the search service.

Includes text tokenization, document assembly, embedding provider interfaces,
and embedding caches. These utilities are used by both the ranker and the
feature extraction stages of the retrieval pipeline.
"""

from __future__ import annotations

from search_service.features.cache import EmbeddingCache, InMemoryEmbeddingCache
from search_service.features.provider import (
    EmbeddingProvider,
    EmbeddingProviderError,
    EmbeddingResponseError,
    EmbeddingTimeoutError,
    RemoteEmbeddingProvider,
    stable_cache_key,
)
from search_service.features.text import assign_tiers, build_document
from search_service.features.tokenizer import tokenize, tokenize_many

__all__ = [
    "EmbeddingCache",
    "EmbeddingProvider",
    "EmbeddingProviderError",
    "EmbeddingResponseError",
    "EmbeddingTimeoutError",
    "InMemoryEmbeddingCache",
    "RemoteEmbeddingProvider",
    "assign_tiers",
    "build_document",
    "stable_cache_key",
    "tokenize",
    "tokenize_many",
]
