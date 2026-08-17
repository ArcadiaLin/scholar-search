"""Unified entry point for local re-ranking strategies."""

from __future__ import annotations

from src.retriever.bm25 import BM25Ranker
from src.retriever.schema import RankRequest, RankResponse


def rank(request: RankRequest) -> RankResponse:
    """Re-rank ``request.candidates`` using the requested strategy.

    Currently only ``bm25`` is implemented.  ``embedding`` and ``hybrid`` will
    be added in a follow-up PR.
    """
    if request.strategy == "bm25":
        response = BM25Ranker().rank(request)
    elif request.strategy in ("embedding", "hybrid"):
        raise ValueError(f"Strategy {request.strategy!r} is not implemented yet.")
    else:
        raise ValueError(f"Unknown strategy {request.strategy!r}")

    if response.elapsed_ms > request.max_wall_ms:
        raise TimeoutError(f"Ranking exceeded budget of {request.max_wall_ms} ms (took {response.elapsed_ms} ms).")

    return response
