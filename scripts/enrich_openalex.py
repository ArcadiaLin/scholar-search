#!/usr/bin/env python3
"""Enrich a local paper list with OpenAlex metadata via arXiv DOIs.

This script reads a local file containing arXiv IDs, resolves each ID to the
standard arXiv DOI (``10.48550/arXiv.<id>``), queries OpenAlex in batches, and
writes the enriched records to a JSONL file. A SQLite cache avoids re-querying
already-resolved IDs and makes the process resumable.

Usage example::

    uv run --env-file .env scripts/enrich_openalex.py \
        --input references/datasets/pasa/paper_database/papers.jsonl \
        --id-field arxiv_id \
        --output data/openalex_enriched.jsonl \
        --cache data/openalex_cache.db \
        --batch-size 50 \
        --rate-limit-rps 10

Input formats supported:
- JSONL: one JSON object per line; ``--id-field`` selects the field.
- CSV/TSV: ``--id-field`` selects the column.
- Parquet: ``--id-field`` selects the column.

If the selected field contains a list (e.g. PaSa's ``answer_arxiv_id``), the
script flattens the list and emits one output row per arXiv ID while preserving
the parent record's fields under ``source_record``.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sqlite3
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.retriever.openalex import OpenAlexClient, OpenAlexError
from src.retriever.schema import PaperCandidate

logger = logging.getLogger(__name__)


def _arxiv_id_to_doi(arxiv_id: str) -> str:
    """Return the canonical arXiv DOI for an arXiv ID."""
    clean = arxiv_id.strip()
    if clean.lower().startswith("arxiv:"):
        clean = clean[len("arxiv:") :]
    # OpenAlex stores arXiv DOIs with a lowercase 'arxiv' prefix.
    return f"10.48550/arxiv.{clean}"


def _read_records(path: Path, id_field: str) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (arxiv_id, source_record) pairs from the input file.

    Lists are flattened so each arXiv ID gets its own row.
    """
    suffix = path.suffix.lower()

    if suffix == ".jsonl":
        records = _read_jsonl(path)
    elif suffix in (".csv", ".tsv"):
        records = _read_csv(path, suffix)
    elif suffix == ".parquet":
        records = _read_parquet(path)
    else:
        raise ValueError(f"Unsupported input format: {suffix}")

    for record in records:
        raw_value = record.get(id_field)
        if raw_value is None:
            continue
        ids = raw_value if isinstance(raw_value, list) else [raw_value]
        for arxiv_id in ids:
            if not arxiv_id or not str(arxiv_id).strip():
                continue
            yield str(arxiv_id).strip(), record


def _read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                logger.warning("Skipping malformed JSONL line: %s", exc)


def _read_csv(path: Path, suffix: str) -> Iterator[dict[str, Any]]:
    delimiter = "\t" if suffix == ".tsv" else ","
    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=delimiter)
        yield from reader


def _read_parquet(path: Path) -> Iterator[dict[str, Any]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise ImportError("Parquet support requires pyarrow; install it with 'uv add --dev pyarrow'") from exc

    table = pq.read_table(path)
    for row in table.to_pylist():
        # pyarrow may return bytes for string columns; decode safely.
        yield {k: (v.decode("utf-8") if isinstance(v, bytes) else v) for k, v in row.items()}


class OpenAlexCache:
    """SQLite-backed cache for arXiv ID -> OpenAlex work lookups."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS openalex_cache (
                    arxiv_id TEXT PRIMARY KEY,
                    doi TEXT NOT NULL,
                    paper_id TEXT,
                    title TEXT,
                    abstract TEXT,
                    doi_out TEXT,
                    arxiv_id_out TEXT,
                    work_json TEXT,
                    raw_work_json TEXT,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_status ON openalex_cache(status)")
            conn.commit()

    def get(self, arxiv_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as conn:
            row = conn.execute("SELECT * FROM openalex_cache WHERE arxiv_id = ?", (arxiv_id,)).fetchone()
        if row is None:
            return None
        columns = [
            desc[0] for desc in conn.execute("SELECT * FROM openalex_cache WHERE arxiv_id = ?", (arxiv_id,)).description
        ]
        return dict(zip(columns, row, strict=True))

    def get_many(self, arxiv_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not arxiv_ids:
            return {}
        placeholders = ",".join("?" * len(arxiv_ids))
        with sqlite3.connect(self.path) as conn:
            rows = conn.execute(
                f"SELECT * FROM openalex_cache WHERE arxiv_id IN ({placeholders})",
                arxiv_ids,
            ).fetchall()
            columns = [
                desc[0]
                for desc in conn.execute(
                    f"SELECT * FROM openalex_cache WHERE arxiv_id IN ({placeholders})",
                    arxiv_ids,
                ).description
            ]
        return {row[columns.index("arxiv_id")]: dict(zip(columns, row, strict=True)) for row in rows}

    def set(
        self,
        arxiv_id: str,
        doi: str,
        candidate: PaperCandidate | None,
        raw_work: dict[str, Any] | None,
        status: str,
    ) -> None:
        work_json = json.dumps(candidate.model_dump() if candidate else None)
        raw_work_json = json.dumps(raw_work)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                INSERT INTO openalex_cache
                (arxiv_id, doi, paper_id, title, abstract, doi_out, arxiv_id_out,
                 work_json, raw_work_json, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(arxiv_id) DO UPDATE SET
                    doi=excluded.doi,
                    paper_id=excluded.paper_id,
                    title=excluded.title,
                    abstract=excluded.abstract,
                    doi_out=excluded.doi_out,
                    arxiv_id_out=excluded.arxiv_id_out,
                    work_json=excluded.work_json,
                    raw_work_json=excluded.raw_work_json,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (
                    arxiv_id,
                    doi,
                    candidate.paper_id if candidate else None,
                    candidate.title if candidate else None,
                    candidate.abstract if candidate else None,
                    candidate.doi if candidate else None,
                    candidate.arxiv_id if candidate else None,
                    work_json,
                    raw_work_json,
                    status,
                    now,
                ),
            )
            conn.commit()

    def counts(self) -> dict[str, int]:
        with sqlite3.connect(self.path) as conn:
            rows = conn.execute("SELECT status, COUNT(*) FROM openalex_cache GROUP BY status").fetchall()
        return {status: count for status, count in rows}


class OpenAlexEnricher:
    """Orchestrate reading, caching, batch querying, and writing."""

    def __init__(
        self,
        client: OpenAlexClient,
        cache: OpenAlexCache,
        output_path: Path,
        *,
        batch_size: int = 50,
        max_retries_per_batch: int = 3,
    ) -> None:
        self.client = client
        self.cache = cache
        self.output_path = output_path
        self.batch_size = max(1, min(batch_size, 50))
        self.max_retries_per_batch = max(0, max_retries_per_batch)
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self._out_fh = self.output_path.open("w", encoding="utf-8")
        self._written = 0
        self._api_calls = 0
        self._credits_used = 0

    def _write(
        self,
        arxiv_id: str,
        record: dict[str, Any],
        candidate: PaperCandidate | None,
        raw_work: dict[str, Any] | None,
        status: str,
    ) -> None:
        out = {
            "arxiv_id": arxiv_id,
            "source_record": record,
            "openalex": candidate.model_dump() if candidate else None,
            "openalex_raw": raw_work,
            "status": status,
        }
        self._out_fh.write(json.dumps(out, ensure_ascii=False) + "\n")
        self._out_fh.flush()
        self._written += 1

    def _enrich_batch(
        self,
        batch: list[tuple[str, dict[str, Any]]],
    ) -> list[tuple[str, dict[str, Any], PaperCandidate | None, dict[str, Any] | None, str]]:
        """Query OpenAlex for one batch and return resolved results.

        The method retries the whole batch on transient failures. Already-cached
        items are not re-queried.
        """
        dois = [_arxiv_id_to_doi(aid) for aid, _ in batch]
        last_exception: Exception | None = None

        for attempt in range(self.max_retries_per_batch + 1):
            try:
                pairs = self.client.get_works_by_dois_with_raw_sync(dois)
                break
            except OpenAlexError as exc:
                last_exception = exc
                logger.warning(
                    "Batch query failed (attempt %d/%d): %s", attempt + 1, self.max_retries_per_batch + 1, exc
                )
                if attempt == self.max_retries_per_batch:
                    raise
                time.sleep(min(2**attempt, 60.0))
        else:
            raise last_exception or RuntimeError("Batch enrichment failed")

        # Build lookup by DOI for matching. OpenAlex returns DOIs both as full
        # https://doi.org/ URLs and occasionally as bare DOIs; index both forms
        # case-insensitively because OpenAlex uses a lowercase 'arxiv' prefix.
        by_doi: dict[str, tuple[PaperCandidate, dict[str, Any]]] = {}
        for c, raw in pairs:
            if c.doi:
                bare = c.doi.removeprefix("https://doi.org/").lower()
                by_doi[c.doi.lower()] = (c, raw)
                by_doi[bare] = (c, raw)
        results: list[tuple[str, dict[str, Any], PaperCandidate | None, dict[str, Any] | None, str]] = []
        for arxiv_id, record in batch:
            doi = _arxiv_id_to_doi(arxiv_id).lower()
            match = by_doi.get(doi)
            candidate, raw_work = match if match else (None, None)
            status = "ok" if candidate else "not_found"
            results.append((arxiv_id, record, candidate, raw_work, status))
        return results

    def run(self, input_path: Path, id_field: str) -> dict[str, Any]:
        """Run the enrichment pipeline and return summary statistics."""
        start = time.perf_counter()
        total_seen = 0
        cached_hits = 0
        success = 0
        not_found = 0
        failed = 0

        # First pass: collect unique arXiv IDs and source records while streaming.
        stream: Iterator[tuple[str, dict[str, Any]]] = _read_records(input_path, id_field)

        batch: list[tuple[str, dict[str, Any]]] = []
        current_dois: list[str] = []

        with tqdm(unit=" papers", desc="Enriching with OpenAlex") as pbar:
            for arxiv_id, record in stream:
                total_seen += 1

                cached = self.cache.get(arxiv_id)
                if cached is not None:
                    cached_hits += 1
                    candidate = self._candidate_from_cache(cached)
                    raw_work = self._raw_work_from_cache(cached)
                    status = cached["status"]
                    self._write(arxiv_id, record, candidate, raw_work, status)
                    if status == "ok":
                        success += 1
                    elif status == "not_found":
                        not_found += 1
                    pbar.update(1)
                    continue

                doi = _arxiv_id_to_doi(arxiv_id)
                if doi in current_dois:
                    # Duplicate within the same batch; skip to avoid wasted API call.
                    continue
                batch.append((arxiv_id, record))
                current_dois.append(doi)

                if len(batch) >= self.batch_size:
                    batch_counts = self._process_batch(batch)
                    success += batch_counts["success"]
                    not_found += batch_counts["not_found"]
                    failed += batch_counts["failed"]
                    pbar.update(len(batch))
                    batch = []
                    current_dois = []

            if batch:
                batch_counts = self._process_batch(batch)
                success += batch_counts["success"]
                not_found += batch_counts["not_found"]
                failed += batch_counts["failed"]
                pbar.update(len(batch))

        self._out_fh.close()
        elapsed = time.perf_counter() - start

        return {
            "total_seen": total_seen,
            "written": self._written,
            "cached_hits": cached_hits,
            "success": success,
            "not_found": not_found,
            "failed": failed,
            "api_calls": self._api_calls,
            "credits_used": self._credits_used,
            "elapsed_seconds": elapsed,
        }

    def _process_batch(
        self,
        batch: list[tuple[str, dict[str, Any]]],
    ) -> dict[str, int]:
        """Query, cache, and write one batch. Returns increment counters."""
        counts = {"success": 0, "not_found": 0, "failed": 0}
        try:
            results = self._enrich_batch(batch)
        except OpenAlexError as exc:
            logger.error("Batch failed after retries: %s", exc)
            for arxiv_id, record in batch:
                self.cache.set(arxiv_id, _arxiv_id_to_doi(arxiv_id), None, None, "failed")
                self._write(arxiv_id, record, None, None, "failed")
                counts["failed"] += 1
            return counts

        self._api_calls += 1
        self._credits_used += 10  # OpenAlex list request cost
        for arxiv_id, record, candidate, raw_work, status in results:
            doi = _arxiv_id_to_doi(arxiv_id)
            self.cache.set(arxiv_id, doi, candidate, raw_work, status)
            self._write(arxiv_id, record, candidate, raw_work, status)
            if status == "ok":
                counts["success"] += 1
            else:
                counts["not_found"] += 1
        return counts

    @staticmethod
    def _candidate_from_cache(cached: dict[str, Any]) -> PaperCandidate | None:
        work_json = cached.get("work_json")
        if not work_json:
            return None
        data = json.loads(work_json)
        if data is None:
            return None
        return PaperCandidate.model_validate(data)

    @staticmethod
    def _raw_work_from_cache(cached: dict[str, Any]) -> dict[str, Any] | None:
        raw_work_json = cached.get("raw_work_json")
        if not raw_work_json:
            return None
        data = json.loads(raw_work_json)
        if data is None:
            return None
        return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Enrich local arXiv IDs with OpenAlex metadata.")
    parser.add_argument("--input", type=Path, required=True, help="Input file (jsonl/csv/tsv/parquet).")
    parser.add_argument("--id-field", type=str, default="arxiv_id", help="Field/column containing arXiv ID(s).")
    parser.add_argument("--output", type=Path, required=True, help="Output JSONL file.")
    parser.add_argument("--cache", type=Path, default=Path("data/openalex_cache.db"), help="SQLite cache path.")
    parser.add_argument("--batch-size", type=int, default=50, help="OpenAlex batch size (max 50).")
    parser.add_argument("--rate-limit-rps", type=float, default=10.0, help="Requests per second ceiling.")
    parser.add_argument("--max-retries", type=int, default=3, help="Retries per failed batch.")
    parser.add_argument("--api-key", type=str, default=None, help="OpenAlex API key (or env OPENALEX_API_KEY).")
    parser.add_argument("--mailto", type=str, default=None, help="Email for polite pool (or env OPENALEX_MAILTO).")
    parser.add_argument("--log-level", type=str, default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not args.input.exists():
        logger.error("Input file not found: %s", args.input)
        return 2

    client = OpenAlexClient(
        api_key=args.api_key,
        mailto=args.mailto,
        rate_limit_rps=args.rate_limit_rps,
        max_retries=0,  # we handle batch retries ourselves
    )
    cache = OpenAlexCache(args.cache)
    enricher = OpenAlexEnricher(
        client=client,
        cache=cache,
        output_path=args.output,
        batch_size=args.batch_size,
        max_retries_per_batch=args.max_retries,
    )

    try:
        stats = enricher.run(args.input, args.id_field)
    finally:
        # _run already closes the per-call AsyncClient; this is a safety net.
        try:
            import asyncio

            asyncio.run(client.close())
        except RuntimeError:
            pass

    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
