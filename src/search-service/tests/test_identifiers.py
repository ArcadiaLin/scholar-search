"""Tests for the shared identifier parser.

The contract under test is the one F-10 broke: a ``paper_id`` that ``/search``
hands out must address the same work everywhere it is accepted. So these tests
are mostly about *forms that came out of another endpoint*, not about pretty ids.
"""

from __future__ import annotations

import pytest

from search_service.identifiers import openalex_address, parse_identifier, strip_arxiv_version


@pytest.mark.parametrize(
    ("raw", "kind", "value"),
    [
        ("W2741809807", "openalex", "W2741809807"),
        ("https://openalex.org/W2741809807", "openalex", "W2741809807"),
        ("w2741809807", "openalex", "W2741809807"),
        ("10.1007/978-3-642-15555-0_26", "doi", "10.1007/978-3-642-15555-0_26"),
        ("doi:10.1007/978-3-642-15555-0_26", "doi", "10.1007/978-3-642-15555-0_26"),
        # The shape OpenAlex puts in `Paper.doi`, and therefore the shape
        # `/search` hands out as `paper_id` for an OpenAlex hit.
        ("https://doi.org/10.1007/978-3-642-15555-0_26", "doi", "10.1007/978-3-642-15555-0_26"),
        ("http://dx.doi.org/10.1007/978-3-642-15555-0_26", "doi", "10.1007/978-3-642-15555-0_26"),
        ("1810.09726", "arxiv", "1810.09726"),
        ("arXiv:1706.03762v5", "arxiv", "1706.03762v5"),
        ("https://arxiv.org/abs/1911.11789", "arxiv", "1911.11789"),
        ("https://arxiv.org/pdf/1911.11789.pdf", "arxiv", "1911.11789"),
        ("cs/0701001", "arxiv", "cs/0701001"),
        # An arXiv DOI is both a DOI and an arXiv id; the arXiv reading is the
        # more specific one, and the only one arXiv itself can resolve.
        ("10.48550/arXiv.1810.09726", "arxiv", "1810.09726"),
    ],
)
def test_parse_identifier_recognises_the_forms_the_endpoints_hand_out(raw, kind, value):
    identifier = parse_identifier(raw)
    assert identifier is not None
    assert (identifier.kind, identifier.value) == (kind, value)
    assert identifier.raw == raw


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "Attention Is All You Need", "10.1007", "W", "not/an/id", "2101.1"],
)
def test_parse_identifier_returns_none_rather_than_guessing(raw):
    # `None` is what lets a caller report a bad input as a bad input instead of
    # sending it upstream and calling the 400 an absent paper (F-10).
    assert parse_identifier(raw) is None


@pytest.mark.parametrize(
    ("raw", "address"),
    [
        ("https://openalex.org/W2741809807", "W2741809807"),
        # Measured against the live API: `doi:<doi>` resolves as a singleton
        # lookup, while `works/https://doi.org/...` is rejected outright.
        ("https://doi.org/10.1007/978-3-642-15555-0_26", "doi:10.1007/978-3-642-15555-0_26"),
        ("1810.09726", "doi:10.48550/arXiv.1810.09726"),
        # The DOI is registered per submission, not per version.
        ("arXiv:1706.03762v5", "doi:10.48550/arXiv.1706.03762"),
    ],
)
def test_openalex_address_uses_forms_openalex_resolves(raw, address):
    identifier = parse_identifier(raw)
    assert identifier is not None
    assert openalex_address(identifier) == address


def test_strip_arxiv_version():
    assert strip_arxiv_version("1706.03762v5") == "1706.03762"
    assert strip_arxiv_version("1706.03762") == "1706.03762"
