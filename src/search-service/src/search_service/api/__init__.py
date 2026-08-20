"""HTTP API routers for the Search Service."""

from __future__ import annotations

from search_service.api.providers import router as providers_router
from search_service.api.search import router as search_router

__all__ = [
    "providers_router",
    "search_router",
]
