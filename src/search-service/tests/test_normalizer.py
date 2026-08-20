"""Tests for SearchResultItem to Paper normalization and merging."""

from __future__ import annotations

from search_service.models import SearchResultItem
from search_service.schemas import Author, Paper, merge_papers, search_result_item_to_paper


def test_search_result_item_to_paper_maps_fields():
    item = SearchResultItem(
        paper_id="10.1/1",
        title="Test Paper",
        authors=["Alice Smith", "Bob Jones"],
        abstract="An abstract",
        venue="ICML",
        published="2024-01-01",
        year=2024,
        doi="10.1/1",
        arxiv_id="2401.00001",
        openalex_id="W123",
        urls={"paper": "https://example.com", "pdf": "https://example.com/pdf"},
        source="openalex",
        source_rank=1,
        raw={"id": "W123"},
    )

    paper = search_result_item_to_paper(item)
    assert paper.paper_id == "10.1/1"
    assert paper.title == "Test Paper"
    assert paper.authors == [Author(name="Alice Smith"), Author(name="Bob Jones")]
    assert paper.venue == "ICML"
    assert paper.doi == "10.1/1"
    assert paper.arxiv_id == "2401.00001"
    assert paper.openalex_id == "W123"
    assert paper.urls == {"paper": "https://example.com", "pdf": "https://example.com/pdf"}
    assert paper.sources == ["openalex"]


def test_merge_papers_prefers_source_preference():
    openalex = Paper(
        paper_id="10.1/1",
        title="OpenAlex Title",
        abstract="OpenAlex abstract",
        venue="OpenAlex Venue",
        sources=["openalex"],
    )
    arxiv = Paper(
        paper_id="10.1/1",
        title="arXiv Title",
        abstract="arXiv abstract",
        venue="arXiv Venue",
        sources=["arxiv"],
    )

    merged = merge_papers([arxiv, openalex], source_preference=["openalex", "arxiv"])
    assert merged.title == "OpenAlex Title"
    assert merged.abstract == "OpenAlex abstract"
    assert merged.venue == "OpenAlex Venue"
    assert merged.sources == ["openalex", "arxiv"]


def test_merge_papers_falls_back_when_preferred_missing():
    openalex = Paper(
        paper_id="10.1/1",
        title="OpenAlex Title",
        abstract=None,
        venue=None,
        sources=["openalex"],
    )
    arxiv = Paper(
        paper_id="10.1/1",
        title="arXiv Title",
        abstract="arXiv abstract",
        venue="arXiv Venue",
        sources=["arxiv"],
    )

    merged = merge_papers([openalex, arxiv], source_preference=["openalex", "arxiv"])
    assert merged.title == "OpenAlex Title"
    assert merged.abstract == "arXiv abstract"
    assert merged.venue == "arXiv Venue"
    assert merged.sources == ["openalex", "arxiv"]


def test_merge_papers_single_paper_returns_unchanged():
    paper = Paper(paper_id="W1", title="Only")
    assert merge_papers([paper]) is paper


def test_merge_papers_merges_urls():
    openalex = Paper(
        paper_id="10.1/1",
        title="Title",
        urls={"paper": "https://openalex.org", "pdf": None},
        sources=["openalex"],
    )
    arxiv = Paper(
        paper_id="10.1/1",
        title="Title",
        urls={"paper": None, "pdf": "https://arxiv.org/pdf"},
        sources=["arxiv"],
    )

    merged = merge_papers([openalex, arxiv], source_preference=["openalex", "arxiv"])
    assert merged.urls == {"paper": "https://openalex.org", "pdf": "https://arxiv.org/pdf"}
