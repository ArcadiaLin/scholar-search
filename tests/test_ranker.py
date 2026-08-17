"""Tests for the unified ranker entry point."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.retriever.ranker import rank
from src.retriever.schema import PaperCandidate, RankRequest


def _load_fixture() -> dict:
    return json.loads(Path("tests/fixtures/candidates.json").read_text())


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


@pytest.mark.parametrize("strategy", ["embedding", "hybrid"])
def test_rank_unsupported_strategy(strategy: str) -> None:
    payload = _load_fixture()
    request = RankRequest(
        query=payload["query"],
        candidates=[PaperCandidate.model_validate(c) for c in payload["candidates"]],
        strategy=strategy,  # type: ignore[arg-type]
    )
    with pytest.raises(ValueError, match="not implemented yet"):
        rank(request)


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
