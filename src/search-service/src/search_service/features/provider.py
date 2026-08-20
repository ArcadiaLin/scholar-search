"""Embedding provider interface and remote HTTP implementation.

The provider is intentionally injected so that rankers and tests never depend
on a concrete model or runtime.  ``RemoteEmbeddingProvider`` speaks either an
OpenAI-compatible ``/v1/embeddings`` endpoint or a simple custom ``/embed``
endpoint.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Literal, Protocol

import httpx


class EmbeddingProviderError(Exception):
    """Base exception for embedding provider failures."""


class EmbeddingTimeoutError(EmbeddingProviderError):
    """Remote embedding call timed out."""


class EmbeddingResponseError(EmbeddingProviderError):
    """Remote embedding call returned an invalid or unexpected response."""


class EmbeddingProvider(Protocol):
    """Protocol for embedding encoders.

    Implementations must be async-safe; synchronous callers can use
    ``encode_sync``.
    """

    async def encode(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text.

        Raises:
            EmbeddingTimeoutError: on timeout.
            EmbeddingResponseError: on HTTP error or malformed response.
            EmbeddingProviderError: on other provider failures.
        """
        ...


class RemoteEmbeddingProvider:
    """HTTP client for a remote embedding service.

    Supports two API formats:

    * ``openai``: ``POST /v1/embeddings`` with ``{"input": [...], "model": ...}``
      and response ``data[].embedding``.
    * ``custom``: ``POST /embed`` with ``{"texts": [...]}`` and response
      ``{"embeddings": [[...]]}``.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        api_key: str | None = None,
        api_format: Literal["openai", "custom"] = "openai",
        timeout: httpx.Timeout | None = None,
        max_retries: int = 2,
        truncate: bool = False,
    ) -> None:
        """Initialize the provider.

        Args:
            base_url: Remote service base URL, e.g. ``http://localhost:8000/v1``.
            model: Model name registered on the remote service.
            api_key: Optional bearer token for authentication.
            api_format: Protocol dialect to use.
            timeout: Request timeout. Defaults to 5s connect / 30s read.
            max_retries: Maximum retry attempts after the first failed request.
            truncate: If ``True``, ask the server to truncate inputs that exceed
                its maximum token limit (TEI-compatible parameter).
        """
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.api_format = api_format
        self.timeout = timeout or httpx.Timeout(30.0, connect=5.0)
        self.max_retries = max(0, max_retries)
        self.truncate = truncate

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request_body(self, texts: list[str]) -> dict[str, Any]:
        if self.api_format == "openai":
            body: dict[str, Any] = {"input": texts, "model": self.model}
            if self.truncate:
                body["truncate"] = True
            return body
        # TEI-compatible custom endpoint uses ``inputs`` and supports ``truncate``.
        body = {"inputs": texts}
        if self.truncate:
            body["truncate"] = True
        return body

    def _endpoint(self) -> str:
        if self.api_format == "openai":
            return f"{self.base_url}/embeddings"
        return f"{self.base_url}/embed"

    def _parse_response(self, payload: Any, n_expected: int) -> list[list[float]]:
        if self.api_format == "openai":
            if not isinstance(payload, dict):
                raise EmbeddingResponseError("OpenAI response is not an object")
            data = payload.get("data")
            if not isinstance(data, list) or len(data) != n_expected:
                raise EmbeddingResponseError(
                    f"OpenAI response 'data' field invalid: expected {n_expected} items, "
                    f"got {len(data) if isinstance(data, list) else type(data)}"
                )
            embeddings: list[list[float]] = []
            for item in data:
                if not isinstance(item, dict):
                    raise EmbeddingResponseError("OpenAI response item is not an object")
                embedding = item.get("embedding")
                if not isinstance(embedding, list) or not all(isinstance(v, (int, float)) for v in embedding):
                    raise EmbeddingResponseError("OpenAI response embedding is not a numeric list")
                embeddings.append([float(v) for v in embedding])
            return embeddings

        # TEI ``/embed`` returns the embeddings as a plain array.
        if not isinstance(payload, list) or len(payload) != n_expected:
            raise EmbeddingResponseError(f"Custom response is not an array of length {n_expected}: got {type(payload)}")
        for embedding in payload:
            if not isinstance(embedding, list) or not all(isinstance(v, (int, float)) for v in embedding):
                raise EmbeddingResponseError("Custom response embedding is not a numeric list")
        return [[float(v) for v in embedding] for embedding in payload]

    async def encode(self, texts: list[str]) -> list[list[float]]:
        """Encode ``texts`` via the remote service with bounded retries."""
        if not texts:
            return []

        body = self._request_body(texts)
        endpoint = self._endpoint()
        headers = self._headers()
        last_exception: Exception | None = None

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for attempt in range(self.max_retries + 1):
                try:
                    response = await client.post(endpoint, json=body, headers=headers)
                    response.raise_for_status()
                    payload = response.json()
                    return self._parse_response(payload, len(texts))
                except httpx.TimeoutException as exc:
                    last_exception = exc
                    if attempt == self.max_retries:
                        raise EmbeddingTimeoutError(
                            f"Embedding request timed out after {attempt + 1} attempts"
                        ) from exc
                except httpx.HTTPStatusError as exc:
                    last_exception = exc
                    if attempt == self.max_retries:
                        raise EmbeddingResponseError(
                            f"Embedding request failed with status {exc.response.status_code}: "
                            f"{exc.response.text[:200]}"
                        ) from exc
                    # Do not retry client errors except 429 Too Many Requests / 503 Service Unavailable.
                    if exc.response.status_code not in (429, 503) and 400 <= exc.response.status_code < 500:
                        raise EmbeddingResponseError(
                            f"Embedding request failed with status {exc.response.status_code}: "
                            f"{exc.response.text[:200]}"
                        ) from exc
                except httpx.RequestError as exc:
                    last_exception = exc
                    if attempt == self.max_retries:
                        raise EmbeddingProviderError(f"Embedding request failed: {exc}") from exc
                except ValueError as exc:
                    # JSON decode error from response.json()
                    raise EmbeddingResponseError(f"Embedding response is not valid JSON: {exc}") from exc

        # Unreachable unless retry loop exits unexpectedly; kept for type checker.
        raise EmbeddingProviderError(f"Embedding request failed after retries: {last_exception}")

    def encode_sync(self, texts: list[str]) -> list[list[float]]:
        """Synchronous wrapper around ``encode``.

        Creates a temporary event loop when called from a non-async context.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.encode(texts))

        if loop.is_running():
            # Already inside an event loop (e.g. async test).  Use a helper task.
            return loop.run_until_complete(self.encode(texts))

        return asyncio.run(self.encode(texts))


def stable_cache_key(text: str) -> str:
    """Return a stable cache key for an embedding text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
