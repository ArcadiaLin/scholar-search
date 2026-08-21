"""Full-text section retrieval.

The honest boundary matters more here than anywhere else in the tool set: this
is retrieval by identifier, not a full-text search index. `query` filters and
ranks the sections of papers the caller names; it never finds new papers. A test
pins that, because a tool that quietly recalled would break the separation
between recall and evidence-checking that the whole trajectory analysis rests on.
"""

from __future__ import annotations

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from search_service.main import app

_AR5IV_PAGE = """
<html><body>
<h1>Introduction</h1>
<p>Diffusion models have become the dominant approach for conformer generation.</p>
<h2>Related Work</h2>
<p>Earlier approaches relied on distance geometry and force fields.</p>
<h2>Method</h2>
<p>We train a score network on torsion angles.</p>
<script>var tracking = "must not appear";</script>
<h2>Experiments</h2>
<p>On GEOM-DRUGS our method improves coverage.</p>
</body></html>
"""


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@respx.mock
def test_it_returns_sections_for_an_arxiv_paper(client):
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(200, text=_AR5IV_PAGE))

    body = client.post("/fulltext", json={"paper_ids": ["2206.01729"]}).json()

    paper = body["papers"][0]
    assert paper["available"] is True
    titles = [section["title"] for section in paper["sections"]]
    assert "Introduction" in titles
    assert "Method" in titles


@respx.mock
def test_script_content_never_becomes_section_text(client):
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(200, text=_AR5IV_PAGE))

    body = client.post("/fulltext", json={"paper_ids": ["2206.01729"]}).json()

    assert "must not appear" not in str(body)


@respx.mock
def test_a_query_filters_and_ranks_sections_without_recalling(client):
    # Only the named paper is fetched, and only its matching sections come back.
    route = respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(
        return_value=Response(200, text=_AR5IV_PAGE)
    )

    body = client.post("/fulltext", json={"paper_ids": ["2206.01729"], "query": "torsion angles score network"}).json()

    assert route.call_count == 1, "one paper named, one fetch: query must not widen the paper set"
    paper = body["papers"][0]
    assert len(paper["sections"]) >= 1
    assert paper["sections"][0]["title"] == "Method"
    assert paper["sections"][0]["match_count"] >= 1


@respx.mock
def test_a_section_filter_selects_by_heading(client):
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(200, text=_AR5IV_PAGE))

    body = client.post("/fulltext", json={"paper_ids": ["2206.01729"], "sections": ["related work"]}).json()

    titles = [section["title"] for section in body["papers"][0]["sections"]]
    assert titles == ["Related Work"]


@respx.mock
def test_a_paper_with_no_rendering_is_a_coverage_fact_not_an_error(client):
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(404))

    body = client.post("/fulltext", json={"paper_ids": ["9999.99999"]}).json()

    paper = body["papers"][0]
    assert paper["available"] is False
    assert "no ar5iv rendering" in paper["reason"]
    assert paper["sections"] == []


def test_a_non_arxiv_id_says_so_rather_than_failing(client):
    body = client.post("/fulltext", json={"paper_ids": ["10.1145/3292500"]}).json()

    paper = body["papers"][0]
    assert paper["available"] is False
    assert "arXiv" in paper["reason"]


@respx.mock
def test_the_paper_count_is_bounded(client):
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(200, text=_AR5IV_PAGE))

    body = client.post("/fulltext", json={"paper_ids": [f"2206.0{i:04d}" for i in range(12)]}).json()

    assert len(body["papers"]) == 5, "max_papers is 5"
    assert "paper_ids" in body["clamped"]


@respx.mock
def test_section_text_is_bounded(client):
    long_page = f"<html><body><h1>Long</h1><p>{'x' * 9000}</p></body></html>"
    respx.get(url__startswith="https://ar5iv.labs.arxiv.org/html/").mock(return_value=Response(200, text=long_page))

    body = client.post("/fulltext", json={"paper_ids": ["2206.01729"]}).json()

    text = body["papers"][0]["sections"][0]["text"]
    assert len(text) <= 2_003
    assert text.endswith("...")
    assert body["effective_limits"]["max_section_chars"] == 2_000
