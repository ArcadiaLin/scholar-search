"""Tests for the unified ranker entry point."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.retriever.ranker import rank
from src.retriever.schema import PaperCandidate, RankRequest


def _load_fixture() -> dict:
    return json.loads(Path("tests/fixtures/candidates.json").read_text())


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


def test_rank_bm25() -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy="bm25",
    )
    response = rank(request)

    assert response.strategy == "bm25"
    assert len(response.ranked) == 3


def test_rank_embedding() -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy="embedding",  # type: ignore[arg-type]
    )
    response = rank(request, embedding_provider=_MockEmbeddingProvider())

    assert response.strategy == "embedding"
    assert len(response.ranked) == 3


def test_rank_hybrid() -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy="hybrid",  # type: ignore[arg-type]
    )
    response = rank(request, embedding_provider=_MockEmbeddingProvider())

    assert response.strategy == "hybrid"
    assert len(response.ranked) == 3
    assert response.source_counts == {"bm25": 3, "embedding": 3}


def test_rank_unknown_strategy() -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy="bm25",
    )
    # Bypass Pydantic literal validation to test the ranker's own guard.
    invalid_request = request.model_copy(update={"strategy": "unknown"})
    with pytest.raises(ValueError, match="Unknown strategy"):
        rank(invalid_request)


def test_rank_respects_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy="bm25",
        max_wall_ms=1,
    )

    def _slow_rank(_self: object, _request: RankRequest) -> object:
        from src.retriever.schema import RankResponse

        return RankResponse(ranked=[], elapsed_ms=1000, strategy="bm25")

    monkeypatch.setattr("src.retriever.ranker.BM25Ranker.rank", _slow_rank)

    with pytest.raises(TimeoutError):
        rank(request)
