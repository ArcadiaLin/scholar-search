"""Tests for the BM25 local re-ranker."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.retriever.bm25 import BM25Ranker
from src.retriever.schema import PaperCandidate, RankRequest


@pytest.fixture
def ranker() -> BM25Ranker:
    return BM25Ranker()


@pytest.fixture
def candidates() -> list[PaperCandidate]:
    payload = json.loads(Path("tests/fixtures/candidates.json").read_text())
    return [PaperCandidate.model_validate(c) for c in payload["candidates"]]


@pytest.fixture
def query() -> str:
    payload = json.loads(Path("tests/fixtures/candidates.json").read_text())
    return payload["query"]


def test_bm25_ranks_transformer_papers_first(ranker: BM25Ranker, query: str, candidates: list[PaperCandidate]) -> None:
    request = RankRequest(query=query, candidates=candidates, strategy="bm25")
    response = ranker.rank(request)

    assert len(response.ranked) == 3
    assert response.ranked[0].paper_id in {"p1", "p2"}
    assert response.ranked[0].score > response.ranked[-1].score
    assert response.strategy == "bm25"
    assert response.elapsed_ms >= 0
    assert response.cost_usd == 0.0


def test_bm25_top_k(ranker: BM25Ranker, query: str, candidates: list[PaperCandidate]) -> None:
    request = RankRequest(query=query, candidates=candidates, strategy="bm25", top_k=2)
    response = ranker.rank(request)

    assert len(response.ranked) == 2
    assert response.ranked[0].rank == 1
    assert response.ranked[1].rank == 2


def test_bm25_irrelevant_paper_is_lowest(ranker: BM25Ranker, query: str, candidates: list[PaperCandidate]) -> None:
    request = RankRequest(query=query, candidates=candidates, strategy="bm25")
    response = ranker.rank(request)

    last = response.ranked[-1]
    assert last.paper_id == "p3"
    assert last.tier == "not_relevant"


def test_bm25_empty_candidates(ranker: BM25Ranker) -> None:
    request = RankRequest(query="transformer", candidates=[], strategy="bm25")
    response = ranker.rank(request)

    assert response.ranked == []
    assert response.source_counts == {"bm25": 0}


def test_bm25_all_stopwords_query(ranker: BM25Ranker, candidates: list[PaperCandidate]) -> None:
    request = RankRequest(query="the and of", candidates=candidates, strategy="bm25")
    response = ranker.rank(request)

    assert len(response.ranked) == 3
    for paper in response.ranked:
        assert paper.score == pytest.approx(0.0)
        assert paper.tier == "not_relevant"
