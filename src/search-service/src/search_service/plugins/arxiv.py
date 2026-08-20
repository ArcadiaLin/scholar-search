"""arXiv source plugin.

This plugin queries the arXiv Atom API and normalizes results into the common
``SearchResultItem`` schema.
"""

from __future__ import annotations

import asyncio
import re
import time
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from search_service.exceptions import SourceError
from search_service.models import SearchResultItem
from search_service.plugin_loader import SourcePlugin

_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5}|arxiv:\d{4}\.\d{4,5})", re.IGNORECASE)


def _extract_arxiv_id(text: str) -> str | None:
    """Extract an arXiv ID from an arXiv URI or text."""
    match = _ARXIV_ID_RE.search(text)
    if not match:
        return None
    raw = match.group(1)
    return raw.lower().removeprefix("arxiv:")


def _clean_text(text: str | None) -> str:
    """Normalize whitespace in text content."""
    if text is None:
        return ""
    return " ".join(text.split())


def _extract_doi(entry: ET.Element) -> str | None:
    """Look for a DOI in arXiv category or comment fields if present."""
    # arXiv Atom does not consistently expose DOI; this is a placeholder for
    # any future namespace extraction.
    return None


def _local_name(tag: str) -> tuple[str, str | None]:
    """Return (local_name, namespace_prefix) for an Atom/arxiv tag."""
    if tag.startswith("{http://www.w3.org/2005/Atom}"):
        return tag.split("}", 1)[1], "atom"
    if tag.startswith("{http://arxiv.org/schemas/atom}"):
        return tag.split("}", 1)[1], "arxiv"
    return tag, None


def _extract_raw_fields(entry: ET.Element) -> dict[str, Any]:
    """Collect arXiv entry fields that are not mapped to the unified schema."""
    extracted = {"title", "id", "summary", "published", "author", "link"}
    raw: dict[str, Any] = {}

    for child in entry:
        local, ns = _local_name(child.tag)
        if local in extracted and ns == "atom":
            continue

        key = f"arxiv:{local}" if ns == "arxiv" else local
        if child.attrib:
            value: Any = {"text": child.text, **dict(child.attrib)}
        else:
            value = child.text

        if key in raw:
            if not isinstance(raw[key], list):
                raw[key] = [raw[key]]
            raw[key].append(value)
        else:
            raw[key] = value

    # Collect author affiliations (nested under <author>).
    affiliations: list[str] = []
    for author in entry.findall("atom:author", _ATOM_NS):
        for affil in author:
            _, ns = _local_name(affil.tag)
            if ns == "arxiv" and affil.text:
                affiliations.append(affil.text.strip())
    if affiliations:
        raw["arxiv:affiliation"] = affiliations

    return raw


def _parse_entry(entry: ET.Element, rank: int | None = None) -> SearchResultItem:
    """Parse a single arXiv Atom entry into a normalized result item."""
    id_el = entry.find("atom:id", _ATOM_NS)
    arxiv_id = _extract_arxiv_id(id_el.text if id_el is not None else "")

    title_el = entry.find("atom:title", _ATOM_NS)
    title = _clean_text(title_el.text if title_el is not None else "")

    summary_el = entry.find("atom:summary", _ATOM_NS)
    abstract = _clean_text(summary_el.text if summary_el is not None else None) or None

    published_el = entry.find("atom:published", _ATOM_NS)
    published = published_el.text if published_el is not None else None
    year: int | None = None
    if published and len(published) >= 4:
        try:
            year = int(published[:4])
        except ValueError:
            year = None

    authors: list[str] = []
    for author in entry.findall("atom:author", _ATOM_NS):
        name_el = author.find("atom:name", _ATOM_NS)
        if name_el is not None and name_el.text:
            authors.append(name_el.text.strip())

    urls: dict[str, str | None] = {"paper": None, "pdf": None, "html": None}
    if arxiv_id:
        urls["paper"] = f"https://arxiv.org/abs/{arxiv_id}"
        urls["pdf"] = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
        urls["html"] = f"https://arxiv.org/html/{arxiv_id}"

    return SearchResultItem(
        paper_id=arxiv_id or (id_el.text if id_el is not None else ""),
        title=title,
        authors=authors if authors else None,
        abstract=abstract,
        published=published,
        year=year,
        doi=_extract_doi(entry),
        arxiv_id=arxiv_id,
        openalex_id=None,
        urls=urls,
        source="arxiv",
        source_rank=rank,
        raw=_extract_raw_fields(entry),
    )


def _parse_feed(xml_text: str) -> list[SearchResultItem]:
    """Parse arXiv Atom feed XML into normalized result items."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise SourceError("arxiv", "parse", f"Failed to parse arXiv XML: {exc}") from exc

    entries = root.findall("atom:entry", _ATOM_NS)
    return [_parse_entry(entry, rank=idx + 1) for idx, entry in enumerate(entries)]


class ArxivClient:
    """Async arXiv API client with polite rate limiting."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.base_url = str(config.get("base_url", "https://export.arxiv.org/api/query")).rstrip("/")
        self.timeout = float(config.get("timeout", 30.0))
        self.max_retries = max(0, int(config.get("max_retries", 2)))
        self.rate_limit_rps = max(0.1, float(config.get("rate_limit_rps", 0.33)))
        self._min_interval = 1.0 / self.rate_limit_rps
        self._last_request_at = 0.0
        self._lock = asyncio.Lock()
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout),
                follow_redirects=True,
            )
        return self._client

    async def _rate_limit(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_at
            if elapsed < self._min_interval:
                await asyncio.sleep(self._min_interval - elapsed)
                now = time.monotonic()
            self._last_request_at = now

    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        """Query arXiv and return normalized result items."""
        await self._rate_limit()
        client = await self._get_client()
        params = {
            "search_query": f"all:{query}",
            "start": 0,
            "max_results": top_k,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }

        last_exception: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await client.get(self.base_url, params=params)
                response.raise_for_status()
                return _parse_feed(response.text)
            except httpx.TimeoutException as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("arxiv", "timeout", f"arXiv request timed out after {attempt + 1} attempts") from exc
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status == 429:
                    if attempt == self.max_retries:
                        raise SourceError("arxiv", "rate_limit", "arXiv rate limit exceeded") from exc
                elif 400 <= status < 500:
                    raise SourceError("arxiv", "http", f"arXiv client error {status}: {exc.response.text[:200]}") from exc
                elif attempt == self.max_retries:
                    raise SourceError("arxiv", "http", f"arXiv server error {status}: {exc.response.text[:200]}") from exc
            except httpx.RequestError as exc:
                last_exception = exc
                if attempt == self.max_retries:
                    raise SourceError("arxiv", "http", f"arXiv request failed: {exc}") from exc

            wait = min(2**attempt, 60.0)
            await asyncio.sleep(wait)

        raise SourceError("arxiv", "unknown", f"arXiv request failed after retries: {last_exception}")

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()


class ArxivPlugin(SourcePlugin):
    """arXiv source plugin."""

    name = "arxiv"

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self._client = ArxivClient(config)

    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        try:
            return await self._client.search(query, top_k)
        finally:
            await self._client.close()


Plugin = ArxivPlugin
