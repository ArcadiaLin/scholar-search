"""Converters between the unified ``Paper`` schema and internal ranker types.

The internal BM25/embedding rankers historically operate on a lightweight
``PaperCandidate`` type. This module provides lossless bidirectional conversion
so that the HTTP API can speak the unified ``Paper`` schema while the ranker
remains agnostic to provider-specific fields.
"""

from __future__ import annotations

from search_service.rank.schema import PaperCandidate
from search_service.schemas.paper import Author, Paper


def paper_to_candidate(paper: Paper) -> PaperCandidate:
    """Convert a unified ``Paper`` into a ranker ``PaperCandidate``."""
    return PaperCandidate(
        paper_id=paper.paper_id,
        title=paper.title,
        abstract=paper.abstract,
        full_text=None,
        arxiv_id=paper.arxiv_id,
        doi=paper.doi,
        s2_corpus_id=paper.external_ids.get("s2_corpus_id"),
    )


def candidate_to_paper(candidate: PaperCandidate) -> Paper:
    """Convert a ranker ``PaperCandidate`` into a minimal unified ``Paper``."""
    return Paper(
        paper_id=candidate.paper_id,
        title=candidate.title,
        abstract=candidate.abstract,
        arxiv_id=candidate.arxiv_id,
        doi=candidate.doi,
        external_ids={"s2_corpus_id": candidate.s2_corpus_id} if candidate.s2_corpus_id else {},
    )


def authors_to_strings(authors: list[Author] | None) -> list[str] | None:
    """Extract display names from a list of ``Author`` objects."""
    if authors is None:
        return None
    names = [a.name for a in authors if a.name]
    return names if names else None
