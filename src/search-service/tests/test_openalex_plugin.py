"""Tests for the OpenAlex source plugin."""

import httpx
import pytest
import respx
from httpx import Response

from search_service.plugins.openalex import OpenAlexPlugin


@pytest.fixture
def plugin():
    return OpenAlexPlugin({
        "enabled": True,
        "base_url": "https://api.openalex.org",
        "timeout": 5.0,
        "max_retries": 0,
        "per_page": 10,
        "rate_limit_rps": 1000.0,
    })


@respx.mock
def test_search_returns_results(plugin):
    route = respx.get("https://api.openalex.org/works").mock(
        return_value=Response(
            200,
            json={
                "meta": {"count": 1},
                "results": [
                    {
                        "id": "https://openalex.org/W123456789",
                        "display_name": "Attention Is All You Need",
                        "publication_year": 2017,
                        "publication_date": "2017-06-12",
                        "doi": "10.48550/arXiv.1706.03762",
                        "ids": {"arxiv": "1706.03762"},
                        "authorships": [{"author": {"display_name": "Ashish Vaswani"}}],
                        "abstract_inverted_index": {"Attention": [0], "mechanisms": [1]},
                        "primary_location": {
                        "landing_page_url": "https://arxiv.org/abs/1706.03762",
                        "source": {"display_name": "arXiv"},
                    },
                        "open_access": {"oa_url": "https://arxiv.org/pdf/1706.03762.pdf"},
                    }
                ],
            },
        )
    )

    results = plugin.search_sync("attention is all you need", top_k=5)

    assert route.called
    assert len(results) == 1
    item = results[0]
    assert item.paper_id == "10.48550/arXiv.1706.03762"
    assert item.title == "Attention Is All You Need"
    assert item.openalex_id == "W123456789"
    assert item.arxiv_id == "1706.03762"
    assert item.year == 2017
    assert item.abstract == "Attention mechanisms"
    assert item.urls["pdf"] == "https://arxiv.org/pdf/1706.03762.pdf"
    assert item.venue == "arXiv"


@respx.mock
def test_search_empty_results(plugin):
    respx.get("https://api.openalex.org/works").mock(
        return_value=Response(200, json={"meta": {"count": 0}, "results": []})
    )

    results = plugin.search_sync("xyznonexistent", top_k=5)
    assert results == []


@respx.mock
def test_search_rate_limit(plugin):
    respx.get("https://api.openalex.org/works").mock(return_value=Response(429, text="Too Many Requests"))

    from search_service.exceptions import SourceError

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "rate_limit"


@respx.mock
def test_search_timeout(plugin):
    respx.get("https://api.openalex.org/works").mock(side_effect=httpx.TimeoutException("Timeout"))

    from search_service.exceptions import SourceError

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "timeout"


@respx.mock
def test_search_merges_end_date_with_native_filter(plugin):
    route = respx.get("https://api.openalex.org/works").mock(
        return_value=Response(200, json={"meta": {"count": 0}, "results": []})
    )

    plugin.search_sync(
        "machine learning",
        top_k=5,
        end_date="2024-12-31",
        native_params={"filter": "publication_year:>2020"},
    )

    assert route.called
    request = route.calls.last.request
    filter_param = request.url.params["filter"]
    assert "publication_year:>2020" in filter_param
    assert "to_publication_date:2024-12-31" in filter_param
