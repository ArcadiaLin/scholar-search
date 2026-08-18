"""Runtime cache interfaces for local retriever components.

For the initial BM25-only milestone only the in-memory implementation is
provided; persistent caching will be added together with the embedding ranker
and the paper cache database.
"""

from __future__ import annotations

from typing import Protocol


class EmbeddingCache(Protocol):
    """Cache for embedding vectors, keyed by a stable identifier."""

    def get(self, key: str) -> list[float] | None:
        """Return the cached vector, or ``None`` if missing."""
        ...

    def set(self, key: str, vector: list[float]) -> None:
        """Store a vector in the cache."""
        ...


class InMemoryEmbeddingCache:
    """Simple thread-unsafe in-memory embedding cache."""

    def __init__(self) -> None:
        self._store: dict[str, list[float]] = {}

    def get(self, key: str) -> list[float] | None:
        return self._store.get(key)

    def set(self, key: str, vector: list[float]) -> None:
        self._store[key] = vector
