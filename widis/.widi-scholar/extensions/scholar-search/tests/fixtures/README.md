# scholar-search fixtures

Recorded Search Service responses. Bytes, not source: `scripts/widis-quality.mjs`
skips this directory so biome never reformats the very thing a parser test
asserts against.

## `providers.json`

`GET /providers` as the service actually answers it, captured from
`src/search-service/` with its checked-in `config.yaml`:

```bash
cd src/search-service
PYTHONPATH=src uv run python -c "
import json
from fastapi.testclient import TestClient
from search_service.main import app
with TestClient(app) as c:
    print(json.dumps(c.get('/providers').json(), indent=2))
"
```

Captured 2026-08-20. Contents at that point: `openalex` (enabled),
`arxiv` (enabled), `serper` (disabled) — the disabled one is kept deliberately,
since "configured but disabled" is a state `list_providers` has to report
distinctly from "absent".

Re-record it when the service's provider set or the `ProviderInfo` schema
changes. Do not hand-edit it to make a test pass: a fixture that no longer
matches the service is worse than a failing test.

## `search-metadata.json`

`POST /search/metadata` with one subquery, recorded against a stubbed provider so
the paper content is fixed while the envelope — `search_state.issued_queries`,
`candidate_counts`, `filters.subqueries`, and the full `Paper` including `raw` —
is exactly what the service produces:

```bash
cd src/search-service
PYTHONPATH=src uv run python - <<'PY'
import json
from unittest import mock
from fastapi.testclient import TestClient
from search_service.main import app
from search_service.models import SearchResultItem

item = SearchResultItem(
    paper_id="10.48550/arXiv.1706.03762", title="Attention Is All You Need",
    source="openalex", source_rank=1, doi="10.48550/arXiv.1706.03762",
    arxiv_id="1706.03762", openalex_id="W2963403868", year=2017,
    published="2017-06-12", venue="NeurIPS",
    abstract="The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
    authors=["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones", "Aidan Gomez"],
    urls={"paper": "https://arxiv.org/abs/1706.03762", "pdf": "https://arxiv.org/pdf/1706.03762.pdf"},
)
with TestClient(app) as c, \
     mock.patch("search_service.plugins.openalex.OpenAlexPlugin.search", mock.AsyncMock(return_value=[item])), \
     mock.patch("search_service.plugins.arxiv.ArxivPlugin.search", mock.AsyncMock(return_value=[])):
    print(json.dumps(c.post("/search/metadata", json={
        "query": "transformer attention", "top_k": 5, "subqueries": ["self-attention"]}).json(), indent=2))
PY
```

The `raw` block is kept deliberately: one test asserts that it is present in the
fixture and absent from the summary the client produces, which is the check that
`PaperSummary` has not quietly started carrying whole records.

Re-recorded 2026-08-21 for `issued_queries[].native_query` (F-1). The item above
now carries the abstract, authors, venue, date and URLs the fixture has always
had; the earlier snippet in this file omitted them and would have re-recorded a
thinner fixture than the one committed.

## `paper-lookup.json`

`GET /paper/{paper_id}` with a stubbed arXiv lookup — the envelope (`source`,
`tried_sources`, `failures`) is the service's.

Captured 2026-08-20, same session as the others.
