"""Multi-source search aggregator.

``Aggregator`` selects enabled providers, issues keyword searches in parallel,
normalizes results to the unified ``Paper`` schema, deduplicates by stable ID,
and reranks using Reciprocal Rank Fusion (RRF).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from search_service.exceptions import SourceError
from search_service.models import SearchResultItem
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import (
    CandidateCounts,
    Failure,
    IssuedQuery,
    Paper,
    Provenance,
    RankedPaper,
    SearchState,
    merge_papers,
    search_result_item_to_paper,
)

_DEFAULT_RRF_K = 60
_SOURCE_PREFERENCE = ["openalex", "arxiv"]


class AggregationError(Exception):
    """Raised when aggregation cannot produce any results."""


class Aggregator:
    """Aggregate search results from multiple providers."""

    def __init__(self, registry: PluginRegistry) -> None:
        self.registry = registry

    def _select_sources(self, sources: list[str] | None) -> list[SearchProvider]:
        """Return enabled providers that advertise keyword search."""
        candidates = self.registry.get_enabled_plugins(sources)
        return [
            p
            for p in candidates
            if isinstance(p, SearchProvider) and p.has_capability("search_keyword")
        ]

    async def _search_one(
        self,
        provider: SearchProvider,
        query: str,
        top_k: int,
        end_date: str | None,
        native_params: dict[str, Any] | None,
    ) -> tuple[str, list[SearchResultItem], Failure | None, int]:
        """Call a single provider and classify any failure."""
        start = time.perf_counter_ns()
        try:
            items = await provider.search(
                query,
                top_k,
                end_date=end_date,
                native_params=native_params,
            )
        except SourceError as exc:
            elapsed = (time.perf_counter_ns() - start) // 1_000_000
            failure = Failure(
                stage="recall",
                source=provider.name,
                error_type=exc.error_type,
                message=str(exc),
            )
            return provider.name, [], failure, elapsed
        except Exception as exc:  # pragma: no cover - defensive catch
            elapsed = (time.perf_counter_ns() - start) // 1_000_000
            failure = Failure(
                stage="recall",
                source=provider.name,
                error_type="unknown",
                message=str(exc),
            )
            return provider.name, [], failure, elapsed

        elapsed = (time.perf_counter_ns() - start) // 1_000_000
        return provider.name, items, None, elapsed

    def _deduplicate(
        self,
        items_by_source: dict[str, list[SearchResultItem]],
    ) -> dict[str, tuple[Paper, list[tuple[str, int]]]]:
        """Group normalized results by stable ID and merge duplicates."""
        groups: dict[str, list[tuple[Paper, str, int]]] = {}

        for source, items in items_by_source.items():
            for item in items:
                paper = search_result_item_to_paper(item)
                key = paper.doi or paper.arxiv_id or paper.openalex_id or paper.paper_id
                rank = item.source_rank or 1
                groups.setdefault(key, []).append((paper, source, rank))

        merged: dict[str, tuple[Paper, list[tuple[str, int]]]] = {}
        for key, group in groups.items():
            papers = [paper for paper, _, _ in group]
            paper = merge_papers(papers, _SOURCE_PREFERENCE)
            source_ranks = [(source, rank) for _, source, rank in group]
            merged[key] = (paper, source_ranks)

        return merged

    def _rank(
        self,
        merged: dict[str, tuple[Paper, list[tuple[str, int]]]],
        top_k: int,
        k: int = _DEFAULT_RRF_K,
    ) -> list[RankedPaper]:
        """Score merged papers with RRF and return the top_k ranked list."""
        scored: list[tuple[float, Paper, list[str]]] = []
        for paper, source_ranks in merged.values():
            score = sum(1.0 / (k + rank) for _, rank in source_ranks)
            scored.append((score, paper, [source for source, _ in source_ranks]))

        scored.sort(key=lambda entry: entry[0], reverse=True)

        ranked: list[RankedPaper] = []
        for idx, (score, paper, _sources) in enumerate(scored[:top_k], start=1):
            ranked.append(
                RankedPaper(
                    **paper.model_dump(),
                    score=score,
                    rank=idx,
                    tier="partially_relevant",
                )
            )
        return ranked

    async def aggregate(
        self,
        query: str,
        top_k: int,
        end_date: str | None,
        sources: list[str] | None,
        timeout_ms: int,
        provider_params: dict[str, dict[str, Any]] | None,
    ) -> tuple[list[RankedPaper], SearchState, Provenance, int]:
        """Run a multi-source aggregated search.

        Returns the ranked paper list, search state, provenance, and elapsed
        milliseconds. Raises ``AggregationError`` if no provider can be selected
        or if all providers fail.
        """
        selected = self._select_sources(sources)
        if not selected:
            raise AggregationError("No enabled providers support keyword search.")

        # Fetch more than top_k from each source so RRF has candidates to merge.
        per_provider_top_k = top_k * 2
        tasks = [
            asyncio.create_task(
                self._search_one(
                    provider,
                    query,
                    per_provider_top_k,
                    end_date,
                    (provider_params or {}).get(provider.name),
                )
            )
            for provider in selected
        ]

        start = time.perf_counter_ns()
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*tasks),
                timeout=timeout_ms / 1000.0,
            )
        except TimeoutError as exc:
            raise AggregationError(f"Aggregation timed out after {timeout_ms}ms") from exc

        items_by_source: dict[str, list[SearchResultItem]] = {}
        issued_queries: list[IssuedQuery] = []
        failures: list[Failure] = []

        for name, items, failure, latency_ms in results:
            if failure is not None:
                failures.append(failure)
                continue
            items_by_source[name] = items
            issued_queries.append(
                IssuedQuery(
                    provider=name,
                    mode="aggregated",
                    query=query,
                    raw=(provider_params or {}).get(name),
                    latency_ms=latency_ms,
                )
            )

        if not items_by_source:
            raise AggregationError("All providers failed.")

        merged = self._deduplicate(items_by_source)
        ranked = self._rank(merged, top_k)

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        search_state = SearchState(
            issued_queries=issued_queries,
            selected_sources=[provider.name for provider in selected],
            filters={"end_date": end_date} if end_date else {},
            candidate_counts=CandidateCounts(
                recalled=sum(len(items) for items in items_by_source.values()),
                returned=len(ranked),
            ),
            failures=failures,
        )
        provenance = Provenance(
            per_paper_sources={paper.paper_id: paper.sources for paper in ranked},
        )

        return ranked, search_state, provenance, elapsed_ms
