"""Search aggregation: parallel source calls, deduplication, and error handling."""

from __future__ import annotations

import asyncio
import re
import time

from search_service.cache import TTLCache
from search_service.exceptions import SourceError
from search_service.models import SearchRequest, SearchResponse, SearchResultItem, SourceErrorModel
from search_service.plugin_loader import PluginRegistry, SourcePlugin

_DEFAULT_SOURCES_BY_MODE: dict[str, list[str]] = {
    "metadata": ["openalex", "arxiv"],
    "fulltext": ["arxiv", "serper"],
}

_SOURCE_PRIORITY = {"openalex": 0, "arxiv": 1, "serper": 2}


def _normalize_title(title: str) -> str:
    """Create a stable fallback key from a title for deduplication."""
    cleaned = re.sub(r"[^\w\s]", "", title.lower())
    return cleaned.strip()[:80]


class SearchAggregator:
    """Aggregates results from multiple source plugins."""

    def __init__(self, registry: PluginRegistry, cache: TTLCache[SearchResponse]) -> None:
        self.registry = registry
        self.cache = cache

    def _select_sources(self, request: SearchRequest) -> list[str]:
        if request.sources:
            return request.sources
        return _DEFAULT_SOURCES_BY_MODE.get(request.mode, _DEFAULT_SOURCES_BY_MODE["metadata"])

    async def search(self, request: SearchRequest) -> SearchResponse:
        """Execute a search across selected sources and return aggregated results."""
        start = time.perf_counter_ns()
        cache_key = {
            "query": request.query,
            "mode": request.mode,
            "top_k": request.top_k,
            "sources": request.sources,
        }
        cached = await self.cache.get(cache_key)
        if cached is not None:
            # Return a copy so the cached object remains marked as uncached.
            return cached.model_copy(update={"cached": True})

        source_names = self._select_sources(request)
        plugins = self.registry.get_enabled_plugins(source_names)
        errors: list[SourceErrorModel] = []

        if not plugins:
            elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
            errors.append(
                SourceErrorModel(
                    source="aggregator",
                    error_type="disabled",
                    message=f"No enabled sources available for mode '{request.mode}'",
                )
            )
            return SearchResponse(
                query=request.query,
                mode=request.mode,
                results=[],
                total=0,
                source_counts={},
                errors=errors,
                elapsed_ms=elapsed_ms,
                cached=False,
            )

        coros = [self._call_plugin(plugin, request.query, request.top_k) for plugin in plugins]
        raw_results = await asyncio.gather(*coros, return_exceptions=True)

        all_items: list[SearchResultItem] = []
        source_counts: dict[str, int] = {}
        for plugin, result in zip(plugins, raw_results, strict=False):
            if isinstance(result, SourceError):
                errors.append(SourceErrorModel(source=result.source, error_type=result.error_type, message=result.message))
            elif isinstance(result, Exception):
                errors.append(
                    SourceErrorModel(
                        source=plugin.name,
                        error_type="unknown",
                        message=f"{type(result).__name__}: {result}",
                    )
                )
            else:
                items: list[SearchResultItem] = result
                source_counts[plugin.name] = len(items)
                all_items.extend(items)

        merged = self._deduplicate_and_merge(all_items)
        merged = merged[: request.top_k]

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        response = SearchResponse(
            query=request.query,
            mode=request.mode,
            results=merged,
            total=len(merged),
            source_counts=source_counts,
            errors=errors,
            elapsed_ms=elapsed_ms,
            cached=False,
        )

        if not errors or merged:
            await self.cache.set(cache_key, response)

        return response

    async def _call_plugin(
        self, plugin: SourcePlugin, query: str, top_k: int
    ) -> list[SearchResultItem]:
        return await plugin.search(query, top_k)

    def _deduplicate_and_merge(self, items: list[SearchResultItem]) -> list[SearchResultItem]:
        """Deduplicate by paper_id (or title fallback) and merge field values."""
        by_id: dict[str, list[SearchResultItem]] = {}
        unmatched: list[SearchResultItem] = []

        for item in items:
            key = item.paper_id if item.paper_id else _normalize_title(item.title)
            if key:
                by_id.setdefault(key, []).append(item)
            else:
                unmatched.append(item)

        merged: list[SearchResultItem] = []
        for group in by_id.values():
            merged.append(self._merge_group(group))
        merged.extend(unmatched)

        # Stable sort: by source priority, then source_rank.
        def sort_key(item: SearchResultItem) -> tuple[int, int]:
            priority = _SOURCE_PRIORITY.get(item.source, 99)
            rank = item.source_rank or 9999
            return (priority, rank)

        merged.sort(key=sort_key)
        return merged

    def _merge_group(self, group: list[SearchResultItem]) -> SearchResultItem:
        """Merge multiple items representing the same paper into one."""
        # Prefer sources in priority order for metadata.
        group_sorted = sorted(
            group,
            key=lambda item: (_SOURCE_PRIORITY.get(item.source, 99), item.source_rank or 9999),
        )
        base = group_sorted[0]

        urls: dict[str, str | None] = dict(base.urls)
        authors = base.authors
        abstract = base.abstract
        doi = base.doi
        arxiv_id = base.arxiv_id
        openalex_id = base.openalex_id
        published = base.published
        year = base.year

        for item in group_sorted[1:]:
            for url_type, url in item.urls.items():
                if url and not urls.get(url_type):
                    urls[url_type] = url
            if item.authors and not authors:
                authors = item.authors
            if item.abstract and not abstract:
                abstract = item.abstract
            if item.doi and not doi:
                doi = item.doi
            if item.arxiv_id and not arxiv_id:
                arxiv_id = item.arxiv_id
            if item.openalex_id and not openalex_id:
                openalex_id = item.openalex_id
            if item.published and not published:
                published = item.published
            if item.year and not year:
                year = item.year

        return SearchResultItem(
            paper_id=base.paper_id,
            title=base.title,
            authors=authors,
            abstract=abstract,
            published=published,
            year=year,
            doi=doi,
            arxiv_id=arxiv_id,
            openalex_id=openalex_id,
            urls=urls,
            source="merged",
            source_rank=base.source_rank,
            raw=None,
        )
