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


_EMPTY_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>
"""


@respx.mock
async def test_lookup_uses_id_list_rather_than_a_keyword_search(plugin):
    # arXiv's `id_list` is exact; `search_query` would return fuzzy matches, so a
    # lookup that used it could answer with the wrong paper.
    route = respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    record = await plugin.lookup("1706.03762")

    assert route.called
    assert route.calls.last.request.url.params["id_list"] == "1706.03762"
    assert "search_query" not in route.calls.last.request.url.params
    assert record is not None
    assert record["paper_id"] == "1706.03762"
    assert record["arxiv_id"] == "1706.03762"


@respx.mock
async def test_lookup_strips_a_version_suffix_and_an_arxiv_prefix(plugin):
    route = respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    await plugin.lookup("arXiv:1706.03762v5")

    assert route.calls.last.request.url.params["id_list"] == "1706.03762"


@respx.mock
async def test_lookup_returns_none_for_an_unknown_id(plugin):
    # An empty feed is arXiv's "no such ID", and it must not become an exception:
    # the caller distinguishes "not here" from "lookup broke".
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_EMPTY_FEED))

    assert await plugin.lookup("9999.99999") is None


async def test_lookup_returns_none_for_a_blank_id(plugin):
    # No request should be issued at all for an ID that cannot identify anything.
    with respx.mock:
        route = respx.get("https://export.arxiv.org/api/query")
        assert await plugin.lookup("   ") is None
        assert not route.called
