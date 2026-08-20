"""Tests for the migrated search_service rank module."""

from __future__ import annotations

import pytest

from search_service.rank import BM25Ranker, PaperCandidate, RankRequest, rank


def _candidates() -> list[PaperCandidate]:
    return [
        PaperCandidate(
            paper_id="W1",
            title="Attention Is All You Need",
            abstract="We propose a new simple network architecture, the Transformer.",
        ),
        PaperCandidate(
            paper_id="W2",
            title="BERT: Pre-training of Deep Bidirectional Transformers",
            abstract="We introduce a new language representation model called BERT.",
        ),
        PaperCandidate(
            paper_id="W3",
            title="A Survey on Graph Neural Networks",
            abstract="This survey provides a comprehensive overview of graph neural networks.",
        ),
    ]


class _MockEmbeddingProvider:
    """Deterministic provider that returns one-hot vectors by text hash."""

    async def encode(self, texts: list[str]) -> list[list[float]]:
        return [self._vectorize(t) for t in texts]

    def _vectorize(self, text: str) -> list[float]:
        bucket = hash(text) % 3
        if bucket == 0:
            return [1.0, 0.0, 0.0]
        if bucket == 1:
            return [0.0, 1.0, 0.0]
        return [0.0, 0.0, 1.0]


def test_bm25_ranker():
    request = RankRequest(query="transformer architecture", candidates=_candidates(), strategy="bm25")
    response = rank(request)

    assert response.strategy == "bm25"
    assert len(response.ranked) == 3
    assert response.ranked[0].rank == 1


def test_embedding_ranker():
    request = RankRequest(query="transformer architecture", candidates=_candidates(), strategy="embedding")
    response = rank(request, embedding_provider=_MockEmbeddingProvider())

    assert response.strategy == "embedding"
    assert len(response.ranked) == 3


def test_hybrid_ranker():
    request = RankRequest(query="transformer architecture", candidates=_candidates(), strategy="hybrid")
    response = rank(request, embedding_provider=_MockEmbeddingProvider())

    assert response.strategy == "hybrid"
    assert len(response.ranked) == 3
    assert response.source_counts == {"bm25": 3, "embedding": 3}


def test_unknown_strategy():
    request = RankRequest(query="test", candidates=_candidates(), strategy="bm25")
    invalid_request = request.model_copy(update={"strategy": "unknown"})
    with pytest.raises(ValueError, match="Unknown strategy"):
        rank(invalid_request)


def test_ranker_respects_budget(monkeypatch: pytest.MonkeyPatch):
    request = RankRequest(
        query="test",
        candidates=_candidates(),
        strategy="bm25",
        max_wall_ms=1,
    )

    def _slow_rank(_self: object, _request: RankRequest):
        from search_service.rank.schema import RankResponse

        return RankResponse(ranked=[], elapsed_ms=1000, strategy="bm25")

    monkeypatch.setattr("search_service.rank.ranker.BM25Ranker.rank", _slow_rank)

    with pytest.raises(TimeoutError):
        rank(request)


def test_bm25_ranker_empty_candidates():
    request = RankRequest(query="test", candidates=[], strategy="bm25")
    response = BM25Ranker().rank(request)
    assert response.ranked == []
    assert response.source_counts == {"bm25": 0}
