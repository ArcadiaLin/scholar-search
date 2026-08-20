"""HTTP API routers for the Search Service."""

from __future__ import annotations

from search_service.api.budget import router as budget_router
from search_service.api.expand import router as expand_router
from search_service.api.facet import router as facet_router
from search_service.api.paper import router as paper_router
from search_service.api.providers import router as providers_router
from search_service.api.rank import router as rank_router
from search_service.api.search import router as search_router

__all__ = [
    "budget_router",
    "expand_router",
    "facet_router",
    "paper_router",
    "providers_router",
    "rank_router",
    "search_router",
]
