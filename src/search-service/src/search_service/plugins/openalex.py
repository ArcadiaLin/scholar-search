"""OpenAlex source plugin.

This plugin is intentionally self-contained and does not import from
``src.retriever``.  It provides a thin async client over the OpenAlex REST API
with polite-pool markers, rate limiting, and bounded retries.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from search_service.exceptions import SourceError
from search_service.models import SearchResultItem
from search_service.providers.base import SearchProvider
from search_service.schemas import Author, Paper, ProviderCapabilities

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


def _parse_url(work: dict[str, Any]) -> dict[str, str | None]:
    """Extract paper landing page and PDF URLs from a work."""
    urls: dict[str, str | None] = {"paper": None, "pdf": None, "html": None}
    primary = work.get("primary_location") or {}
    landing = primary.get("landing_page_url")
    if isinstance(landing, str):
        urls["paper"] = landing
    pdf = (primary.get("pdf_url") or (work.get("open_access") or {}).get("oa_url"))
    if isinstance(pdf, str):
        urls["pdf"] = pdf
    return urls


def _parse_authors(work: dict[str, Any]) -> list[str] | None:
    """Extract author display names from authorships."""
    authorships = work.get("authorships") or []
    authors: list[str] = []
    for authorship in authorships:
        author = authorship.get("author") or {}
        name = author.get("display_name")
        if isinstance(name, str):
            authors.append(name)
    return authors if authors else None


def _parse_work(work: dict[str, Any], rank: int | None = None) -> SearchResultItem:
    """Convert a raw OpenAlex work object into a normalized result item."""
    raw_id = work.get("id", "")
    openalex_id = _extract_openalex_id(raw_id)
    title = work.get("display_name") or work.get("title") or ""
    abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))
    doi = work.get("doi")
    arxiv_id = _extract_arxiv_id(work.get("ids"))
    publication_date = work.get("publication_date") or str(work.get("publication_year") or "")
    year = work.get("publication_year")
    urls = _parse_url(work)

    # Fields already mapped to the unified schema; exclude from raw.
    extracted_top_fields = {
        "id",
        "display_name",
        "title",
        "publication_year",
        "publication_date",
        "doi",
        "abstract_inverted_index",
        "authorships",
    }
    raw: dict[str, Any] = {k: v for k, v in work.items() if k not in extracted_top_fields}
    # Avoid repeating the extracted arxiv id inside ids.
    if isinstance(raw.get("ids"), dict):
        raw["ids"] = {k: v for k, v in raw["ids"].items() if k != "arxiv"}
        if not raw["ids"]:
            del raw["ids"]

    return SearchResultItem(
        paper_id=doi or arxiv_id or openalex_id,
        title=title,
        authors=_parse_authors(work),
        abstract=abstract,
        published=publication_date if publication_date else None,
        year=int(year) if isinstance(year, int) else None,
        doi=doi,
        arxiv_id=arxiv_id,
        openalex_id=openalex_id,
        urls=urls,
        source="openalex",
        source_rank=rank,
        raw=raw,
    )


def work_to_paper(work: dict[str, Any]) -> Paper:
    """Convert a raw OpenAlex work object into the unified Paper schema."""
    raw_id = work.get("id", "")
    openalex_id = _extract_openalex_id(raw_id)
    title = work.get("display_name") or work.get("title") or ""
    abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))
    doi = work.get("doi")
    arxiv_id = _extract_arxiv_id(work.get("ids"))
    publication_date = work.get("publication_date") or str(work.get("publication_year") or "")
    year = work.get("publication_year")
    urls = _parse_url(work)

    venue = None
    primary_location = work.get("primary_location") or {}
    source = primary_location.get("source") or {}
    if isinstance(source, dict):
        venue = source.get("display_name")

    authors = None
    if work.get("authorships"):
        authors = [
            Author(name=name)
            for name in (_parse_authors(work) or [])
        ]

    # Bibliometric fields.
    citation_count = work.get("cited_by_count")
    normalized_impact = work.get("fwci")
    citation_percentile = None
    if (percentile := work.get("citation_normalized_percentile")) and isinstance(percentile, dict):
        citation_percentile = percentile.get("value")
    counts_by_year = None
    if (counts := work.get("counts_by_year")) and isinstance(counts, list):
        counts_by_year = [
            {"year": c["year"], "count": c["cited_by_count"]}
            for c in counts
            if isinstance(c, dict) and "year" in c and "cited_by_count" in c
        ]

    # Graph fields.
    references = work.get("referenced_works")
    citations = None

    # Quality fields.
    is_retracted = work.get("is_retracted")

    return Paper(
        paper_id=doi or arxiv_id or openalex_id,
        doi=doi,
        arxiv_id=arxiv_id,
        openalex_id=openalex_id,
        title=title,
        abstract=abstract,
        authors=authors,
        venue=venue,
        published=publication_date if publication_date else None,
        year=int(year) if isinstance(year, int) else None,
        urls=urls,
        citation_count=int(citation_count) if isinstance(citation_count, int) else None,
        normalized_impact=float(normalized_impact) if isinstance(normalized_impact, (int, float)) else None,
        citation_percentile=float(citation_percentile) if isinstance(citation_percentile, (int, float)) else None,
        counts_by_year=counts_by_year,
        references=references,
        citations=citations,
        is_retracted=bool(is_retracted) if is_retracted is not None else None,
        sources=["openalex"],
        raw=work,
    )


class OpenAlexClient:
    """Async OpenAlex client with rate limiting and bounded retries."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.api_key = config.get("api_key") or None
        self.mailto = config.get("mailto") or None
        self.base_url = str(config.get("base_url", "https://api.openalex.org")).rstrip("/")
        self.timeout = float(config.get("timeout", 30.0))
        self.max_retries = max(0, int(config.get("max_retries", 3)))
        self.per_page = max(1, min(int(config.get("per_page", 100)), 200))
        self.rate_limit_rps = max(0.1, float(config.get("rate_limit_rps", 10.0)))
        self._min_interval = 1.0 / self.rate_limit_rps
        self._last_request_at = 0.0
        self._lock = asyncio.Lock()
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

    def _params(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if self.api_key:
            params["api_key"] = self.api_key
        if self.mailto:
            params["mailto"] = self.mailto
        if extra:
            params.update(extra)
        return params

    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        await self._rate_limit()
        client = await self._get_client()
        url = f"{self.base_url}/{path.lstrip('/')}"
        request_params = self._params(params)
        last_exception: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = await client.request(method, url, params=request_params)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("OpenAlex response is not a JSON object")
                return payload
            except httpx.TimeoutException as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("openalex", "timeout", f"OpenAlex request timed out after {attempt + 1} attempts") from exc
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status == 429:
                    if attempt == self.max_retries:
                        raise SourceError("openalex", "rate_limit", "OpenAlex rate limit exceeded") from exc
                elif 400 <= status < 500:
                    raise SourceError("openalex", "http", f"OpenAlex client error {status}: {exc.response.text[:200]}") from exc
                elif attempt == self.max_retries:
                    raise SourceError("openalex", "http", f"OpenAlex server error {status}: {exc.response.text[:200]}") from exc
            except httpx.RequestError as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("openalex", "http", f"OpenAlex request failed: {exc}") from exc
            except ValueError as exc:
                raise SourceError("openalex", "parse", f"OpenAlex response parse failed: {exc}") from exc

            wait = min(2**attempt, 60.0)
            await asyncio.sleep(wait)

        raise SourceError("openalex", "unknown", f"OpenAlex request failed after retries: {last_exception}")

    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        """Search works using OpenAlex full-text search."""
        candidates: list[SearchResultItem] = []
        page = 1

        while len(candidates) < top_k:
            params: dict[str, Any] = {
                "search": query,
                "per-page": self.per_page,
                "page": page,
                "select": _WORK_SELECT,
            }
            payload = await self._request("GET", "works", params)
            results = payload.get("results") or []
            if not results:
                break

            for _idx, work in enumerate(results):
                if len(candidates) >= top_k:
                    break
                candidates.append(_parse_work(work, rank=len(candidates) + 1))

            total = (payload.get("meta") or {}).get("count", 0)
            if 0 < total <= len(candidates):
                break
            page += 1

        return candidates

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    async def native_query(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Execute a provider-native query against the works endpoint.

        The caller is responsible for providing a valid OpenAlex parameter set.
        ``select`` is injected if absent to keep responses small.
        """
        params = dict(raw_payload)
        params.setdefault("select", _WORK_SELECT)
        return await self._request("GET", "works", params)

    async def query(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute a provider-native query against any OpenAlex endpoint.

        The caller is responsible for providing a valid OpenAlex endpoint path
        and parameter set. Credentials and polite-pool markers are injected
        automatically.
        """
        return await self._request("GET", endpoint, params)

    async def lookup_work(self, work_id: str) -> dict[str, Any] | None:
        """Fetch a single work by OpenAlex ID (short or full URI)."""
        short_id = _extract_openalex_id(work_id) or work_id
        payload = await self._request(
            "GET",
            f"works/{short_id}",
            {"select": _WORK_SELECT},
        )
        return payload if isinstance(payload, dict) else None

    async def fetch_references(self, work_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """Fetch outgoing references of a work.

        Returns the referenced work objects, capped at ``limit``.
        """
        short_id = _extract_openalex_id(work_id) or work_id
        work = await self.lookup_work(short_id)
        if not work:
            return []
        refs = work.get("referenced_works") or []
        if not refs:
            return []

        results: list[dict[str, Any]] = []
        for ref_id in refs[:limit]:
            ref_short = _extract_openalex_id(ref_id) or ref_id
            try:
                ref = await self.lookup_work(ref_short)
            except SourceError:
                continue
            if ref:
                results.append(ref)
        return results

    async def fetch_citations(self, work_id: str, limit: int = 20) -> list[dict[str, Any]]:
        """Fetch works citing the given work.

        Uses OpenAlex's ``filter=cites:<id>`` mechanism.
        """
        short_id = _extract_openalex_id(work_id) or work_id
        payload = await self._request(
            "GET",
            "works",
            {
                "filter": f"cites:{short_id}",
                "per-page": min(limit, 200),
                "select": _WORK_SELECT,
            },
        )
        return payload.get("results") or []

    async def fetch_facet(self, query: str, group_by: list[str]) -> dict[str, Any]:
        """Return facet distribution for a query."""
        params: dict[str, Any] = {
            "search": query,
            "group-by": ",".join(group_by),
            "per-page": 1,
        }
        return await self._request("GET", "works", params)


class OpenAlexPlugin(SearchProvider):
    """OpenAlex source plugin."""

    name = "openalex"

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self._client = OpenAlexClient(config)

    def _build_capabilities(self) -> ProviderCapabilities:
        cfg = self.config.get("capabilities", {})
        return ProviderCapabilities(
            name=self.name,
            search_keyword=bool(cfg.get("search_keyword", True)),
            search_native_query=bool(cfg.get("search_native_query", True)),
            search_field_filter=bool(cfg.get("search_field_filter", True)),
            facet_group_by=bool(cfg.get("facet_group_by", True)),
            id_lookup=bool(cfg.get("id_lookup", True)),
            id_mapping=bool(cfg.get("id_mapping", False)),
            graph_references=bool(cfg.get("graph_references", True)),
            graph_citations=bool(cfg.get("graph_citations", True)),
            recommend_related=bool(cfg.get("recommend_related", True)),
            metrics_raw_citations=bool(cfg.get("metrics_raw_citations", True)),
            metrics_normalized=bool(cfg.get("metrics_normalized", True)),
            text_abstract=bool(cfg.get("text_abstract", True)),
            text_fulltext=bool(cfg.get("text_fulltext", False)),
            cost_model=self.config.get("cost_model", {}),
            field_map=self.config.get("field_map", {}),
            reliability=self.config.get("reliability", {}),
        )

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        filters: dict[str, Any] | None = None,
        subqueries: list[str] | None = None,
        end_date: str | None = None,
    ) -> list[SearchResultItem]:
        """Search works using OpenAlex full-text search."""
        try:
            return await self._client.search(query, top_k)
        finally:
            await self._client.close()

    async def search_native(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self._client.native_query(raw_payload)
        finally:
            await self._client.close()

    async def query(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute a native query against any OpenAlex endpoint."""
        try:
            return await self._client.query(endpoint, params)
        finally:
            await self._client.close()

    async def lookup(self, paper_id: str) -> dict[str, Any] | None:
        try:
            return await self._client.lookup_work(paper_id)
        finally:
            await self._client.close()

    async def get_references(self, paper_id: str, limit: int = 20) -> list[dict[str, Any]]:
        try:
            return await self._client.fetch_references(paper_id, limit)
        finally:
            await self._client.close()

    async def get_citations(self, paper_id: str, limit: int = 20) -> list[dict[str, Any]]:
        try:
            return await self._client.fetch_citations(paper_id, limit)
        finally:
            await self._client.close()

    async def facet(self, query: str, group_by: list[str]) -> dict[str, Any]:
        try:
            return await self._client.fetch_facet(query, group_by)
        finally:
            await self._client.close()


Plugin = OpenAlexPlugin
