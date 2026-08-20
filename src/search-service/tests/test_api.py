"""Integration tests for the FastAPI search endpoints."""

from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.main import app
from search_service.models import SearchResultItem


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def mock_openalex_search():
    return mock.AsyncMock(return_value=[
        SearchResultItem(
            paper_id="10.1/1",
            title="OpenAlex Paper",
            source="openalex",
            source_rank=1,
            doi="10.1/1",
            authors=["Alice Smith"],
            abstract="OpenAlex abstract",
            published="2024-01-15",
            year=2024,
        ),
    ])


@pytest.fixture
def mock_arxiv_search():
    return mock.AsyncMock(return_value=[
        SearchResultItem(
            paper_id="1706.03762",
            title="Attention Is All You Need",
            source="arxiv",
            source_rank=1,
            arxiv_id="1706.03762",
            authors=["Ashish Vaswani"],
            abstract="arXiv abstract",
            published="2017-06-12",
            year=2017,
        ),
    ])


def test_search_aggregates_multiple_sources(client, mock_openalex_search, mock_arxiv_search):
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock_openalex_search),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock_arxiv_search),
    ):
        response = client.post("/search", json={"query": "machine learning", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert len(body["papers"]) == 2
    assert set(body["search_state"]["selected_sources"]) == {"openalex", "arxiv"}
    assert set(body["search_state"]["candidate_counts"].keys()) == {"recalled", "returned"}
    assert body["search_state"]["candidate_counts"]["recalled"] == 2


def test_search_deduplicates_by_stable_id(client):
    shared_doi = "10.2/duplicate"
    openalex_item = SearchResultItem(
        paper_id=shared_doi,
        title="OpenAlex Version",
        source="openalex",
        source_rank=1,
        doi=shared_doi,
        abstract="OpenAlex abstract",
        published="2023-01-01",
        year=2023,
    )
    arxiv_item = SearchResultItem(
        paper_id=shared_doi,
        title="arXiv Version",
        source="arxiv",
        source_rank=2,
        doi=shared_doi,
        abstract="arXiv abstract",
        published="2023-01-01",
        year=2023,
    )

    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock.AsyncMock(return_value=[openalex_item])),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock.AsyncMock(return_value=[arxiv_item])),
    ):
        response = client.post("/search", json={"query": "duplicate", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert len(body["papers"]) == 1
    assert body["papers"][0]["sources"] == ["openalex", "arxiv"]
    assert body["provenance"]["per_paper_sources"][shared_doi] == ["openalex", "arxiv"]


def test_search_forwards_provider_params(client, mock_openalex_search, mock_arxiv_search):
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock_openalex_search),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock_arxiv_search),
    ):
        response = client.post(
            "/search",
            json={
                "query": "machine learning",
                "top_k": 10,
                "provider_params": {
                    "openalex": {"filter": "publication_year:>2020"},
                    "arxiv": {"search_query": "ti:machine learning", "max_results": 5},
                },
            },
        )

    assert response.status_code == 200
    mock_openalex_search.assert_awaited_once()
    assert mock_openalex_search.call_args.kwargs["native_params"] == {"filter": "publication_year:>2020"}
    assert mock_arxiv_search.call_args.kwargs["native_params"] == {"search_query": "ti:machine learning", "max_results": 5}


def test_search_records_failure_when_one_provider_fails(client, mock_openalex_search):
    failing_arxiv = mock.AsyncMock(side_effect=Exception("arXiv down"))
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock_openalex_search),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", failing_arxiv),
    ):
        response = client.post("/search", json={"query": "machine learning", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert len(body["papers"]) == 1
    assert len(body["search_state"]["failures"]) == 1
    assert body["search_state"]["failures"][0]["source"] == "arxiv"


def test_search_returns_502_when_all_providers_fail(client):
    failing = mock.AsyncMock(side_effect=Exception("down"))
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", failing),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", failing),
    ):
        response = client.post("/search", json={"query": "machine learning", "top_k": 10})

    assert response.status_code == 502
    assert "All providers failed" in response.json()["detail"]


def test_search_no_enabled_providers(client):
    with mock.patch("search_service.plugin_loader.PluginRegistry.get_enabled_plugins", return_value=[]):
        response = client.post("/search", json={"query": "machine learning", "top_k": 10})

    assert response.status_code == 502
    assert "No enabled providers" in response.json()["detail"]


def test_provider_openalex_passthrough(client):
    mock_query = mock.AsyncMock(return_value={"results": [], "meta": {"count": 0}})
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", mock_query):
        response = client.post(
            "/provider/openalex/query",
            json={"endpoint": "authors", "params": {"search": "alice smith"}},
        )

    assert response.status_code == 200
    mock_query.assert_awaited_once_with("authors", {"search": "alice smith"})


def test_provider_arxiv_passthrough(client):
    mock_native = mock.AsyncMock(return_value={"results": []})
    with mock.patch("search_service.plugins.arxiv.ArxivPlugin.search_native", mock_native):
        response = client.post(
            "/provider/arxiv/query",
            json={"params": {"search_query": "all:machine learning", "max_results": 5}},
        )

    assert response.status_code == 200
    mock_native.assert_awaited_once_with({"search_query": "all:machine learning", "max_results": 5})
