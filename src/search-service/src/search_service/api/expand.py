"""Citation-graph expansion.

``POST /expand/citations`` walks the citation graph outward from a set of seeds
and returns the papers it reached, normalized.

Everything about the walk is bounded, and the bounds come from configuration
(``limits.expand``), never from the request. That is a design requirement rather
than caution: ``docs/design.md`` §4 puts depth, fan-out, concurrency and total
candidate count under $\\theta^S_k$, and a bound the caller supplies is not a
bound. The request may ask for *less* than the configured ceiling and be obeyed;
it may ask for more and be clamped, and the response says so.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.exceptions import SourceError
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import ExpandRequest, ExpandResponse, Failure, Paper, search_result_item_to_paper
from search_service.schemas.paper import CitationEdge

router = APIRouter(tags=["expand"])

_DIRECTION_CAPABILITY = {"backward": "graph_references", "forward": "graph_citations"}


def _clamp(requested: int | None, ceiling: int) -> tuple[int, bool]:
    """Return the effective value and whether the request was clamped."""
    if requested is None:
        return ceiling, False
    if requested < 1:
        return 1, True
    if requested > ceiling:
        return ceiling, True
    return requested, False


def _capable_providers(registry: PluginRegistry, capability: str) -> list[SearchProvider]:
    return [
        plugin.instance
        for plugin in registry.list_plugins()
        if plugin.enabled and isinstance(plugin.instance, SearchProvider) and plugin.instance.has_capability(capability)
    ]


def _paper_key(paper: Paper) -> str:
    return paper.doi or paper.arxiv_id or paper.openalex_id or paper.paper_id


@router.post("/expand/citations", response_model=ExpandResponse)
async def expand_citations(payload: ExpandRequest, request: Request) -> ExpandResponse | JSONResponse:
    """Expand the citation graph from `seed_ids`, bounded by configuration."""
    registry: PluginRegistry = request.app.state.registry
    limits = request.app.state.config.get_limits()["expand"]

    capability = _DIRECTION_CAPABILITY[payload.direction]
    providers = _capable_providers(registry, capability)
    if not providers:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={
                "detail": (
                    f"No enabled provider advertises the {capability} capability, so "
                    f"{payload.direction} expansion is not available. Check GET /providers."
                )
            },
        )

    depth, depth_clamped = _clamp(payload.depth, int(limits["max_depth"]))
    fanout, fanout_clamped = _clamp(payload.fanout, int(limits["max_fanout_per_seed"]))
    max_seeds = int(limits["max_seeds"])
    max_total = int(limits["max_total_candidates"])
    concurrency = max(1, int(limits["max_concurrency"]))

    seeds = [seed.strip() for seed in payload.seed_ids if seed.strip()]
    seeds_clamped = len(seeds) > max_seeds
    frontier = seeds[:max_seeds]
    if not frontier:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "seed_ids must contain at least one non-empty identifier."},
        )

    # Concurrency is capped by a semaphore rather than by batching, so one slow
    # provider cannot serialise the whole walk while still never exceeding the
    # configured parallelism.
    gate = asyncio.Semaphore(concurrency)
    failures: list[Failure] = []
    edges: list[CitationEdge] = []
    reached: dict[str, Paper] = {}
    visited: set[str] = set(frontier)
    calls = 0
    truncated_by_total = False

    async def _one(provider: SearchProvider, seed: str) -> tuple[str, str, list[dict[str, Any]] | None]:
        async with gate:
            try:
                if payload.direction == "backward":
                    return provider.name, seed, await provider.get_references(seed, fanout)
                return provider.name, seed, await provider.get_citations(seed, fanout)
            except SourceError as exc:
                failures.append(
                    Failure(
                        stage="expand", source=provider.name, error_type=exc.error_type, message=f"seed {seed!r}: {exc}"
                    )
                )
            except NotImplementedError as exc:
                failures.append(
                    Failure(
                        stage="expand",
                        source=provider.name,
                        error_type="unknown",
                        message=f"advertises {capability} but does not implement it: {exc}",
                    )
                )
            except Exception as exc:  # pragma: no cover - defensive catch
                failures.append(
                    Failure(stage="expand", source=provider.name, error_type="unknown", message=f"seed {seed!r}: {exc}")
                )
            return provider.name, seed, None

    for _ in range(depth):
        if not frontier or truncated_by_total:
            break
        tasks = [_one(provider, seed) for provider in providers for seed in frontier]
        calls += len(tasks)
        results = await asyncio.gather(*tasks)

        next_frontier: list[str] = []
        for provider_name, seed, raw_items in results:
            if raw_items is None:
                continue
            for raw in raw_items:
                if len(reached) >= max_total:
                    truncated_by_total = True
                    break
                paper = _normalize(provider_name, raw)
                if paper is None:
                    continue
                key = _paper_key(paper)
                edges.append(
                    CitationEdge(
                        source_id=seed if payload.direction == "backward" else key,
                        target_id=key if payload.direction == "backward" else seed,
                        edge_type="references" if payload.direction == "backward" else "cites",
                    )
                )
                if key in reached or key in visited:
                    continue
                reached[key] = paper
                next_frontier.append(key)
            if truncated_by_total:
                break
        visited.update(next_frontier)
        frontier = next_frontier[:max_seeds]

    return ExpandResponse(
        papers=list(reached.values()),
        edges=edges,
        direction=payload.direction,
        effective_limits={
            "depth": depth,
            "fanout": fanout,
            "max_seeds": max_seeds,
            "max_total_candidates": max_total,
            "max_concurrency": concurrency,
        },
        clamped=[
            name
            for name, was_clamped in (
                ("depth", depth_clamped),
                ("fanout", fanout_clamped),
                ("seed_ids", seeds_clamped),
                ("max_total_candidates", truncated_by_total),
            )
            if was_clamped
        ],
        provider_calls=calls,
        failures=failures,
    )


def _normalize(provider_name: str, raw: dict[str, Any]) -> Paper | None:
    """Turn a provider's raw graph record into a unified Paper.

    OpenAlex graph methods return raw works, so the provider's own parser is the
    only thing that knows their shape; importing it here keeps the endpoint from
    growing provider knowledge of its own.
    """
    if provider_name == "openalex":
        from search_service.plugins.openalex import _parse_work

        try:
            return search_result_item_to_paper(_parse_work(raw))
        except Exception:  # pragma: no cover - a malformed record is skipped, not fatal
            return None
    try:
        from search_service.models import SearchResultItem

        return search_result_item_to_paper(SearchResultItem.model_validate(raw))
    except Exception:
        return None
