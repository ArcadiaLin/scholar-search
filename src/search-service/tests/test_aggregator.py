"""Tests for the search aggregator and cache."""

from typing import Any

import pytest

from search_service.aggregator import _DEFAULT_SOURCES_BY_MODE, SearchAggregator
from search_service.cache import TTLCache
from search_service.exceptions import SourceError
from search_service.models import SearchRequest, SearchResponse, SearchResultItem
from search_service.plugin_loader import SourcePlugin


class MockPlugin(SourcePlugin):
    def __init__(self, name: str, results: list[SearchResultItem], fail_with: Exception | None = None):
        super().__init__({})
        self.name = name
        self._results = results
        self._fail_with = fail_with

    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        if self._fail_with is not None:
            raise self._fail_with
        return self._results[:top_k]


class MockRegistry:
    def __init__(self, plugins: list[SourcePlugin], capabilities: dict[str, Any] | None = None) -> None:
        self._plugins = {p.name: p for p in plugins}
        self._capabilities = capabilities or {}

    def get_enabled_plugins(self, names: list[str] | None = None) -> list[SourcePlugin]:
        plugins = list(self._plugins.values())
        if names is not None:
            plugins = [p for p in plugins if p.name in names]
        return plugins

    def get_provider_capabilities(self, name: str) -> Any | None:
        return self._capabilities.get(name)


@pytest.fixture
def cache():
    return TTLCache[SearchResponse](ttl_seconds=60)


def _item(paper_id: str, title: str, source: str, rank: int, **kwargs) -> SearchResultItem:
    return SearchResultItem(
        paper_id=paper_id,
        title=title,
        source=source,
        source_rank=rank,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_aggregator_combines_sources(cache):
    openalex = MockPlugin(
        "openalex",
        [_item("W1", "Paper One", "openalex", 1, abstract="abstract one", doi="10.1/1")],
    )
    arxiv = MockPlugin(
        "arxiv",
        [_item("arxiv:1", "Paper Two", "arxiv", 1, arxiv_id="1")],
    )
    registry = MockRegistry([openalex, arxiv])
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(SearchRequest(query="test", mode="metadata", top_k=10))

    assert response.total == 2
    assert response.source_counts == {"openalex": 1, "arxiv": 1}
    assert response.errors == []
    assert response.results[0].source == "openalex"
    assert response.results[1].source == "arxiv"


@pytest.mark.asyncio
async def test_aggregator_deduplicates_and_merges(cache):
    openalex = MockPlugin(
        "openalex",
        [
            _item(
                "arxiv:1706.03762",
                "Attention Is All You Need",
                "openalex",
                1,
                abstract="OpenAlex abstract",
                openalex_id="W1",
                doi="10.48550/arXiv.1706.03762",
            )
        ],
    )
    arxiv = MockPlugin(
        "arxiv",
        [
            _item(
                "arxiv:1706.03762",
                "Attention Is All You Need",
                "arxiv",
                1,
                arxiv_id="1706.03762",
                urls={"paper": "https://arxiv.org/abs/1706.03762", "pdf": "https://arxiv.org/pdf/1706.03762.pdf", "html": None},
            )
        ],
    )
    registry = MockRegistry([openalex, arxiv])
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(SearchRequest(query="attention", mode="metadata", top_k=10))

    assert response.total == 1
    merged = response.results[0]
    assert merged.source == "merged"
    assert merged.abstract == "OpenAlex abstract"
    assert merged.openalex_id == "W1"
    assert merged.arxiv_id == "1706.03762"
    assert merged.urls.get("pdf") == "https://arxiv.org/pdf/1706.03762.pdf"


@pytest.mark.asyncio
async def test_aggregator_partial_failure(cache):
    openalex = MockPlugin("openalex", [_item("W1", "Paper One", "openalex", 1)])
    arxiv = MockPlugin("arxiv", [], fail_with=SourceError("arxiv", "rate_limit", "arXiv rate limit"))
    registry = MockRegistry([openalex, arxiv])
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(SearchRequest(query="test", mode="metadata", top_k=10))

    assert response.total == 1
    assert response.source_counts == {"openalex": 1}
    assert len(response.errors) == 1
    assert response.errors[0].source == "arxiv"
    assert response.errors[0].error_type == "rate_limit"


@pytest.mark.asyncio
async def test_aggregator_no_enabled_sources(cache):
    registry = MockRegistry([])
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(SearchRequest(query="test", mode="metadata", top_k=10))

    assert response.total == 0
    assert len(response.errors) == 1
    assert response.errors[0].error_type == "disabled"


@pytest.mark.asyncio
async def test_aggregator_caches_result(cache):
    plugin = MockPlugin("openalex", [_item("W1", "Paper One", "openalex", 1)])
    registry = MockRegistry([plugin])
    aggregator = SearchAggregator(registry, cache)

    request = SearchRequest(query="cache_test", mode="metadata", top_k=10)
    response1 = await aggregator.search(request)
    response2 = await aggregator.search(request)

    assert response1.cached is False
    assert response2.cached is True
    assert response1.results == response2.results


@pytest.mark.asyncio
async def test_aggregator_selects_sources_by_capability_for_metadata(cache):
    """Metadata mode requires search_keyword; sources without it are skipped."""
    openalex = MockPlugin("openalex", [_item("W1", "Paper One", "openalex", 1)])
    # A hypothetical source that cannot do keyword search.
    no_keyword = MockPlugin("no_keyword", [_item("W2", "Paper Two", "no_keyword", 1)])
    caps = {
        "openalex": type("Caps", (), {"search_keyword": True, "text_fulltext": False})(),
        "no_keyword": type("Caps", (), {"search_keyword": False, "text_fulltext": True})(),
    }
    registry = MockRegistry([openalex, no_keyword], capabilities=caps)
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(
        SearchRequest(query="test", mode="metadata", top_k=10, sources=["openalex", "no_keyword"])
    )

    assert response.selected_sources == ["openalex"]
    assert response.total == 1
    assert response.source_counts == {"openalex": 1}
    assert any(e.source == "no_keyword" for e in response.errors)


@pytest.mark.asyncio
async def test_aggregator_selects_sources_by_capability_for_fulltext(cache):
    """Fulltext mode requires text_fulltext; only matching sources are selected."""
    arxiv = MockPlugin("arxiv", [_item("arxiv:1", "Paper One", "arxiv", 1)])
    openalex = MockPlugin("openalex", [_item("W1", "Paper Two", "openalex", 1)])
    caps = {
        "arxiv": type("Caps", (), {"search_keyword": True, "text_fulltext": True})(),
        "openalex": type("Caps", (), {"search_keyword": True, "text_fulltext": False})(),
    }
    registry = MockRegistry([arxiv, openalex], capabilities=caps)
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(
        SearchRequest(query="test", mode="fulltext", top_k=10, sources=["arxiv", "openalex"])
    )

    assert response.selected_sources == ["arxiv"]
    assert response.total == 1
    assert response.source_counts == {"arxiv": 1}


@pytest.mark.asyncio
async def test_aggregator_records_selected_sources(cache):
    """The response must accurately reflect the sources that were selected."""
    openalex = MockPlugin("openalex", [_item("W1", "Paper One", "openalex", 1)])
    arxiv = MockPlugin("arxiv", [_item("arxiv:1", "Paper Two", "arxiv", 1)])
    registry = MockRegistry([openalex, arxiv])
    aggregator = SearchAggregator(registry, cache)

    response = await aggregator.search(SearchRequest(query="test", mode="metadata", top_k=10))

    assert set(response.selected_sources) == {"openalex", "arxiv"}



def test_default_source_map_excludes_serper():
    """Serper is disabled in P0 and must not appear in any default source map."""
    for mode, sources in _DEFAULT_SOURCES_BY_MODE.items():
        assert "serper" not in sources, f"serper must not be in default {mode} sources"
