"""Tests for the local retriever CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


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


def test_cli_unsupported_strategy(cli_cmd: list[str]) -> None:
    payload = {
        "query": "x",
        "candidates": [{"paper_id": "p1", "title": "X"}],
        "strategy": "embedding",
    }
    result = subprocess.run(
        cli_cmd,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 3
    assert result.stdout == ""
