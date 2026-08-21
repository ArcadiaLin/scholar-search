"""HTTP API routers for the Search Service."""

from __future__ import annotations

from search_service.api.expand import router as expand_router
from search_service.api.fulltext import router as fulltext_router
from search_service.api.judge import router as judge_router
from search_service.api.paper import router as paper_router
from search_service.api.probe import router as probe_router
from search_service.api.providers import router as providers_router
from search_service.api.search import router as search_router

__all__ = [
    "expand_router",
    "fulltext_router",
    "judge_router",
    "paper_router",
    "probe_router",
    "providers_router",
    "search_router",
]
