"""Tests for the /judge LLM forwarding endpoint."""

from __future__ import annotations

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from search_service.main import app

_CHAT_COMPLETIONS_URL = "http://192.168.163.112:8003/v1/chat/completions"
_DEFAULT_PROVIDER = "vllm"
_DEFAULT_MODEL = "qwen3.6-35b-a3b"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _last_request_json(route):
    """Return the JSON body of the last call to a mocked route."""
    return json.loads(route.calls.last.request.content)


@respx.mock
def test_judge_forwards_prompt_as_single_user_message(client):
    payload = {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "model": _DEFAULT_MODEL,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "relevant"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
    }
    route = respx.post(_CHAT_COMPLETIONS_URL).mock(return_value=Response(200, json=payload))

    response = client.post("/judge", json={"prompt": "Is this paper relevant?"})

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == _DEFAULT_PROVIDER
    assert body["model"] == _DEFAULT_MODEL
    assert body["output"]["choices"][0]["message"]["content"] == "relevant"
    assert body["usage"]["total_tokens"] == 12
    assert body["elapsed_ms"] >= 0
    assert route.call_count == 1
    assert _last_request_json(route)["messages"] == [{"role": "user", "content": "Is this paper relevant?"}]


@respx.mock
def test_judge_uses_messages_directly(client):
    payload = {
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "yes"}, "finish_reason": "stop"}],
    }
    route = respx.post(_CHAT_COMPLETIONS_URL).mock(return_value=Response(200, json=payload))

    response = client.post(
        "/judge",
        json={
            "messages": [
                {"role": "system", "content": "You are a judge."},
                {"role": "user", "content": "Judge this."},
            ],
        },
    )

    assert response.status_code == 200
    request_json = _last_request_json(route)
    assert request_json["messages"][0]["role"] == "system"
    assert request_json["messages"][1]["role"] == "user"


@respx.mock
def test_judge_allows_model_override(client):
    payload = {"choices": []}
    route = respx.post(_CHAT_COMPLETIONS_URL).mock(return_value=Response(200, json=payload))

    client.post("/judge", json={"prompt": "x", "model": "overridden-model"})

    assert _last_request_json(route)["model"] == "overridden-model"


@respx.mock
def test_judge_forwards_extra_provider_params(client):
    payload = {"choices": []}
    route = respx.post(_CHAT_COMPLETIONS_URL).mock(return_value=Response(200, json=payload))

    client.post("/judge", json={"prompt": "x", "extra": {"top_p": 0.9, "seed": 42}})

    request_json = _last_request_json(route)
    assert request_json["top_p"] == 0.9
    assert request_json["seed"] == 42


@respx.mock
def test_judge_returns_501_for_unknown_provider(client):
    response = client.post("/judge", json={"prompt": "x", "provider": "nonexistent"})

    assert response.status_code == 501
    assert "nonexistent" in response.json()["detail"]


def test_judge_rejects_request_without_prompt_or_messages(client):
    response = client.post("/judge", json={"temperature": 0.5})

    assert response.status_code == 422


@respx.mock
def test_judge_returns_502_on_provider_http_error(client):
    respx.post(_CHAT_COMPLETIONS_URL).mock(return_value=Response(500, json={"error": "boom"}))

    response = client.post("/judge", json={"prompt": "x"})

    assert response.status_code == 502
    assert _DEFAULT_PROVIDER in response.json()["detail"]


@respx.mock
def test_judge_returns_502_on_provider_timeout(client):
    respx.post(_CHAT_COMPLETIONS_URL).mock(side_effect=httpx.ConnectTimeout("timed out"))

    response = client.post("/judge", json={"prompt": "x"})

    assert response.status_code == 502
    assert _DEFAULT_PROVIDER in response.json()["detail"]


def test_list_llm_providers(client):
    response = client.get("/judge/providers")

    assert response.status_code == 200
    providers = response.json()
    assert _DEFAULT_PROVIDER in providers
    assert "openai" in providers
