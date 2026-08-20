"""Tests for the arXiv source plugin."""

import httpx
import pytest
import respx
from httpx import Response

from search_service.plugins.arxiv import ArxivPlugin

_ARXIV_ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762</id>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models...</summary>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <link rel="alternate" type="text/html" href="https://arxiv.org/abs/1706.03762"/>
    <link title="pdf" type="application/pdf" href="https://arxiv.org/pdf/1706.03762.pdf"/>
  </entry>
</feed>
"""


@pytest.fixture
def plugin():
    return ArxivPlugin({
        "enabled": True,
        "base_url": "https://export.arxiv.org/api/query",
        "timeout": 5.0,
        "max_retries": 0,
        "rate_limit_rps": 1000.0,
    })


@respx.mock
def test_search_returns_results(plugin):
    route = respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    results = plugin.search_sync("attention is all you need", top_k=5)

    assert route.called
    assert len(results) == 1
    item = results[0]
    assert item.paper_id == "1706.03762"
    assert item.title == "Attention Is All You Need"
    assert item.arxiv_id == "1706.03762"
    assert item.year == 2017
    assert item.abstract.startswith("The dominant sequence")
    assert item.urls["pdf"] == "https://arxiv.org/pdf/1706.03762.pdf"
    assert item.authors == ["Ashish Vaswani", "Noam Shazeer"]


@respx.mock
def test_search_empty_results(plugin):
    empty_atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=empty_atom))

    results = plugin.search_sync("xyznonexistent", top_k=5)
    assert results == []


@respx.mock
def test_search_rate_limit(plugin):
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(503, text="Service Unavailable"))

    from search_service.exceptions import SourceError

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "http"


@respx.mock
def test_search_timeout(plugin):
    respx.get("https://export.arxiv.org/api/query").mock(side_effect=httpx.TimeoutException("Timeout"))

    from search_service.exceptions import SourceError

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "timeout"


@respx.mock
def test_search_parse_error(plugin):
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text="not xml"))

    from search_service.exceptions import SourceError

    with pytest.raises(SourceError) as exc_info:
        plugin.search_sync("query", top_k=5)
    assert exc_info.value.error_type == "parse"
