"""Concurrent operations against one provider must not close each other's client.

Each plugin shares one ``httpx.AsyncClient`` per instance and used to close it in
a ``finally`` after every call. That was deliberate - ``search_sync`` drives each
call from its own ``asyncio.run`` loop, and a client bound to a finished loop
cannot be reused - but it made concurrency unsafe: once subquery fan-out issued
several queries per provider, the first to finish closed the connection under the
others and they failed with "Cannot send a request, as the client has been
closed". These tests pin both properties at once.
"""

from __future__ import annotations

import asyncio

import pytest
import respx
from httpx import Response

from search_service.exceptions import SourceError
from search_service.plugins.arxiv import ArxivPlugin
from search_service.plugins.openalex import OpenAlexPlugin

_ARXIV_ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762</id>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models...</summary>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
  </entry>
</feed>
"""

_OPENALEX_PAGE = {
    "meta": {"count": 1},
    "results": [
        {
            "id": "https://openalex.org/W1",
            "display_name": "A Work",
            "publication_year": 2019,
            "publication_date": "2019-01-01",
        }
    ],
}


@pytest.fixture
def arxiv_plugin():
    return ArxivPlugin(
        {
            "enabled": True,
            "base_url": "https://export.arxiv.org/api/query",
            "timeout": 5.0,
            "max_retries": 0,
            "rate_limit_rps": 1000.0,
        }
    )


@pytest.fixture
def openalex_plugin():
    return OpenAlexPlugin(
        {
            "enabled": True,
            "base_url": "https://api.openalex.org",
            "timeout": 5.0,
            "max_retries": 0,
            "rate_limit_rps": 1000.0,
        }
    )


@respx.mock
async def test_concurrent_arxiv_searches_all_succeed(arxiv_plugin):
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    results = await asyncio.gather(
        arxiv_plugin.search("attention", 5),
        arxiv_plugin.search("self-attention", 5),
        arxiv_plugin.search("transduction", 5),
    )

    assert [len(items) for items in results] == [1, 1, 1]


@respx.mock
async def test_concurrent_openalex_searches_all_succeed(openalex_plugin):
    respx.get(url__startswith="https://api.openalex.org/works").mock(return_value=Response(200, json=_OPENALEX_PAGE))

    results = await asyncio.gather(
        openalex_plugin.search("attention", 5),
        openalex_plugin.search("self-attention", 5),
        openalex_plugin.search("transduction", 5),
    )

    assert [len(items) for items in results] == [1, 1, 1]


@respx.mock
async def test_a_mix_of_operations_can_run_concurrently(openalex_plugin):
    respx.get(url__startswith="https://api.openalex.org/works").mock(return_value=Response(200, json=_OPENALEX_PAGE))

    search, lookup = await asyncio.gather(
        openalex_plugin.search("attention", 5),
        openalex_plugin.lookup("W1"),
    )

    assert len(search) == 1
    assert lookup is not None


@respx.mock
async def test_the_client_is_closed_again_once_the_last_operation_leaves(arxiv_plugin):
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    await asyncio.gather(arxiv_plugin.search("a", 1), arxiv_plugin.search("b", 1))

    # Closing when idle is what lets `search_sync` run each call in a fresh event
    # loop, so the counter must return to zero rather than leak the client open.
    client = arxiv_plugin._client
    assert client._active_sessions == 0
    assert client._client is None or client._client.is_closed


@respx.mock
def test_repeated_search_sync_calls_still_work(arxiv_plugin):
    # Each call gets its own asyncio.run loop. This is the case the per-call close
    # existed for, and it must keep working.
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(200, text=_ARXIV_ATOM))

    first = arxiv_plugin.search_sync("attention", 1)
    second = arxiv_plugin.search_sync("attention", 1)

    assert len(first) == 1
    assert len(second) == 1


@respx.mock
async def test_a_failing_operation_does_not_leave_the_counter_raised(arxiv_plugin):
    respx.get("https://export.arxiv.org/api/query").mock(return_value=Response(500, text="boom"))

    with pytest.raises(SourceError):
        await arxiv_plugin.search("attention", 1)

    # A leaked count would keep the client open forever and break search_sync.
    assert arxiv_plugin._client._active_sessions == 0
