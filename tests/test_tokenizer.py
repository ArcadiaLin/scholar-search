"""Tests for the local retriever tokenizer."""

from __future__ import annotations

import pytest

from src.retriever.tokenizer import tokenize, tokenize_many


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", []),
        ("The quick brown fox", ["quick", "brown", "fox"]),
        ("Transformers are great!", ["transformers", "great"]),
        (r"We use \emph{attention} and \citep{vaswani2017}", ["use", "attention", "vaswani2017"]),
        (r"See https://arxiv.org/abs/1706.03762 and doi.org/10.1234/example", ["see"]),
        ("There are 123 models in 2024", ["models"]),
    ],
)
def test_tokenize(text: str, expected: list[str]) -> None:
    assert tokenize(text) == expected


def test_tokenize_many() -> None:
    assert tokenize_many(["Hello world", "The cat"]) == [["hello", "world"], ["cat"]]
