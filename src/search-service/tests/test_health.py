"""Smoke tests for the FastAPI application skeleton."""

from fastapi.testclient import TestClient

from search_service.main import app


def test_root():
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "scholar-search-service"
    assert "version" in body


def test_health():
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"]
    assert isinstance(body["sources"], list)
