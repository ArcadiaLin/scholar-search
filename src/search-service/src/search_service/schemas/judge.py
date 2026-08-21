"""Request/response schemas for the LLM-as-Judge endpoint.

This module exposes the stable HTTP contract used by ``POST /judge``. It is
intentionally generic: the endpoint forwards messages to a configured LLM
provider and returns the raw response. Concrete judge prompts and result
parsing will live in a separate layer so that provider adapters stay reusable.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class LLMMessage(BaseModel):
    """One message in a chat-style LLM request."""

    role: Literal["system", "user", "assistant"] = Field(description="Message role.")
    content: str = Field(min_length=1, description="Message content.")


class JudgeRequest(BaseModel):
    """Request schema for the LLM forwarding endpoint.

    Callers can supply either ``messages`` or ``prompt``; ``prompt`` is a
    convenience that gets converted to a single user message. Provider-native
    parameters can be forwarded via ``extra``.
    """

    provider: str | None = Field(
        default=None, description="Name of the configured LLM provider. Defaults to the configured default provider."
    )
    model: str | None = Field(
        default=None, description="Model override. When omitted, the provider's configured model is used."
    )
    messages: list[LLMMessage] | None = Field(
        default=None, max_length=64, description="Chat messages to send to the LLM."
    )
    prompt: str | None = Field(default=None, min_length=1, description="Convenience alias for a single user message.")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0, description="Sampling temperature.")
    max_tokens: int | None = Field(default=None, ge=1, description="Maximum tokens to generate.")
    extra: dict[str, Any] | None = Field(default=None, description="Provider-native parameters forwarded verbatim.")

    @model_validator(mode="after")
    def _require_messages_or_prompt(self) -> JudgeRequest:
        if not self.messages and not self.prompt:
            raise ValueError("Either 'messages' or 'prompt' must be provided.")
        return self


class JudgeResponse(BaseModel):
    """Response schema for the LLM forwarding endpoint.

    ``output`` carries the provider's raw JSON response so callers can access
    choices, finish reasons, and any provider-specific fields.
    """

    provider: str = Field(description="Provider that handled the request.")
    model: str = Field(description="Model actually invoked.")
    output: Any = Field(description="Raw LLM response body.")
    usage: dict[str, Any] | None = Field(
        default=None, description="Token usage as reported by the provider, when available."
    )
    elapsed_ms: int = Field(ge=0, description="Wall-clock time in milliseconds.")
    raw_request: dict[str, Any] | None = Field(
        default=None, description="Request body sent to the provider, for debugging."
    )
