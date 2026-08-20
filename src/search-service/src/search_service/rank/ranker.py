"""Unified entry point for local re-ranking strategies."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from search_service.features.provider import RemoteEmbeddingProvider
from search_service.rank.bm25 import BM25Ranker
from search_service.rank.embedding import EmbeddingRanker
from search_service.rank.schema import RankedPaper, RankRequest, RankResponse

if TYPE_CHECKING:
    from search_service.features.provider import EmbeddingProvider


def _min_max_normalize(scores: list[float]) -> list[float]:
    """Normalize scores to [0, 1]. Identical or single scores map to 0."""
    if not scores:
        return []
    min_score = min(scores)
    max_score = max(scores)
    span = max_score - min_score
    if span == 0.0:
        return [0.0] * len(scores)
    return [(s - min_score) / span for s in scores]


def _default_embedding_provider() -> EmbeddingProvider:
    """Create a remote embedding provider from environment variables."""
    base_url = os.environ.get("EMBEDDING_BASE_URL", "http://localhost:8000/v1")
    model = os.environ.get("EMBEDDING_MODEL", "intfloat/e5-base-v2")
    api_key = os.environ.get("EMBEDDING_API_KEY") or None
    return RemoteEmbeddingProvider(base_url=base_url, model=model, api_key=api_key)


def rank(
    request: RankRequest,
    *,
    embedding_provider: EmbeddingProvider | None = None,
) -> RankResponse:
    """Re-rank ``request.candidates`` using the requested strategy.

    Args:
        request: Re-ranking request with strategy, candidates, and budget.
        embedding_provider: Optional embedding provider. If ``None`` and an
            embedding-based strategy is requested, a default
            ``RemoteEmbeddingProvider`` is built from environment variables
            ``EMBEDDING_BASE_URL``, ``EMBEDDING_MODEL``, and ``EMBEDDING_API_KEY``.

    Raises:
        ValueError: For unknown or unsupported strategies.
        TimeoutError: If ranking exceeds ``request.max_wall_ms``.
    """
    if request.strategy == "bm25":
        response = BM25Ranker().rank(request)
    elif request.strategy == "embedding":
        provider = embedding_provider if embedding_provider is not None else _default_embedding_provider()
        response = EmbeddingRanker(provider).rank(request)
    elif request.strategy == "hybrid":
        response = _hybrid_rank(request, embedding_provider=embedding_provider)
    else:
        raise ValueError(f"Unknown strategy {request.strategy!r}")

    if response.elapsed_ms > request.max_wall_ms:
        raise TimeoutError(f"Ranking exceeded budget of {request.max_wall_ms} ms (took {response.elapsed_ms} ms).")

    return response


def _hybrid_rank(
    request: RankRequest,
    *,
    embedding_provider: EmbeddingProvider | None = None,
) -> RankResponse:
    """Combine BM25 and embedding scores with equal weights.

    Both score lists are min-max normalized to [0, 1] and combined as
    ``0.5 * bm25_norm + 0.5 * emb_norm``. The combined score is then used for
    ranking and tier assignment.
    """
    from search_service.features.text import assign_tiers

    bm25_response = BM25Ranker().rank(request)
    provider = embedding_provider if embedding_provider is not None else _default_embedding_provider()
    emb_response = EmbeddingRanker(provider).rank(request)

    # Build score maps keyed by candidate index.  Both responses contain every
    # candidate because neither applies top_k internally.
    bm25_by_index: dict[int, float] = {}
    for paper in bm25_response.ranked:
        # Recover original candidate index from the ranked list order is not
        # enough; we look up by paper_id.  This is O(n^2) but n < 1000 here.
        for idx, candidate in enumerate(request.candidates):
            if candidate.paper_id == paper.paper_id:
                bm25_by_index[idx] = paper.score
                break

    emb_by_index: dict[int, float] = {}
    for paper in emb_response.ranked:
        for idx, candidate in enumerate(request.candidates):
            if candidate.paper_id == paper.paper_id:
                emb_by_index[idx] = paper.score
                break

    n = len(request.candidates)
    bm25_scores = [bm25_by_index.get(i, 0.0) for i in range(n)]
    emb_scores = [emb_by_index.get(i, 0.0) for i in range(n)]

    bm25_norm = _min_max_normalize(bm25_scores)
    emb_norm = _min_max_normalize(emb_scores)

    combined = [(idx, 0.5 * bm25_norm[idx] + 0.5 * emb_norm[idx]) for idx in range(n)]
    combined.sort(key=lambda x: (-x[1], x[0]))

    sorted_scores = [score for _, score in combined]
    tiers = assign_tiers(sorted_scores)

    top_k = request.top_k if request.top_k is not None else n
    ranked: list[RankedPaper] = []
    for rank_idx, (candidate_idx, score) in enumerate(combined[:top_k]):
        candidate = request.candidates[candidate_idx]
        ranked.append(
            RankedPaper(
                paper_id=candidate.paper_id,
                score=float(score),
                rank=rank_idx + 1,
                tier=tiers[rank_idx],
            )
        )

    return RankResponse(
        ranked=ranked,
        elapsed_ms=bm25_response.elapsed_ms + emb_response.elapsed_ms,
        strategy="hybrid",
        source_counts={"bm25": len(request.candidates), "embedding": len(request.candidates)},
    )
