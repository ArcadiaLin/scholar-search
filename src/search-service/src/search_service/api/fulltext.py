"""Full-text evidence retrieval.

``POST /fulltext`` returns the body sections of papers whose full text is
reachable, so a claim can be checked against the text rather than the abstract.

Scope, stated plainly: this is retrieval **by identifier**, not a full-text
search index. There is no full-text index behind this service, and pretending
otherwise would make `search_fulltext(query=...)` look like a recall path it is
not. `query` filters and ranks the sections of the papers you name; it does not
find new papers. Recall stays with ``/search``.

Today the only reachable full text is arXiv's, via ar5iv's HTML rendering. A
paper with no ar5iv rendering comes back `available: false` with the reason,
which is a fact about coverage rather than an error.
"""

from __future__ import annotations

import asyncio
import re
from html.parser import HTMLParser

import httpx
from fastapi import APIRouter, Request

from search_service.call_ledger import CallLedger
from search_service.schemas import FulltextPaper, FulltextRequest, FulltextResponse, FulltextSection

router = APIRouter(tags=["fulltext"])

_AR5IV_URL = "https://ar5iv.labs.arxiv.org/html/{arxiv_id}"
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5})")
_SECTION_TAGS = {"h1", "h2", "h3", "h4"}


class _Ar5ivParser(HTMLParser):
    """Collect (heading, body) pairs from an ar5iv page.

    A parser rather than a regex because the body of a section is everything
    between two headings, which a regex over nested markup gets wrong in exactly
    the cases that matter (display maths, nested lists, footnotes).
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[tuple[str, list[str]]] = [("(front matter)", [])]
        self._in_heading = False
        self._heading_parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self._skip_depth += 1
            return
        if tag in _SECTION_TAGS:
            self._in_heading = True
            self._heading_parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in _SECTION_TAGS and self._in_heading:
            self._in_heading = False
            title = " ".join("".join(self._heading_parts).split())
            if title:
                self.sections.append((title, []))

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_heading:
            self._heading_parts.append(data)
            return
        if data.strip():
            self.sections[-1][1].append(data.strip())


def _extract_arxiv_id(paper_id: str) -> str | None:
    match = _ARXIV_ID_RE.search(paper_id)
    return match.group(1) if match else None


async def _fetch_sections(client: httpx.AsyncClient, arxiv_id: str) -> tuple[list[tuple[str, str]], str | None]:
    try:
        response = await client.get(_AR5IV_URL.format(arxiv_id=arxiv_id))
    except httpx.HTTPError as exc:
        return [], f"ar5iv request failed: {exc}"
    if response.status_code == 404:
        return [], "no ar5iv rendering exists for this paper"
    if response.status_code >= 400:
        return [], f"ar5iv returned HTTP {response.status_code}"

    parser = _Ar5ivParser()
    parser.feed(response.text)
    sections = [(title, " ".join(parts)) for title, parts in parser.sections if parts]
    if not sections:
        return [], "ar5iv page fetched but no sections could be extracted"
    return sections, None


@router.post("/fulltext", response_model=FulltextResponse)
async def fulltext(payload: FulltextRequest, request: Request) -> FulltextResponse:
    """Return full-text sections for the named papers, bounded by configuration."""
    limits = request.app.state.config.get_limits()["fulltext"]
    ledger: CallLedger = request.app.state.ledger

    max_papers = int(limits["max_papers"])
    max_sections = int(limits["max_sections"])
    max_chars = int(limits["max_section_chars"])

    requested = [pid.strip() for pid in payload.paper_ids if pid.strip()]
    clamped = ["paper_ids"] if len(requested) > max_papers else []
    requested = requested[:max_papers]

    terms = {term for term in (payload.query or "").lower().split() if len(term) > 2}
    wanted = [name.lower() for name in (payload.sections or [])]

    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), follow_redirects=True) as client:

        async def _one(paper_id: str) -> FulltextPaper:
            arxiv_id = _extract_arxiv_id(paper_id)
            if arxiv_id is None:
                return FulltextPaper(
                    paper_id=paper_id,
                    available=False,
                    reason="only arXiv papers have reachable full text in this configuration",
                )
            ledger.record("fulltext")
            raw_sections, reason = await _fetch_sections(client, arxiv_id)
            if reason is not None:
                return FulltextPaper(paper_id=paper_id, available=False, reason=reason)

            picked: list[FulltextSection] = []
            for title, text in raw_sections:
                if wanted and not any(name in title.lower() for name in wanted):
                    continue
                haystack = f"{title} {text}".lower()
                matches = sum(haystack.count(term) for term in terms)
                if terms and matches == 0:
                    continue
                body = text if len(text) <= max_chars else f"{text[:max_chars]}..."
                picked.append(FulltextSection(title=title, text=body, match_count=matches))

            # Query given: most-matching sections first, since the caller is
            # looking for evidence, not reading the paper front to back.
            if terms:
                picked.sort(key=lambda section: section.match_count, reverse=True)
            if not picked:
                return FulltextPaper(
                    paper_id=paper_id,
                    available=True,
                    reason="full text retrieved but no section matched the query or section filter",
                )
            return FulltextPaper(paper_id=paper_id, available=True, sections=picked[:max_sections])

        papers = await asyncio.gather(*[_one(pid) for pid in requested])

    return FulltextResponse(
        papers=list(papers),
        effective_limits={"max_papers": max_papers, "max_sections": max_sections, "max_section_chars": max_chars},
        clamped=clamped,
    )
