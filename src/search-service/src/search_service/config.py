"""Configuration loading for the search service.

Configuration is layered:
1. Default values.
2. YAML config file (default: ./config.yaml).
3. Environment variables (highest priority).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from search_service.exceptions import ConfigError


class Settings(BaseSettings):
    """Environment-variable based settings."""

    model_config = SettingsConfigDict(
        env_prefix="SEARCH_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    config_file: str = Field(default="./config.yaml", alias="SEARCH_CONFIG_FILE")
    plugin_dirs: str = Field(default="", alias="SEARCH_PLUGIN_DIRS")
    service_host: str = Field(default="0.0.0.0", alias="SEARCH_SERVICE_HOST")
    service_port: int = Field(default=8000, alias="SEARCH_SERVICE_PORT")
    log_level: str = Field(default="info", alias="SEARCH_LOG_LEVEL")

    # Sensitive credentials that can be injected purely via env vars.
    openalex_api_key: str = Field(default="", alias="OPENALEX_API_KEY")
    openalex_mailto: str = Field(default="", alias="OPENALEX_MAILTO")
    serper_api_key: str = Field(default="", alias="SERPER_API_KEY")


class ServiceConfig:
    """Layered configuration holder."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()
        self._yaml: dict[str, Any] = self._load_yaml()

    def _load_yaml(self) -> dict[str, Any]:
        path = Path(self.settings.config_file)
        if not path.exists():
            return {}
        try:
            with path.open("r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
                return data if isinstance(data, dict) else {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"Failed to parse YAML config file {path}: {exc}") from exc
        except OSError as exc:
            raise ConfigError(f"Failed to read config file {path}: {exc}") from exc

    def get_service_config(self) -> dict[str, Any]:
        """Return service-level config with env overrides."""
        cfg = dict(self._yaml.get("service", {}))
        cfg["host"] = self.settings.service_host or cfg.get("host", "0.0.0.0")
        cfg["port"] = self.settings.service_port or cfg.get("port", 8000)
        cfg["log_level"] = self.settings.log_level or cfg.get("log_level", "info")
        return cfg

    def get_cache_config(self) -> dict[str, Any]:
        """Return cache-level config."""
        return dict(self._yaml.get("cache", {"ttl_seconds": 300}))

    def get_plugin_config(self, name: str) -> dict[str, Any]:
        """Return config dict for a named plugin.

        Sensitive fields left empty in YAML are resolved from environment variables
        using conventional names.
        """
        plugins = self._yaml.get("plugins", {})
        cfg: dict[str, Any] = dict(plugins.get(name, {})) if isinstance(plugins, dict) else {}

        if name == "openalex":
            cfg["api_key"] = cfg.get("api_key") or self.settings.openalex_api_key or None
            cfg["mailto"] = cfg.get("mailto") or self.settings.openalex_mailto or None
        elif name == "serper":
            cfg["api_key"] = cfg.get("api_key") or self.settings.serper_api_key or None

        return cfg

    def list_plugin_names(self) -> list[str]:
        """Return all plugin names declared in the YAML config."""
        plugins = self._yaml.get("plugins", {})
        if not isinstance(plugins, dict):
            return []
        return list(plugins.keys())

    def get_plugin_dirs(self) -> list[Path]:
        """Return list of extra plugin directories to scan."""
        if not self.settings.plugin_dirs:
            return []
        return [Path(d.strip()) for d in self.settings.plugin_dirs.split(",") if d.strip()]
