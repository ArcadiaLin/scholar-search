"""Shared test fixtures."""

from __future__ import annotations

from typing import Any

import pytest

from search_service.models import SearchResultItem
from search_service.plugin_loader import SourcePlugin


@pytest.fixture(autouse=True)
def _set_dummy_api_keys(monkeypatch):
    """Provide dummy API keys so that plugins load during integration tests."""
    monkeypatch.setenv("SERPER_API_KEY", "test-key")


class MockPlugin(SourcePlugin):
    """Test-only source plugin."""

    def __init__(self, name: str, results: list[SearchResultItem], fail_with: Exception | None = None):
        super().__init__({"enabled": True})
        self.name = name
        self._results = results
        self._fail_with = fail_with

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        if self._fail_with is not None:
            raise self._fail_with
        return self._results[:top_k]


def make_item(paper_id: str, title: str, source: str, rank: int = 1, **kwargs) -> SearchResultItem:
    return SearchResultItem(
        paper_id=paper_id,
        title=title,
        source=source,
        source_rank=rank,
        **kwargs,
    )
