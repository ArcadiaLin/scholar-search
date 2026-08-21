"""OpenAI-compatible chat completions provider.

This adapter covers any backend exposing ``POST /chat/completions``, including
OpenAI, vLLM, llama.cpp-server, and Ollama when served with its OpenAI layer.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from search_service.exceptions import LLMError
from search_service.llm.base import LLMProvider, LLMResult
from search_service.schemas import LLMMessage

logger = logging.getLogger(__name__)

_CHAT_COMPLETIONS_PATH = "/chat/completions"


class OpenAICompatibleProvider(LLMProvider):
    """Forward chat requests to an OpenAI-compatible HTTP endpoint."""

    def __init__(self, name: str, config: dict[str, Any]) -> None:
        super().__init__(name, config)
        self._base_url = self._normalize_base_url(config.get("base_url", ""))
        self._default_model = config.get("model", "")
        if not self._default_model:
            raise LLMError(f"LLM provider '{name}' is missing required 'model' config.")
        self._timeout = float(config.get("timeout", 60.0))
        self._max_retries = int(config.get("max_retries", 2))

    @staticmethod
    def _normalize_base_url(url: str) -> str:
        url = url.rstrip("/")
        if not url:
            raise LLMError("OpenAI-compatible provider requires 'base_url'.")
        return url

    def _api_key(self) -> str | None:
        """Resolve API key from config or a provider-specific env var."""
        key = self.config.get("api_key", "")
        if key:
            return key if key else None
        env_name = f"{self.name.upper().replace('-', '_')}_API_KEY"
        return os.environ.get(env_name) or os.environ.get("LLM_API_KEY") or None

    def _build_request_body(
        self,
        messages: list[LLMMessage],
        model: str | None,
        temperature: float | None,
        max_tokens: int | None,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model or self._default_model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if extra:
            body.update(extra)
        return body

    async def chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra: dict[str, Any] | None = None,
    ) -> LLMResult:
        url = f"{self._base_url}{_CHAT_COMPLETIONS_PATH}"
        body = self._build_request_body(messages, model, temperature, max_tokens, extra)
        headers: dict[str, str] = {"Content-Type": "application/json"}
        api_key = self._api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout)) as client:
                    response = await client.post(url, headers=headers, json=body)
            except httpx.TimeoutException as exc:
                last_error = exc
                logger.warning("LLM provider '%s' request timed out (attempt %d)", self.name, attempt + 1)
                continue
            except httpx.HTTPError as exc:
                last_error = exc
                logger.warning("LLM provider '%s' HTTP error (attempt %d): %s", self.name, attempt + 1, exc)
                continue

            if response.status_code >= 500:
                last_error = LLMError(f"Provider returned HTTP {response.status_code}")
                logger.warning("LLM provider '%s' HTTP %d (attempt %d)", self.name, response.status_code, attempt + 1)
                continue

            try:
                output = response.json()
            except Exception as exc:
                raise LLMError(f"Provider returned non-JSON response: {exc}") from exc

            usage = output.get("usage") if isinstance(output, dict) else None
            return LLMResult(
                provider=self.name,
                model=body["model"],
                output=output,
                usage=usage,
                raw_request=body,
            )

        raise LLMError(f"LLM provider '{self.name}' failed after {self._max_retries + 1} attempts: {last_error}")
