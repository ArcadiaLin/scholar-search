"""Dense embedding re-ranker using a remote embedding provider."""

from __future__ import annotations

import asyncio
import math
import time

from src.retriever.cache import EmbeddingCache, InMemoryEmbeddingCache
from src.retriever.provider import EmbeddingProvider, stable_cache_key
from src.retriever.schema import PaperCandidate, RankedPaper, RankRequest, RankResponse
from src.retriever.text import assign_tiers


def _cosine_similarity(query_vec: list[float], doc_vec: list[float]) -> float:
    """Compute cosine similarity between two equal-dimension vectors."""
    if len(query_vec) != len(doc_vec):
        raise ValueError(f"Vector dimension mismatch: query {len(query_vec)} vs doc {len(doc_vec)}")

    dot = 0.0
    query_norm = 0.0
    doc_norm = 0.0
    for q, d in zip(query_vec, doc_vec, strict=True):
        dot += q * d
        query_norm += q * q
        doc_norm += d * d

    denom = math.sqrt(query_norm) * math.sqrt(doc_norm)
    if denom == 0.0:
        return 0.0
    return dot / denom


def _build_query_text(query: str) -> str:
    return f"query: {query}"


def _build_passage_text(candidate: PaperCandidate) -> str:
    parts: list[str] = [f"passage: {candidate.title}"]
    if candidate.abstract:
        parts.append(candidate.abstract)
    return " ".join(parts)


class EmbeddingRanker:
    """Re-rank candidates by cosine similarity against a remote embedding model."""

    def __init__(
        self,
        provider: EmbeddingProvider,
        *,
        cache: EmbeddingCache | None = None,
        batch_size: int = 64,
    ) -> None:
        """Initialize the ranker.

        Args:
            provider: Injected embedding provider.
            cache: Optional embedding cache. Defaults to in-memory.
            batch_size: Max number of texts sent to the provider in one call.
        """
        self.provider = provider
        self.cache = cache if cache is not None else InMemoryEmbeddingCache()
        self.batch_size = max(1, batch_size)

    def _get_or_encode(self, texts: list[str]) -> list[list[float]]:
        """Fetch cached vectors and encode the rest via the provider."""
        results: list[list[float] | None] = [None] * len(texts)
        missing_indices: list[int] = []
        missing_texts: list[str] = []

        for idx, text in enumerate(texts):
            key = stable_cache_key(text)
            cached = self.cache.get(key)
            if cached is not None:
                results[idx] = cached
            else:
                missing_indices.append(idx)
                missing_texts.append(text)

        if missing_texts:
            encoded = asyncio.run(self.provider.encode(missing_texts))
            if len(encoded) != len(missing_texts):
                raise RuntimeError(f"Provider returned {len(encoded)} vectors for {len(missing_texts)} texts")
            for dest_idx, text, vector in zip(missing_indices, missing_texts, encoded, strict=True):
                self.cache.set(stable_cache_key(text), vector)
                results[dest_idx] = vector

        # ``results`` is fully populated by construction; cast for the type checker.
        return [v for v in results if v is not None]

    def _encode_in_batches(self, texts: list[str]) -> list[list[float]]:
        """Encode a list of texts respecting ``batch_size``."""
        vectors: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            vectors.extend(self._get_or_encode(batch))
        return vectors

    def rank(self, request: RankRequest) -> RankResponse:
        """Re-rank ``request.candidates`` using dense embeddings."""
        start = time.perf_counter_ns()

        if not request.candidates:
            elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
            return RankResponse(
                ranked=[],
                elapsed_ms=elapsed_ms,
                strategy="embedding",
                source_counts={"embedding": 0},
            )

        query_text = _build_query_text(request.query)
        query_vector = self._encode_in_batches([query_text])[0]

        passage_texts = [_build_passage_text(c) for c in request.candidates]
        passage_vectors = self._encode_in_batches(passage_texts)

        scored = [(idx, _cosine_similarity(query_vector, doc_vec)) for idx, doc_vec in enumerate(passage_vectors)]
        # Sort by similarity descending; ties preserve original candidate order.
        scored.sort(key=lambda x: (-x[1], x[0]))

        sorted_scores = [score for _, score in scored]
        tiers = assign_tiers(sorted_scores)

        top_k = request.top_k if request.top_k is not None else len(request.candidates)
        ranked: list[RankedPaper] = []
        for rank_idx, (candidate_idx, score) in enumerate(scored[:top_k]):
            candidate = request.candidates[candidate_idx]
            ranked.append(
                RankedPaper(
                    paper_id=candidate.paper_id,
                    score=float(score),
                    rank=rank_idx + 1,
                    tier=tiers[rank_idx],
                )
            )

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return RankResponse(
            ranked=ranked,
            elapsed_ms=elapsed_ms,
            strategy="embedding",
            source_counts={"embedding": len(ranked)},
        )
