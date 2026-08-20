"""Single-paper lookup endpoint.

``GET /paper/{paper_id}`` resolves one stable ID to a unified ``Paper``. It is
the read side of the ID space the aggregated search hands out: a ``paper_id``
that came back from ``/search`` must be resolvable without the caller knowing
which provider produced it.

Routing is by capability, never by provider name (``search-service.md`` §2.1):
the endpoint asks every enabled provider that advertises ``id_lookup`` whose ID
space this looks like, and tries those in order. A provider that advertises the
capability but cannot answer is a failure worth reporting, not a silent miss.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.exceptions import SourceError
from search_service.models import SearchResultItem
from search_service.plugin_loader import PluginRegistry
from search_service.providers.base import SearchProvider
from search_service.schemas import Failure, PaperResponse, search_result_item_to_paper

router = APIRouter(tags=["paper"])

_ARXIV_ID_RE = re.compile(r"^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$", re.IGNORECASE)
_DOI_RE = re.compile(r"^(doi:|https?://(dx\.)?doi\.org/)?10\.\d{4,9}/\S+$", re.IGNORECASE)
_OPENALEX_RE = re.compile(r"^(https?://openalex\.org/)?W\d+$", re.IGNORECASE)


def _preferred_providers(paper_id: str) -> list[str]:
    """Providers whose ID space this string plausibly belongs to, best first.

    An ID shape is a hint for ordering, not a filter: a DOI can be resolved by
    OpenAlex, and an unrecognised shape simply means "no preference", so every
    capable provider is still tried.
    """
    if _ARXIV_ID_RE.match(paper_id):
        return ["arxiv", "openalex"]
    if _OPENALEX_RE.match(paper_id) or _DOI_RE.match(paper_id):
        return ["openalex", "arxiv"]
    return []


def _capable_providers(registry: PluginRegistry, paper_id: str) -> list[SearchProvider]:
    """Enabled providers advertising ``id_lookup``, ordered by ID-shape preference."""
    capable = [
        plugin.instance
        for plugin in registry.list_plugins()
        if plugin.enabled
        and isinstance(plugin.instance, SearchProvider)
        and plugin.instance.has_capability("id_lookup")
    ]
    preference = _preferred_providers(paper_id)

    def _key(provider: SearchProvider) -> int:
        try:
            return preference.index(provider.name)
        except ValueError:
            return len(preference)

    return sorted(capable, key=_key)


@router.get("/paper/{paper_id:path}", response_model=PaperResponse)
async def get_paper(paper_id: str, request: Request) -> PaperResponse | JSONResponse:
    """Resolve one paper ID to a unified ``Paper``."""
    registry: PluginRegistry = request.app.state.registry
    identifier = paper_id.strip()
    if not identifier:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "paper_id must not be empty."},
        )

    providers = _capable_providers(registry, identifier)
    if not providers:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={
                "detail": (
                    "No enabled provider advertises the id_lookup capability. "
                    "Check GET /providers for what the configured sources can do."
                )
            },
        )

    failures: list[Failure] = []
    tried: list[str] = []
    for provider in providers:
        tried.append(provider.name)
        try:
            raw = await provider.lookup(identifier)
        except SourceError as exc:
            failures.append(Failure(stage="lookup", source=provider.name, error_type=exc.error_type, message=str(exc)))
            continue
        except NotImplementedError as exc:
            # The provider advertises id_lookup but has no implementation. That is
            # a capability-table bug, and hiding it would make the paper simply
            # look absent.
            failures.append(
                Failure(
                    stage="lookup",
                    source=provider.name,
                    error_type="unknown",
                    message=f"advertises id_lookup but does not implement it: {exc}",
                )
            )
            continue
        except Exception as exc:  # pragma: no cover - defensive catch
            failures.append(Failure(stage="lookup", source=provider.name, error_type="unknown", message=str(exc)))
            continue

        if raw is None:
            continue

        item = SearchResultItem.model_validate(raw)
        return PaperResponse(
            paper=search_result_item_to_paper(item),
            source=provider.name,
            tried_sources=tried,
            failures=failures,
        )

    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={
            "detail": f"No provider could resolve paper_id '{identifier}'.",
            "tried_sources": tried,
            "failures": [failure.model_dump() for failure in failures],
        },
    )
