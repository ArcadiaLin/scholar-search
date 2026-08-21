"""Tool A's output must be a legal input to tool B (F-10).

``/search`` hands out a ``paper_id`` that is a DOI URL whenever OpenAlex answered.
``/paper/{id}`` accepted that form; ``/expand/citations`` handed it straight to
OpenAlex, which rejected it as "not a valid OpenAlex ID" - and the tool text
called the resulting empty walk a direction with no edges. So the test is
literally the pipe: take the id shape one endpoint produces, feed it to the other,
and assert the id never reaches the provider in a form the provider refuses.
"""

from __future__ import annotations

from typing import Any
from unittest import mock

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from search_service.main import app
from search_service.plugins.openalex import OpenAlexPlugin

_DOI_URL = "https://doi.org/10.1007/978-3-642-15555-0_26"
_OPENALEX_API = "https://api.openalex.org"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def plugin():
    return OpenAlexPlugin({
        "enabled": True,
        "base_url": _OPENALEX_API,
        "timeout": 5.0,
        "max_retries": 0,
        "rate_limit_rps": 1000.0,
        "per_page": 5,
    })


def work(work_id: str, doi: str | None = None) -> dict[str, Any]:
    return {
        "id": f"https://openalex.org/{work_id}",
        "display_name": "A Work",
        "publication_year": 2020,
        "publication_date": "2020-01-01",
        "doi": doi or f"https://doi.org/10.1/{work_id}",
    }


@respx.mock
async def test_a_doi_url_seed_reaches_openalex_as_a_resolvable_address(plugin):
    route = respx.get(url__startswith=f"{_OPENALEX_API}/works/").mock(
        return_value=Response(200, json=work("W1", doi=_DOI_URL))
    )

    await plugin.get_references(_DOI_URL, 5)

    path = route.calls[0].request.url.path
    # The failing form was `/works/https://doi.org/...`; `doi:` is what resolves.
    assert path == "/works/doi:10.1007/978-3-642-15555-0_26"
    assert "https://doi.org" not in path


@respx.mock
async def test_a_forward_walk_resolves_a_doi_seed_before_filtering_on_it(plugin):
    # `filter=cites:` only accepts OpenAlex's own ids, so a DOI seed has to be
    # resolved first rather than interpolated into the filter.
    respx.get(url__startswith=f"{_OPENALEX_API}/works/doi:").mock(return_value=Response(200, json=work("W7")))
    works = respx.get(f"{_OPENALEX_API}/works").mock(return_value=Response(200, json={"results": [work("W8")]}))

    await plugin.get_citations(_DOI_URL, 5)

    assert works.calls.last.request.url.params["filter"] == "cites:W7"


@respx.mock
async def test_an_arxiv_id_seed_is_addressed_through_its_registered_doi(plugin):
    route = respx.get(url__startswith=f"{_OPENALEX_API}/works/").mock(return_value=Response(200, json=work("W1")))

    await plugin.get_references("1810.09726", 5)

    assert route.calls[0].request.url.path == "/works/doi:10.48550/arXiv.1810.09726"


def test_expansion_rejects_an_unparseable_seed_as_a_bad_id(client):
    refs = mock.AsyncMock(return_value=[])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["Attention Is All You Need"]})

    # 400, not an empty 200: the input is wrong, and reporting it as an empty graph
    # is what made the agent give up on citation expansion (F-10).
    assert response.status_code == 400
    body = response.json()
    assert body["failures"][0]["error_type"] == "bad_id"
    assert "Accepted forms" in body["detail"]
    assert refs.await_count == 0


def test_a_bad_seed_does_not_stop_the_walk_for_the_good_ones(client):
    refs = mock.AsyncMock(return_value=[work("W2")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": ["not an id", "W1"], "depth": 1})

    assert response.status_code == 200
    body = response.json()
    assert [failure["error_type"] for failure in body["failures"]] == ["bad_id"]
    assert len(body["papers"]) == 1
    # The valid seed was walked, and only it.
    assert refs.await_args_list[0].args[0] == "W1"


def test_a_search_result_id_is_a_legal_expansion_seed(client):
    """The whole contract in one call: ``/search``'s output feeds ``/expand``.

    The id used here is the exact shape ``/search`` returns for an OpenAlex hit,
    and the assertion is that no failure of category ``http`` mentioning an
    invalid OpenAlex ID comes back.
    """
    refs = mock.AsyncMock(return_value=[work("W2")])
    with mock.patch("search_service.plugins.openalex.OpenAlexPlugin.get_references", refs):
        response = client.post("/expand/citations", json={"seed_ids": [_DOI_URL], "depth": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["failures"] == []
    assert refs.await_args_list[0].args[0] == _DOI_URL
