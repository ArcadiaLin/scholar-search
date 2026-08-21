"""Tests for the LLM provider registry."""

from __future__ import annotations

from typing import Any

import pytest

from search_service.config import ServiceConfig
from search_service.exceptions import LLMConfigError
from search_service.llm import LLMProvider, LLMRegistry
from search_service.llm.base import LLMResult
from search_service.schemas import LLMMessage


def _config_from_dict(data: dict[str, Any]) -> ServiceConfig:
    """Build a ServiceConfig whose YAML source is the given dict."""
    cfg = ServiceConfig()
    cfg._yaml = data
    return cfg


def test_registry_loads_openai_compatible_provider():
    cfg = _config_from_dict(
        {
            "llm_providers": {
                "default": "local",
                "providers": {
                    "local": {
                        "type": "openai-compatible",
                        "base_url": "http://localhost:8000/v1",
                        "model": "test-model",
                    },
                },
            },
        }
    )
    registry = LLMRegistry(cfg)
    registry.load()

    assert registry.list_provider_names() == ["local"]
    assert registry.get() is not None
    assert registry.get("local").name == "local"


def test_registry_returns_none_when_no_default():
    cfg = _config_from_dict(
        {
            "llm_providers": {
                "providers": {
                    "remote": {
                        "type": "openai-compatible",
                        "base_url": "http://example.com/v1",
                        "model": "m",
                    },
                },
            },
        }
    )
    registry = LLMRegistry(cfg)
    registry.load()

    assert registry.get() is None
    assert registry.get("remote") is not None


def test_registry_raises_on_missing_default():
    cfg = _config_from_dict(
        {
            "llm_providers": {
                "default": "missing",
                "providers": {},
            },
        }
    )
    registry = LLMRegistry(cfg)

    with pytest.raises(LLMConfigError, match="missing"):
        registry.load()


def test_registry_skips_unknown_provider_type():
    cfg = _config_from_dict(
        {
            "llm_providers": {
                "providers": {
                    "weird": {"type": "future-provider", "base_url": "x", "model": "m"},
                },
            },
        }
    )
    registry = LLMRegistry(cfg)
    registry.load()

    assert registry.list_provider_names() == []


def test_registry_raises_on_missing_model():
    cfg = _config_from_dict(
        {
            "llm_providers": {
                "providers": {
                    "bad": {"type": "openai-compatible", "base_url": "http://x/v1"},
                },
            },
        }
    )
    registry = LLMRegistry(cfg)

    with pytest.raises(LLMConfigError, match="missing"):
        registry.load()


def test_registry_allows_runtime_type_registration():
    class DummyProvider(LLMProvider):
        async def chat(self, messages: list[LLMMessage], **kwargs: Any) -> LLMResult:
            return LLMResult(provider=self.name, model="dummy", output={})

    cfg = _config_from_dict(
        {
            "llm_providers": {
                "providers": {
                    "dummy": {"type": "dummy", "model": "ignored"},
                },
            },
        }
    )
    registry = LLMRegistry(cfg)
    registry.register_type("dummy", DummyProvider)
    registry.load()

    provider = registry.get("dummy")
    assert provider is not None
    assert provider.name == "dummy"
