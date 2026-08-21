"""Identity of a work, defined once (D-13).

``canonical_key`` replaced an inline expression inside ``Aggregator._deduplicate``
that nothing outside that method could call and nothing could test. The tests
that matter here are the cross-source ones: the same paper arriving from arXiv and
from OpenAlex must land on one key, or the answer pool records it twice and
Recall@k counts it twice.
"""

from __future__ import annotations

import pytest

from search_service.identifiers import parse_identifier
from search_service.schemas import Paper, canonical_key


def paper(**kwargs) -> Paper:
    return Paper(paper_id=kwargs.pop("paper_id", "x"), title=kwargs.pop("title", "A Paper"), **kwargs)


def test_a_doi_wins_over_the_other_ids():
    key = canonical_key(paper(doi="10.1007/abc", arxiv_id="2101.00001", openalex_id="W1"))
    assert key == "doi:10.1007/abc"


def test_the_arxiv_id_is_used_when_there_is_no_doi():
    assert canonical_key(paper(arxiv_id="2101.00001", openalex_id="W1")) == "arxiv:2101.00001"


def test_versions_of_one_submission_are_one_work():
    assert canonical_key(paper(arxiv_id="2101.00001v3")) == canonical_key(paper(arxiv_id="2101.00001"))


def test_an_arxiv_paper_from_arxiv_and_from_openalex_is_one_work():
    # This is the case that decides whether the answer pool double-counts.
    # OpenAlex records an arXiv preprint's DOI as `10.48550/arxiv.<id>`, arXiv
    # reports the bare id; unnormalized those are two papers.
    from_arxiv = paper(paper_id="1810.09726", arxiv_id="1810.09726")
    from_openalex = paper(
        paper_id="https://doi.org/10.48550/arxiv.1810.09726",
        doi="https://doi.org/10.48550/arxiv.1810.09726",
        openalex_id="W2893040979",
    )
    assert canonical_key(from_arxiv) == canonical_key(from_openalex) == "arxiv:1810.09726"


def test_doi_case_does_not_split_a_work():
    # DOIs are case-insensitive by specification and sources disagree on case.
    assert canonical_key(paper(doi="10.1007/ABC")) == canonical_key(paper(doi="10.1007/abc"))


def test_an_unparseable_identifier_is_kept_verbatim():
    # Better one odd key than collapsing two unrelated records into one.
    assert canonical_key(paper(paper_id="some-internal-handle")) == "some-internal-handle"


def test_a_paper_with_no_identifier_at_all_still_has_a_key():
    assert canonical_key(paper(paper_id="")) == ""


def test_the_key_is_exposed_on_the_model_and_cannot_be_overridden():
    record = Paper(paper_id="x", title="t", arxiv_id="2101.00001", canonical_id="attacker-supplied")
    # Derived, never supplied: a caller that could set it could split one paper
    # into two, or merge two into one.
    assert record.canonical_id == "arxiv:2101.00001"
    assert record.model_dump()["canonical_id"] == "arxiv:2101.00001"


@pytest.mark.parametrize("key", ["arxiv:1810.09726", "doi:10.1007/abc", "openalex:W2893040979"])
def test_a_canonical_key_is_itself_a_usable_identifier(key):
    # The expansion endpoint uses canonical keys as next-hop seeds, so a key that
    # does not parse would be rejected as a bad id by the walk that produced it.
    assert parse_identifier(key) is not None
