"""FastAPI application for the search service."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from search_service import __version__
from search_service.aggregator import SearchAggregator
from search_service.api import (
    budget_router,
    expand_router,
    facet_router,
    paper_router,
    providers_router,
    rank_router,
    search_router,
)
from search_service.cache import TTLCache
from search_service.config import ServiceConfig
from search_service.models import HealthResponse
from search_service.models import SearchResponse as LegacySearchResponse
from search_service.plugin_loader import PluginRegistry

logger = logging.getLogger(__name__)

# Global state managed by the lifespan context.
_state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and teardown service state."""
    config = ServiceConfig()
    registry = PluginRegistry(config)
    registry.load()

    cache_config = config.get_cache_config()
    cache = TTLCache[LegacySearchResponse](
        ttl_seconds=float(cache_config.get("ttl_seconds", 300)),
    )
    aggregator = SearchAggregator(registry, cache)

    _state["config"] = config
    _state["registry"] = registry
    _state["cache"] = cache
    _state["aggregator"] = aggregator

    app.state.config = config
    app.state.registry = registry
    app.state.cache = cache
    app.state.aggregator = aggregator

    enabled = [p.name for p in registry.get_enabled_plugins()]
    logger.info("Search service started with enabled plugin(s): %s", enabled)
    yield
    _state.clear()


app = FastAPI(
    title="Scholar Search Service",
    version=__version__,
    description="Pluggable HTTP aggregation service for academic paper search.",
    lifespan=lifespan,
)

# Include API routers. Order matters for documentation only; FastAPI resolves
# paths uniquely by their full path + method.
app.include_router(search_router)
app.include_router(providers_router)
app.include_router(rank_router)
app.include_router(expand_router)
app.include_router(facet_router)
app.include_router(paper_router)
app.include_router(budget_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all handler to avoid leaking internal tracebacks."""
    logger.exception("Unhandled exception during request: %s %s", request.method, request.url)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


def get_config() -> ServiceConfig:
    return _state["config"]


def get_registry() -> PluginRegistry:
    return _state["registry"]


def get_aggregator() -> SearchAggregator:
    return _state["aggregator"]


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Return service health and plugin status."""
    registry = get_registry()
    return HealthResponse(
        status="ok",
        version=__version__,
        sources=registry.health(),
    )


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "scholar-search-service", "version": __version__}
