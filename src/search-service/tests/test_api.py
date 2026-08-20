"""Integration tests for the FastAPI search endpoints."""

from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def mock_openalex_query():
    return mock.AsyncMock(return_value={
        "results": [
            {
                "id": "https://openalex.org/W123",
                "display_name": "OpenAlex Paper",
                "publication_year": 2024,
                "publication_date": "2024-01-15",
                "doi": "10.1/1",
                "cited_by_count": 42,
                "abstract_inverted_index": {"openalex": [0], "abstract": [1]},
                "authorships": [{"author": {"display_name": "Alice Smith"}}],
            }
        ],
        "meta": {"count": 1},
    })


@pytest.fixture
def mock_arxiv_native():
    return mock.AsyncMock(return_value={
        "feed": {
            "entries": [
                {
                    "title": "ArXiv Paper",
                    "id": "http://arxiv.org/abs/1706.03762",
                    "published": "2017-06-12",
                    "summary": "ArXiv abstract",
                }
            ]
        }
    })


def test_search_forwards_openalex_params(client, mock_openalex_query):
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", mock_openalex_query):
        response = client.post(
            "/search/metadata",
            json={"search": "machine learning", "filter": "publication_year:>2020", "top_k": 10},
        )

    assert response.status_code == 200
    body = response.json()
    assert len(body["papers"]) == 1
    assert body["papers"][0]["paper_id"] == "10.1/1"
    assert body["papers"][0]["title"] == "OpenAlex Paper"

    mock_openalex_query.assert_awaited_once()
    endpoint, params = mock_openalex_query.call_args.args
    assert endpoint == "works"
    assert params["search"] == "machine learning"
    assert params["filter"] == "publication_year:>2020"


def test_search_injects_end_date(client, mock_openalex_query):
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", mock_openalex_query):
        response = client.post(
            "/search",
            json={"search": "test", "end_date": "2026-06-30", "top_k": 5},
        )

    assert response.status_code == 200
    mock_openalex_query.assert_awaited_once()
    _endpoint, params = mock_openalex_query.call_args.args
    assert "to_publication_date:2026-06-30" in params["filter"]


def test_search_truncates_top_k(client, mock_openalex_query):
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", mock_openalex_query):
        response = client.post("/search", json={"search": "test", "top_k": 1})

    assert response.status_code == 200
    body = response.json()
    assert len(body["papers"]) == 1
    assert body["search_state"]["candidate_counts"]["returned"] == 1


def test_search_openalex_disabled(client):
    with mock.patch("search_service.plugin_loader.PluginRegistry.get_plugin", return_value=None):
        response = client.post("/search", json={"search": "test"})

    assert response.status_code == 503
    assert "OpenAlex provider is not enabled" in response.json()["detail"]


def test_provider_openalex_passthrough(client, mock_openalex_query):
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", mock_openalex_query):
        response = client.post(
            "/provider/openalex/query",
            json={"endpoint": "authors", "params": {"search": "alice smith"}},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["count"] == 1

    mock_openalex_query.assert_awaited_once_with("authors", {"search": "alice smith"})


def test_provider_arxiv_passthrough(client, mock_arxiv_native):
    with mock.patch("search_service.plugins.arxiv.ArxivPlugin.search_native", mock_arxiv_native):
        response = client.post(
            "/provider/arxiv/query",
            json={"params": {"search_query": "all:machine learning", "max_results": 5}},
        )

    assert response.status_code == 200
    mock_arxiv_native.assert_awaited_once_with({"search_query": "all:machine learning", "max_results": 5})
