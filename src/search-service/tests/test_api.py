"""Integration tests for the FastAPI search endpoints."""

from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.main import app
from search_service.models import SearchResultItem


def _item(paper_id: str, title: str, source: str, rank: int = 1, **kwargs) -> SearchResultItem:
    return SearchResultItem(
        paper_id=paper_id,
        title=title,
        source=source,
        source_rank=rank,
        **kwargs,
    )


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def mock_openalex():
    return mock.AsyncMock(return_value=[
        _item(
            "W123",
            "OpenAlex Paper",
            "openalex",
            1,
            abstract="OpenAlex abstract",
            doi="10.1/1",
        )
    ])


@pytest.fixture
def mock_arxiv():
    return mock.AsyncMock(return_value=[
        _item(
            "arxiv:1",
            "ArXiv Paper",
            "arxiv",
            1,
            arxiv_id="1",
            urls={"paper": "https://arxiv.org/abs/1", "pdf": "https://arxiv.org/pdf/1.pdf", "html": None},
        )
    ])


@pytest.fixture
def mock_serper():
    return mock.AsyncMock(return_value=[
        _item(
            "serper:1",
            "Serper PDF",
            "serper",
            1,
            urls={"paper": "https://example.com/1.pdf", "pdf": "https://example.com/1.pdf", "html": None},
        )
    ])


def test_search_metadata(client, mock_openalex, mock_arxiv):
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock_openalex),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock_arxiv),
    ):
        response = client.post("/search/metadata", json={"query": "test", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "test"
    assert body["mode"] == "metadata"
    assert body["total"] == 2
    assert body["source_counts"] == {"openalex": 1, "arxiv": 1}
    assert body["errors"] == []


def test_search_fulltext(client, mock_arxiv, mock_serper):
    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock_arxiv),
        mock.patch("search_service.plugins.serper.SerperPlugin.search", mock_serper),
    ):
        response = client.post("/search/fulltext", json={"query": "test", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "fulltext"
    assert body["total"] == 2


def test_search_generic(client, mock_openalex, mock_arxiv):
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock_openalex),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock_arxiv),
    ):
        response = client.post("/search", json={"query": "test", "mode": "metadata", "top_k": 10})

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "metadata"


def test_search_all_sources_fail(client):
    failing = mock.AsyncMock(side_effect=Exception("boom"))
    with (
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", failing),
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", failing),
    ):
        response = client.post("/search/metadata", json={"query": "test", "top_k": 10})

    assert response.status_code == 503
    body = response.json()
    assert body["total"] == 0
    assert len(body["errors"]) == 2
