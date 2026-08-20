"""Input/output schemas for the local retriever."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PaperCandidate(BaseModel):
    """A single candidate paper supplied by an upstream retrieval source.

    The ``paper_id`` must be stable across sources; upstream callers are
    responsible for cross-source ID normalization and deduplication.
    """

    paper_id: str = Field(description="Stable unique identifier for the paper.")
    title: str = Field(description="Paper title.")
    abstract: str | None = Field(default=None, description="Paper abstract, if available.")
    full_text: str | None = Field(default=None, description="Full text snippet, if available.")
    arxiv_id: str | None = Field(default=None, description="arXiv identifier for diagnostics.")
    doi: str | None = Field(default=None, description="DOI for diagnostics.")
    s2_corpus_id: str | None = Field(default=None, description="Semantic Scholar CorpusID for diagnostics.")


class RankRequest(BaseModel):
    """A single re-ranking request."""

    query: str = Field(description="Original search query.")
    candidates: list[PaperCandidate] = Field(description="Candidate papers to re-rank.")
    strategy: Literal["bm25", "embedding", "hybrid"] = Field(
        default="bm25",
        description="Ranking strategy to use.",
    )
    top_k: int | None = Field(default=None, ge=1, description="Return only the top-k results.")
    max_wall_ms: int = Field(default=30_000, ge=1, description="Wall-clock time budget in milliseconds.")


class RankedPaper(BaseModel):
    """A candidate paper after re-ranking."""

    paper_id: str
    score: float
    rank: int = Field(ge=1, description="1-based position in the ranked list.")
    tier: Literal["highly_relevant", "partially_relevant", "not_relevant"]


class RankResponse(BaseModel):
    """Unified response from a ranking operation."""

    ranked: list[RankedPaper]
    elapsed_ms: int = Field(ge=0)
    strategy: str
    cost_usd: float = Field(default=0.0, description="Local ranking has no API cost.")
    source_counts: dict[str, int] = Field(default_factory=dict)
