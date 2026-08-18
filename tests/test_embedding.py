"""Tests for the embedding re-ranker using a mock provider."""

from __future__ import annotations

import pytest

from src.retriever.cache import InMemoryEmbeddingCache
from src.retriever.embedding import EmbeddingRanker, _cosine_similarity
from src.retriever.provider import EmbeddingProvider
from src.retriever.ranker import rank
from src.retriever.schema import PaperCandidate, RankRequest


class MockProvider:
    """Deterministic embedding provider for tests.

    Returns a unit vector along one axis based on a simple hash of the text.
    """

    async def encode(self, texts: list[str]) -> list[list[float]]:
        return [self._vectorize(t) for t in texts]

    def _vectorize(self, text: str) -> list[float]:
        # Three axes are enough for deterministic cosine tests.
        bucket = hash(text) % 3
        if bucket == 0:
            return [1.0, 0.0, 0.0]
        if bucket == 1:
            return [0.0, 1.0, 0.0]
        return [0.0, 0.0, 1.0]


def make_request(strategy: str = "embedding", top_k: int | None = None) -> RankRequest:
    return RankRequest(
        query="transformer architecture",
        candidates=[
            PaperCandidate(
                paper_id="p1",
                title="Attention Is All You Need",
                abstract="We propose the transformer.",
            ),
            PaperCandidate(
                paper_id="p2",
                title="Cooking for Beginners",
                abstract="A guide to basic culinary techniques.",
            ),
            PaperCandidate(
                paper_id="p3",
                title="BERT: Pre-training of Deep Transformers",
                abstract="We introduce a new language representation model.",
            ),
        ],
        strategy=strategy,  # type: ignore[arg-type]
        top_k=top_k,
    )


@pytest.fixture
def provider() -> EmbeddingProvider:
    return MockProvider()


def test_cosine_similarity_orthogonal() -> None:
    assert _cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_similarity_identical() -> None:
    assert _cosine_similarity([1.0, 1.0], [1.0, 1.0]) == pytest.approx(1.0)


def test_cosine_similarity_dimension_mismatch() -> None:
    with pytest.raises(ValueError, match="dimension mismatch"):
        _cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0])


def test_embedding_ranker_sorts_candidates(provider: EmbeddingProvider) -> None:
    request = make_request()
    ranker = EmbeddingRanker(provider)
    response = ranker.rank(request)

    assert response.strategy == "embedding"
    assert len(response.ranked) == 3
    # Scores should be descending.
    scores = [r.score for r in response.ranked]
    assert scores == sorted(scores, reverse=True)
    # Ranks are 1-based.
    assert [r.rank for r in response.ranked] == [1, 2, 3]


def test_embedding_ranker_top_k(provider: EmbeddingProvider) -> None:
    request = make_request(top_k=2)
    ranker = EmbeddingRanker(provider)
    response = ranker.rank(request)
    assert len(response.ranked) == 2
    assert response.ranked[-1].rank == 2


def test_embedding_ranker_empty_candidates(provider: EmbeddingProvider) -> None:
    request = RankRequest(query="foo", candidates=[], strategy="embedding")
    ranker = EmbeddingRanker(provider)
    response = ranker.rank(request)
    assert response.ranked == []
    assert response.source_counts == {"embedding": 0}


def test_embedding_ranker_caches_vectors(provider: EmbeddingProvider) -> None:
    cache = InMemoryEmbeddingCache()
    ranker = EmbeddingRanker(provider, cache=cache)
    request = make_request()

    ranker.rank(request)
    # The cache should contain the query vector plus one vector per candidate.
    assert len(cache._store) == 1 + len(request.candidates)

    # Second call should not require new provider invocations for existing texts.
    ranker.rank(request)
    assert len(cache._store) == 1 + len(request.candidates)


def test_embedding_ranker_batch_splitting(provider: EmbeddingProvider) -> None:
    """Ensure texts are split into batches respecting batch_size."""

    class BatchedMockProvider:
        def __init__(self, inner: MockProvider) -> None:
            self.inner = inner
            self.batch_sizes: list[int] = []

        async def encode(self, texts: list[str]) -> list[list[float]]:
            self.batch_sizes.append(len(texts))
            return await self.inner.encode(texts)

    inner = BatchedMockProvider(MockProvider())
    ranker = EmbeddingRanker(inner, batch_size=2)
    request = make_request()
    ranker.rank(request)

    # Query is encoded separately from passages, so batches are [query], [2 passages], [1 passage].
    assert sum(inner.batch_sizes) == 4
    assert inner.batch_sizes == [1, 2, 1]


def test_rank_entry_embedding(provider: EmbeddingProvider) -> None:
    request = make_request(strategy="embedding")
    response = rank(request, embedding_provider=provider)
    assert response.strategy == "embedding"
    assert len(response.ranked) == 3


def test_rank_entry_hybrid(provider: EmbeddingProvider) -> None:
    request = make_request(strategy="hybrid")
    response = rank(request, embedding_provider=provider)
    assert response.strategy == "hybrid"
    assert len(response.ranked) == 3
    assert response.source_counts == {"bm25": 3, "embedding": 3}
