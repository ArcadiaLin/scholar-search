"""Lightweight academic-text tokenizer used by local rankers."""

from __future__ import annotations

import re
from collections.abc import Iterable

# Compact English stopword list.  Avoids pulling in NLTK for this small task.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "or",
        "but",
        "if",
        "then",
        "else",
        "of",
        "at",
        "to",
        "for",
        "from",
        "in",
        "on",
        "by",
        "with",
        "about",
        "as",
        "into",
        "through",
        "during",
        "before",
        "after",
        "above",
        "below",
        "between",
        "among",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "could",
        "should",
        "may",
        "might",
        "must",
        "can",
        "this",
        "that",
        "these",
        "those",
        "i",
        "we",
        "you",
        "he",
        "she",
        "it",
        "they",
        "their",
        "our",
        "my",
        "his",
        "her",
        "its",
        "there",
        "here",
    }
)

# Remove LaTeX commands but keep the text inside braces (e.g. \emph{attention}
# -> attention).  A separate pass removes the command name itself and any
# citations that did not contain useful words.
_LATEX_RE = re.compile(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?")
# Remove HTTP/HTTPS/DOI URLs.
_URL_RE = re.compile(r"https?://\S+|doi\.org/\S+|arxiv:\S+", re.IGNORECASE)
# Split on anything that is not alphanumeric or underscore.
_TOKEN_RE = re.compile(r"[^a-z0-9_]+")
# Pure numeric tokens.
_NUMERIC_RE = re.compile(r"^\d+$")


def tokenize(text: str) -> list[str]:
    """Tokenize ``text`` for BM25 indexing.

    Steps:
        1. Lowercase.
        2. Strip LaTeX commands but preserve their braced arguments.
        3. Remove URLs.
        4. Split on non-alphanumeric characters.
        5. Drop pure numeric tokens and stopwords.
        6. Drop empty tokens.
    """
    if not text:
        return []

    cleaned = _LATEX_RE.sub(r"\1", text)
    cleaned = _URL_RE.sub(" ", cleaned)
    cleaned = cleaned.lower()
    tokens: list[str] = []
    for raw in _TOKEN_RE.split(cleaned):
        if not raw or len(raw) < 2 or _NUMERIC_RE.match(raw) or raw in _STOPWORDS:
            continue
        tokens.append(raw)
    return tokens


def tokenize_many(texts: Iterable[str]) -> list[list[str]]:
    """Tokenize a batch of strings."""
    return [tokenize(t) for t in texts]
