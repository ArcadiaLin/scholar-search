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
