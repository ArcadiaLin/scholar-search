"""Tests for provider capability tables exposed by the runtime registry."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from search_service.main import app
from search_service.plugins.arxiv import ArxivPlugin
from search_service.plugins.openalex import OpenAlexPlugin
from search_service.schemas import ProviderCapabilities


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_openalex_plugin_capabilities():
    """OpenAlex advertises the expected metadata-centric capabilities."""
    plugin = OpenAlexPlugin({"enabled": True})
    caps = plugin.capabilities

    assert caps.name == "openalex"
    assert caps.search_keyword is True
    assert caps.search_native_query is True
    assert caps.graph_references is True
    assert caps.graph_citations is True
    assert caps.text_abstract is True
    assert caps.text_fulltext is False
    assert caps.metrics_raw_citations is True
    assert caps.metrics_normalized is True


def test_arxiv_plugin_capabilities():
    """arXiv advertises supplementary capabilities, including full text."""
    plugin = ArxivPlugin({"enabled": True})
    caps = plugin.capabilities

    assert caps.name == "arxiv"
    assert caps.search_keyword is True
    assert caps.text_fulltext is True
    assert caps.text_abstract is True
    assert caps.graph_references is False
    assert caps.graph_citations is False
    assert caps.metrics_raw_citations is False


def test_providers_endpoint_returns_cost_model_and_reliability(client):
    """The /providers endpoint must surface nested cost_model and reliability."""
    response = client.get("/providers")
    assert response.status_code == 200
    body = response.json()

    openalex = next(p for p in body if p["name"] == "openalex")
    assert "works_search" in openalex["cost_model"]
    assert "burst_policy" in openalex["cost_model"]["works_search"]
    assert openalex["cost_model"]["works_search"]["usd_per_call"] == 0.001
    assert openalex["reliability"]["retry_policy"] == "exponential"
    assert "timeout" in openalex["reliability"]["error_taxonomy"]


def test_providers_endpoint_disabled_serper_is_marked_disabled(client):
    """A disabled provider still appears but advertises enabled=false."""
    response = client.get("/providers")
    assert response.status_code == 200
    body = response.json()

    serper = next(p for p in body if p["name"] == "serper")
    assert serper["enabled"] is False
    # Disabled providers expose their configured capability table; the enabled
    # flag is what prevents them from being selected by the pipeline.
    assert "search_keyword" in serper["capabilities"]


def test_provider_capabilities_are_pydantic_model():
    """Capability tables must be valid Pydantic models."""
    caps = ProviderCapabilities(
        name="test",
        search_keyword=True,
        text_fulltext=True,
        cost_model={
            "search": {"usd_per_call": 0.001, "daily_quota": 1000, "rate_limit_rps": 10.0},
        },
        reliability={"p50_latency_ms": 500, "max_retries": 3},
    )

    dumped = caps.model_dump()
    assert dumped["search_keyword"] is True
    assert dumped["cost_model"]["search"]["burst_policy"]["max_burst"] == 1
    assert dumped["reliability"]["retry_policy"] == "exponential"
