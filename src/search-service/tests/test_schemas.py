"""Tests for the new search service schemas."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from search_service.schemas import (
    Budget,
    ExpandRequest,
    Failure,
    Paper,
    PassthroughRequest,
    ProviderCapabilities,
    RankedPaper,
    RankRequest,
    SearchRequest,
    SearchResponse,
)


def test_budget_accepts_zero_and_null():
    b = Budget()
    assert b.usd is None
    assert b.wall_ms is None
    assert b.api_calls is None

    b = Budget(usd=0.05, wall_ms=0, api_calls=0)
    assert b.usd == 0.05
    assert b.wall_ms == 0


def test_search_request_end_date_validation():
    with pytest.raises(ValidationError):
        SearchRequest(query="test", end_date="abc")

    req = SearchRequest(query="test", end_date="2026-06-30")
    assert req.end_date == "2026-06-30"


def test_search_request_defaults():
    req = SearchRequest(query="test")
    assert req.top_k == 20
    assert req.intent is None
    assert req.subqueries == []


def test_rank_request_with_paper_candidates():
    paper = Paper(paper_id="W1", title="Test Paper")
    req = RankRequest(query="test", candidates=[paper], top_k=10)
    assert len(req.candidates) == 1
    assert req.candidates[0].paper_id == "W1"


def test_passthrough_request_native_payload():
    req = PassthroughRequest(raw={"filter": "publication_year:>2020"})
    assert req.raw["filter"] == "publication_year:>2020"
    assert req.normalize is False


def test_expand_request_depth_bound():
    with pytest.raises(ValidationError):
        ExpandRequest(seed_ids=["W1"], depth=3)

    req = ExpandRequest(seed_ids=["W1"], depth=1, fanout=20)
    assert req.depth == 1


def test_ranked_paper_inherits_paper_fields():
    rp = RankedPaper(
        paper_id="W1",
        title="Test",
        score=0.9,
        rank=1,
        tier="highly_relevant",
    )
    assert rp.score == 0.9
    assert rp.rank == 1
    assert rp.title == "Test"


def test_search_response_includes_state():
    response = SearchResponse(
        papers=[],
        cost_usd=0.012,
        elapsed_ms=3180,
    )
    assert response.search_state is not None
    assert response.evidence_state is not None
    assert response.provenance is not None


def test_failure_classification():
    f = Failure(stage="recall", source="openalex", error_type="rate_limit", message="too many requests")
    assert f.error_type == "rate_limit"


def test_provider_capabilities_defaults():
    caps = ProviderCapabilities(name="openalex")
    assert caps.search_keyword is False
    assert caps.name == "openalex"
