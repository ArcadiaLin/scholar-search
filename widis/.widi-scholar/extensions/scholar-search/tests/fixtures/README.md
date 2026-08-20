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
