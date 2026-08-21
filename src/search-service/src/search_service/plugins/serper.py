"""Serper source plugin.

This plugin uses Serper.dev (Google Search API) to find paper landing pages
and PDF links.  It is intentionally lightweight and complements the academic
metadata sources.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import unquote

import httpx

from search_service.exceptions import SourceError
from search_service.models import SearchResultItem
from search_service.plugin_loader import SourcePlugin

_DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)
_ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4,5}\.\d{4,5})", re.IGNORECASE)


def _extract_doi(text: str) -> str | None:
    match = _DOI_RE.search(unquote(text))
    return match.group(0) if match else None


def _extract_arxiv_id(text: str) -> str | None:
    match = _ARXIV_URL_RE.search(unquote(text))
    return match.group(1) if match else None


def _build_paper_id(link: str, title: str) -> str:
    doi = _extract_doi(link)
    if doi:
        return doi.lower()
    arxiv_id = _extract_arxiv_id(link)
    if arxiv_id:
        return f"arxiv:{arxiv_id.lower()}"
    return f"serper:{link}"


def _parse_result(result: dict[str, Any], rank: int | None = None) -> SearchResultItem:
    """Parse a single Serper organic result into a normalized item."""
    title = result.get("title", "")
    link = result.get("link", "")
    snippet = result.get("snippet") or ""

    paper_id = _build_paper_id(link, title)
    doi = _extract_doi(link)
    arxiv_id = _extract_arxiv_id(link)

    urls: dict[str, str | None] = {"paper": None, "pdf": None, "html": None}
    if link.lower().endswith(".pdf"):
        urls["pdf"] = link
        urls["paper"] = link
    else:
        urls["html"] = link
        urls["paper"] = link

    extracted = {"title", "link", "snippet"}
    raw = {k: v for k, v in result.items() if k not in extracted}

    return SearchResultItem(
        paper_id=paper_id,
        title=title,
        authors=None,
        abstract=snippet if snippet else None,
        published=None,
        year=None,
        doi=doi,
        arxiv_id=arxiv_id,
        openalex_id=None,
        urls=urls,
        source="serper",
        source_rank=rank,
        raw=raw,
    )


class SerperClient:
    """Async Serper.dev client with rate limiting."""

    def __init__(self, config: dict[str, Any]) -> None:
        api_key = config.get("api_key")
        if not api_key:
            raise SourceError("serper", "auth", "Serper API key is missing")
        self.api_key = str(api_key)
        self.base_url = str(config.get("base_url", "https://google.serper.dev")).rstrip("/")
        self.timeout = float(config.get("timeout", 30.0))
        self.max_retries = max(0, int(config.get("max_retries", 2)))
        self.rate_limit_rps = max(0.1, float(config.get("rate_limit_rps", 1.0)))
        self.query_template = str(config.get("query_template", "{query} filetype:pdf OR arxiv.org OR doi.org"))
        self._min_interval = 1.0 / self.rate_limit_rps
        self._last_request_at = 0.0
        self._lock = asyncio.Lock()
        self._session_lock = asyncio.Lock()
        self._active_sessions = 0
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout))
        return self._client

    async def _rate_limit(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_at
            if elapsed < self._min_interval:
                await asyncio.sleep(self._min_interval - elapsed)
                now = time.monotonic()
            self._last_request_at = now

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        """Query Serper and return normalized result items."""
        await self._rate_limit()
        client = await self._get_client()
        q = self.query_template.format(query=query)
        payload = {"q": q, "num": min(top_k, 100)}
        if native_params:
            payload.update(native_params)
        headers = {"X-API-KEY": self.api_key, "Content-Type": "application/json"}
        url = f"{self.base_url}/search"

        last_exception: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise SourceError("serper", "parse", "Serper response is not a JSON object")
                organic = data.get("organic") or []
                return [_parse_result(item, rank=idx + 1) for idx, item in enumerate(organic) if isinstance(item, dict)]
            except httpx.TimeoutException as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("serper", "timeout", f"Serper request timed out after {attempt + 1} attempts") from exc
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status == 429:
                    if attempt == self.max_retries:
                        raise SourceError("serper", "rate_limit", "Serper rate limit exceeded") from exc
                elif status in (401, 403):
                    raise SourceError("serper", "auth", f"Serper authentication failed ({status})") from exc
                elif 400 <= status < 500:
                    raise SourceError("serper", "http", f"Serper client error {status}: {exc.response.text[:200]}") from exc
                elif attempt == self.max_retries:
                    raise SourceError("serper", "http", f"Serper server error {status}: {exc.response.text[:200]}") from exc
            except httpx.RequestError as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("serper", "http", f"Serper request failed: {exc}") from exc
            except ValueError as exc:
                raise SourceError("serper", "parse", f"Serper response is not valid JSON: {exc}") from exc

            wait = min(2**attempt, 60.0)
            await asyncio.sleep(wait)

        raise SourceError("serper", "unknown", f"Serper request failed after retries: {last_exception}")

    @asynccontextmanager
    async def session(self) -> AsyncIterator[None]:
        """Bracket one operation, closing the shared client when the last one leaves.

        See ``OpenAlexClient.session``: the aggregator issues several queries per
        provider concurrently, and closing after each one closed the connection
        under the calls still in flight.
        """
        async with self._session_lock:
            self._active_sessions += 1
        try:
            yield
        finally:
            async with self._session_lock:
                self._active_sessions -= 1
                if self._active_sessions == 0:
                    await self.close()

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()


class SerperPlugin(SourcePlugin):
    """Serper source plugin."""

    name = "serper"

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self._client = SerperClient(config)

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        async with self._client.session():
            return await self._client.search(
                query,
                top_k,
                end_date=end_date,
                native_params=native_params,
            )


Plugin = SerperPlugin
