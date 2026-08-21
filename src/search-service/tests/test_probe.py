"""Facet probing, rank-only scoring, and budget reporting.

The property worth a test of its own is that **rank issues no provider call**.
If ranking could recall, "the agent ranked" and "the agent searched again" would
stop being distinguishable in the trajectory, and the rank-only tool in $T^M$
would be a second search path wearing a different name.
"""

from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.exceptions import SourceError
from search_service.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def candidate(paper_id: str, title: str, abstract: str = "", citation_count: int | None = None) -> dict:
    return {
        "paper_id": paper_id,
        "title": title,
        "abstract": abstract,
        "citation_count": citation_count,
        "sources": ["openalex"],
    }


class TestFacet:
    def test_it_returns_the_provider_group_counts(self, client):
        payload = {"group_by": [{"key": "2021", "count": 12}, {"key": "2022", "count": 30}]}
        with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.facet", mock.AsyncMock(return_value=payload)):
            response = client.post("/facet", json={"query": "graph neural networks", "group_by": ["publication_year"]})

        assert response.status_code == 200
        body = response.json()
        assert body["source"] == "openalex"
        assert body["groups"]["publication_year"] == payload["group_by"]

    def test_group_by_is_bounded(self, client):
        facet = mock.AsyncMock(return_value={"group_by": []})
        with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.facet", facet):
            client.post("/facet", json={"query": "q", "group_by": ["a", "b", "c", "d", "e"]})

        # max_group_by is 3: each grouping field costs the provider work, so the
        # ceiling has to reach the provider call.
        assert len(facet.await_args.args[1]) == 3

    def test_no_capable_provider_is_a_501(self, client):
        with mock.patch("search_service.plugin_loader.PluginRegistry.list_plugins", return_value=[]):
            response = client.post("/facet", json={"query": "q", "group_by": ["publication_year"]})

        assert response.status_code == 501
        assert "facet_group_by" in response.json()["detail"]

    def test_a_provider_failure_is_classified(self, client):
        failing = mock.AsyncMock(side_effect=SourceError("openalex", "timeout", "timed out"))
        with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.facet", failing):
            response = client.post("/facet", json={"query": "q", "group_by": ["publication_year"]})

        assert response.status_code == 502
        assert response.json()["failures"][0]["error_type"] == "timeout"


class TestRank:
    def test_it_issues_no_provider_call(self, client):
        # The whole point of a rank-only stage. Every provider entry point is
        # patched to explode; ranking must still succeed.
        boom = mock.AsyncMock(side_effect=AssertionError("rank must not call a provider"))
        with (
            mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", boom),
            mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", boom),
            mock.patch("search_service.plugins.openalex.OpenAlexPlugin.query", boom),
            mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", boom),
        ):
            response = client.post(
                "/rank",
                json={"query": "graph neural network", "candidates": [candidate("W1", "Graph Neural Network Survey")]},
            )

        assert response.status_code == 200
        assert response.json()["provider_calls"] == 0
        boom.assert_not_awaited()

    def test_a_title_match_outranks_an_abstract_match(self, client):
        response = client.post(
            "/rank",
            json={
                "query": "conformer generation diffusion",
                "candidates": [
                    candidate("W1", "Unrelated work", "mentions conformer generation diffusion in passing"),
                    candidate("W2", "Diffusion for conformer generation"),
                ],
            },
        )

        papers = response.json()["papers"]
        assert papers[0]["paper_id"] == "W2"
        assert papers[0]["rank"] == 1

    def test_citations_cannot_outrank_relevance(self, client):
        # A highly cited but off-topic classic must not take the top slot; that
        # failure mode is called out in prototype.md's risk list.
        response = client.post(
            "/rank",
            json={
                "query": "conformer generation diffusion",
                "candidates": [
                    candidate("classic", "Attention Is All You Need", "", citation_count=100_000),
                    candidate("ontopic", "Diffusion for conformer generation"),
                ],
            },
        )

        assert response.json()["papers"][0]["paper_id"] == "ontopic"

    def test_top_k_is_honoured(self, client):
        response = client.post(
            "/rank",
            json={
                "query": "q",
                "candidates": [candidate(f"W{i}", f"Paper {i} q") for i in range(10)],
                "top_k": 3,
            },
        )

        body = response.json()
        assert len(body["papers"]) == 3
        assert body["scored"] == 10, "scored counts what was ranked, not what was returned"

    def test_unparseable_candidates_are_counted_not_dropped_silently(self, client):
        response = client.post(
            "/rank",
            json={"query": "q", "candidates": [candidate("W1", "Paper q"), {"not": "a paper"}]},
        )

        body = response.json()
        assert body["scored"] == 1
        assert body["skipped"] == 1

    def test_candidates_are_bounded(self, client):
        response = client.post(
            "/rank",
            json={"query": "q", "candidates": [candidate(f"W{i}", f"Paper {i} q") for i in range(600)]},
        )

        assert response.json()["scored"] == 500


class TestBudget:
    def test_it_reports_the_effective_limits(self, client):
        body = client.get("/budget").json()

        assert body["limits"]["expand"]["max_depth"] == 2
        assert body["limits"]["expand"]["max_concurrency"] == 4
        assert body["limits"]["rank"]["max_candidates"] == 500

    def test_it_reports_per_provider_quotas(self, client):
        body = client.get("/budget").json()

        assert body["quotas"]["openalex"]["enabled"] is True
        assert body["quotas"]["openalex"]["cost_model"]["works_search"]["daily_quota"] == 1000
        assert body["quotas"]["serper"]["enabled"] is False

    def test_it_labels_its_scope_honestly(self, client):
        # Process-scoped, not episode-scoped: the Evidence Store that would carry
        # per-episode accounting does not exist yet, and implying otherwise would
        # make a long-lived service look like one expensive search.
        assert client.get("/budget").json()["scope"] == "process"

    def test_spending_is_counted(self, client):
        before = client.get("/budget").json()["spent"].get("facet", 0)
        with mock.patch(
            "search_service.plugins.openalex.OpenAlexPlugin.facet", mock.AsyncMock(return_value={"group_by": []})
        ):
            client.post("/facet", json={"query": "q", "group_by": ["publication_year"]})

        assert client.get("/budget").json()["spent"]["facet"] == before + 1
