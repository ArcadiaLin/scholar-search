"""Regression tests for the arXiv query builder (F-1).

arXiv expands whitespace inside ``all:`` into **OR**, so ``all:a b c`` means "any
one of a, b, c". Every multi-word topical query the service sent was therefore a
word-bag query, silently: twenty plausible-looking papers came back and the right
ones were not among them (``docs/develop/backlog.md`` §1, measured 0/4 on
``AutoScholarQuery_train_1``).

Two levels of test, because the bug lived in the gap between them:

- offline, on ``build_search_query``, which is what the request is built from;
- live (``-m network``), on arXiv's own echo of the *parsed* query in the feed's
  first ``<title>``. That echo is the only authority on how arXiv read the query,
  and reading it is what found the bug in the first place.
"""

from __future__ import annotations

import re

import httpx
import pytest
import respx
from httpx import Response

from search_service.plugins.arxiv import ArxivPlugin, build_search_query

_ARXIV_API = "https://export.arxiv.org/api/query"
_EMPTY_FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'


@pytest.fixture
def plugin():
    return ArxivPlugin({
        "enabled": True,
        "base_url": _ARXIV_API,
        "timeout": 5.0,
        "max_retries": 0,
        "rate_limit_rps": 1000.0,
    })


def test_terms_are_conjoined():
    assert build_search_query("reinforced active learning image segmentation") == (
        "all:reinforced AND all:active AND all:learning AND all:image AND all:segmentation"
    )


def test_a_single_term_needs_no_operator():
    assert build_search_query("superpixel") == "all:superpixel"


def test_a_quoted_span_stays_one_phrase():
    assert build_search_query('"active learning" "semantic segmentation" superpixel') == (
        'all:"active learning" AND all:"semantic segmentation" AND all:superpixel'
    )


def test_sentence_punctuation_is_not_part_of_the_word():
    # An agent told to state what it wants writes a sentence; `segmentation?` and
    # `segmentation` are not the same term to a word index.
    assert build_search_query("superpixels, for semantic segmentation?") == (
        "all:superpixels AND all:for AND all:semantic AND all:segmentation"
    )


def test_a_field_prefixed_term_is_passed_through():
    assert build_search_query('ti:"ViewAL" cat:cs.CV') == 'ti:"ViewAL" AND cat:cs.CV'


def test_an_explicit_operator_is_not_doubled():
    assert build_search_query("superpixel OR patches") == "all:superpixel OR all:patches"


def test_a_query_with_no_usable_term_falls_back_to_the_old_shape():
    # Nothing to conjoin, so the caller's string goes out as it did before. Better
    # a query arXiv rejects than a silently empty one.
    assert build_search_query('""') == 'all:""'


@respx.mock
def test_the_request_carries_the_conjoined_query(plugin):
    route = respx.get(_ARXIV_API).mock(return_value=Response(200, text=_EMPTY_FEED))

    plugin.search_sync("active learning semantic segmentation", top_k=5)

    sent = route.calls.last.request.url.params["search_query"]
    assert sent == "all:active AND all:learning AND all:semantic AND all:segmentation"
    assert " OR " not in sent


@respx.mock
def test_native_params_override_the_builder(plugin):
    # Passthrough exists so a caller can write arXiv's syntax itself; the builder
    # must not overwrite it.
    route = respx.get(_ARXIV_API).mock(return_value=Response(200, text=_EMPTY_FEED))

    plugin.search_sync("ignored", top_k=5, native_params={"search_query": "au:Vaswani"})

    assert route.calls.last.request.url.params["search_query"] == "au:Vaswani"


def test_native_query_for_reports_what_search_will_send(plugin):
    # The trajectory records this string, so it has to come from the same builder
    # the request comes from - the divergence is what let F-1 hide.
    assert plugin.native_query_for("active learning superpixel") == "all:active AND all:learning AND all:superpixel"


@pytest.mark.network
def test_arxiv_does_not_parse_the_issued_query_as_or():
    """arXiv echoes the *parsed* query in the feed's first ``<title>``.

    This is the assertion ``backlog.md`` F-1 asks for, and it is the only one that
    can fail if arXiv changes how it parses ``all:``. It needs the live API, so it
    is opt-in.
    """
    query = build_search_query("reinforced active learning image segmentation")
    response = httpx.get(_ARXIV_API, params={"search_query": query, "max_results": 1}, timeout=30.0)
    response.raise_for_status()
    echoed = re.search(r"<title>(.*?)</title>", response.text, re.DOTALL)
    assert echoed is not None, "arXiv did not echo the parsed query"
    assert " OR " not in echoed.group(1)
