"""LLM-as-Judge forwarding endpoint.

``POST /judge`` accepts a unified request, routes it to a configured LLM
provider, and returns the provider's raw response. This module intentionally
does not contain prompt templates or result parsing; those belong in a separate
judge-strategy layer.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.exceptions import LLMError
from search_service.llm import LLMRegistry
from search_service.schemas import JudgeRequest, JudgeResponse, LLMMessage

router = APIRouter(prefix="/judge", tags=["judge"])


def _get_llm_registry(request: Request) -> LLMRegistry:
    """Retrieve the LLM registry from application state."""
    return request.app.state.llm_registry


def _build_messages(payload: JudgeRequest) -> list[LLMMessage]:
    """Normalize ``messages`` or ``prompt`` into a message list."""
    if payload.messages:
        return list(payload.messages)
    if payload.prompt:
        return [LLMMessage(role="user", content=payload.prompt)]
    raise ValueError("Either 'messages' or 'prompt' must be provided.")


@router.post("", response_model=JudgeResponse)
async def judge(http_request: Request, request: JudgeRequest) -> JudgeResponse | JSONResponse:
    """Forward a chat request to the configured LLM provider."""
    registry = _get_llm_registry(http_request)
    provider = registry.get(request.provider)

    if provider is None:
        requested = request.provider or "<default>"
        available = registry.list_provider_names()
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={
                "detail": (
                    f"LLM provider '{requested}' is not available. Configured providers: {available or 'none'}."
                ),
            },
        )

    messages = _build_messages(request)
    started = time.perf_counter()
    try:
        result = await provider.chat(
            messages,
            model=request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            extra=request.extra,
        )
    except LLMError as exc:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": f"LLM provider '{provider.name}' failed: {exc}"},
        )
    except Exception as exc:  # pragma: no cover - defensive catch-all
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": f"Unexpected error from LLM provider '{provider.name}': {exc}"},
        )

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return JudgeResponse(
        provider=result.provider,
        model=result.model,
        output=result.output,
        usage=result.usage,
        elapsed_ms=elapsed_ms,
        raw_request=result.raw_request,
    )


@router.get("/providers", response_model=list[str])
async def list_llm_providers(http_request: Request) -> list[str]:
    """Return names of configured LLM providers."""
    registry = _get_llm_registry(http_request)
    return registry.list_provider_names()
