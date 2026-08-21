"""Abstract base class for LLM providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from search_service.schemas import LLMMessage


@dataclass
class LLMResult:
    """Internal result returned by an LLM provider adapter."""

    provider: str
    model: str
    output: Any
    usage: dict[str, Any] | None = None
    raw_request: dict[str, Any] | None = None


class LLMProvider(ABC):
    """Base class for an LLM backend.

    Subclasses are responsible for turning a unified chat request into a
    provider-specific HTTP call and returning the provider's raw response.
    The endpoint layer adds timing and wraps the result in ``JudgeResponse``.
    """

    name: str
    config: dict[str, Any]

    def __init__(self, name: str, config: dict[str, Any]) -> None:
        self.name = name
        self.config = config

    @abstractmethod
    async def chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra: dict[str, Any] | None = None,
    ) -> LLMResult:
        """Send a chat request to the backend and return the raw result.

        Args:
            messages: Chat messages in OpenAI-compatible role/content form.
            model: Optional model override.
            temperature: Optional sampling temperature.
            max_tokens: Optional generation limit.
            extra: Provider-native parameters to merge into the request body.
        """
        ...
