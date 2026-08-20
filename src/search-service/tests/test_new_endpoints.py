"""Tests for the new Phase 1 endpoints."""

from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.main import app
from search_service.schemas import Paper


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_list_providers(client):
    response = client.get("/providers")
    assert response.status_code == 200
    body = response.json()
    names = {p["name"] for p in body}
    assert "openalex" in names
    assert "arxiv" in names
    assert "serper" in names

    openalex = next(p for p in body if p["name"] == "openalex")
    assert openalex["enabled"] is True
    assert openalex["capabilities"]["search_keyword"] is True
    assert openalex["capabilities"]["graph_references"] is True

    serper = next(p for p in body if p["name"] == "serper")
    assert serper["enabled"] is False


def test_provider_passthrough_openalex(client):
    mock_native = mock.AsyncMock(return_value={"results": [{"id": "W1"}], "meta": {"count": 1}})
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search_native", mock_native):
        response = client.post(
            "/provider/openalex/query",
            json={"raw": {"filter": "publication_year:>2020"}},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["results"][0]["id"] == "W1"
    mock_native.assert_awaited_once()


def test_rank_endpoint(client):
    candidates = [
        Paper(paper_id="W1", title="Attention Is All You Need", abstract="Transformers"),
        Paper(paper_id="W2", title="BERT Pretraining", abstract="Bidirectional encoders"),
    ]
    response = client.post(
        "/rank",
        json={
            "query": "transformer architecture",
            "candidates": [c.model_dump() for c in candidates],
            "strategy": "bm25",
            "top_k": 2,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["ranked"]) == 2
    assert body["ranked"][0]["rank"] == 1
    assert body["provenance"]["ranker_version"] == "search_service.rank"


def test_rank_endpoint_persists_paper_fields(client):
    candidates = [
        Paper(
            paper_id="W1",
            title="Attention Is All You Need",
            abstract="Transformers",
            doi="10.1/1",
            arxiv_id="1706.03762",
        ),
    ]
    response = client.post(
        "/rank",
        json={"query": "transformer", "candidates": [c.model_dump() for c in candidates], "strategy": "bm25"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ranked"][0]["doi"] == "10.1/1"
    assert body["ranked"][0]["arxiv_id"] == "1706.03762"


def test_expand_placeholder(client):
    response = client.post(
        "/expand",
        json={"seed_ids": ["W1"], "direction": "both", "depth": 1, "fanout": 20},
    )
    assert response.status_code == 501
    assert "not yet implemented" in response.json()["detail"]


def test_facet_placeholder(client):
    response = client.get("/facet?query=machine+learning")
    assert response.status_code == 501
    assert response.json()["query"] == "machine learning"


def test_paper_detail_placeholder(client):
    response = client.get("/paper/W123")
    assert response.status_code == 501
    assert response.json()["paper_id"] == "W123"


def test_budget_endpoint(client):
    response = client.get("/budget?trace_id=ep_001")
    assert response.status_code == 200
    body = response.json()
    assert body["trace_id"] == "ep_001"
    assert body["spent"]["api_calls"] == 0
