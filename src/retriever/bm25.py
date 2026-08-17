"""BM25 re-ranker for candidate papers."""

from __future__ import annotations

import time
from collections.abc import Callable

from rank_bm25 import BM25Okapi

from src.retriever.schema import PaperCandidate, RankedPaper, RankRequest, RankResponse
from src.retriever.text import build_document
from src.retriever.tokenizer import tokenize


def _assign_tiers(sorted_scores: list[float]) -> list[str]:
    """Assign relevance tiers based on relative score ranking.

    Only positive scores receive ``highly_relevant`` or ``partially_relevant``;
    all zero or negative scores are ``not_relevant``.
    """
    n = len(sorted_scores)
    if n == 0:
        return []

    tiers: list[str] = []
    for rank_idx, score in enumerate(sorted_scores):
        if score <= 0:
            tiers.append("not_relevant")
            continue
        percentile = rank_idx / n
        if percentile < 0.20:
            tiers.append("highly_relevant")
        elif percentile < 0.50:
            tiers.append("partially_relevant")
        else:
            tiers.append("not_relevant")
    return tiers


class BM25Ranker:
    """BM25-based local re-ranker.

    Builds a temporary inverted index per request and scores candidates against
    the query tokens.  No network calls; deterministic.
    """

    def __init__(
        self,
        *,
        title_weight: int = 3,
        tokenizer: Callable[[str], list[str]] = tokenize,
    ) -> None:
        self.title_weight = title_weight
        self.tokenizer = tokenizer

    def _assemble(self, candidate: PaperCandidate) -> str:
        return build_document(candidate, title_weight=self.title_weight)

    def rank(self, request: RankRequest) -> RankResponse:
        start = time.perf_counter_ns()

        if not request.candidates:
            elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
            return RankResponse(
                ranked=[],
                elapsed_ms=elapsed_ms,
                strategy="bm25",
                source_counts={"bm25": 0},
            )

        corpus = [self.tokenizer(self._assemble(c)) for c in request.candidates]
        query_tokens = self.tokenizer(request.query)

        if query_tokens:
            bm25 = BM25Okapi(corpus)
            scores = bm25.get_scores(query_tokens)
        else:
            scores = [0.0] * len(request.candidates)

        indexed_scores = list(enumerate(scores))
        indexed_scores.sort(key=lambda x: (x[1], x[0]), reverse=True)

        sorted_scores = [score for _, score in indexed_scores]
        tiers = _assign_tiers(sorted_scores)

        top_k = request.top_k if request.top_k is not None else len(request.candidates)
        ranked: list[RankedPaper] = []
        for rank_idx, (candidate_idx, score) in enumerate(indexed_scores[:top_k]):
            candidate = request.candidates[candidate_idx]
            ranked.append(
                RankedPaper(
                    paper_id=candidate.paper_id,
                    score=float(score),
                    rank=rank_idx + 1,
                    tier=tiers[rank_idx],
                )
            )

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return RankResponse(
            ranked=ranked,
            elapsed_ms=elapsed_ms,
            strategy="bm25",
            source_counts={"bm25": len(ranked)},
        )
