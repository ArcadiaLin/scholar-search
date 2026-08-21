"""Configuration-driven registry for LLM providers."""

from __future__ import annotations

import logging

from search_service.config import ServiceConfig
from search_service.exceptions import LLMConfigError
from search_service.llm.base import LLMProvider
from search_service.llm.providers.openai_compatible import OpenAICompatibleProvider

logger = logging.getLogger(__name__)

_PROVIDER_TYPES: dict[str, type[LLMProvider]] = {
    "openai-compatible": OpenAICompatibleProvider,
}


class LLMRegistry:
    """Loads and resolves LLM providers from service configuration."""

    def __init__(self, config: ServiceConfig) -> None:
        self.config = config
        self._providers: dict[str, LLMProvider] = {}
        self._default: str | None = None

    def load(self) -> None:
        """Instantiate providers declared under ``llm_providers`` in config.yaml."""
        self._providers = {}
        cfg = self.config.get_llm_providers_config()
        self._default = cfg.get("default")
        providers_cfg = cfg.get("providers", {})
        if not isinstance(providers_cfg, dict):
            raise LLMConfigError("'llm_providers.providers' must be a mapping.")

        for name, provider_cfg in providers_cfg.items():
            if not isinstance(provider_cfg, dict):
                logger.warning("LLM provider '%s' config is not a mapping; skipping.", name)
                continue
            provider_type = provider_cfg.get("type")
            if not provider_type:
                logger.warning("LLM provider '%s' is missing 'type'; skipping.", name)
                continue
            cls = _PROVIDER_TYPES.get(provider_type)
            if cls is None:
                logger.warning("LLM provider '%s' has unknown type '%s'; skipping.", name, provider_type)
                continue
            try:
                self._providers[name] = cls(name, provider_cfg)
                logger.info("Loaded LLM provider '%s' (type=%s)", name, provider_type)
            except Exception as exc:
                logger.exception("Failed to load LLM provider '%s'", name)
                raise LLMConfigError(f"Failed to load LLM provider '{name}': {exc}") from exc

        if self._default and self._default not in self._providers:
            raise LLMConfigError(f"Default LLM provider '{self._default}' is not defined in 'llm_providers.providers'.")

    def list_provider_names(self) -> list[str]:
        """Return names of all loaded providers."""
        return list(self._providers.keys())

    def get(self, name: str | None = None) -> LLMProvider | None:
        """Return a provider by name, or the default provider when name is None."""
        resolved = name or self._default
        if resolved is None:
            return None
        return self._providers.get(resolved)

    def register_type(self, name: str, cls: type[LLMProvider]) -> None:
        """Register an additional provider type at runtime (mostly for tests)."""
        _PROVIDER_TYPES[name] = cls
