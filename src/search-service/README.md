# Scholar Search Service

一个可插拔的学术文献检索 HTTP 聚合服务。它会并发查询多个在线数据源（当前为 OpenAlex 和 arXiv），对结果进行归一化、去重与重排，并以统一格式返回。

## 特性

- **可插拔数据源**：在 `src/search_service/plugins/` 下添加 Python 插件文件，并在 `config.yaml` 中启用即可接入新的检索 API。
- **并行聚合**：`POST /search` 会并发查询所有选中的数据源。
- **Provider 原生参数**：通过 `provider_params` 按 provider 透传原生参数，同时保持统一的查询入口。
- **跨源去重**：按稳定 ID 去重，优先级为 `DOI > arXiv ID > OpenAlex ID > 源原生 ID`。
- **RRF 重排**：合并后的结果使用 Reciprocal Rank Fusion 计算最终分数。
- **部分失败容忍**：某个源失败时，服务仍会返回其他源的结果，并在 `search_state.failures` 中记录失败信息。

## 快速开始

```bash
cd src/search-service
uv sync
PYTHONPATH=src uv run uvicorn search_service.main:app --reload --host 0.0.0.0 --port 8000
```

## 配置

复制 `config.yaml` 并根据环境调整：

```yaml
service:
  host: "0.0.0.0"
  port: 8000
  log_level: "info"
  default_top_k: 20
  default_timeout_ms: 15000

plugins:
  openalex:
    enabled: true
    api_key: ""          # 或设置 OPENALEX_API_KEY 环境变量
    mailto: ""           # 或设置 OPENALEX_MAILTO 环境变量
    rate_limit_rps: 10.0

  arxiv:
    enabled: true
    rate_limit_rps: 0.33 # 约 1 次 / 3 秒

  serper:
    enabled: false       # 当前版本默认禁用
    api_key: ""          # 或设置 SERPER_API_KEY 环境变量
    rate_limit_rps: 1.0
```

敏感值可通过环境变量注入：

- `OPENALEX_API_KEY`
- `OPENALEX_MAILTO`
- `SERPER_API_KEY`
- `SEARCH_CONFIG_FILE` — 指定其他 YAML 配置文件路径
- `SEARCH_PLUGIN_DIRS` — 额外的插件目录，逗号分隔

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 服务与各插件健康状态 |
| GET | `/providers` | 各 provider 能力表 |
| POST | `/search` | 跨源聚合检索 |
| POST | `/search/metadata` | `/search` 的别名 |
| POST | `/provider/{name}/query` | 单个 provider 的原生查询转发 |

### `POST /search`

统一聚合检索入口。

```bash
curl -s -X POST http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "transformer architecture", "top_k": 20}'
```

请求体示例：

```json
{
  "query": "transformer architecture",
  "top_k": 20,
  "end_date": "2024-12-31",
  "sources": ["openalex", "arxiv"],
  "timeout_ms": 15000,
  "provider_params": {
    "openalex": {"filter": "publication_year:>2020", "sort": "cited_by_count:desc"},
    "arxiv": {"search_query": "ti:transformer AND cat:cs.LG", "max_results": 10}
  }
}
```

字段说明：

- `query`（必填）：统一检索词。
- `top_k`：返回结果上限，默认 20。
- `end_date`：出版日期上边界（不含）。
- `sources`：指定查询的 provider 列表，默认为所有启用 provider。
- `timeout_ms`：整体超时，默认 15000 毫秒。
- `provider_params`：按 provider 名传入的原生参数，会与统一请求合并。

### `POST /provider/{name}/query`

单个 provider 的原生查询转发。OpenAlex 的 `endpoint` 为实体路径（如 `works`、`authors`）；arXiv 的 `endpoint` 被忽略，`params` 直接转发给 Atom API。

```bash
curl -s -X POST http://localhost:8000/provider/openalex/query \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "works", "params": {"search": "transformer"}}'

curl -s -X POST http://localhost:8000/provider/arxiv/query \
  -H "Content-Type: application/json" \
  -d '{"params": {"search_query": "all:transformer", "max_results": 10}}'
```

## 添加新的数据源插件

1. 创建 `src/search_service/plugins/<name>.py`。
2. 实现 `SearchProvider` 子类，并通过 `Plugin` 暴露：

```python
from typing import Any

from search_service.models import SearchResultItem
from search_service.providers.base import SearchProvider
from search_service.schemas import ProviderCapabilities

class MyPlugin(SearchProvider):
    name = "myplugin"

    def _build_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(name=self.name, search_keyword=True)

    async def search(
        self,
        query: str,
        top_k: int,
        *,
        end_date: str | None = None,
        native_params: dict[str, Any] | None = None,
    ) -> list[SearchResultItem]:
        ...

Plugin = MyPlugin
```

3. 在 `config.yaml` 的 `plugins` 段增加 `plugins.<name>` 配置，并设置 `enabled: true`。
4. 重启服务。

## 测试

```bash
uv run pytest
```

测试使用 Mock HTTP 响应，默认不会调用真实 API。
