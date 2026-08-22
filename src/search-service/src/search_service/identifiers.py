"""One parser for the identifier space every endpoint shares.

Tool A's output must be a legal input to tool B. That contract broke because each
endpoint carried its own idea of what an identifier looks like: ``/search`` hands
out ``paper_id`` values that are DOI URLs (OpenAlex's own ``doi`` field shape),
``/paper/{id}`` guessed a provider from three local regexes, and
``/expand/citations`` passed the string through to OpenAlex untouched - which
answers ``400 ... is not a valid OpenAlex ID`` for exactly the ids the other two
endpoints produce and accept (``docs/develop/backlog.md`` F-10).

So parsing lives here, once, and every endpoint that takes an identifier routes
through it. Two things this module is careful about:

- **It normalizes to the form a provider actually accepts, not to a pretty
  form.** Measured against the live API on 2026-08-21: ``works/W2741809807`` and
  ``works/doi:10.1234/abc`` resolve as singleton lookups (cost $0), while
  ``works/https://doi.org/10.1234/abc`` and ``works/arxiv:2101.00001`` do not.
  arXiv preprints are addressable in OpenAlex through their registered DOI,
  ``10.48550/arXiv.<id>``, which is why an arXiv id can be routed to OpenAlex at
  all.
- **An unrecognised string is an answer, not a guess.** ``parse_identifier``
  returns ``None`` rather than hoping a provider will cope, so the caller can
  report a bad input as a bad input instead of as an absent paper.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

IdentifierKind = Literal["openalex", "doi", "arxiv"]

#: What the endpoints accept, in the words a caller needs to fix its input.
ACCEPTED_ID_FORMS = (
    "an OpenAlex id (W2741809807 or https://openalex.org/W2741809807), "
    "a DOI (10.1234/abc, doi:10.1234/abc or https://doi.org/10.1234/abc), "
    "or an arXiv id (2101.00001, arXiv:2101.00001v2 or https://arxiv.org/abs/2101.00001)"
)

# The `openalex:` prefix is accepted because `canonical_key` emits it: a canonical
# id is handed back to the tools as a seed, so it has to parse.
_OPENALEX_RE = re.compile(r"^(?:openalex:|https?://openalex\.org/)?(W\d+)$", re.IGNORECASE)
_DOI_PREFIX_RE = re.compile(r"^(?:doi:|https?://(?:dx\.)?doi\.org/)", re.IGNORECASE)
_DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
_ARXIV_PREFIX_RE = re.compile(r"^(?:arxiv:|https?://arxiv\.org/(?:abs|pdf)/)", re.IGNORECASE)
_ARXIV_NEW_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")
_ARXIV_OLD_RE = re.compile(r"^[a-z-]+(?:\.[A-Za-z]{2})?/\d{7}(v\d+)?$")
#: The DOI prefix arXiv registers for every submission, which is how OpenAlex indexes them.
_ARXIV_DOI_PREFIX = "10.48550/arXiv."


@dataclass(frozen=True)
class PaperIdentifier:
    """A parsed identifier: which id space it belongs to, and its canonical value."""

    kind: IdentifierKind
    #: Canonical within its space: ``W2741809807`` / ``10.1234/abc`` / ``2101.00001v2``.
    value: str
    #: Exactly what the caller passed, so a diagnostic can quote it back.
    raw: str


def parse_identifier(raw: str) -> PaperIdentifier | None:
    """Parse one identifier string, or return ``None`` if it is not one.

    The arXiv branch comes before the DOI branch on purpose: an arXiv DOI
    (``10.48550/arXiv.2101.00001``) is both, and the arXiv id is the more
    specific reading - it is the only one arXiv itself can resolve.
    """
    text = raw.strip()
    if not text:
        return None

    openalex = _OPENALEX_RE.match(text)
    if openalex:
        return PaperIdentifier("openalex", openalex.group(1).upper(), raw)

    arxiv_body = _ARXIV_PREFIX_RE.sub("", text).removesuffix(".pdf")
    if _ARXIV_NEW_RE.match(arxiv_body) or _ARXIV_OLD_RE.match(arxiv_body):
        return PaperIdentifier("arxiv", arxiv_body, raw)

    doi_body = _DOI_PREFIX_RE.sub("", text)
    if _DOI_RE.match(doi_body):
        lowered = doi_body.lower()
        prefix = _ARXIV_DOI_PREFIX.lower()
        if lowered.startswith(prefix):
            return PaperIdentifier("arxiv", doi_body[len(prefix) :], raw)
        return PaperIdentifier("doi", doi_body, raw)

    return None


_VERSION_SUFFIX_RE = re.compile(r"v\d+$")


def strip_arxiv_version(arxiv_id: str) -> str:
    """Drop a trailing ``v3``. Versionless is the form that names the submission."""
    return _VERSION_SUFFIX_RE.sub("", arxiv_id)


def arxiv_id_of(identifier: PaperIdentifier, *, with_version: bool = True) -> str | None:
    """The arXiv id this identifier denotes, if it denotes one."""
    if identifier.kind != "arxiv":
        return None
    return identifier.value if with_version else strip_arxiv_version(identifier.value)


def openalex_address(identifier: PaperIdentifier) -> str:
    """The path segment that addresses this work in OpenAlex's ``/works/`` route.

    A DOI goes in as ``doi:<doi>`` and an arXiv id as its registered arXiv DOI,
    because those are the two forms the API resolves as a singleton lookup.
    """
    if identifier.kind == "openalex":
        return identifier.value
    if identifier.kind == "doi":
        return f"doi:{identifier.value}"
    # Version suffixes are an arXiv concept; the DOI is registered per submission.
    return f"doi:{_ARXIV_DOI_PREFIX}{strip_arxiv_version(identifier.value)}"
