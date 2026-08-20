"""Provider capability discovery and passthrough endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.config import ServiceConfig
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import PassthroughRequest, ProviderCapabilities, ProviderInfo

router = APIRouter(tags=["providers"])


def _get_config(request: Request) -> ServiceConfig:
    """Retrieve the service config from application state."""
    return request.app.state.config


def _get_registry(request: Request) -> PluginRegistry:
    """Retrieve the plugin registry from application state."""
    return request.app.state.registry


def _capabilities_to_dict(caps: ProviderCapabilities) -> dict[str, Any]:
    """Flatten a ProviderCapabilities model to a plain capability flag dict."""
    return {
        "search_keyword": caps.search_keyword,
        "search_native_query": caps.search_native_query,
        "search_field_filter": caps.search_field_filter,
        "facet_group_by": caps.facet_group_by,
        "id_lookup": caps.id_lookup,
        "id_mapping": caps.id_mapping,
        "graph_references": caps.graph_references,
        "graph_citations": caps.graph_citations,
        "recommend_related": caps.recommend_related,
        "metrics_raw_citations": caps.metrics_raw_citations,
        "metrics_normalized": caps.metrics_normalized,
        "text_abstract": caps.text_abstract,
        "text_fulltext": caps.text_fulltext,
    }


def _build_provider_info(name: str, cfg: dict[str, Any], caps: Any | None) -> ProviderInfo:
    """Build a ProviderInfo from raw config, optionally enriched with runtime capabilities."""
    if isinstance(caps, ProviderCapabilities):
        capabilities = _capabilities_to_dict(caps)
        cost_model = {k: v.model_dump() for k, v in caps.cost_model.items()}
        field_map = caps.field_map
        reliability = caps.reliability.model_dump()
    else:
        caps_cfg = cfg.get("capabilities", {})
        capabilities = {
            "search_keyword": bool(caps_cfg.get("search_keyword", False)),
            "search_native_query": bool(caps_cfg.get("search_native_query", False)),
            "search_field_filter": bool(caps_cfg.get("search_field_filter", False)),
            "facet_group_by": bool(caps_cfg.get("facet_group_by", False)),
            "id_lookup": bool(caps_cfg.get("id_lookup", False)),
            "id_mapping": bool(caps_cfg.get("id_mapping", False)),
            "graph_references": bool(caps_cfg.get("graph_references", False)),
            "graph_citations": bool(caps_cfg.get("graph_citations", False)),
            "recommend_related": bool(caps_cfg.get("recommend_related", False)),
            "metrics_raw_citations": bool(caps_cfg.get("metrics_raw_citations", False)),
            "metrics_normalized": bool(caps_cfg.get("metrics_normalized", False)),
            "text_abstract": bool(caps_cfg.get("text_abstract", False)),
            "text_fulltext": bool(caps_cfg.get("text_fulltext", False)),
        }
        cost_model = cfg.get("cost_model", {})
        field_map = cfg.get("field_map", {})
        reliability = cfg.get("reliability", {})

    return ProviderInfo(
        name=name,
        enabled=bool(cfg.get("enabled", False)),
        capabilities=capabilities,
        cost_model=cost_model,
        field_map=field_map,
        reliability=reliability,
    )


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers(request: Request) -> list[ProviderInfo]:
    """Return capability and quota information for all configured providers."""
    config = _get_config(request)
    registry = _get_registry(request)
    plugins = config.get_plugins_config()
    runtime_caps = registry.list_provider_capabilities()

    return [
        _build_provider_info(name, raw_cfg, runtime_caps.get(name))
        for name, raw_cfg in plugins.items()
    ]


@router.post("/provider/{name}/query")
async def provider_passthrough(name: str, payload: PassthroughRequest, request: Request) -> JSONResponse:
    """Execute a provider-native query with governance but no result rewriting.

    The provider must advertise ``search_native_query`` capability. The Service
    applies budget/time-bound governance but does not rewrite the native query
    expression.
    """
    registry = _get_registry(request)
    loaded = registry.list_plugins()
    plugin_entry = next((p for p in loaded if p.name == name), None)

    if plugin_entry is None or not plugin_entry.enabled:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"detail": f"Provider '{name}' is not configured or disabled."},
        )

    instance = plugin_entry.instance
    if instance is None:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": f"Provider '{name}' failed to load."},
        )

    if not isinstance(instance, SearchProvider):
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={"detail": f"Provider '{name}' does not support native query passthrough."},
        )

    if not instance.has_capability("search_native_query"):
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={"detail": f"Provider '{name}' does not advertise search_native_query capability."},
        )

    try:
        raw_result = await instance.search_native(payload.raw)
    except Exception as exc:  # pragma: no cover - provider errors surfaced generically
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": f"Provider '{name}' query failed: {exc}"},
        )

    if payload.normalize:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={"detail": "normalize=true is not yet implemented for passthrough."},
        )

    return JSONResponse(content=raw_result)
