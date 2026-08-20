"""OpenAlex API client for academic paper retrieval.

This module is intentionally independent from the BM25 and embedding rankers.
It provides a thin, async-first client over the OpenAlex REST API with
built-in rate limiting, bounded retries, and citation-network helpers.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from pydantic import BaseModel, Field

from src.retriever.schema import PaperCandidate


class OpenAlexError(Exception):
    """Base exception for OpenAlex client failures."""


class OpenAlexRateLimitError(OpenAlexError):
    """Raised when the daily rate limit or hard QPS limit is exceeded."""


class OpenAlexResponseError(OpenAlexError):
    """Raised when the API returns an unexpected or malformed response."""


class OpenAlexTimeoutError(OpenAlexError):
    """Raised when an OpenAlex request times out."""


class OpenAlexSearchResult(BaseModel):
    """Result of an OpenAlex list query."""

    query: str = Field(description="Query or relationship label for this result.")
    candidates: list[PaperCandidate] = Field(description="Retrieved paper candidates.")
    total_count: int = Field(default=0, ge=0, description="Total matches reported by OpenAlex.")
    page_count: int = Field(default=0, ge=0, description="Number of API pages fetched.")
    api_calls: int = Field(default=0, ge=0, description="Number of HTTP API calls made.")
    credits_used: int = Field(default=0, ge=0, description="Credits consumed, from response headers.")
    elapsed_ms: int = Field(default=0, ge=0, description="Wall-clock time in milliseconds.")


_OPENALEX_ID_PREFIX = "https://openalex.org/"
_WORK_SELECT = (
    "id,display_name,title,publication_year,publication_date,type,"
    "abstract_inverted_index,doi,ids,open_access,cited_by_count,"
    "authorships,primary_location,concepts,topics,keywords,"
    "referenced_works,related_works,cited_by_api_url,biblio,"
    "is_retracted,is_paratext,mesh"
)


def _extract_openalex_id(raw_id: str | None) -> str:
    """Return the short OpenAlex ID from either a short ID or a full URI."""
    if not raw_id:
        return ""
    if isinstance(raw_id, str) and raw_id.startswith(_OPENALEX_ID_PREFIX):
        return raw_id[len(_OPENALEX_ID_PREFIX) :]
    return str(raw_id)


def _parse_api_url(url: str) -> tuple[str, dict[str, str]]:
    """Parse an OpenAlex API URL into a relative path and query params.

    The returned path is relative to the API host and does not start with ``/``.
    """
    parsed = urlparse(url)
    path = parsed.path.lstrip("/")
    params: dict[str, str] = {}
    for key, values in parse_qs(parsed.query, keep_blank_values=True).items():
        if values:
            params[key] = values[-1]
    return path, params


def _reconstruct_abstract(inverted_index: dict[str, list[int]] | None) -> str | None:
    """Rebuild an abstract string from OpenAlex's inverted index format."""
    if not inverted_index:
        return None
    positions: list[tuple[int, str]] = []
    for word, idxs in inverted_index.items():
        for idx in idxs:
            positions.append((idx, word))
    if not positions:
        return None
    positions.sort(key=lambda x: x[0])
    return " ".join(word for _, word in positions)


def _extract_arxiv_id(ids: dict[str, Any] | None) -> str | None:
    """Extract an arXiv identifier from the work's ``ids`` block."""
    if not ids:
        return None
    arxiv = ids.get("arxiv") or ids.get("arxiv_id")
    if isinstance(arxiv, str):
        return arxiv
    return None


def _parse_work(work: dict[str, Any]) -> PaperCandidate:
    """Convert a raw OpenAlex work object into a ``PaperCandidate``."""
    raw_id = work.get("id", "")
    openalex_id = _extract_openalex_id(raw_id)
    title = work.get("display_name") or work.get("title") or ""
    abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))
    doi = work.get("doi")
    arxiv_id = _extract_arxiv_id(work.get("ids"))
    return PaperCandidate(
        paper_id=openalex_id,
        title=title,
        abstract=abstract,
        doi=doi,
        arxiv_id=arxiv_id,
    )


def _is_not_found(exc: OpenAlexResponseError) -> bool:
    """Return True if the wrapped exception is an HTTP 404."""
    cause = exc.__cause__
    return isinstance(cause, httpx.HTTPStatusError) and cause.response.status_code == 404


class OpenAlexClient:
    """Async OpenAlex client with rate limiting, retries, and citation helpers."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        mailto: str | None = None,
        base_url: str = "https://api.openalex.org",
        timeout: float = 30.0,
        max_retries: int = 3,
        per_page: int = 100,
        rate_limit_rps: float = 10.0,
    ) -> None:
        """Initialize the client.

        Args:
            api_key: OpenAlex API key. Falls back to ``OPENALEX_API_KEY``.
            mailto: Contact email for the polite pool. Falls back to ``OPENALEX_MAILTO``.
            base_url: OpenAlex API base URL.
            timeout: Request timeout in seconds.
            max_retries: Maximum retry attempts after the first failed request.
            per_page: Results per list request (max 200).
            rate_limit_rps: Maximum requests per second for polite-pool throttling.
        """
        self.api_key = api_key or os.environ.get("OPENALEX_API_KEY") or None
        self.mailto = mailto or os.environ.get("OPENALEX_MAILTO") or None
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(0, max_retries)
        self.per_page = max(1, min(per_page, 200))
        self.rate_limit_rps = max(0.1, rate_limit_rps)
        self._min_interval = 1.0 / self.rate_limit_rps
        self._last_request_at: float = 0.0
        self._lock = asyncio.Lock()
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout))
        return self._client

    async def _rate_limit(self) -> None:
        """Enforce the configured requests-per-second ceiling."""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_at
            if elapsed < self._min_interval:
                wait = self._min_interval - elapsed
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._last_request_at = now

    def _params(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build query params including auth and polite-pool markers."""
        params: dict[str, Any] = {}
        if self.api_key:
            params["api_key"] = self.api_key
        if self.mailto:
            params["mailto"] = self.mailto
        if extra:
            params.update(extra)
        return params

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any | None = None,
    ) -> tuple[httpx.Response, int]:
        """Make a rate-limited request with bounded exponential backoff.

        Returns the response and the credits consumed as reported by OpenAlex.
        """
        await self._rate_limit()
        client = await self._get_client()
        url = f"{self.base_url}/{path.lstrip('/')}"
        request_params = self._params(params)
        last_exception: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = await client.request(method, url, params=request_params, json=json)
                response.raise_for_status()
                credits_used = int(response.headers.get("X-RateLimit-Credits-Used", "0"))
                return response, credits_used
            except httpx.TimeoutException as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise OpenAlexTimeoutError(f"OpenAlex request timed out after {attempt + 1} attempts") from exc
            except httpx.HTTPStatusError as exc:
                last_exception = exc
                status = exc.response.status_code
                if status == 429:
                    if attempt == self.max_retries:
                        raise OpenAlexRateLimitError(
                            f"OpenAlex rate limit exceeded after {attempt + 1} attempts: {exc.response.text[:200]}"
                        ) from exc
                elif 400 <= status < 500:
                    raise OpenAlexResponseError(
                        f"OpenAlex request failed with status {status}: {exc.response.text[:200]}"
                    ) from exc
                elif attempt == self.max_retries:
                    raise OpenAlexResponseError(
                        f"OpenAlex request failed with status {status} after retries: {exc.response.text[:200]}"
                    ) from exc
            except httpx.RequestError as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise OpenAlexError(f"OpenAlex request failed: {exc}") from exc

            wait = min(2**attempt, 60.0)
            await asyncio.sleep(wait)

        # Unreachable unless the retry loop exits unexpectedly; kept for the type checker.
        raise OpenAlexError(f"OpenAlex request failed after retries: {last_exception}")

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> tuple[dict[str, Any], int]:
        """GET a JSON object from the API."""
        response, credits = await self._request("GET", path, params=params)
        try:
            payload = response.json()
        except ValueError as exc:
            raise OpenAlexResponseError("OpenAlex response is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise OpenAlexResponseError("OpenAlex response is not a JSON object")
        return payload, credits

    def _build_search_params(
        self,
        query: str,
        filters: dict[str, str] | None,
        sort: str | None,
        page: int,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "search": query,
            "per-page": self.per_page,
            "page": page,
            "select": _WORK_SELECT,
        }
        if filters:
            params["filter"] = ",".join(f"{k}:{v}" for k, v in filters.items())
        if sort:
            params["sort"] = sort
        return params

    async def search(
        self,
        query: str,
        *,
        filters: dict[str, str] | None = None,
        top_k: int = 100,
        sort: str | None = None,
    ) -> OpenAlexSearchResult:
        """Search works using OpenAlex's full-text search and filters."""
        start = time.perf_counter_ns()
        candidates: list[PaperCandidate] = []
        total_count = 0
        page = 1
        api_calls = 0
        credits_used = 0

        while len(candidates) < top_k:
            params = self._build_search_params(query, filters, sort, page)
            payload, credits = await self._get("works", params)
            api_calls += 1
            credits_used += credits

            meta = payload.get("meta") or {}
            if total_count == 0:
                total_count = meta.get("count", 0)

            results = payload.get("results") or []
            if not results:
                break

            for work in results:
                if len(candidates) >= top_k:
                    break
                candidates.append(_parse_work(work))

            if not results:
                break
            if 0 < total_count <= len(candidates):
                break
            page += 1

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return OpenAlexSearchResult(
            query=query,
            candidates=candidates,
            total_count=total_count,
            page_count=page,
            api_calls=api_calls,
            credits_used=credits_used,
            elapsed_ms=elapsed_ms,
        )

    async def get_work(self, openalex_id: str) -> PaperCandidate | None:
        """Fetch a single work by its OpenAlex ID. Returns ``None`` for 404."""
        clean_id = _extract_openalex_id(openalex_id)
        params: dict[str, Any] = {"select": _WORK_SELECT}
        try:
            payload, _ = await self._get(f"works/{clean_id}", params)
        except OpenAlexResponseError as exc:
            if _is_not_found(exc):
                return None
            raise
        return _parse_work(payload)

    async def get_works_by_dois(self, dois: list[str]) -> list[PaperCandidate]:
        """Batch-fetch works by DOI using OR filters (up to 50 per request)."""
        return [c for c, _ in await self.get_works_by_dois_with_raw(dois)]

    async def get_works_by_dois_with_raw(self, dois: list[str]) -> list[tuple[PaperCandidate, dict[str, Any]]]:
        """Batch-fetch works by DOI, returning both parsed candidate and raw work JSON."""
        if not dois:
            return []

        results: list[tuple[PaperCandidate, dict[str, Any]]] = []
        batch_size = 50
        for i in range(0, len(dois), batch_size):
            batch = dois[i : i + batch_size]
            normalized = []
            for doi in batch:
                # OpenAlex accepts both bare DOIs and https://doi.org/ URIs.
                normalized.append(doi.removeprefix("https://doi.org/"))
            filter_value = "|".join(f"https://doi.org/{doi}" for doi in normalized)
            params: dict[str, Any] = {
                "filter": f"doi:{filter_value}",
                "per-page": batch_size,
                "select": _WORK_SELECT,
            }
            payload, _ = await self._get("works", params)
            for work in payload.get("results") or []:
                results.append((_parse_work(work), work))
        return results

    async def _get_works_by_openalex_ids(self, ids: list[str]) -> tuple[list[PaperCandidate], int, int]:
        """Batch-fetch works by short OpenAlex IDs.

        Returns (candidates, api_calls, credits_used).
        """
        if not ids:
            return [], 0, 0
        candidates: list[PaperCandidate] = []
        api_calls = 0
        credits_used = 0
        batch_size = 50
        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            filter_value = "|".join(batch)
            params: dict[str, Any] = {
                "filter": f"ids.openalex:{filter_value}",
                "per-page": batch_size,
                "select": _WORK_SELECT,
            }
            payload, credits = await self._get("works", params)
            api_calls += 1
            credits_used += credits
            for work in payload.get("results") or []:
                candidates.append(_parse_work(work))
        return candidates, api_calls, credits_used

    async def get_citing_works(
        self,
        openalex_id: str,
        *,
        top_k: int = 100,
    ) -> OpenAlexSearchResult:
        """Return papers that cite the given OpenAlex work."""
        clean_id = _extract_openalex_id(openalex_id)
        params: dict[str, Any] = {"select": _WORK_SELECT}
        start = time.perf_counter_ns()
        payload, _ = await self._get(f"works/{clean_id}", params)
        cited_by_url: str | None = payload.get("cited_by_api_url")
        if not cited_by_url:
            elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
            return OpenAlexSearchResult(
                query=f"cited_by:{clean_id}",
                candidates=[],
                total_count=0,
                page_count=0,
                api_calls=1,
                credits_used=0,
                elapsed_ms=elapsed_ms,
            )

        path, base_params = _parse_api_url(cited_by_url)

        result = await self._fetch_list(
            query=f"cited_by:{clean_id}",
            path=path,
            top_k=top_k,
            base_params=base_params,
        )
        result.api_calls += 1  # count the initial work lookup
        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        result.elapsed_ms = elapsed_ms
        return result

    async def get_referenced_works(
        self,
        openalex_id: str,
        *,
        top_k: int = 100,
    ) -> OpenAlexSearchResult:
        """Return papers referenced by the given OpenAlex work."""
        clean_id = _extract_openalex_id(openalex_id)
        params: dict[str, Any] = {"select": _WORK_SELECT}
        start = time.perf_counter_ns()
        payload, _ = await self._get(f"works/{clean_id}", params)
        referenced = payload.get("referenced_works") or []
        referenced_ids = [_extract_openalex_id(rid) for rid in referenced[:top_k]]

        candidates, batch_calls, batch_credits = await self._get_works_by_openalex_ids(referenced_ids)
        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return OpenAlexSearchResult(
            query=f"referenced_by:{clean_id}",
            candidates=candidates,
            total_count=len(referenced),
            page_count=1 if batch_calls else 0,
            api_calls=1 + batch_calls,
            credits_used=batch_credits,
            elapsed_ms=elapsed_ms,
        )

    async def _fetch_list(
        self,
        query: str,
        path: str,
        top_k: int,
        base_params: dict[str, Any] | None = None,
    ) -> OpenAlexSearchResult:
        """Generic paginated list fetcher."""
        start = time.perf_counter_ns()
        candidates: list[PaperCandidate] = []
        total_count = 0
        page = 1
        api_calls = 0
        credits_used = 0

        while len(candidates) < top_k:
            params: dict[str, Any] = {
                "per-page": self.per_page,
                "page": page,
                "select": _WORK_SELECT,
            }
            if base_params:
                params.update(base_params)
            payload, credits = await self._get(path, params)
            api_calls += 1
            credits_used += credits

            meta = payload.get("meta") or {}
            if total_count == 0:
                total_count = meta.get("count", 0)

            results = payload.get("results") or []
            if not results:
                break

            for work in results:
                if len(candidates) >= top_k:
                    break
                candidates.append(_parse_work(work))

            if 0 < total_count <= len(candidates):
                break
            page += 1

        elapsed_ms = (time.perf_counter_ns() - start) // 1_000_000
        return OpenAlexSearchResult(
            query=query,
            candidates=candidates,
            total_count=total_count,
            page_count=page,
            api_calls=api_calls,
            credits_used=credits_used,
            elapsed_ms=elapsed_ms,
        )

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    # Synchronous wrappers ----------------------------------------------------

    def _run(self, coro: Any) -> Any:
        """Run an async coroutine from a synchronous context.

        Each synchronous call gets a fresh ``httpx.AsyncClient`` that is closed
        before the temporary event loop is destroyed. This prevents transports
        from being reused across closed loops.
        """

        async def _wrapped() -> Any:
            self._client = None
            try:
                return await coro
            finally:
                if self._client is not None and not self._client.is_closed:
                    await self._client.aclose()
                    self._client = None

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(_wrapped())
        if loop.is_running():
            return loop.run_until_complete(_wrapped())
        return asyncio.run(_wrapped())

    def search_sync(
        self,
        query: str,
        *,
        filters: dict[str, str] | None = None,
        top_k: int = 100,
        sort: str | None = None,
    ) -> OpenAlexSearchResult:
        """Synchronous wrapper for :meth:`search`."""
        return self._run(self.search(query, filters=filters, top_k=top_k, sort=sort))

    def get_work_sync(self, openalex_id: str) -> PaperCandidate | None:
        """Synchronous wrapper for :meth:`get_work`."""
        return self._run(self.get_work(openalex_id))

    def get_works_by_dois_sync(self, dois: list[str]) -> list[PaperCandidate]:
        """Synchronous wrapper for :meth:`get_works_by_dois`."""
        return self._run(self.get_works_by_dois(dois))

    def get_works_by_dois_with_raw_sync(self, dois: list[str]) -> list[tuple[PaperCandidate, dict[str, Any]]]:
        """Synchronous wrapper for :meth:`get_works_by_dois_with_raw`."""
        return self._run(self.get_works_by_dois_with_raw(dois))

    def get_citing_works_sync(
        self,
        openalex_id: str,
        *,
        top_k: int = 100,
    ) -> OpenAlexSearchResult:
        """Synchronous wrapper for :meth:`get_citing_works`."""
        return self._run(self.get_citing_works(openalex_id, top_k=top_k))

    def get_referenced_works_sync(
        self,
        openalex_id: str,
        *,
        top_k: int = 100,
    ) -> OpenAlexSearchResult:
        """Synchronous wrapper for :meth:`get_referenced_works`."""
        return self._run(self.get_referenced_works(openalex_id, top_k=top_k))
