"""LLM provider adapters for the search service.

This package is intentionally separate from ``search_service.plugin_loader``:
LLM providers are not academic source plugins and have a different lifecycle.
"""

from __future__ import annotations

from search_service.llm.base import LLMProvider
from search_service.llm.registry import LLMRegistry

__all__ = ["LLMProvider", "LLMRegistry"]
