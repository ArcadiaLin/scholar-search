"""The Reviewer's detector thresholds, served from config (D-15).

Two things worth pinning down: the section is served at all, and a missing or
partial section degrades to defaults rather than to ``None``. A threshold that
arrives as ``None`` makes every comparison against it false, which turns a
detector off silently - the failure mode this whole stage exists to remove.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from search_service.config import ServiceConfig
from search_service.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_the_endpoint_serves_the_configured_thresholds(client):
    response = client.get("/review-config")

    assert response.status_code == 200
    body = response.json()
    assert body["thresholds"]["subquery_jaccard_ceiling"] == 0.5
    assert body["thresholds"]["soft_call_budget"] == 40
    # Said out loud because it decides what a tuned number is worth.
    assert "placeholder" in body["provenance"]


def test_the_checked_in_config_carries_every_threshold_the_detectors_read():
    # The extension falls back per key, so a key missing here would not break
    # anything - it would silently move a threshold out of an HP search's reach,
    # which is the whole point of D-15.
    config = yaml.safe_load(Path("config.yaml").read_text(encoding="utf-8"))
    assert set(config["review"]) == set(ServiceConfig().get_review_config())


def test_a_missing_section_falls_back_to_defaults_rather_than_to_none(tmp_path, monkeypatch):
    empty = tmp_path / "config.yaml"
    empty.write_text("service:\n  port: 8000\n", encoding="utf-8")
    monkeypatch.setenv("SEARCH_CONFIG_FILE", str(empty))

    review = ServiceConfig().get_review_config()

    assert review["subquery_jaccard_ceiling"] == 0.5
    assert all(value is not None for value in review.values())


def test_a_partial_section_overrides_only_what_it_names(tmp_path, monkeypatch):
    partial = tmp_path / "config.yaml"
    partial.write_text("review:\n  soft_call_budget: 7\n", encoding="utf-8")
    monkeypatch.setenv("SEARCH_CONFIG_FILE", str(partial))

    review = ServiceConfig().get_review_config()

    assert review["soft_call_budget"] == 7
    assert review["subquery_jaccard_ceiling"] == 0.5
