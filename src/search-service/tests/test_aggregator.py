"""Unit tests for the multi-source aggregator."""

from __future__ import annotations

from typing import Any
from unittest import mock

import pytest

from search_service.aggregator import AggregationError, Aggregator
from search_service.models import SearchResultItem
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import ProviderCapabilities


class FakeProvider(SearchProvider):
    """Test-only provider that returns a fixed result list."""

    def __init__(self, name: str, results: list[SearchResultItem], fail_with: Exception | None = None):
        super().__init__({"enabled": True})
        self.name = name
        self._results = results
        self._fail_with = fail_with

    def _build_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            name=self.name,
            search_keyword=True,
            search_native_query=True,
            search_field_filter=False,
            facet_group_by=False,
            id_lookup=False,
            id_mapping=False,
            graph_references=False,
            graph_citations=False,
            recommend_related=False,
            metrics_raw_citations=False,
            metrics_normalized=False,
            text_abstract=True,
            text_fulltext=False,
        )

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        if self._fail_with is not None:
            raise self._fail_with
        return self._results[:top_k]


def make_item(paper_id: str, source: str, rank: int, **kwargs: Any) -> SearchResultItem:
    return SearchResultItem(
        paper_id=paper_id,
        title=f"Paper {paper_id}",
        source=source,
        source_rank=rank,
        **kwargs,
    )


@pytest.fixture
def registry():
    return mock.Mock(spec=PluginRegistry)


async def test_aggregate_combines_sources(registry):
    provider_a = FakeProvider("a", [make_item("W1", "a", 1), make_item("W2", "a", 2)])
    provider_b = FakeProvider("b", [make_item("W3", "b", 1)])
    registry.get_enabled_plugins.return_value = [provider_a, provider_b]

    aggregator = Aggregator(registry)
    papers, state, _provenance, _elapsed = await aggregator.aggregate(
        query="test", top_k=10, end_date=None, sources=None, timeout_ms=5000, provider_params=None
    )

    assert len(papers) == 3
    assert state.candidate_counts.recalled == 3
    assert state.candidate_counts.returned == 3
    assert set(state.selected_sources) == {"a", "b"}
    assert not state.failures


async def test_aggregate_deduplicates_and_rrf_ranks(registry):
    provider_a = FakeProvider("a", [make_item("shared", "a", 1, doi="10.1/shared")])
    provider_b = FakeProvider("b", [make_item("shared", "b", 2, doi="10.1/shared")])
    registry.get_enabled_plugins.return_value = [provider_a, provider_b]

    aggregator = Aggregator(registry)
    papers, _state, provenance, _elapsed = await aggregator.aggregate(
        query="test", top_k=10, end_date=None, sources=None, timeout_ms=5000, provider_params=None
    )

    assert len(papers) == 1
    assert papers[0].score == pytest.approx(1.0 / 61 + 1.0 / 62)
    assert papers[0].rank == 1
    assert papers[0].sources == ["a", "b"]
    assert provenance.per_paper_sources["shared"] == ["a", "b"]


async def test_aggregate_respects_top_k(registry):
    provider_a = FakeProvider("a", [make_item(f"W{i}", "a", i) for i in range(1, 6)])
    provider_b = FakeProvider("b", [])
    registry.get_enabled_plugins.return_value = [provider_a, provider_b]

    aggregator = Aggregator(registry)
    papers, state, _provenance, _elapsed = await aggregator.aggregate(
        query="test", top_k=3, end_date=None, sources=None, timeout_ms=5000, provider_params=None
    )

    assert len(papers) == 3
    assert state.candidate_counts.returned == 3


async def test_aggregate_records_partial_failure(registry):
    provider_a = FakeProvider("a", [make_item("W1", "a", 1)])
    provider_b = FakeProvider("b", [], fail_with=RuntimeError("b failed"))
    registry.get_enabled_plugins.return_value = [provider_a, provider_b]

    aggregator = Aggregator(registry)
    papers, state, _provenance, _elapsed = await aggregator.aggregate(
        query="test", top_k=10, end_date=None, sources=None, timeout_ms=5000, provider_params=None
    )

    assert len(papers) == 1
    assert len(state.failures) == 1
    assert state.failures[0].source == "b"


async def test_aggregate_raises_when_all_fail(registry):
    provider_a = FakeProvider("a", [], fail_with=RuntimeError("a failed"))
    provider_b = FakeProvider("b", [], fail_with=RuntimeError("b failed"))
    registry.get_enabled_plugins.return_value = [provider_a, provider_b]

    aggregator = Aggregator(registry)
    with pytest.raises(AggregationError, match="All providers failed"):
        await aggregator.aggregate(
            query="test", top_k=10, end_date=None, sources=None, timeout_ms=5000, provider_params=None
        )


async def test_aggregate_raises_when_no_keyword_providers(registry):
    provider_a = FakeProvider("a", [])
    provider_a.capabilities.search_keyword = False
    registry.get_enabled_plugins.return_value = [provider_a]

    aggregator = Aggregator(registry)
    with pytest.raises(AggregationError, match="No enabled providers"):
        await aggregator.aggregate(
            query="test", top_k=10, end_date=None, sources=None, timeout_ms=5000, provider_params=None
        )


async def test_aggregate_passes_native_params(registry):
    provider_a = FakeProvider("a", [make_item("W1", "a", 1)])
    registry.get_enabled_plugins.return_value = [provider_a]

    mock_search = mock.AsyncMock(return_value=[make_item("W1", "a", 1)])
    with mock.patch.object(provider_a, "search", mock_search):
        aggregator = Aggregator(registry)
        await aggregator.aggregate(
            query="test",
            top_k=10,
            end_date=None,
            sources=None,
            timeout_ms=5000,
            provider_params={"a": {"filter": "year:2024"}},
        )

    mock_search.assert_awaited_once()
    assert mock_search.call_args.kwargs["native_params"] == {"filter": "year:2024"}
