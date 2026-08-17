"""Tests for the remote embedding provider."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from src.retriever.provider import (
    EmbeddingResponseError,
    EmbeddingTimeoutError,
    RemoteEmbeddingProvider,
)


def _mock_response(
    *,
    status_code: int = 200,
    json_payload: dict | None = None,
    text: str = "",
) -> httpx.Response:
    request = httpx.Request("POST", "http://localhost:8000/v1/embeddings")
    if json_payload is not None:
        return httpx.Response(status_code, json=json_payload, request=request)
    return httpx.Response(status_code, text=text, request=request)


@pytest.fixture
def provider() -> RemoteEmbeddingProvider:
    return RemoteEmbeddingProvider(
        base_url="http://localhost:8000/v1",
        model="intfloat/e5-base-v2",
    )


def _run(coro):
    """Run an async coroutine from a synchronous test."""
    return asyncio.run(coro)


def test_openai_encode_success(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(
        json_payload={
            "object": "list",
            "data": [
                {"object": "embedding", "embedding": [0.1, 0.2, 0.3], "index": 0},
                {"object": "embedding", "embedding": [0.4, 0.5, 0.6], "index": 1},
            ],
            "model": "intfloat/e5-base-v2",
        },
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        vectors = _run(provider.encode(["hello", "world"]))

    assert len(vectors) == 2
    assert vectors[0] == [0.1, 0.2, 0.3]
    assert vectors[1] == [0.4, 0.5, 0.6]


def test_custom_encode_success() -> None:
    provider = RemoteEmbeddingProvider(
        base_url="http://localhost:8000",
        model="e5-base",
        api_format="custom",
    )
    response = _mock_response(json_payload=[[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response) as mocked_post:
        vectors = _run(provider.encode(["hello", "world"]))

    assert vectors == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
    body = mocked_post.call_args.kwargs["json"]
    assert body["inputs"] == ["hello", "world"]


def test_api_key_header() -> None:
    provider = RemoteEmbeddingProvider(
        base_url="http://localhost:8000/v1",
        model="e5-base",
        api_key="sk-secret",
    )
    response = _mock_response(
        json_payload={
            "data": [{"embedding": [0.1, 0.2, 0.3], "index": 0}],
        },
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response) as mocked_post:
        _run(provider.encode(["hello"]))

    call_kwargs = mocked_post.call_args.kwargs
    assert call_kwargs["headers"]["Authorization"] == "Bearer sk-secret"


def test_empty_input_returns_empty(provider: RemoteEmbeddingProvider) -> None:
    assert _run(provider.encode([])) == []


def test_non_numeric_embedding_raises(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(
        json_payload={
            "data": [
                {"embedding": [0.1, "not-a-number"], "index": 0},
            ],
        },
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        with pytest.raises(EmbeddingResponseError):
            _run(provider.encode(["hello"]))


def test_openai_response_count_mismatch(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(
        json_payload={
            "data": [{"embedding": [0.1, 0.2, 0.3], "index": 0}],
        },
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        with pytest.raises(EmbeddingResponseError):
            _run(provider.encode(["hello", "world"]))


def test_client_error_no_retry(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(status_code=400, text="bad request")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response) as mocked_post:
        with pytest.raises(EmbeddingResponseError) as exc_info:
            _run(provider.encode(["hello"]))

    assert exc_info.value.__cause__ is not None
    assert mocked_post.call_count == 1


def test_server_error_retries(provider: RemoteEmbeddingProvider) -> None:
    bad_response = _mock_response(status_code=503, text="service unavailable")
    good_response = _mock_response(
        json_payload={"data": [{"embedding": [0.1, 0.2, 0.3], "index": 0}]},
    )

    with patch(
        "httpx.AsyncClient.post",
        new_callable=AsyncMock,
        side_effect=[bad_response, good_response],
    ) as mocked_post:
        vectors = _run(provider.encode(["hello"]))

    assert vectors == [[0.1, 0.2, 0.3]]
    assert mocked_post.call_count == 2


def test_timeout_raises_embedding_timeout(provider: RemoteEmbeddingProvider) -> None:
    with patch(
        "httpx.AsyncClient.post",
        new_callable=AsyncMock,
        side_effect=httpx.TimeoutException("timed out"),
    ):
        with pytest.raises(EmbeddingTimeoutError):
            _run(provider.encode(["hello"]))


def test_invalid_json_raises_response_error(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(status_code=200, text="not-json")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        with pytest.raises(EmbeddingResponseError):
            _run(provider.encode(["hello"]))


def test_encode_sync_wraps_async(provider: RemoteEmbeddingProvider) -> None:
    response = _mock_response(
        json_payload={
            "data": [{"embedding": [0.1, 0.2, 0.3], "index": 0}],
        },
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=response):
        vectors = provider.encode_sync(["hello"])

    assert vectors == [[0.1, 0.2, 0.3]]
