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
    canonical_key,
    merge_papers,
    search_result_item_to_paper,
)

_DEFAULT_RRF_K = 60
_SOURCE_PREFERENCE = ["openalex", "arxiv"]


class AggregationError(Exception):
    """Raised when aggregation cannot produce any results.

    Carries the classified failures and the sources that were *not* tried. When
    every provider fails, the caller's next move depends entirely on which kind of
    failure it was - a rate limit means wait, an empty result means rephrase, a
    source fault means switch source - and the previous version raised a bare
    string with the ``Failure`` list already built and then discarded
    (``docs/develop/backlog.md`` F-2).
    """

    def __init__(
        self,
        message: str,
        *,
        failures: list[Failure] | None = None,
        alternative_sources: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.failures = failures or []
        #: Enabled providers that advertise keyword search and were not selected.
        #: Empty means "there is no other source to try", which is the fact a
        #: caller needs before it retries somewhere else.
        self.alternative_sources = alternative_sources or []


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
    ) -> tuple[str, str, list[SearchResultItem], Failure | None, int]:
        """Call a single provider with a single query and classify any failure.

        Returns the query alongside the provider so a failure can name which
        decomposition failed, not just which source.
        """
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
                message=f"query {query!r}: {exc}",
            )
            return provider.name, query, [], failure, elapsed
        except Exception as exc:  # pragma: no cover - defensive catch
            elapsed = (time.perf_counter_ns() - start) // 1_000_000
            failure = Failure(
                stage="recall",
                source=provider.name,
                error_type="unknown",
                message=f"query {query!r}: {exc}",
            )
            return provider.name, query, [], failure, elapsed

        elapsed = (time.perf_counter_ns() - start) // 1_000_000
        return provider.name, query, items, None, elapsed

    def _deduplicate(
        self,
        items_by_list: dict[str, list[SearchResultItem]],
    ) -> dict[str, tuple[Paper, list[tuple[str, int]]]]:
        """Group normalized results by canonical identity and merge duplicates.

        Identity comes from ``canonical_key``, not from a local expression: the
        rule has to be the same one the answer pool and every endpoint use, or
        "the same paper" means different things in different places.

        The outer key identifies one *recall list*, which is a (provider, query)
        pair rather than a provider: a paper found by three subqueries contributes
        three RRF terms, and agreement across decompositions is exactly the signal
        the fusion exists to read. Provider attribution does not come from this
        key - it lives on ``Paper.sources``, set from the item itself.
        """
        groups: dict[str, list[tuple[Paper, str, int]]] = {}

        for list_id, items in items_by_list.items():
            for item in items:
                paper = search_result_item_to_paper(item)
                key = canonical_key(paper)
                rank = item.source_rank or 1
                groups.setdefault(key, []).append((paper, list_id, rank))

        merged: dict[str, tuple[Paper, list[tuple[str, int]]]] = {}
        for key, group in groups.items():
            papers = [paper for paper, _, _ in group]
            paper = merge_papers(papers, _SOURCE_PREFERENCE)
            list_ranks = [(list_id, rank) for _, list_id, rank in group]
            merged[key] = (paper, list_ranks)

        return merged

    def _rank(
        self,
        merged: dict[str, tuple[Paper, list[tuple[str, int]]]],
        top_k: int,
        k: int = _DEFAULT_RRF_K,
    ) -> list[RankedPaper]:
        """Score merged papers with RRF and return the top_k ranked list.

        One term per recall list the paper appeared in, so appearing in several
        lists outranks a single high placement.
        """
        scored: list[tuple[float, Paper]] = []
        for paper, list_ranks in merged.values():
            score = sum(1.0 / (k + rank) for _, rank in list_ranks)
            scored.append((score, paper))

        scored.sort(key=lambda entry: entry[0], reverse=True)

        ranked: list[RankedPaper] = []
        for idx, (score, paper) in enumerate(scored[:top_k], start=1):
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
        subqueries: list[str] | None = None,
    ) -> tuple[list[RankedPaper], SearchState, Provenance, int]:
        """Run a multi-source, multi-query aggregated search.

        Every (provider, query) pair is one recall list, and all of them are fused
        by RRF into a single ranking. Returns the ranked paper list, search state,
        provenance, and elapsed milliseconds. Raises ``AggregationError`` if no
        provider can be selected or if every call fails.
        """
        selected = self._select_sources(sources)
        if not selected:
            raise AggregationError("No enabled providers support keyword search.")
        by_name = {provider.name: provider for provider in selected}
        selected_names = set(by_name)
        alternatives = [
            provider.name for provider in self._select_sources(None) if provider.name not in selected_names
        ]

        # The main query first, then subqueries, deduplicated: an agent that
        # repeats the main query as a subquery must not pay for it twice.
        queries: list[str] = [query]
        for subquery in subqueries or []:
            if subquery not in queries:
                queries.append(subquery)

        # Fetch more than top_k from each list so RRF has candidates to merge.
        per_provider_top_k = top_k * 2
        tasks = [
            asyncio.create_task(
                self._search_one(
                    provider,
                    issued,
                    per_provider_top_k,
                    end_date,
                    (provider_params or {}).get(provider.name),
                )
            )
            for provider in selected
            for issued in queries
        ]

        start = time.perf_counter_ns()
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*tasks),
                timeout=timeout_ms / 1000.0,
            )
        except TimeoutError as exc:
            raise AggregationError(
                f"Aggregation timed out after {timeout_ms}ms",
                failures=[
                    Failure(
                        stage="recall",
                        source=None,
                        error_type="timeout",
                        message=(
                            f"{len(tasks)} provider call(s) did not all finish within {timeout_ms}ms. "
                            "Fewer subqueries or fewer sources per call is the lever; retrying the same "
                            "call unchanged is not."
                        ),
                    )
                ],
                alternative_sources=alternatives,
            ) from exc

        items_by_list: dict[str, list[SearchResultItem]] = {}
        issued_queries: list[IssuedQuery] = []
        failures: list[Failure] = []
        recalled = 0

        for name, issued, items, failure, latency_ms in results:
            if failure is not None:
                failures.append(failure)
                continue
            # One entry per (provider, query): the RRF key must distinguish the
            # lists, and merging them here would throw away exactly the agreement
            # signal the fusion is there to read.
            items_by_list[f"{name}::{issued}"] = items
            recalled += len(items)
            provider = by_name.get(name)
            issued_queries.append(
                IssuedQuery(
                    provider=name,
                    mode="aggregated",
                    query=issued,
                    native_query=(
                        None
                        if provider is None
                        else provider.native_query_for(
                            issued,
                            end_date=end_date,
                            native_params=(provider_params or {}).get(name),
                        )
                    ),
                    raw=(provider_params or {}).get(name),
                    latency_ms=latency_ms,
                )
            )

        if not items_by_list:
            raise AggregationError(
                "All providers failed.",
                failures=failures,
                alternative_sources=alternatives,
            )

        merged = self._deduplicate(items_by_list)
        ranked = self._rank(merged, top_k)

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        filters: dict[str, Any] = {}
        if end_date:
            filters["end_date"] = end_date
        if len(queries) > 1:
            filters["subqueries"] = queries[1:]
        search_state = SearchState(
            issued_queries=issued_queries,
            selected_sources=[provider.name for provider in selected],
            filters=filters,
            candidate_counts=CandidateCounts(recalled=recalled, returned=len(ranked)),
            failures=failures,
        )
        provenance = Provenance(
            per_paper_sources={paper.paper_id: paper.sources for paper in ranked},
        )

        return ranked, search_state, provenance, elapsed_ms
