"""arXiv source plugin.

This plugin queries the arXiv Atom API and normalizes results into the common
``SearchResultItem`` schema.
"""

from __future__ import annotations

import asyncio
import re
import time
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from search_service.exceptions import SourceError
from search_service.identifiers import arxiv_id_of, parse_identifier
from search_service.models import SearchResultItem
from search_service.providers.base import SearchProvider
from search_service.schemas import ProviderCapabilities

_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}
_ARXIV_NS = {"arxiv": "http://arxiv.org/schemas/atom"}
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5}|arxiv:\d{4}\.\d{4,5})", re.IGNORECASE)

#: arXiv's own field prefixes. A term that already carries one is passed through.
_FIELD_PREFIXES = ("all:", "ti:", "abs:", "au:", "co:", "jr:", "cat:", "rn:", "id:")
#: arXiv's boolean operators, which a caller may write itself.
_OPERATORS = frozenset({"AND", "OR", "ANDNOT"})
#: Trimmed from the edges of an unquoted term. Sentence punctuation is not part of
#: the word, and arXiv indexes the word.
_EDGE_PUNCTUATION = "?!.,;:()[]{}\"'`"


def _split_terms(query: str) -> list[str]:
    """Split on whitespace, except inside double quotes. Quotes are kept.

    Keeping the quotes in the token is what lets ``ti:"ViewAL"`` stay one term:
    a quote here marks a span that whitespace does not break, not a token boundary.
    """
    terms: list[str] = []
    buffer: list[str] = []
    in_quotes = False
    for char in query:
        if char == '"':
            in_quotes = not in_quotes
            buffer.append(char)
            continue
        if char.isspace() and not in_quotes:
            if buffer:
                terms.append("".join(buffer))
                buffer = []
            continue
        buffer.append(char)
    if buffer:
        terms.append("".join(buffer))
    return [term for term in (item.strip() for item in terms) if term]


def build_search_query(query: str) -> str:
    """Build the ``search_query`` parameter arXiv will actually be sent.

    arXiv's parser expands whitespace inside ``all:`` into **OR**, so
    ``all:reinforced active learning`` is "any one of these words" - which for a
    query made of common words returns a bag of unrelated papers and drops the
    target entirely (``docs/develop/backlog.md`` F-1, measured 0/4 -> 3/4 on
    ``AutoScholarQuery_train_1`` from this one change). Terms are therefore joined
    with an explicit ``AND``.

    A quoted phrase stays a phrase, but phrasing is not the default: the measured
    all-phrase form returned zero results, so it is too strict to impose.
    """
    rendered: list[str] = []
    for term in _split_terms(query):
        if term in _OPERATORS:
            rendered.append(term)
            continue
        if term.lower().startswith(_FIELD_PREFIXES):
            # The caller wrote arXiv's own syntax; do not second-guess it.
            rendered.append(term)
            continue
        if len(term) > 1 and term.startswith('"') and term.endswith('"'):
            phrase = term[1:-1].strip()
            if phrase:
                rendered.append(f'all:"{phrase}"')
            continue
        word = term.strip(_EDGE_PUNCTUATION)
        if word:
            rendered.append(f"all:{word}")

    if not rendered:
        # Nothing usable to conjoin; send the caller's string as it was handled
        # before rather than an empty query.
        return f"all:{query.strip()}"

    pieces: list[str] = []
    for piece in rendered:
        if pieces and pieces[-1] not in _OPERATORS and piece not in _OPERATORS:
            pieces.append("AND")
        pieces.append(piece)
    return " ".join(pieces)


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

    journal_ref_el = entry.find("arxiv:journal_ref", _ARXIV_NS)
    venue = _clean_text(journal_ref_el.text if journal_ref_el is not None else None) or None

    return SearchResultItem(
        paper_id=arxiv_id or (id_el.text if id_el is not None else ""),
        title=title,
        authors=authors if authors else None,
        abstract=abstract,
        venue=venue,
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
        self._session_lock = asyncio.Lock()
        self._active_sessions = 0
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

    def build_params(
        self,
        query: str,
        top_k: int,
        native_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """The request parameters this client will send for a unified search.

        Public and pure so the trajectory can record the query string that was
        *actually issued* without a second implementation of the rewrite going out
        of step with this one - the divergence between the two is what let F-1 hide.
        """
        params: dict[str, Any] = {
            "search_query": build_search_query(query),
            "start": 0,
            "max_results": top_k,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        if native_params:
            params.update(native_params)
        return params

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        """Query arXiv and return normalized result items."""
        await self._rate_limit()
        client = await self._get_client()
        params = self.build_params(query, top_k, native_params)

        def _after_end_date(item: SearchResultItem) -> bool:
            if not end_date or not item.published:
                return False
            return item.published > end_date

        last_exception: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await client.get(self.base_url, params=params)
                response.raise_for_status()
                items = _parse_feed(response.text)
                if end_date:
                    items = [item for item in items if not _after_end_date(item)]
                return items
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

    async def lookup(self, paper_id: str) -> SearchResultItem | None:
        """Fetch a single entry by arXiv ID.

        ``id_list`` is arXiv's own ID lookup, which unlike ``search_query`` is
        exact: a version suffix is accepted and an unknown ID comes back as an
        empty feed rather than as fuzzy matches.
        """
        identifier = parse_identifier(paper_id)
        # Versionless: ``id_list`` accepts a version but then pins the answer to it,
        # and a caller asking for a paper wants the paper.
        arxiv_id = arxiv_id_of(identifier, with_version=False) if identifier is not None else None
        # An id from another space is a miss, not an error: the caller routes on
        # the ``id_lookup`` capability and tries the next provider.
        if not arxiv_id:
            return None
        items = await self.native_query({"id_list": arxiv_id, "max_results": 1})
        return items[0] if items else None

    async def native_query(self, raw_payload: dict[str, Any]) -> list[SearchResultItem]:
        """Execute a provider-native arXiv query and return parsed items.

        The arXiv Atom API returns XML, so the result is parsed into the same
        normalized items as the regular search endpoint.
        """
        await self._rate_limit()
        client = await self._get_client()

        # Merge caller payload with safe defaults.
        params = {
            "start": 0,
            "max_results": 200,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        params.update(raw_payload)

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

    @asynccontextmanager
    async def session(self) -> AsyncIterator[None]:
        """Bracket one operation, closing the shared client when the last one leaves.

        See ``OpenAlexClient.session``: closing unconditionally after every call
        breaks concurrent queries against one provider, and never closing breaks
        ``search_sync``, which drives each call from its own event loop.
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


class ArxivPlugin(SearchProvider):
    """arXiv source plugin.

    In P0 arXiv is a supplementary source: it provides precise ID/title hits,
    exact abstracts, version information and time-window validation. It does not
    serve as the primary recall source.
    """

    name = "arxiv"

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self._client = ArxivClient(config)

    def _build_capabilities(self) -> ProviderCapabilities:
        cfg = self.config.get("capabilities", {})
        return ProviderCapabilities(
            name=self.name,
            search_keyword=bool(cfg.get("search_keyword", True)),
            search_native_query=bool(cfg.get("search_native_query", True)),
            search_field_filter=bool(cfg.get("search_field_filter", True)),
            facet_group_by=bool(cfg.get("facet_group_by", False)),
            id_lookup=bool(cfg.get("id_lookup", True)),
            id_mapping=bool(cfg.get("id_mapping", False)),
            graph_references=bool(cfg.get("graph_references", False)),
            graph_citations=bool(cfg.get("graph_citations", False)),
            recommend_related=bool(cfg.get("recommend_related", False)),
            metrics_raw_citations=bool(cfg.get("metrics_raw_citations", False)),
            metrics_normalized=bool(cfg.get("metrics_normalized", False)),
            text_abstract=bool(cfg.get("text_abstract", True)),
            text_fulltext=bool(cfg.get("text_fulltext", True)),
            cost_model=self.config.get("cost_model", {}),
            field_map=self.config.get("field_map", {}),
            reliability=self.config.get("reliability", {}),
        )

    def native_query_for(
        self,
        query: str,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> str | None:
        value = self._client.build_params(query, 1, native_params).get("search_query")
        return value if isinstance(value, str) else None

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        filters: dict[str, Any] | None = None,
        subqueries: list[str] | None = None,
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

    async def search_native(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Execute a provider-native arXiv query and return a JSON-serializable dict.

        The arXiv Atom API returns XML; the result is parsed and exposed as a
        dict so the passthrough endpoint can return JSON.
        """
        async with self._client.session():
            items = await self._client.native_query(raw_payload)
            return {"results": [item.model_dump() for item in items]}

    async def lookup(self, paper_id: str) -> dict[str, Any] | None:
        """Look up one arXiv entry by ID.

        The capability table has always advertised ``id_lookup`` for arXiv while
        the base class raised ``NotImplementedError``, so anything routing on the
        capability got a crash instead of a record.
        """
        async with self._client.session():
            item = await self._client.lookup(paper_id)
            return item.model_dump() if item else None


Plugin = ArxivPlugin
