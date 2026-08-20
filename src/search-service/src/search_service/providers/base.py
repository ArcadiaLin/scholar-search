"""Capability-aware provider base class.

A ``SearchProvider`` is a ``SourcePlugin`` that additionally declares a
``ProviderCapabilities`` table and exposes optional pipeline operations
(search, native query, lookup, references, citations, facet). The pipeline
binds to capabilities, not provider names.
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Any

from search_service.plugin_loader import SourcePlugin
from search_service.schemas import ProviderCapabilities


class SearchProvider(SourcePlugin):
    """Base class for academic search providers.

    Subclasses must set ``capabilities`` (or override ``_build_capabilities``)
    and implement the operations they advertise. Operations whose capability
    flag is ``False`` may raise ``NotImplementedError`` or simply not be called.
    """

    capabilities: ProviderCapabilities

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self.capabilities = self._build_capabilities()

    @abstractmethod
    def _build_capabilities(self) -> ProviderCapabilities:
        """Return the capability table for this provider."""
        ...

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        filters: dict[str, Any] | None = None,
        subqueries: list[str] | None = None,
        end_date: str | None = None,
    ) -> list[Any]:
        """Keyword/natural-language search.

        Requires ``search_keyword`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement search()")

    async def search_native(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Execute a provider-native query and return the raw response.

        Requires ``search_native_query`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement search_native()")

    async def lookup(self, paper_id: str) -> dict[str, Any] | None:
        """Lookup a single paper by its stable ID and return raw provider data.

        Requires ``id_lookup`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement lookup()")

    async def get_references(self, paper_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """Return outgoing reference edges for a paper.

        Requires ``graph_references`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement get_references()")

    async def get_citations(self, paper_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """Return incoming citation edges for a paper.

        Requires ``graph_citations`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement get_citations()")

    async def facet(self, query: str, group_by: list[str]) -> dict[str, Any]:
        """Return facet distribution for a query.

        Requires ``facet_group_by`` capability.
        """
        raise NotImplementedError(f"{self.name} does not implement facet()")

    def has_capability(self, capability: str) -> bool:
        """Return whether this provider advertises the given capability."""
        return getattr(self.capabilities, capability, False)
