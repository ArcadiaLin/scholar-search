"""Citation-graph expansion, and above all that its bounds actually bound.

``docs/design.md`` §4 requires depth, fan-out, concurrency and total candidate
count to be bounded by configuration. An unbounded walk is not a slow feature,
it is a different system: it makes the candidate set a function of the graph
rather than of the budget, and the agent can no longer be held to a budget at
all. So most of this file is about the ceilings holding, and about the response
saying when a request was clamped rather than quietly obeying a smaller number.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from search_service.exceptions import SourceError
from search_service.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def work(work_id: str, title: str = "A Work") -> dict[str, Any]:
    """A raw OpenAlex work, which is what the graph methods return."""
    return {
        "id": f"https://openalex.org/{work_id}",
        "display_name": title,
        "publication_year": 2020,
        "publication_date": "2020-01-01",
        "doi": f"10.1/{work_id}",
    }


def test_backward_expansion_returns_reached_papers_and_edges(client):
    refs = mock.AsyncMock(return_value=[work("W2"), work("W3")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "direction": "backward", "depth": 1})

    assert response.status_code == 200
    body = response.json()
    assert {paper["title"] for paper in body["papers"]} == {"A Work"}
    assert len(body["papers"]) == 2
    assert body["direction"] == "backward"
    assert all(edge["edge_type"] == "references" for edge in body["edges"])


def test_forward_expansion_uses_the_citations_capability(client):
    cites = mock.AsyncMock(return_value=[work("W9")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_citations", cites):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "direction": "forward", "depth": 1})

    assert response.status_code == 200
    assert cites.await_count == 1
    assert all(edge["edge_type"] == "cites" for edge in response.json()["edges"])


def test_depth_beyond_the_ceiling_is_clamped_and_reported(client):
    refs = mock.AsyncMock(return_value=[work("W2")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 99})

    body = response.json()
    # Configured ceiling is 2. Silently walking 2 when 99 was asked would make a
    # bounded result look like an exhausted graph.
    assert body["effective_limits"]["depth"] == 2
    assert "depth" in body["clamped"]


def test_fanout_beyond_the_ceiling_is_clamped_and_passed_to_the_provider(client):
    refs = mock.AsyncMock(return_value=[work("W2")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 1, "fanout": 10_000})

    body = response.json()
    assert body["effective_limits"]["fanout"] == 25
    assert "fanout" in body["clamped"]
    # The clamp has to reach the provider, not just the response: a ceiling the
    # provider never hears about does not bound anything.
    assert refs.await_args.args[1] == 25


def test_a_request_within_the_ceiling_is_obeyed(client):
    refs = mock.AsyncMock(return_value=[work("W2")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 1, "fanout": 3})

    body = response.json()
    assert body["effective_limits"]["fanout"] == 3
    assert body["clamped"] == []
    assert refs.await_args.args[1] == 3


def test_too_many_seeds_are_clamped(client):
    refs = mock.AsyncMock(return_value=[])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post(
            "/expand/citations",
            json={"seed_ids": [f"W{i}" for i in range(50)], "depth": 1},
        )

    body = response.json()
    assert "seed_ids" in body["clamped"]
    assert refs.await_count == 10, "max_seeds is 10, so only 10 seeds may be expanded"


def test_the_total_candidate_ceiling_stops_the_walk(client):
    # One seed returning far more than the total ceiling: the walk must stop at
    # the ceiling rather than return everything the provider offered.
    many = [work(f"W{i}") for i in range(1_000)]
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", mock.AsyncMock(return_value=many)):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 1})

    body = response.json()
    assert len(body["papers"]) <= 200
    assert "max_total_candidates" in body["clamped"]


def test_concurrency_never_exceeds_the_configured_ceiling(client):
    peak = 0
    live = 0
    lock = asyncio.Lock()

    async def _slow(_self, _paper_id, _limit=20):
        nonlocal peak, live
        async with lock:
            live += 1
            peak = max(peak, live)
        await asyncio.sleep(0.02)
        async with lock:
            live -= 1
        return [work("W2")]

    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", _slow):
        response = client.post(
            "/expand/citations",
            json={"seed_ids": [f"W{i}" for i in range(10)], "depth": 1},
        )

    assert response.status_code == 200
    assert peak <= 4, f"max_concurrency is 4, saw {peak} simultaneous provider calls"


def test_duplicates_across_seeds_are_merged(client):
    # Two seeds both citing the same work: one paper, two edges.
    with mock.patch(
        "search_service.plugins.openalex.OpenAlexPlugin.get_references",
        mock.AsyncMock(return_value=[work("Wshared")]),
    ):
        response = client.post("/expand/citations", json={"seed_ids": ["W1", "W2"], "depth": 1})

    body = response.json()
    assert len(body["papers"]) == 1
    assert len(body["edges"]) == 2


def test_a_failing_provider_is_classified_not_swallowed(client):
    failing = mock.AsyncMock(side_effect=SourceError("openalex", "rate_limit", "OpenAlex rate limit exceeded"))
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", failing):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 1})

    body = response.json()
    assert response.status_code == 200, "a failed expansion is an answer with failures, not a 5xx"
    assert body["papers"] == []
    assert body["failures"][0]["error_type"] == "rate_limit"
    assert "W1" in body["failures"][0]["message"], "the failure has to name the seed"


def test_a_provider_that_lies_about_the_capability_is_reported(client):
    with mock.patch(
        "search_service.plugins.openalex.OpenAlexPlugin.get_references",
        mock.AsyncMock(side_effect=NotImplementedError("not implemented")),
    ):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"], "depth": 1})

    assert any("advertises graph_references" in f["message"] for f in response.json()["failures"])


def test_no_capable_provider_is_a_501_pointing_at_the_capability_table(client):
    with mock.patch("search_service.plugin_loader.PluginRegistry.list_plugins", return_value=[]):
        response = client.post("/expand/citations", json={"seed_ids": ["W1"]})

    assert response.status_code == 501
    assert "graph_references" in response.json()["detail"]


def test_empty_seeds_are_rejected(client):
    response = client.post("/expand/citations", json={"seed_ids": ["   "]})
    assert response.status_code == 400
