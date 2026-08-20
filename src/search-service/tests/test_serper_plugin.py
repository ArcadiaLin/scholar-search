"""Tests for the Serper source plugin."""

import httpx
import pytest
import respx
from httpx import Response

from search_service.exceptions import SourceError
from search_service.plugins.serper import SerperPlugin


@pytest.fixture
def plugin():
    return SerperPlugin({
        "enabled": True,
        "api_key": "test-key",
        "base_url": "https://google.serper.dev",
        "timeout": 5.0,
        "max_retries": 0,
        "rate_limit_rps": 1000.0,
    })


@respx.mock
def test_search_returns_results(plugin):
    route = respx.post("https://google.serper.dev/search").mock(
        return_value=Response(
            200,
            json={
                "organic": [
                    {
                        "title": "Attention Is All You Need",
                        "link": "https://arxiv.org/abs/1706.03762",
                        "snippet": "We propose a new simple network architecture...",
                    },
                    {
                        "title": "Attention Is All You Need PDF",
                        "link": "https://arxiv.org/pdf/1706.03762.pdf",
                        "snippet": "PDF version",
                    },
                ]
            },
        )
    )

    results = plugin.search_sync("attention is all you need", top_k=5)

    assert route.called
    assert len(results) == 2
    item = results[0]
    assert item.paper_id == "arxiv:1706.03762"
    assert item.title == "Attention Is All You Need"
    assert item.arxiv_id == "1706.03762"
    assert item.urls["html"] == "https://arxiv.org/abs/1706.03762"

    pdf_item = results[1]
    assert pdf_item.urls["pdf"] == "https://arxiv.org/pdf/1706.03762.pdf"


@respx.mock
def test_search_doi_extraction(plugin):
    respx.post("https://google.serper.dev/search").mock(
        return_value=Response(
            200,
            json={
                "organic": [
                    {
                        "title": "Some Paper",
                        "link": "https://doi.org/10.1000/182",
                        "snippet": "DOI link",
                    }
                ]
            },
        )
    )

    results = plugin.search_sync("some paper", top_k=5)
    assert len(results) == 1
    assert results[0].paper_id == "10.1000/182"
    assert results[0].doi == "10.1000/182"


@respx.mock
def test_search_empty_results(plugin):
    respx.post("https://google.serper.dev/search").mock(return_value=Response(200, json={"organic": []}))

    results = plugin.search_sync("xyznonexistent", top_k=5)
    assert results == []


@respx.mock
def test_search_auth_error(plugin):
    respx.post("https://google.serper.dev/search").mock(return_value=Response(401, text="Unauthorized"))

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "auth"


@respx.mock
def test_search_rate_limit(plugin):
    respx.post("https://google.serper.dev/search").mock(return_value=Response(429, text="Too Many Requests"))

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "rate_limit"


@respx.mock
def test_search_timeout(plugin):
    respx.post("https://google.serper.dev/search").mock(side_effect=httpx.TimeoutException("Timeout"))

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "timeout"


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    with pytest.raises(SourceError) as exc_info:
        SerperPlugin({"enabled": True, "api_key": ""})
    assert exc_info.value.error_type == "auth"
