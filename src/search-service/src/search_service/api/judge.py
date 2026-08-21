"""LLM transport, and the relevance-judging endpoint built on it.

``POST /judge`` is **transport**: it routes a unified chat request to a configured
LLM provider and returns the raw response. It holds no prompt templates and no
result parsing, deliberately - those belong to the judge-strategy layer, which is
``search_service/judge/``.

``POST /judge/relevance`` is that layer's own endpoint: one paper, one query, the
derived weighted criteria, and the graded verdict in the shape
``docs/prototype.md`` §4.2 specifies. It exists so a judgement can be inspected
directly, which is what makes "the criteria carrier has an effect" checkable
without running a whole search.

Neither is registered as an agent tool, and neither should be. The agent's only
handle on judging is `judge_level` on the search tool: deciding how much budget to
spend on judging is the Agent's strategy, executing the judging is the Service's
implementation (``docs/prototype.md`` §7.1). A judge the agent could call directly
would move the decision into a tool's fixed prompt, where it neither enters
$\\bar{\\tau}_t$ nor responds to $NP_k^{agent}$.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from search_service.exceptions import LLMError
from search_service.judge.service import build_judge
from search_service.llm import LLMRegistry
from search_service.schemas import (
    JudgeRequest,
    JudgeResponse,
    LLMMessage,
    Paper,
    RelevanceJudgeRequest,
    RelevanceJudgeResponse,
)

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


@router.post("/relevance", response_model=RelevanceJudgeResponse)
async def judge_relevance(
    http_request: Request, request: RelevanceJudgeRequest
) -> RelevanceJudgeResponse | JSONResponse:
    """Grade one paper against one query's derived criteria."""
    judge_config = http_request.app.state.config.get_judge_config()
    availability = build_judge(judge_config, _get_llm_registry(http_request), request.level)
    if availability.strategy is None:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={"detail": availability.reason or f"judging tier '{request.level}' is not available."},
        )

    try:
        paper = Paper.model_validate(request.paper)
    except Exception as exc:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": f"'paper' is not a valid unified Paper record: {exc}"},
        )

    try:
        derived = await availability.strategy.criteria_for(request.query)
    except LLMError as exc:
        # A derivation failure is not a verdict of "not relevant": nothing was
        # judged, and saying so is the only honest answer.
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": f"could not derive criteria for this query: {exc}"},
        )

    try:
        judgement = await availability.strategy.judge_one(request.query, paper, derived)
    except LLMError as exc:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": f"the paper could not be judged: {exc}"},
        )

    return RelevanceJudgeResponse(
        paper_id=judgement.paper_id,
        criteria=judgement.criteria,
        criteria_definition=[
            {"key": criterion.key, "description": criterion.description, "weight": criterion.weight}
            for criterion in derived.criteria
        ],
        summary=judgement.summary,
        score=judgement.score,
        tier=judgement.tier,
        rubric_version=judgement.rubric_version,
        criteria_version=judgement.criteria_version,
        model_version=judgement.model_version,
        carrier_version=derived.carrier_version,
        cached=judgement.cached,
    )


@router.get("/providers", response_model=list[str])
async def list_llm_providers(http_request: Request) -> list[str]:
    """Return names of configured LLM providers."""
    registry = _get_llm_registry(http_request)
    return registry.list_provider_names()
