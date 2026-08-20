"""Tests for the OpenAlex API client."""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
import respx

from src.retriever.openalex import (
    OpenAlexClient,
    OpenAlexRateLimitError,
    OpenAlexResponseError,
    OpenAlexSearchResult,
    OpenAlexTimeoutError,
)
from src.retriever.schema import PaperCandidate


@pytest.fixture
def base_url() -> str:
    return "https://api.openalex.org"


@pytest.fixture
def client(base_url: str) -> OpenAlexClient:
    return OpenAlexClient(
        base_url=base_url,
        api_key="test-key",
        mailto="test@example.com",
        rate_limit_rps=1000.0,  # effectively disable throttling for most tests
    )


@pytest.fixture
def work_fixture() -> dict:
    return json.loads(Path("tests/fixtures/openalex_work.json").read_text())


def _work_result(work: dict) -> dict:
    return {"meta": {"count": 1, "page": 1, "per_page": 1}, "results": [work]}


def test_search_returns_candidates(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works").mock(return_value=httpx.Response(200, json=_work_result(work_fixture)))
        result = client.search_sync("open access", top_k=1)

    assert isinstance(result, OpenAlexSearchResult)
    assert result.query == "open access"
    assert len(result.candidates) == 1
    assert result.total_count == 1
    assert result.api_calls == 1
    paper = result.candidates[0]
    assert paper.paper_id == "W2741809807"
    assert paper.title == work_fixture["display_name"]
    assert paper.doi == work_fixture["doi"]
    assert paper.abstract is not None
    assert "Background Open Access articles" in paper.abstract


def test_search_respects_top_k_and_pagination(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    work_a = {**work_fixture, "id": "https://openalex.org/WA"}
    work_b = {**work_fixture, "id": "https://openalex.org/WB"}
    work_c = {**work_fixture, "id": "https://openalex.org/WC"}

    with respx.mock(base_url=base_url) as rsps:
        route1 = rsps.get("/works", params={"page": 1}).mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 3, "page": 1, "per_page": 2}, "results": [work_a, work_b]},
            )
        )
        rsps.get("/works", params={"page": 2}).mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 3, "page": 2, "per_page": 2}, "results": [work_c]},
            )
        )
        result = client.search_sync("open access", top_k=3, filters={"publication_year": ">2020"})

    assert len(result.candidates) == 3
    assert result.page_count == 2
    assert result.api_calls == 2
    assert result.candidates[0].paper_id == "WA"
    assert result.candidates[1].paper_id == "WB"
    assert result.candidates[2].paper_id == "WC"

    # Verify the filter made it into the request.
    sent_request = route1.calls[0].request
    assert "filter=publication_year%3A%3E2020" in sent_request.url.query.decode()


def test_get_work_by_openalex_id(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W2741809807").mock(return_value=httpx.Response(200, json=work_fixture))
        paper = client.get_work_sync("W2741809807")

    assert isinstance(paper, PaperCandidate)
    assert paper.paper_id == "W2741809807"
    assert paper.title == work_fixture["display_name"]


def test_get_work_by_full_url(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W2741809807").mock(return_value=httpx.Response(200, json=work_fixture))
        paper = client.get_work_sync("https://openalex.org/W2741809807")

    assert paper is not None
    assert paper.paper_id == "W2741809807"


def test_get_work_not_found(
    client: OpenAlexClient,
    base_url: str,
) -> None:
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W0000000000").mock(return_value=httpx.Response(404, text="not found"))
        paper = client.get_work_sync("W0000000000")

    assert paper is None


def test_get_works_by_dois(client: OpenAlexClient, base_url: str, work_fixture: dict) -> None:
    work_a = {**work_fixture, "id": "https://openalex.org/WA", "doi": "https://doi.org/10.1/abc"}
    work_b = {**work_fixture, "id": "https://openalex.org/WB", "doi": "https://doi.org/10.2/def"}

    with respx.mock(base_url=base_url) as rsps:
        route = rsps.get("/works").mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 2, "page": 1, "per_page": 50}, "results": [work_a, work_b]},
            )
        )
        papers = client.get_works_by_dois_sync(["10.1/abc", "https://doi.org/10.2/def"])

    assert len(papers) == 2
    assert {p.paper_id for p in papers} == {"WA", "WB"}
    sent_request = route.calls[0].request
    query = sent_request.url.query.decode()
    assert "filter=doi%3A" in query
    assert "10.1%2Fabc" in query
    assert "10.2%2Fdef" in query


def test_get_citing_works(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    citing_work = {**work_fixture, "id": "https://openalex.org/WCITE"}

    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W2741809807").mock(return_value=httpx.Response(200, json=work_fixture))
        rsps.get("/works", params={"filter": "cites:W2741809807"}).mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 1, "page": 1, "per_page": 100}, "results": [citing_work]},
            )
        )
        result = client.get_citing_works_sync("W2741809807", top_k=1)

    assert result.query == "cited_by:W2741809807"
    assert len(result.candidates) == 1
    assert result.candidates[0].paper_id == "WCITE"
    assert result.api_calls == 2


def test_get_referenced_works(
    client: OpenAlexClient,
    base_url: str,
    work_fixture: dict,
) -> None:
    ref_a = {**work_fixture, "id": "https://openalex.org/W1234567890"}
    ref_b = {**work_fixture, "id": "https://openalex.org/W0987654321"}

    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W2741809807").mock(return_value=httpx.Response(200, json=work_fixture))
        route = rsps.get("/works").mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 2, "page": 1, "per_page": 50}, "results": [ref_a, ref_b]},
            )
        )
        result = client.get_referenced_works_sync("W2741809807", top_k=2)

    assert result.query == "referenced_by:W2741809807"
    assert len(result.candidates) == 2
    assert {p.paper_id for p in result.candidates} == {"W1234567890", "W0987654321"}
    assert result.api_calls == 2

    sent_request = route.calls[0].request
    assert "filter=ids.openalex%3A" in sent_request.url.query.decode()


def test_empty_search_result(client: OpenAlexClient, base_url: str) -> None:
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works").mock(
            return_value=httpx.Response(
                200,
                json={"meta": {"count": 0, "page": 1, "per_page": 100}, "results": []},
            )
        )
        result = client.search_sync("xyznonexistent", top_k=100)

    assert result.candidates == []
    assert result.total_count == 0
    assert result.api_calls == 1
    assert result.credits_used == 0


@pytest.mark.asyncio
async def test_rate_limit_enforced(base_url: str) -> None:
    client = OpenAlexClient(
        base_url=base_url,
        rate_limit_rps=10.0,  # 100 ms between requests
    )
    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W1").mock(return_value=httpx.Response(200, json={"id": "https://openalex.org/W1"}))
        rsps.get("/works/W2").mock(return_value=httpx.Response(200, json={"id": "https://openalex.org/W2"}))
        start = time.monotonic()
        await client.get_work("W1")
        await client.get_work("W2")
        elapsed = time.monotonic() - start

    # Two requests at 10 req/s should be spaced by at least ~0.1 s.
    assert elapsed >= 0.08


@pytest.mark.asyncio
async def test_429_retry_with_backoff(base_url: str) -> None:
    client = OpenAlexClient(base_url=base_url, max_retries=2)
    good_response = httpx.Response(200, json={"id": "https://openalex.org/W1"})
    bad_response = httpx.Response(429, text="rate limited")

    with respx.mock(base_url=base_url) as rsps:
        route = rsps.get("/works/W1")
        route.side_effect = [bad_response, good_response]
        paper = await client.get_work("W1")

    assert paper is not None
    assert paper.paper_id == "W1"
    assert route.call_count == 2


@pytest.mark.asyncio
async def test_429_exhausted_retries_raises(base_url: str) -> None:
    client = OpenAlexClient(base_url=base_url, max_retries=1)

    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W1").mock(return_value=httpx.Response(429, text="rate limited"))
        with pytest.raises(OpenAlexRateLimitError):
            await client.get_work("W1")


@pytest.mark.asyncio
async def test_400_no_retry(base_url: str) -> None:
    client = OpenAlexClient(base_url=base_url, max_retries=3)

    with respx.mock(base_url=base_url) as rsps:
        route = rsps.get("/works/W1")
        route.mock(return_value=httpx.Response(400, text="bad request"))
        with pytest.raises(OpenAlexResponseError):
            await client.get_work("W1")

    assert route.call_count == 1


@pytest.mark.asyncio
async def test_timeout_raises_openalex_timeout(base_url: str) -> None:
    client = OpenAlexClient(base_url=base_url, timeout=0.01, max_retries=0)

    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W1").mock(side_effect=httpx.TimeoutException("timed out"))
        with pytest.raises(OpenAlexTimeoutError):
            await client.get_work("W1")


@pytest.mark.asyncio
async def test_invalid_json_raises_response_error(base_url: str) -> None:
    client = OpenAlexClient(base_url=base_url)

    with respx.mock(base_url=base_url) as rsps:
        rsps.get("/works/W1").mock(return_value=httpx.Response(200, text="not-json"))
        with pytest.raises(OpenAlexResponseError):
            await client.get_work("W1")


def test_extract_openalex_id_from_short_and_full() -> None:
    from src.retriever.openalex import _extract_openalex_id

    assert _extract_openalex_id("W123") == "W123"
    assert _extract_openalex_id("https://openalex.org/W123") == "W123"
    assert _extract_openalex_id("") == ""


def test_reconstruct_abstract() -> None:
    from src.retriever.openalex import _reconstruct_abstract

    assert _reconstruct_abstract(None) is None
    assert _reconstruct_abstract({}) is None
    assert _reconstruct_abstract({"Hello": [0], "world": [1]}) == "Hello world"


def test_client_reads_environment_variables(monkeypatch: pytest.MonkeyPatch, base_url: str) -> None:
    monkeypatch.setenv("OPENALEX_API_KEY", "env-key")
    monkeypatch.setenv("OPENALEX_MAILTO", "env@example.com")
    client = OpenAlexClient(base_url=base_url)
    assert client.api_key == "env-key"
    assert client.mailto == "env@example.com"
