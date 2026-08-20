"""Tests for the OpenAlex arXiv enrichment script."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from scripts.enrich_openalex import OpenAlexCache, OpenAlexEnricher, _arxiv_id_to_doi, main
from src.retriever.openalex import OpenAlexClient
from src.retriever.schema import PaperCandidate


@pytest.fixture
def input_jsonl(tmp_path: Path) -> Path:
    path = tmp_path / "input.jsonl"
    path.write_text(
        json.dumps({"pid": 1, "arxiv_id": "2301.10120"})
        + "\n"
        + json.dumps({"pid": 2, "arxiv_id": "2107.06499"})
        + "\n"
        + json.dumps({"pid": 3, "arxiv_id": "not-a-real-id"})
        + "\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def fake_papers() -> list[tuple[PaperCandidate, dict[str, Any]]]:
    return [
        (
            PaperCandidate(
                paper_id="W123",
                title="Test 1",
                doi="https://doi.org/10.48550/arxiv.2301.10120",
                arxiv_id="2301.10120",
            ),
            {"id": "W123", "title": "Test 1", "doi": "https://doi.org/10.48550/arxiv.2301.10120"},
        ),
        (
            PaperCandidate(
                paper_id="W456",
                title="Test 2",
                doi="https://doi.org/10.48550/arxiv.2107.06499",
                arxiv_id="2107.06499",
            ),
            {"id": "W456", "title": "Test 2", "doi": "https://doi.org/10.48550/arxiv.2107.06499"},
        ),
    ]


def test_arxiv_id_to_doi() -> None:
    assert _arxiv_id_to_doi("2301.10120") == "10.48550/arxiv.2301.10120"
    assert _arxiv_id_to_doi("arXiv:2301.10120") == "10.48550/arxiv.2301.10120"


def test_cache_round_trip(tmp_path: Path) -> None:
    cache = OpenAlexCache(tmp_path / "cache.db")
    candidate = PaperCandidate(paper_id="W1", title="T", doi="https://doi.org/10.1/x")
    raw_work = {"id": "W1", "title": "T"}
    cache.set("2301.10120", "10.1/x", candidate, raw_work, "ok")

    cached = cache.get("2301.10120")
    assert cached is not None
    assert cached["status"] == "ok"
    assert cached["paper_id"] == "W1"

    restored = OpenAlexEnricher._candidate_from_cache(cached)
    assert restored is not None
    assert restored.paper_id == "W1"

    restored_raw = OpenAlexEnricher._raw_work_from_cache(cached)
    assert restored_raw == raw_work


def test_enricher_jsonl(
    tmp_path: Path,
    input_jsonl: Path,
    fake_papers: list[tuple[PaperCandidate, dict[str, Any]]],
) -> None:
    output_path = tmp_path / "output.jsonl"
    cache_path = tmp_path / "cache.db"
    client = OpenAlexClient(base_url="https://api.openalex.org", rate_limit_rps=1000.0)
    cache = OpenAlexCache(cache_path)
    enricher = OpenAlexEnricher(
        client=client,
        cache=cache,
        output_path=output_path,
        batch_size=50,
    )

    with patch.object(OpenAlexClient, "get_works_by_dois_with_raw_sync", return_value=fake_papers):
        stats = enricher.run(input_jsonl, id_field="arxiv_id")

    assert stats["total_seen"] == 3
    assert stats["success"] == 2
    assert stats["not_found"] == 1
    assert stats["api_calls"] == 1
    assert stats["credits_used"] == 10

    lines = output_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    first = json.loads(lines[0])
    assert first["arxiv_id"] == "2301.10120"
    assert first["status"] == "ok"
    assert first["openalex"]["paper_id"] == "W123"
    assert first["openalex_raw"]["id"] == "W123"

    # Cache should be populated for next run.
    assert cache.get("2301.10120") is not None


def test_main_command(
    tmp_path: Path,
    input_jsonl: Path,
    fake_papers: list[tuple[PaperCandidate, dict[str, Any]]],
) -> None:
    output_path = tmp_path / "main_output.jsonl"
    cache_path = tmp_path / "main_cache.db"

    with patch.object(OpenAlexClient, "get_works_by_dois_with_raw_sync", return_value=fake_papers):
        rc = main(
            [
                "--input",
                str(input_jsonl),
                "--id-field",
                "arxiv_id",
                "--output",
                str(output_path),
                "--cache",
                str(cache_path),
                "--batch-size",
                "50",
                "--rate-limit-rps",
                "1000",
                "--api-key",
                "test-key",
                "--mailto",
                "test@example.com",
            ]
        )

    assert rc == 0
    assert output_path.exists()
    lines = output_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
