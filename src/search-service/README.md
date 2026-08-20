# Scholar Search Service

A pluggable HTTP aggregation service for academic paper search. It exposes a
small set of REST endpoints that query multiple online sources in parallel
(currently OpenAlex, arXiv, and Serper), merges and deduplicates the results,
and returns them in a unified schema.

## Features

- **Pluggable sources**: add or remove search APIs by dropping Python files into
  `src/search_service/plugins/` and enabling them in `config.yaml`.
- **Parallel aggregation**: queries all enabled sources concurrently.
- **Partial failure tolerance**: if one source is down or rate-limited, the
  service still returns results from the others and reports the failure.
- **TTL in-memory cache**: repeated queries are served from cache.
- **Unified response schema**: results from heterogeneous APIs are normalized
  into a common format.

## Quick start

```bash
cd src/search-service
uv sync
uv run uvicorn search_service.main:app --reload --host 0.0.0.0 --port 8000
```

## Configuration

Copy `config.yaml` and adjust it for your environment:

```yaml
service:
  host: "0.0.0.0"
  port: 8000
  log_level: "info"
  default_top_k: 20
  default_timeout_ms: 15000

cache:
  ttl_seconds: 300

plugins:
  openalex:
    enabled: true
    api_key: ""          # or set OPENALEX_API_KEY env var
    mailto: ""           # or set OPENALEX_MAILTO env var
    rate_limit_rps: 10.0

  arxiv:
    enabled: true
    rate_limit_rps: 0.33 # 1 req / 3s

  serper:
    enabled: true
    api_key: ""          # or set SERPER_API_KEY env var
    rate_limit_rps: 1.0
```

Sensitive values can be injected via environment variables:

- `OPENALEX_API_KEY`
- `OPENALEX_MAILTO`
- `SERPER_API_KEY`
- `SEARCH_CONFIG_FILE` — path to an alternative YAML config
- `SEARCH_PLUGIN_DIRS` — comma-separated list of extra plugin directories

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service and plugin health |
| POST | `/search` | Generic search (use `mode` field) |
| POST | `/search/metadata` | Metadata search (OpenAlex + arXiv) |
| POST | `/search/fulltext` | Full-text/PDF link search (arXiv + Serper) |

Example:

```bash
curl -X POST http://localhost:8000/search/metadata \
  -H "Content-Type: application/json" \
  -d '{"query": "transformer architecture", "top_k": 10}'
```

## Adding a new source plugin

1. Create `src/search_service/plugins/<name>.py`.
2. Implement a `SourcePlugin` subclass and expose it as `Plugin`:

```python
from search_service.models import SearchResultItem
from search_service.plugin_loader import SourcePlugin

class MyPlugin(SourcePlugin):
    name = "myplugin"

    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        ...

Plugin = MyPlugin
```

3. Add a `plugins.<name>` section to `config.yaml` with `enabled: true`.
4. Restart the service.

## Docker

Build and run:

```bash
docker build -t scholar-search-service .
docker run -p 8000:8000 -e SERPER_API_KEY=... scholar-search-service
```

For production with multiple workers:

```bash
docker run -p 8000:8000 scholar-search-service \
  gunicorn search_service.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

## Tests

```bash
uv run pytest
```

Tests use mocked HTTP responses and do not call real APIs by default.
