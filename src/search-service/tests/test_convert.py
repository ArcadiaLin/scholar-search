"""Tests for Paper <-> PaperCandidate conversion."""

from __future__ import annotations

from search_service.features.convert import candidate_to_paper, paper_to_candidate
from search_service.rank.schema import PaperCandidate
from search_service.schemas.paper import Author, Paper


def test_paper_to_candidate():
    paper = Paper(
        paper_id="arxiv:1706.03762",
        title="Attention Is All You Need",
        abstract="Transformer architecture.",
        arxiv_id="1706.03762",
        doi="10.48550/arXiv.1706.03762",
        external_ids={"s2_corpus_id": "12345"},
    )
    candidate = paper_to_candidate(paper)
    assert candidate.paper_id == "arxiv:1706.03762"
    assert candidate.arxiv_id == "1706.03762"
    assert candidate.doi == "10.48550/arXiv.1706.03762"
    assert candidate.s2_corpus_id == "12345"


def test_candidate_to_paper():
    candidate = PaperCandidate(
        paper_id="W1",
        title="Test",
        abstract="Abstract",
        arxiv_id="1706.03762",
        doi="10.1/1",
        s2_corpus_id="999",
    )
    paper = candidate_to_paper(candidate)
    assert paper.paper_id == "W1"
    assert paper.doi == "10.1/1"
    assert paper.external_ids.get("s2_corpus_id") == "999"


def test_authors_to_strings():
    from search_service.features.convert import authors_to_strings

    authors = [Author(name="Alice Smith"), Author(name="Bob Jones")]
    assert authors_to_strings(authors) == ["Alice Smith", "Bob Jones"]
    assert authors_to_strings(None) is None
