"""Tests for the local retriever CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from src.retriever.cli import cmd_rank
from src.retriever.provider import EmbeddingProviderError


@pytest.fixture
def cli_cmd() -> list[str]:
    return [sys.executable, "-m", "src.retriever.cli", "rank"]


def test_cli_rank_success(cli_cmd: list[str]) -> None:
    payload = json.loads(Path("tests/fixtures/candidates.json").read_text())
    result = subprocess.run(
        cli_cmd,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    response = json.loads(result.stdout)
    assert response["strategy"] == "bm25"
    assert len(response["ranked"]) == 3
    assert all("paper_id" in paper and "score" in paper for paper in response["ranked"])


def test_cli_invalid_json(cli_cmd: list[str]) -> None:
    result = subprocess.run(
        cli_cmd,
        input="not-json",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""


def test_cli_unknown_strategy(cli_cmd: list[str]) -> None:
    payload = {
        "query": "x",
        "candidates": [{"paper_id": "p1", "title": "X"}],
        "strategy": "unknown",
    }
    result = subprocess.run(
        cli_cmd,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""


def test_cli_embedding_provider_error(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "query": "x",
        "candidates": [{"paper_id": "p1", "title": "X"}],
        "strategy": "embedding",
    }

    def _failing_rank(_request: object) -> object:
        raise EmbeddingProviderError("mock failure")

    monkeypatch.setattr("src.retriever.cli.rank", _failing_rank)

    import io

    stdin = io.StringIO(json.dumps(payload))
    stdout = io.StringIO()
    stderr = io.StringIO()

    monkeypatch.setattr("sys.stdin", stdin)
    monkeypatch.setattr("sys.stdout", stdout)
    monkeypatch.setattr("sys.stderr", stderr)

    rc = cmd_rank()
    assert rc == 4
    assert stdout.getvalue() == ""
    assert "embedding provider failure" in stderr.getvalue()
