"""Subquery fan-out in the aggregator.

The agent decomposes a research question into subqueries and the service
executes them; these tests pin the part the service owns: every (provider,
query) pair is one recall list, all of them are fused into one ranking, and the
fan-out is bounded and accounted for.
"""

from __future__ import annotations

from typing import Any
from unittest import mock

import pytest
from pydantic import ValidationError

from search_service.aggregator import Aggregator
from search_service.models import SearchResultItem
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import ProviderCapabilities, SearchRequest


class RecordingProvider(SearchProvider):
    """Provider that records every query it was asked and answers per query."""

    def __init__(self, name: str, results_by_query: dict[str, list[SearchResultItem]]):
        super().__init__({"enabled": True})
        self.name = name
        self._results_by_query = results_by_query
        self.queries: list[str] = []

    def _build_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(name=self.name, search_keyword=True)

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        filters: dict[str, Any] | None = None,
        subqueries: list[str] | None = None,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        self.queries.append(query)
        return self._results_by_query.get(query, [])[:top_k]


def item(paper_id: str, source: str, rank: int, **kwargs: Any) -> SearchResultItem:
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


async def test_each_subquery_is_issued_to_every_provider(registry):
    provider = RecordingProvider("a", {"main": [item("W1", "a", 1)], "sub": [item("W2", "a", 1)]})
    registry.get_enabled_plugins.return_value = [provider]

    _papers, state, _provenance, _elapsed = await Aggregator(registry).aggregate(
        query="main",
        top_k=10,
        end_date=None,
        sources=None,
        timeout_ms=5000,
        provider_params=None,
        subqueries=["sub"],
    )

    assert provider.queries == ["main", "sub"]
    assert [(q.provider, q.query) for q in state.issued_queries] == [("a", "main"), ("a", "sub")]
    # The decomposition is part of what the search did, so it belongs in the state.
    assert state.filters["subqueries"] == ["sub"]


async def test_a_paper_found_by_two_subqueries_outranks_one_found_once(registry):
    # `once` sits at rank 1 of a single list; `twice` sits at rank 2 of two
    # lists. Fusing must prefer agreement across decompositions.
    provider = RecordingProvider(
        "a",
        {
            "main": [item("once", "a", 1, doi="10.1/once"), item("twice", "a", 2, doi="10.1/twice")],
            "sub": [item("other", "a", 1, doi="10.1/other"), item("twice", "a", 2, doi="10.1/twice")],
        },
    )
    registry.get_enabled_plugins.return_value = [provider]

    papers, _state, _provenance, _elapsed = await Aggregator(registry).aggregate(
        query="main",
        top_k=10,
        end_date=None,
        sources=None,
        timeout_ms=5000,
        provider_params=None,
        subqueries=["sub"],
    )

    by_id = {paper.paper_id: paper for paper in papers}
    assert by_id["twice"].score == pytest.approx(1.0 / 62 + 1.0 / 62)
    assert by_id["once"].score == pytest.approx(1.0 / 61)
    assert papers[0].paper_id == "twice"
    assert papers[0].rank == 1


async def test_a_repeated_query_is_not_paid_for_twice(registry):
    provider = RecordingProvider("a", {"main": [item("W1", "a", 1)]})
    registry.get_enabled_plugins.return_value = [provider]

    _papers, state, _provenance, _elapsed = await Aggregator(registry).aggregate(
        query="main",
        top_k=10,
        end_date=None,
        sources=None,
        timeout_ms=5000,
        provider_params=None,
        subqueries=["main"],
    )

    assert provider.queries == ["main"], "the main query must not be issued again as a subquery"
    assert len(state.issued_queries) == 1


async def test_no_subqueries_behaves_exactly_as_before(registry):
    provider = RecordingProvider("a", {"main": [item("W1", "a", 1)]})
    registry.get_enabled_plugins.return_value = [provider]

    _papers, state, _provenance, _elapsed = await Aggregator(registry).aggregate(
        query="main",
        top_k=10,
        end_date=None,
        sources=None,
        timeout_ms=5000,
        provider_params=None,
        subqueries=None,
    )

    assert provider.queries == ["main"]
    assert "subqueries" not in state.filters


async def test_one_failing_subquery_does_not_lose_the_others(registry):
    class PartlyFailingProvider(RecordingProvider):
        async def search(self, query: str, top_k: int, **kwargs: Any) -> list[SearchResultItem]:
            self.queries.append(query)
            if query == "bad":
                raise RuntimeError("provider rejected this decomposition")
            return self._results_by_query.get(query, [])[:top_k]

    provider = PartlyFailingProvider("a", {"main": [item("W1", "a", 1)]})
    registry.get_enabled_plugins.return_value = [provider]

    papers, state, _provenance, _elapsed = await Aggregator(registry).aggregate(
        query="main",
        top_k=10,
        end_date=None,
        sources=None,
        timeout_ms=5000,
        provider_params=None,
        subqueries=["bad"],
    )

    assert len(papers) == 1
    assert len(state.failures) == 1
    # The failure has to name the decomposition, otherwise "a subquery failed"
    # is unactionable when several were issued.
    assert "'bad'" in state.failures[0].message
    assert state.failures[0].source == "a"


def test_the_request_schema_bounds_the_fan_out():
    with pytest.raises(ValidationError):
        SearchRequest(query="q", subqueries=[f"s{i}" for i in range(9)])

    assert SearchRequest(query="q", subqueries=[f"s{i}" for i in range(8)]).subqueries is not None


def test_blank_subqueries_are_dropped_rather_than_issued():
    request = SearchRequest(query="q", subqueries=["  ", "real", ""])
    assert request.subqueries == ["real"]

    assert SearchRequest(query="q", subqueries=["   "]).subqueries is None
