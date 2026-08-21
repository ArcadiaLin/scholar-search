"""Integration tests for ``GET /paper/{paper_id}``.

The endpoint is the read side of the ID space ``/search`` hands out: a paper_id
that came back from a search must resolve without the caller knowing which
provider produced it. Routing is by the ``id_lookup`` capability, so these tests
pin the routing order, the failure accounting, and the two ways of not finding a
paper - nobody can look it up, versus nobody has it.
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


def arxiv_record(paper_id: str = "1706.03762") -> dict:
    return {
        "paper_id": paper_id,
        "title": "Attention Is All You Need",
        "source": "arxiv",
        "source_rank": 1,
        "arxiv_id": paper_id,
        "abstract": "The dominant sequence transduction models...",
        "published": "2017-06-12",
        "year": 2017,
        "authors": ["Ashish Vaswani"],
    }


def openalex_record(paper_id: str = "10.1/x") -> dict:
    return {
        "paper_id": paper_id,
        "title": "An OpenAlex Work",
        "source": "openalex",
        "source_rank": 1,
        "doi": paper_id,
        "year": 2020,
    }


def test_an_arxiv_id_is_resolved_by_arxiv_first(client):
    arxiv_lookup = mock.AsyncMock(return_value=arxiv_record())
    openalex_lookup = mock.AsyncMock(return_value=openalex_record())

    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.lookup", arxiv_lookup),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", openalex_lookup),
    ):
        response = client.get("/paper/1706.03762")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "arxiv"
    assert body["paper"]["title"] == "Attention Is All You Need"
    assert body["paper"]["arxiv_id"] == "1706.03762"
    assert body["tried_sources"] == ["arxiv"]
    # The shape said arXiv, so OpenAlex must not have been paid for at all.
    openalex_lookup.assert_not_awaited()


def test_a_doi_is_resolved_by_openalex_first(client):
    arxiv_lookup = mock.AsyncMock(return_value=arxiv_record())
    openalex_lookup = mock.AsyncMock(return_value=openalex_record("10.1145/3292500"))

    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.lookup", arxiv_lookup),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", openalex_lookup),
    ):
        response = client.get("/paper/10.1145/3292500")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "openalex"
    assert body["paper"]["doi"] == "10.1145/3292500"
    arxiv_lookup.assert_not_awaited()


def test_it_falls_through_to_the_next_provider_and_reports_the_first_failure(client):
    failing_arxiv = mock.AsyncMock(side_effect=SourceError("arxiv", "timeout", "arXiv timed out"))
    openalex_lookup = mock.AsyncMock(return_value=openalex_record("1706.03762"))

    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.lookup", failing_arxiv),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", openalex_lookup),
    ):
        response = client.get("/paper/1706.03762")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "openalex"
    assert body["tried_sources"] == ["arxiv", "openalex"]
    # "arXiv timed out but OpenAlex had it" is a different fact about the record
    # than "OpenAlex had it", so the failure travels with the answer.
    assert len(body["failures"]) == 1
    assert body["failures"][0]["error_type"] == "timeout"
    assert body["failures"][0]["source"] == "arxiv"


def test_a_provider_that_lies_about_id_lookup_is_reported_not_hidden(client):
    # The base class raises NotImplementedError for an unimplemented operation.
    # If that were swallowed the paper would simply look absent, which sends the
    # caller looking for a missing paper instead of a broken capability table.
    with (
        mock.patch(
            "search_service.plugins.arxiv.ArxivPlugin.lookup",
            mock.AsyncMock(side_effect=NotImplementedError("arxiv does not implement lookup()")),
        ),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", mock.AsyncMock(return_value=None)),
    ):
        response = client.get("/paper/1706.03762")

    assert response.status_code == 404
    body = response.json()
    assert body["tried_sources"] == ["arxiv", "openalex"]
    assert any("advertises id_lookup" in failure["message"] for failure in body["failures"])


def test_an_unknown_id_is_a_404_that_says_where_it_looked(client):
    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.lookup", mock.AsyncMock(return_value=None)),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", mock.AsyncMock(return_value=None)),
    ):
        response = client.get("/paper/9999.99999")

    assert response.status_code == 404
    body = response.json()
    assert "9999.99999" in body["detail"]
    assert set(body["tried_sources"]) == {"arxiv", "openalex"}
    assert body["failures"] == []


def test_no_capable_provider_is_a_501_pointing_at_the_capability_table(client):
    # Not a 404: "nobody can look anything up" and "nobody has this paper" call
    # for different actions from the caller.
    with mock.patch("search_service.plugin_loader.PluginRegistry.list_plugins", return_value=[]):
        response = client.get("/paper/1706.03762")

    assert response.status_code == 501
    assert "id_lookup" in response.json()["detail"]
    assert "/providers" in response.json()["detail"]


def test_an_unrecognised_id_shape_still_tries_every_capable_provider(client):
    arxiv_lookup = mock.AsyncMock(return_value=None)
    openalex_lookup = mock.AsyncMock(return_value=openalex_record("CorpusID:12345"))

    with (
        mock.patch("search_service.plugins.arxiv.ArxivPlugin.lookup", arxiv_lookup),
        mock.patch("search_service.plugins.openalex.OpenAlexPlugin.lookup", openalex_lookup),
    ):
        response = client.get("/paper/CorpusID:12345")

    assert response.status_code == 200
    assert len(response.json()["tried_sources"]) == 2
