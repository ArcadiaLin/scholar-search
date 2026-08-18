"""Helpers for assembling ranking documents from paper fields."""

from __future__ import annotations

from src.retriever.schema import PaperCandidate


def build_document(candidate: PaperCandidate, title_weight: int = 3) -> str:
    """Build a single ranking document from a candidate.

    The title is repeated ``title_weight`` times so that matches in the title
    contribute more than matches in the abstract.
    """
    parts: list[str] = [candidate.title] * max(1, title_weight)
    if candidate.abstract:
        parts.append(candidate.abstract)
    return " ".join(parts)


def assign_tiers(sorted_scores: list[float]) -> list[str]:
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
