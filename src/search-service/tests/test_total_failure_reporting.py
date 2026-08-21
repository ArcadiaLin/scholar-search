"""When every provider fails, the reason must survive (F-2).

The classified ``Failure`` list was built and then dropped on exactly one path:
total failure. So the caller got ``"All providers failed."`` and could not tell a
quota exhausted until tomorrow from a query with no matches from a broken source -
three situations with three different next moves. It retried blindly instead
(``docs/develop/backlog.md`` F-2).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from search_service.aggregator import Aggregator
from search_service.exceptions import SourceError
from search_service.main import app
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import ProviderCapabilities


class _FailingProvider(SearchProvider):
    def __init__(self, name: str, error: SourceError) -> None:
        self.name = name
        self._error = error
        super().__init__({"enabled": True})

    def _build_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(name=self.name, search_keyword=True)

    async def search(self, query, top_k, **kwargs):
        raise self._error


class _Registry(PluginRegistry):
    def __init__(self, plugins: list[SearchProvider], all_plugins: list[SearchProvider] | None = None) -> None:
        self._plugins = plugins
        self._all = all_plugins if all_plugins is not None else plugins

    def get_enabled_plugins(self, sources=None):
        if sources is None:
            return list(self._all)
        return [plugin for plugin in self._all if plugin.name in sources]


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


async def test_aggregation_error_carries_the_classified_failures():
    provider = _FailingProvider("openalex", SourceError("openalex", "rate_limit", "OpenAlex rate limit exceeded"))
    aggregator = Aggregator(_Registry([provider]))

    from search_service.aggregator import AggregationError

    with pytest.raises(AggregationError) as exc_info:
        await aggregator.aggregate(
            query="anything",
            top_k=5,
            end_date=None,
            sources=None,
            timeout_ms=5_000,
            provider_params=None,
        )

    failures = exc_info.value.failures
    assert [failure.error_type for failure in failures] == ["rate_limit"]
    assert failures[0].source == "openalex"


async def test_alternative_sources_lists_only_what_was_not_tried():
    failing = _FailingProvider("openalex", SourceError("openalex", "rate_limit", "quota gone"))
    spare = _FailingProvider("arxiv", SourceError("arxiv", "http", "unused"))
    aggregator = Aggregator(_Registry([failing], all_plugins=[failing, spare]))

    from search_service.aggregator import AggregationError

    with pytest.raises(AggregationError) as exc_info:
        await aggregator.aggregate(
            query="anything",
            top_k=5,
            end_date=None,
            sources=["openalex"],
            timeout_ms=5_000,
            provider_params=None,
        )

    # This is the half the old unconditional "another source may still be able to
    # answer" got wrong: the answer depends on the registry, not on the wording.
    assert exc_info.value.alternative_sources == ["arxiv"]


async def test_alternative_sources_is_empty_when_every_source_was_tried():
    failing = _FailingProvider("openalex", SourceError("openalex", "rate_limit", "quota gone"))
    aggregator = Aggregator(_Registry([failing]))

    from search_service.aggregator import AggregationError

    with pytest.raises(AggregationError) as exc_info:
        await aggregator.aggregate(
            query="anything",
            top_k=5,
            end_date=None,
            sources=None,
            timeout_ms=5_000,
            provider_params=None,
        )

    assert exc_info.value.alternative_sources == []


def test_the_endpoint_forwards_failures_on_a_502(client, monkeypatch):
    from search_service.aggregator import AggregationError
    from search_service.schemas import Failure

    async def _fail(*args, **kwargs):
        raise AggregationError(
            "All providers failed.",
            failures=[Failure(stage="recall", source="openalex", error_type="rate_limit", message="quota gone")],
            alternative_sources=["arxiv"],
        )

    monkeypatch.setattr(app.state.aggregator, "aggregate", _fail)
    response = client.post("/search/metadata", json={"query": "anything"})

    assert response.status_code == 502
    body = response.json()
    assert body["detail"] == "All providers failed."
    assert body["failures"][0]["error_type"] == "rate_limit"
    assert body["alternative_sources"] == ["arxiv"]
