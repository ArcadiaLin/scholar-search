"""Plugin discovery, loading, and registry for source adapters.

A source plugin is a Python file that exposes a top-level symbol ``Plugin``
referencing a class implementing :class:`SourcePlugin`.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import logging
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from search_service.config import ServiceConfig
from search_service.exceptions import PluginError
from search_service.models import SearchResultItem, SourceHealth

logger = logging.getLogger(__name__)


class SourcePlugin(ABC):
    """Abstract base class for source plugins."""

    name: str = ""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    @abstractmethod
    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        """Execute a search and return normalized result items.

        ``native_params`` contains provider-native query parameters that should
        be merged with the unified ``query`` and ``top_k`` request.
        """
        ...

    def search_sync(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        """Synchronous wrapper around :meth:`search`."""
        return asyncio.run(self.search(query, top_k, end_date=end_date, native_params=native_params))

    async def healthcheck(self) -> dict[str, Any]:
        """Return optional health metadata."""
        return {"ok": True}


class LoadedPlugin:
    """Wrapper around an instantiated plugin plus load-time metadata."""

    def __init__(
        self,
        name: str,
        instance: SourcePlugin | None,
        enabled: bool,
        error: str | None = None,
        capabilities: Any | None = None,
    ) -> None:
        self.name = name
        self.instance = instance
        self.enabled = enabled
        self.error = error
        self.capabilities = capabilities

    @property
    def ok(self) -> bool:
        if not self.enabled:
            return True
        return self.instance is not None and self.error is None


class PluginRegistry:
    """Discovers and holds source plugin instances."""

    def __init__(self, config: ServiceConfig) -> None:
        self.config = config
        self._plugins: dict[str, LoadedPlugin] = {}

    def load(self) -> None:
        """Scan plugin directories and load enabled plugins."""
        self._plugins = {}
        builtin_dir = Path(__file__).parent / "plugins"
        dirs = [builtin_dir, *self.config.get_plugin_dirs()]

        for directory in dirs:
            if not directory.exists() or not directory.is_dir():
                logger.warning("Plugin directory does not exist: %s", directory)
                continue
            self._scan_directory(directory)

    def _scan_directory(self, directory: Path) -> None:
        for file_path in sorted(directory.glob("*.py")):
            if file_path.name.startswith("_"):
                continue
            name = file_path.stem
            plugin_config = self.config.get_plugin_config(name)
            enabled = bool(plugin_config.get("enabled", False))

            if not enabled:
                self._plugins[name] = LoadedPlugin(name=name, instance=None, enabled=False)
                logger.info("Plugin '%s' is disabled by configuration", name)
                continue

            try:
                instance = self._load_plugin(file_path, name, plugin_config)
                capabilities = getattr(instance, "capabilities", None)
                self._plugins[name] = LoadedPlugin(
                    name=name,
                    instance=instance,
                    enabled=True,
                    capabilities=capabilities,
                )
                logger.info("Loaded plugin '%s' from %s", name, file_path)
            except Exception as exc:
                logger.exception("Failed to load plugin '%s'", name)
                self._plugins[name] = LoadedPlugin(
                    name=name,
                    instance=None,
                    enabled=True,
                    error=f"{type(exc).__name__}: {exc}",
                )

    def _load_plugin(self, file_path: Path, name: str, plugin_config: dict[str, Any]) -> SourcePlugin:
        module_name = f"search_service.plugins.{name}"
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec is None or spec.loader is None:
            raise PluginError(f"Cannot create module spec for {file_path}")

        module = importlib.util.module_from_spec(spec)
        # Register in sys.modules so that runtime patches and imports resolve
        # to the same module object loaded here.
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        if not hasattr(module, "Plugin"):
            raise PluginError(f"Plugin file {file_path} does not expose 'Plugin'")

        plugin_cls = module.Plugin
        if not inspect.isclass(plugin_cls):
            raise PluginError(f"Plugin 'Plugin' in {file_path} is not a class")
        if not issubclass(plugin_cls, SourcePlugin):
            raise PluginError(f"Plugin 'Plugin' in {file_path} does not subclass SourcePlugin")

        instance = plugin_cls(plugin_config)
        if not instance.name:
            instance.name = name
        return instance

    def get_enabled_plugins(self, names: list[str] | None = None) -> list[SourcePlugin]:
        """Return enabled plugin instances, optionally filtered by name."""
        result: list[SourcePlugin] = []
        for loaded in self._plugins.values():
            if not loaded.enabled or loaded.instance is None:
                continue
            if names is not None and loaded.name not in names:
                continue
            result.append(loaded.instance)
        return result

    def list_provider_capabilities(self) -> dict[str, Any]:
        """Return capability tables keyed by provider name."""
        return {
            loaded.name: loaded.capabilities
            for loaded in self._plugins.values()
            if loaded.capabilities is not None
        }

    def list_plugins(self) -> list[LoadedPlugin]:
        return list(self._plugins.values())

    def health(self) -> list[SourceHealth]:
        return [
            SourceHealth(
                name=loaded.name,
                enabled=loaded.enabled,
                ok=loaded.ok,
                message=loaded.error if loaded.error else None,
            )
            for loaded in self._plugins.values()
        ]
