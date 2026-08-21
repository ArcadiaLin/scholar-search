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


def _env_files() -> tuple[Path, ...]:
    """The ``.env`` files to read, lowest priority first.

    A bare ``".env"`` resolves against the **process** working directory, and the
    service is not started from the directory that holds the credentials:
    ``scripts/run-scholar.mjs`` runs uvicorn with ``cwd`` set to
    ``src/search-service`` so that ``config_file="./config.yaml"`` resolves, while
    the repository's ``.env`` sits at the root. The result was silent and
    expensive - ``openalex_api_key`` stayed empty, every OpenAlex call went out
    anonymous, and anonymous callers get the per-IP free budget (1000 credits a
    day, i.e. 100 list queries) instead of the key's own. It looked like rate
    limiting; it was a path.

    So both locations are read. The service-local file comes last because a
    ``.env`` placed next to ``config.yaml`` is the more specific statement.
    """
    repository_root = Path(__file__).resolve().parents[4]
    return (repository_root / ".env", Path(".env"))


class Settings(BaseSettings):
    """Environment-variable based settings."""

    model_config = SettingsConfigDict(
        env_prefix="SEARCH_",
        env_file=_env_files(),
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

    def get_limits(self) -> dict[str, Any]:
        """Return the effective operational bounds, merged over the defaults.

        These are $\\theta^S_k$: the service-side knobs the agent does not set.
        They live here rather than as constants in the pipeline because
        ``docs/design.md`` §4 requires expansion depth, fan-out, concurrency and
        total candidate count to be bounded *by configuration* - a hard-coded
        bound cannot be narrowed for an experiment, and a bound the agent passes
        in is not a bound at all.
        """
        configured = self._yaml.get("limits", {})
        limits: dict[str, Any] = {
            "expand": {
                "max_depth": 2,
                "max_seeds": 10,
                "max_fanout_per_seed": 25,
                "max_total_candidates": 200,
                "max_concurrency": 4,
            },
            "facet": {"max_group_by": 3},
            "rank": {"max_candidates": 500},
            "fulltext": {"max_papers": 5, "max_sections": 20, "max_section_chars": 2_000},
        }
        if isinstance(configured, dict):
            for section, values in configured.items():
                if section in limits and isinstance(values, dict):
                    limits[section] = {**limits[section], **values}
                elif isinstance(values, dict):
                    limits[section] = dict(values)
        return limits

    def get_judge_config(self) -> dict[str, Any]:
        """Return the judging configuration, merged over defaults.

        This is where $NP_k^{judge} \\to \\theta^S_k$ actually happens: `carrier`
        names the preference file whose entries reach the judging prompt, and the
        numeric fields are $HP_k$. ``carrier_path`` is resolved against this
        config file's directory so the pointer survives being run from anywhere.
        """
        configured = self._yaml.get("judge", {})
        judge: dict[str, Any] = {
            "enabled": True,
            "forced_level": None,
            "provider": None,
            "temperature": 0.0,
            "max_papers_l3b": 30,
            "max_criteria_per_query": 8,
            "carrier": "../../widis/.widi-scholar/preference/np-judge.md",
        }
        if isinstance(configured, dict):
            for key, value in configured.items():
                # `forced_level` and `provider` are meaningfully null, so unlike
                # the review section this merge keeps explicit nulls.
                judge[key] = value
        carrier = judge.get("carrier")
        judge["carrier_path"] = (
            (Path(self.settings.config_file).resolve().parent / str(carrier)).resolve() if carrier else None
        )
        return judge

    def get_review_config(self) -> dict[str, Any]:
        """Return the Sidecar Reviewer detector thresholds, merged over defaults.

        These are $HP_k$, and this file is their only authoritative carrier - the
        edge $\\theta^S_k = \\mathrm{Configure}(P, HP_k, NP_k^{judge})$ starts
        here. The consumer is a TypeScript extension whose only other
        configuration channel is environment variables, and thresholds scattered
        across those leave an $HP$ search nothing to vary
        (``docs/develop/decisions.md`` D-15).

        The defaults are duplicated here on purpose: a missing ``review:`` section
        must not leave the detectors comparing against ``None``, which would make
        every one of them silently never fire.
        """
        configured = self._yaml.get("review", {})
        review: dict[str, Any] = {
            "min_searches_before_facet_probe": 3,
            "subquery_jaccard_ceiling": 0.5,
            "min_subqueries_for_monotony": 2,
            "min_evidence_before_expansion": 10,
            "max_failures_per_source": 3,
            "max_fetch_per_search_ratio": 1.0,
            "soft_call_budget": 40,
        }
        if isinstance(configured, dict):
            review.update({key: value for key, value in configured.items() if value is not None})
        return review

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

    def get_plugins_config(self) -> dict[str, dict[str, Any]]:
        """Return the raw plugins configuration block from YAML.

        Values are returned as-read so that callers can inspect capabilities,
        cost models and field maps without losing nested structure.
        """
        plugins = self._yaml.get("plugins", {})
        if not isinstance(plugins, dict):
            return {}
        return {name: cfg for name, cfg in plugins.items() if isinstance(cfg, dict)}

    def get_plugin_dirs(self) -> list[Path]:
        """Return list of extra plugin directories to scan."""
        if not self.settings.plugin_dirs:
            return []
        return [Path(d.strip()) for d in self.settings.plugin_dirs.split(",") if d.strip()]

    def get_llm_providers_config(self) -> dict[str, Any]:
        """Return the raw ``llm_providers`` block from YAML."""
        cfg = self._yaml.get("llm_providers", {})
        return dict(cfg) if isinstance(cfg, dict) else {}

    def get_default_llm_provider(self) -> str | None:
        """Return the configured default LLM provider name, if any."""
        cfg = self.get_llm_providers_config()
        default = cfg.get("default")
        return str(default) if default else None
