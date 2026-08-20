"""Tests for the search service schemas."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from search_service.schemas import (
    Failure,
    PassthroughRequest,
    ProviderCapabilities,
    RankedPaper,
    SearchRequest,
    SearchResponse,
)


def test_search_request_accepts_openalex_params():
    req = SearchRequest(
        search="machine learning",
        filter="publication_year:>2020",
        sort="cited_by_count:desc",
        per_page=50,
        page=1,
        end_date="2026-06-30",
        top_k=10,
    )
    assert req.search == "machine learning"
    assert req.filter == "publication_year:>2020"
    assert req.per_page == 50
    assert req.top_k == 10


def test_search_request_end_date_validation():
    with pytest.raises(ValidationError):
        SearchRequest(end_date="abc")

    req = SearchRequest(end_date="2026-06-30")
    assert req.end_date == "2026-06-30"


def test_search_request_defaults():
    req = SearchRequest()
    assert req.top_k == 20
    assert req.search is None
    assert req.filter is None


def test_passthrough_request_endpoint_and_params():
    req = PassthroughRequest(endpoint="works", params={"filter": "publication_year:>2020"})
    assert req.endpoint == "works"
    assert req.params["filter"] == "publication_year:>2020"


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
    assert response.provenance is not None


def test_failure_classification():
    f = Failure(stage="recall", source="openalex", error_type="rate_limit", message="too many requests")
    assert f.error_type == "rate_limit"


def test_provider_capabilities_defaults():
    caps = ProviderCapabilities(name="openalex")
    assert caps.search_keyword is False
    assert caps.name == "openalex"
