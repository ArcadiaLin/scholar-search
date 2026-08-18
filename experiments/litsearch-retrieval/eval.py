#!/usr/bin/env python3
"""Fast LitSearch evaluation for BM25, embedding, and hybrid retrieval.

Unlike ``experiments/litsearch-bm25/eval_bm25.py``, this script builds the
BM25 inverted index **once** over the whole corpus and reuses it for every
query.  The embedding index likewise encodes the corpus once and caches the
vectors in memory.

Run::

    uv run python experiments/litsearch-retrieval/eval.py --strategy bm25
    uv run python experiments/litsearch-retrieval/eval.py --strategy embedding
    uv run python experiments/litsearch-retrieval/eval.py --strategy hybrid

"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

# Allow the script to be invoked from any working directory.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.retriever.embedding import _cosine_similarity  # noqa: E402
from src.retriever.provider import RemoteEmbeddingProvider  # noqa: E402
from src.retriever.schema import PaperCandidate  # noqa: E402
from src.retriever.text import assign_tiers, build_document  # noqa: E402
from src.retriever.tokenizer import tokenize  # noqa: E402


def _find_column(table: Any, candidates: list[str]) -> str:
    """Return the first candidate column name that exists in ``table``."""
    available = set(table.column_names)
    for name in candidates:
        if name in available:
            return name
    raise KeyError(f"none of {candidates!r} found in parquet columns: {table.column_names!r}")


def _load_parquet(path: Path) -> Any:
    """Lazy import of pyarrow.parquet so the script fails cleanly if missing."""
    try:
        import pyarrow.parquet as pq
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "pyarrow is required to read LitSearch parquet files. Install it with: uv add --dev pyarrow"
        ) from exc
    return pq.read_table(path)


def load_corpus(
    corpus_dir: Path,
    *,
    id_col: str | None = None,
    title_col: str | None = None,
    abstract_col: str | None = None,
) -> list[PaperCandidate]:
    """Load all corpus_clean parquet files into ``PaperCandidate`` objects."""
    paths = sorted(corpus_dir.glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"no parquet files found in {corpus_dir}")

    first_table = _load_parquet(paths[0])
    if id_col is None:
        id_col = _find_column(first_table, ["corpusid", "corpus_id", "id", "paper_id"])
    if title_col is None:
        title_col = _find_column(first_table, ["title"])
    if abstract_col is None:
        abstract_col = _find_column(first_table, ["abstract"])

    print(f"[corpus] id={id_col}, title={title_col}, abstract={abstract_col}")

    candidates: list[PaperCandidate] = []
    for path in paths:
        table = _load_parquet(path)
        ids = table.column(id_col).to_pylist()
        titles = table.column(title_col).to_pylist()
        abstracts = table.column(abstract_col).to_pylist()
        for corpus_id, title, abstract in zip(ids, titles, abstracts, strict=True):
            candidates.append(
                PaperCandidate(
                    paper_id=str(corpus_id),
                    title=str(title or ""),
                    abstract=str(abstract or "") if abstract is not None else None,
                    s2_corpus_id=str(corpus_id),
                )
            )
    return candidates


def load_queries(
    query_path: Path,
    *,
    id_col: str | None = None,
    query_col: str | None = None,
    gold_col: str | None = None,
    type_col: str | None = None,
) -> list[dict[str, Any]]:
    """Load LitSearch queries and gold IDs."""
    table = _load_parquet(query_path)
    if query_col is None:
        query_col = _find_column(table, ["query", "text", "question"])
    if gold_col is None:
        gold_col = _find_column(table, ["corpusids", "gold_ids", "gold", "gold_corpus_ids"])

    id_col_candidates = ["id", "query_id"]
    if id_col is None:
        id_col = (
            _find_column(table, id_col_candidates) if any(c in table.column_names for c in id_col_candidates) else None
        )

    type_col_candidates = ["specificity", "type", "query_type", "category"]
    if type_col is None:
        type_col = (
            _find_column(table, type_col_candidates)
            if any(c in table.column_names for c in type_col_candidates)
            else None
        )

    print(f"[query] id={id_col or '<row_index>'}, query={query_col}, gold={gold_col}, type={type_col or '<none>'}")

    queries: list[dict[str, Any]] = []
    for row_idx in range(table.num_rows):
        raw_gold = table.column(gold_col)[row_idx].as_py()
        gold_ids = [str(g) for g in raw_gold] if isinstance(raw_gold, list) else [str(raw_gold)]
        queries.append(
            {
                "id": str(table.column(id_col)[row_idx].as_py()) if id_col else f"q{row_idx}",
                "query": str(table.column(query_col)[row_idx].as_py() or ""),
                "gold_ids": list(dict.fromkeys(gold_ids)),
                "type": str(table.column(type_col)[row_idx].as_py()) if type_col else None,
            }
        )
    return queries


class CorpusBM25Index:
    """Persistent BM25 index built once over the whole corpus."""

    def __init__(self, corpus: Sequence[PaperCandidate], *, title_weight: int = 3) -> None:
        from rank_bm25 import BM25Okapi

        self.corpus = list(corpus)
        self.title_weight = title_weight
        print(f"[BM25] tokenizing {len(corpus)} documents...")
        start = time.perf_counter()
        self.tokenized_corpus = [tokenize(build_document(c, title_weight=title_weight)) for c in corpus]
        print("[BM25] building index...")
        self.index = BM25Okapi(self.tokenized_corpus)
        elapsed = time.perf_counter() - start
        print(f"[BM25] index ready in {elapsed:.2f}s")

    def search(self, query: str, top_k: int) -> list[tuple[str, float]]:
        query_tokens = tokenize(query)
        if not query_tokens:
            return [(c.paper_id, 0.0) for c in self.corpus[:top_k]]

        scores = self.index.get_scores(query_tokens)
        indexed_scores = sorted(enumerate(scores), key=lambda x: (-x[1], x[0]))
        return [(self.corpus[idx].paper_id, float(score)) for idx, score in indexed_scores[:top_k]]


class CorpusEmbeddingIndex:
    """Persistent embedding index: corpus vectors encoded once and kept in memory."""

    # E5 models have a 512-token limit.  A conservative character cap avoids
    # hitting remote-server payload limits while preserving most of the content.
    DEFAULT_MAX_INPUT_CHARS = 500

    def __init__(
        self,
        corpus: Sequence[PaperCandidate],
        *,
        provider: RemoteEmbeddingProvider,
        batch_size: int = 64,
        max_input_chars: int = DEFAULT_MAX_INPUT_CHARS,
    ) -> None:
        self.corpus = list(corpus)
        self.provider = provider
        self.batch_size = batch_size
        self.max_input_chars = max_input_chars
        self._vectors: list[list[float]] = []

        print(f"[embedding] encoding {len(corpus)} documents with batch_size={batch_size}...")
        start = time.perf_counter()
        texts = [self._build_passage_text(c)[:max_input_chars] for c in corpus]
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            self._vectors.extend(self.provider.encode_sync(batch))
            if (i // batch_size + 1) % 10 == 0 or i + batch_size >= len(texts):
                print(f"[embedding] encoded {min(i + batch_size, len(texts))}/{len(texts)}")
        elapsed = time.perf_counter() - start
        print(f"[embedding] corpus encoded in {elapsed:.2f}s")

    @staticmethod
    def _build_passage_text(candidate: PaperCandidate) -> str:
        parts = [f"passage: {candidate.title}"]
        if candidate.abstract:
            parts.append(candidate.abstract)
        return " ".join(parts)

    def search(self, query: str, top_k: int) -> list[tuple[str, float]]:
        query_text = f"query: {query}"[: self.max_input_chars]
        query_vec = self.provider.encode_sync([query_text])[0]
        scored = [(idx, _cosine_similarity(query_vec, doc_vec)) for idx, doc_vec in enumerate(self._vectors)]
        scored.sort(key=lambda x: (-x[1], x[0]))
        return [(self.corpus[idx].paper_id, float(score)) for idx, score in scored[:top_k]]


class CorpusHybridIndex:
    """Combine BM25 and embedding scores with equal weights."""

    def __init__(
        self,
        corpus: Sequence[PaperCandidate],
        *,
        provider: RemoteEmbeddingProvider,
        title_weight: int = 3,
        batch_size: int = 64,
        max_input_chars: int = CorpusEmbeddingIndex.DEFAULT_MAX_INPUT_CHARS,
    ) -> None:
        self.corpus = list(corpus)
        self._id_to_idx = {c.paper_id: i for i, c in enumerate(self.corpus)}
        self.bm25 = CorpusBM25Index(corpus, title_weight=title_weight)
        self.emb = CorpusEmbeddingIndex(
            corpus,
            provider=provider,
            batch_size=batch_size,
            max_input_chars=max_input_chars,
        )

    @staticmethod
    def _min_max_normalize(scores: list[float]) -> list[float]:
        if not scores:
            return []
        min_s, max_s = min(scores), max(scores)
        span = max_s - min_s
        if span == 0.0:
            return [0.0] * len(scores)
        return [(s - min_s) / span for s in scores]

    def search(self, query: str, top_k: int) -> list[tuple[str, float]]:
        bm25_results = self.bm25.search(query, len(self.corpus))
        emb_results = self.emb.search(query, len(self.corpus))

        bm25_by_idx = {self._id_to_idx[pid]: s for pid, s in bm25_results}
        emb_by_idx = {self._id_to_idx[pid]: s for pid, s in emb_results}

        n = len(self.corpus)
        bm25_scores = [bm25_by_idx.get(i, 0.0) for i in range(n)]
        emb_scores = [emb_by_idx.get(i, 0.0) for i in range(n)]
        bm25_norm = self._min_max_normalize(bm25_scores)
        emb_norm = self._min_max_normalize(emb_scores)

        combined = [(i, 0.5 * bm25_norm[i] + 0.5 * emb_norm[i]) for i in range(n)]
        combined.sort(key=lambda x: (-x[1], x[0]))
        return [(self.corpus[idx].paper_id, float(score)) for idx, score in combined[:top_k]]


def compute_metrics(retrieved: list[str], gold: set[str], k: int) -> dict[str, float]:
    """Compute precision@k, recall@k, and f1@k."""
    retrieved_k = retrieved[:k]
    relevant = len(gold & set(retrieved_k))
    precision = relevant / k if k > 0 else 0.0
    recall = relevant / len(gold) if gold else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {
        f"precision@{k}": precision,
        f"recall@{k}": recall,
        f"f1@{k}": f1,
    }


def evaluate_query(
    query: dict[str, Any],
    index: CorpusBM25Index | CorpusEmbeddingIndex | CorpusHybridIndex,
    ks: list[int],
) -> dict[str, Any]:
    """Evaluate a single query and return per-query metrics."""
    gold = set(query["gold_ids"])
    start = time.perf_counter()
    ranked = index.search(query["query"], max(ks))
    elapsed_ms = (time.perf_counter() - start) * 1000

    retrieved = [paper_id for paper_id, _ in ranked]
    scores = [score for _, score in ranked]
    tiers = assign_tiers(scores)

    per_query: dict[str, Any] = {
        "query_id": query["id"],
        "query": query["query"],
        "type": query["type"],
        "gold_ids": query["gold_ids"],
        "retrieved_ids": retrieved,
        "latency_ms": round(elapsed_ms, 2),
    }

    for k in ks:
        per_query.update(compute_metrics(retrieved, gold, k))

    per_query["ranked"] = [
        {"paper_id": paper_id, "score": score, "tier": tier}
        for (paper_id, score), tier in zip(ranked, tiers, strict=True)
    ]
    return per_query


def aggregate(results: list[dict[str, Any]], ks: list[int]) -> dict[str, float]:
    """Aggregate metrics over all queries and by query type."""
    out: dict[str, float] = {}
    n = len(results)
    if n == 0:
        return out

    for k in ks:
        for metric in ("precision", "recall", "f1"):
            key = f"{metric}@{k}"
            scores = [r[key] for r in results]
            out[f"mean_{key}"] = sum(scores) / n

    for query_type in ("broad", "specific"):
        subset = [r for r in results if r.get("type") == query_type]
        if not subset:
            continue
        for k in ks:
            for metric in ("precision", "recall", "f1"):
                key = f"{metric}@{k}"
                scores = [r[key] for r in subset]
                out[f"mean_{key}_{query_type}"] = sum(scores) / len(subset)
    return out


def build_index(
    strategy: str,
    corpus: list[PaperCandidate],
    *,
    bm25_title_weight: int = 3,
    embedding_batch_size: int = 64,
    max_input_chars: int = CorpusEmbeddingIndex.DEFAULT_MAX_INPUT_CHARS,
) -> CorpusBM25Index | CorpusEmbeddingIndex | CorpusHybridIndex:
    """Build the requested index over the corpus."""
    if strategy == "bm25":
        return CorpusBM25Index(corpus, title_weight=bm25_title_weight)

    import os

    base_url = os.environ.get("EMBEDDING_BASE_URL", "http://localhost:8000/v1")
    model = os.environ.get("EMBEDDING_MODEL", "intfloat/e5-base-v2")
    api_key = os.environ.get("EMBEDDING_API_KEY") or None
    # Use TEI's native /embed endpoint which supports server-side truncation.
    # Strip the OpenAI-compatible /v1 suffix if present.
    tei_base_url = base_url.removesuffix("/v1").removesuffix("/")
    provider = RemoteEmbeddingProvider(
        base_url=tei_base_url,
        model=model,
        api_key=api_key,
        api_format="custom",
        truncate=True,
    )

    if strategy == "embedding":
        return CorpusEmbeddingIndex(
            corpus,
            provider=provider,
            batch_size=embedding_batch_size,
            max_input_chars=max_input_chars,
        )
    if strategy == "hybrid":
        return CorpusHybridIndex(
            corpus,
            provider=provider,
            title_weight=bm25_title_weight,
            batch_size=embedding_batch_size,
            max_input_chars=max_input_chars,
        )
    raise ValueError(f"Unknown strategy {strategy!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fast LitSearch evaluation for BM25 / embedding / hybrid")
    parser.add_argument(
        "--corpus-dir",
        type=Path,
        default=Path("references/datasets/litsearch/corpus_clean"),
        help="directory containing corpus_clean parquet files",
    )
    parser.add_argument(
        "--query-path",
        type=Path,
        default=Path("references/datasets/litsearch/query/full-00000-of-00001.parquet"),
        help="LitSearch query parquet file",
    )
    parser.add_argument(
        "--strategy",
        choices=["bm25", "embedding", "hybrid"],
        default="bm25",
        help="retrieval strategy to evaluate",
    )
    parser.add_argument(
        "--ks",
        type=int,
        nargs="+",
        default=[5, 10, 20, 50, 100],
        help="cutoffs to report (default: 5 10 20 50 100)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="path to write JSON results; default uses runs/litsearch-<strategy>-results.json",
    )
    parser.add_argument(
        "--max-queries",
        type=int,
        default=None,
        help="limit number of queries for a quick smoke test",
    )
    parser.add_argument(
        "--bm25-title-weight",
        type=int,
        default=3,
        help="BM25 title repetition weight (default: 3)",
    )
    parser.add_argument(
        "--embedding-batch-size",
        type=int,
        default=64,
        help="embedding provider batch size (default: 64)",
    )
    parser.add_argument(
        "--max-input-chars",
        type=int,
        default=CorpusEmbeddingIndex.DEFAULT_MAX_INPUT_CHARS,
        help="maximum characters per embedding input to avoid remote payload limits (default: 1500)",
    )
    args = parser.parse_args(argv)

    print("Loading corpus...")
    corpus = load_corpus(args.corpus_dir)
    print(f"Loaded {len(corpus)} corpus documents")

    print("Loading queries...")
    queries = load_queries(args.query_path)
    if args.max_queries:
        queries = queries[: args.max_queries]
    print(f"Loaded {len(queries)} queries")

    print(f"Building {args.strategy} index...")
    index = build_index(
        args.strategy,
        corpus,
        bm25_title_weight=args.bm25_title_weight,
        embedding_batch_size=args.embedding_batch_size,
        max_input_chars=args.max_input_chars,
    )

    print("Evaluating queries...")
    results: list[dict[str, Any]] = []
    total_start = time.perf_counter()
    for q in queries:
        results.append(evaluate_query(q, index, args.ks))
    total_elapsed = time.perf_counter() - total_start

    summary = {
        "strategy": args.strategy,
        "num_queries": len(queries),
        "corpus_size": len(corpus),
        "ks": args.ks,
        "total_elapsed_sec": round(total_elapsed, 3),
        "avg_query_latency_ms": round(total_elapsed / len(queries) * 1000, 2) if queries else 0,
        **aggregate(results, args.ks),
        "per_query": results,
    }

    output_path = args.output or Path(f"runs/litsearch-{args.strategy}-results.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps({k: v for k, v in summary.items() if k != "per_query"}, indent=2))
    print(f"Wrote detailed results to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
