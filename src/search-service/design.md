# Search Service 设计方案

## 1. 目标与范围

在 `src/search-service/` 下实现一个**可独立部署的 HTTP 检索聚合服务**。

当前阶段只实现：
- 聚合 OpenAlex、arXiv、Serper 三个在线检索 API；
- 服务端自动并行调用、合并、去重后返回统一格式结果；
- 某个源失败/限流时，返回其他源结果，并在响应中报告错误；
- 检索 API **可插拔**：通过插件目录自动发现，添加/移除 API 只需增减插件文件；
- 支持 YAML 配置文件管理每个 API 的启用状态与参数；
- 内存缓存 + TTL；
- 提供 `/search/metadata`、`/search/fulltext` 两个 endpoint。

**当前不做**：共被引、耦合、被引量、作者 h-index、PageRank 等 rerank/元数据衍生逻辑。

## 2. 关键决策

| 问题 | 决策 |
|------|------|
| 源选择策略 | 服务端自动调用全部已启用插件，调用方也可在请求中覆盖 |
| 返回格式 | 强制统一 schema，但第一版 schema 先基于各 API 实际返回字段整理，不强求覆盖所有字段 |
| Serper 用途 | 搜索论文网页/PDF 链接 |
| 缓存 | 内存缓存 + TTL（可配置秒数） |
| 错误处理 | 部分失败：返回可用源结果，`errors` 字段说明失败的源和原因 |
| WIDI 集成 | 本次不实现，服务先以普通 HTTP API 形态存在 |
| 部署形态 | 独立 ASGI 服务，可 Docker 化、可持久部署 |
| 代码边界 | 所有实现都在 `src/search-service/` 内，**不复用** `src/retriever/` 的任何代码 |
| 可插拔机制 | 插件目录自动发现 + YAML 配置开关；启动时加载 |

## 3. 技术选型

| 层级 | 选型 | 理由 |
|------|------|------|
| Web 框架 | FastAPI | 原生 async、Pydantic 集成、自动生成 OpenAPI、社区主流 |
| ASGI 服务器 | uvicorn（开发）/ gunicorn+uvicorn workers（生产） | 标准部署组合 |
| HTTP 客户端 | httpx | 项目已有依赖，async-first |
| 应用配置 | pydantic-settings + python-dotenv | 类型安全、环境变量注入 |
| 插件/服务配置 | YAML | 用户要求，便于描述嵌套的 adapter 配置 |
| 缓存 | asyncio 安全的内存 dict + TTL | 当前阶段足够，后续可换 Redis |
| 打包/依赖 | 独立 `pyproject.toml` + uv | 可单独部署，也便于纳入根仓库 workspace |
| XML 解析 | 标准库 `xml.etree.ElementTree` | arXiv API 返回 Atom，无需新增 feedparser 依赖 |

新增依赖（在 `src/search-service/pyproject.toml` 中声明）：
- `fastapi>=0.115`
- `uvicorn[standard]>=0.30`
- `pydantic-settings>=2.0`
- `pyyaml>=6,<7`

## 4. 目录结构

```
src/search-service/
├── requirements.md          # 原始需求
├── design.md                # 本方案
├── README.md                # 部署与使用说明
├── Dockerfile               # 生产镜像
├── pyproject.toml           # 独立服务依赖
├── config.yaml              # 服务与插件配置文件（示例）
├── src/
│   └── search_service/
│       ├── __init__.py
│       ├── main.py              # FastAPI app + endpoint 定义
│       ├── config.py            # Settings（环境变量 + YAML 配置）
│       ├── models.py            # 请求/响应 Pydantic schema
│       ├── cache.py             # TTL 内存缓存
│       ├── aggregator.py        # 多源并行调用、合并、去重
│       ├── plugin_loader.py     # 插件目录扫描、加载、注册
│       ├── exceptions.py        # 自定义异常
│       └── plugins/             # 内置检索源插件
│           ├── __init__.py
│           ├── openalex.py      # OpenAlex 插件（独立实现 client）
│           ├── arxiv.py         # arXiv API 插件
│           └── serper.py        # Serper.dev 插件
└── tests/
    ├── conftest.py
    ├── test_api.py
    ├── test_aggregator.py
    ├── test_cache.py
    ├── test_plugin_loader.py
    ├── test_openalex_plugin.py
    ├── test_arxiv_plugin.py
    └── test_serper_plugin.py
```

> 说明：`src/search-service/` 作为独立 Python 项目，源码放在 `src/search-service/src/search_service/`，与仓库根 `src/retriever/` **完全解耦**。部署时只构建这个子目录，不搬运 `src/retriever/` 的任何脚本。

## 5. 统一数据模型（v0 草案）

先不强求覆盖所有字段，但所有 source adapter 都必须把结果归一化到以下 schema。缺失字段用 `null`，未知字段可暂存 `raw`。

```python
class SearchResultItem(BaseModel):
    paper_id: str                    # 跨源稳定 ID，优先 DOI > arXiv ID > 源原生 ID
    title: str
    authors: list[str] | None = None
    abstract: str | None = None
    published: str | None = None     # ISO 8601 日期或年份
    year: int | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    openalex_id: str | None = None
    urls: dict[str, str | None] = Field(default_factory=dict)
                                     # 如 {"paper": ..., "pdf": ..., "html": ...}
    source: str                      # 插件名，如 "openalex" / "arxiv" / "serper"
    source_rank: int | None = None   # 该源内部的排序位置
    raw: dict[str, Any] | None = None  # 源原始字段，便于后续统一
```

请求/响应 schema：

```python
class SearchRequest(BaseModel):
    query: str
    mode: Literal["metadata", "fulltext"] = "metadata"
    top_k: int = Field(default=20, ge=1, le=200)
    sources: list[str] | None = None  # 可选覆盖，默认使用全部已启用插件
    timeout_ms: int = Field(default=15_000, ge=500, le=60_000)

class SourceError(BaseModel):
    source: str
    error_type: str                  # "timeout" / "rate_limit" / "auth" / "http" / "parse" / "disabled"
    message: str

class SearchResponse(BaseModel):
    query: str
    mode: str
    results: list[SearchResultItem]
    total: int                       # 去重后总数
    source_counts: dict[str, int]
    errors: list[SourceError] = Field(default_factory=list)
    elapsed_ms: int
    cached: bool = False
```

## 6. 插件化检索 API 设计

### 6.1 插件接口

每个插件是一个 Python 文件，里面实现一个 `SourcePlugin` 类：

```python
class SourcePlugin(ABC):
    name: str                        # 插件唯一标识，如 "openalex"

    def __init__(self, config: dict[str, Any]) -> None:
        """由 plugin_loader 传入该插件在 YAML 中的配置字典。"""
        ...

    @abstractmethod
    async def search(self, query: str, top_k: int) -> list[SearchResultItem]:
        """执行检索并返回归一化结果。"""
        ...

    async def healthcheck(self) -> dict[str, Any]:
        """可选：返回源健康状态，用于 /health。"""
        return {"ok": True}
```

约定：
- 插件文件名即插件名（不含 `.py`）。
- 插件文件顶层必须暴露 `Plugin = OpenAlexPlugin`（类绑定），`plugin_loader` 通过该名称实例化。
- 插件自己负责 HTTP 超时、重试、限流、异常转换。
- 插件可依赖 `search_service.models.SearchResultItem` 和 `search_service.exceptions.*`。

### 6.2 插件目录与自动发现

- 内置插件放在 `src/search_service/plugins/`。
- 额外插件可放在环境变量 `SEARCH_PLUGIN_DIRS` 指定的目录（支持多个，逗号分隔）。
- `plugin_loader.py` 在启动时扫描所有插件目录：
  1. 列出目录下所有 `.py` 文件（跳过 `__init__.py` 和 `_` 开头文件）。
  2. 按文件名排序，import 模块。
  3. 检查模块是否有 `Plugin` 属性。
  4. 从 YAML 配置读取该插件是否 `enabled: true`；未配置但文件存在的插件默认不启用，需显式开启。
  5. 若启用，则用对应配置实例化 `Plugin(config)`。
- 加载失败的插件记录到启动日志，不中断服务启动。

### 6.3 YAML 配置示例

```yaml
# config.yaml
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
    api_key: ""                 # 空字符串表示从环境变量读取 OPENALEX_API_KEY
    mailto: ""
    base_url: "https://api.openalex.org"
    timeout: 30.0
    max_retries: 3
    per_page: 100
    rate_limit_rps: 10.0

  arxiv:
    enabled: true
    base_url: "http://export.arxiv.org/api/query"
    timeout: 30.0
    max_retries: 2
    rate_limit_rps: 0.33        # 1 req / 3s

  serper:
    enabled: true
    api_key: ""
    base_url: "https://google.serper.dev"
    timeout: 30.0
    max_retries: 2
    rate_limit_rps: 1.0
    query_template: "{query} filetype:pdf OR arxiv.org OR doi.org"
```

配置加载规则：
- 应用先读环境变量，再读 YAML 配置文件；环境变量优先级高于 YAML。
- `plugins.<name>.enabled` 控制是否加载该插件。
- 敏感字段（`api_key`）留空时，fallback 到约定环境变量（如 `OPENALEX_API_KEY`、`SERPER_API_KEY`）。
- 配置文件路径通过环境变量 `SEARCH_CONFIG_FILE` 指定，默认 `./config.yaml`。

### 6.4 添加/移除 API 的方式

**添加新 API**：
1. 在 `src/search_service/plugins/` 下新建 `xxx.py`。
2. 实现 `SourcePlugin` 子类并绑定 `Plugin = XxxPlugin`。
3. 在 `config.yaml` 的 `plugins` 段增加 `xxx:` 配置并 `enabled: true`。
4. 重启服务。

**移除 API**：
1. 在 `config.yaml` 中把对应插件的 `enabled` 设为 `false`，或删除配置文件中的该段。
2. 或直接删除插件文件。
3. 重启服务。

## 7. 数据源插件

### 7.1 OpenAlex

- **不复用**仓库已有的 `src.retriever.openalex.OpenAlexClient`，在 `search_service/plugins/openalex.py` 中独立实现一个精简 client。
- 仅保留搜索服务需要的功能：
  - `search(query, top_k)` 搜索 works；
  - 解析 works 字段为 `SearchResultItem`；
  - 限流、重试、超时、 polite pool 参数。
- 提取字段：`id`（OpenAlex ID）、`display_name`/`title`、`abstract_inverted_index`、`doi`、`ids.arxiv`、`authorships`、`publication_year`、`publication_date`、`primary_location`、`open_access`。
- 限流：配置 `rate_limit_rps`，默认 10。

### 7.2 arXiv

- 使用 arXiv Atom API：`http://export.arxiv.org/api/query`。
- 请求参数：`search_query=all:<query>&start=0&max_results=<top_k>&sortBy=relevance&sortOrder=descending`。
- 标准库解析 Atom XML，提取：
  - `id` → arXiv ID
  - `title`
  - `author/name`
  - `summary` → abstract
  - `published`
  - `link[@title='pdf']` → pdf_url
  - `link[@rel='alternate']` → html_url
- 限流：arXiv 官方建议 1 req/3s，adapter 内置 asyncio 速率限制（可配置）。

### 7.3 Serper

- 使用 Serper.dev `POST https://google.serper.dev/search`。
- 用途：搜索论文网页/PDF 链接。
- 查询构造：默认 `q = f"{query} filetype:pdf OR arxiv.org OR doi.org"`，可通过 YAML 配置 `query_template` 覆盖。
- 返回 JSON 中解析 `organic` 结果：
  - `title`
  - `link`
  - `snippet`
  - `sitelinks`
- `paper_id` 生成：尝试从 link 提取 DOI/arXiv ID，否则用 `serper:<link>` 占位。
- `source` 标记为 `"serper"`。
- 限流：按 Serper 订阅计划配置 QPS。

## 8. 聚合服务

```python
class SearchAggregator:
    def __init__(self, registry: PluginRegistry, cache: Cache):
        ...

    async def search(self, request: SearchRequest) -> SearchResponse:
        # 1. 检查缓存
        # 2. 按 request.sources 过滤已启用插件
        # 3. 并行调用（asyncio.gather(..., return_exceptions=True)）
        # 4. 收集成功的 items 和失败的 errors
        # 5. 合并去重（基于 DOI / arXiv ID / OpenAlex ID / 归一化 title）
        # 6. 截取 top_k
        # 7. 写缓存
        # 8. 返回 SearchResponse
```

去重策略：
1. 先按 `paper_id` 分组；
2. 同一 `paper_id` 下，合并多个源的字段（URL 取并集，优先保留更完整的元数据）；
3. 没有稳定 ID 的，用归一化 title（小写、去标点、截断前 80 字符）作为 fallback key。

合并字段优先级（第一版可简单实现）：
- 元数据优先 OpenAlex > arXiv > Serper
- PDF/HTML URL：arXiv PDF > Serper link > OpenAlex open_access

排序：
- 第一版按来源优先级 + 源内顺序简单排序；
- 后续 rerank 阶段再替换为算法排序。

## 9. API 设计

### 9.1 Endpoints

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | 健康检查，返回各源连通性 |
| POST | `/search/metadata` | 查论文元数据（默认启用 OpenAlex + arXiv） |
| POST | `/search/fulltext` | 查可获取全文的链接（默认启用 arXiv PDF + Serper 网页/PDF） |
| POST | `/search` | 通用入口，`mode` 字段区分 metadata/fulltext |

前两个是文档里提到的 endpoint，底层都调用 `/search`。

### 9.2 请求示例

```bash
curl -X POST http://localhost:8000/search/metadata \
  -H "Content-Type: application/json" \
  -d '{
    "query": "transformer architecture",
    "top_k": 20,
    "timeout_ms": 15000
  }'
```

### 9.3 响应示例

```json
{
  "query": "transformer architecture",
  "mode": "metadata",
  "results": [
    {
      "paper_id": "arxiv:1706.03762",
      "title": "Attention Is All You Need",
      "authors": ["Ashish Vaswani", "Noam Shazeer", ...],
      "abstract": "...",
      "published": "2017-06-12",
      "year": 2017,
      "doi": "10.48550/arXiv.1706.03762",
      "arxiv_id": "1706.03762",
      "openalex_id": "W2020123456",
      "urls": {
        "paper": "https://arxiv.org/abs/1706.03762",
        "pdf": "https://arxiv.org/pdf/1706.03762.pdf",
        "html": null
      },
      "source": "merged",
      "raw": null
    }
  ],
  "total": 35,
  "source_counts": {
    "openalex": 20,
    "arxiv": 15,
    "serper": 0
  },
  "errors": [
    {
      "source": "serper",
      "error_type": "rate_limit",
      "message": "Serper rate limit exceeded (429)"
    }
  ],
  "elapsed_ms": 1240,
  "cached": false
}
```

## 10. 缓存

- 实现 `TTLCache`：asyncio.Lock 保护的 dict，value 带过期时间戳。
- 缓存 key：`sha256(json.dumps({query, mode, top_k, sources}, sort_keys=True))`。
- 命中时直接返回，并设置 `cached: true`。
- TTL 默认 300 秒，通过 YAML `cache.ttl_seconds` 或环境变量配置。
- 不缓存失败结果；只缓存成功的 `SearchResponse`。

## 11. 配置与部署

### 11.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SEARCH_CONFIG_FILE` | `./config.yaml` | YAML 配置文件路径 |
| `SEARCH_PLUGIN_DIRS` | `""` | 额外插件目录，多个用逗号分隔 |
| `SEARCH_SERVICE_HOST` | `0.0.0.0` | 监听地址 |
| `SEARCH_SERVICE_PORT` | `8000` | 监听端口 |
| `SEARCH_LOG_LEVEL` | `info` | uvicorn 日志级别 |
| `OPENALEX_API_KEY` | `""` | OpenAlex API key |
| `SERPER_API_KEY` | `""` | Serper.dev API key |

> 大部分配置建议放在 YAML 中；环境变量用于覆盖和注入敏感信息。

### 11.2 本地开发启动

```bash
cd src/search-service
uv sync
uv run uvicorn search_service.main:app --reload --host 0.0.0.0 --port 8000
```

### 11.3 生产部署

```bash
# 单进程
cd src/search-service
uv run uvicorn search_service.main:app --host 0.0.0.0 --port 8000

# 多 worker
cd src/search-service
uv run gunicorn search_service.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

### 11.4 Docker

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --no-dev
COPY src ./src
COPY config.yaml ./config.yaml
CMD ["uv", "run", "uvicorn", "search_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

> 注意：多 worker 部署时内存缓存不共享，这是第一版可接受的范围；后续若需要共享缓存，可替换为 Redis。

## 12. 错误处理与额度管理

每个插件内部处理：
- **超时**：`httpx.TimeoutException` → `SourceError(error_type="timeout")`。
- **限流/额度用完**：HTTP 429 → `SourceError(error_type="rate_limit")`。
- **认证失败**：HTTP 401/403 → `SourceError(error_type="auth")`。
- **HTTP 其他错误**：4xx/5xx → `SourceError(error_type="http")`。
- **解析失败**：JSON/XML 解析异常 → `SourceError(error_type="parse")`。
- **插件未启用**：不调用，不报错。

`aggregator` 层：
- 并行调用所有已启用插件；
- 任一源失败不抛异常，只写入 `errors`；
- 如果**所有源都失败**，整体返回 `503 Service Unavailable`，body 中仍然带 `errors`。

额度用完处理：
- 插件自身按配置的 QPS 限流，避免触发 429；
- 一旦收到 429，记录错误并停止该源本次请求，不影响其他源；
- 不自动无限重试，避免浪费额度。

## 13. 测试策略

| 测试类型 | 内容 | 工具 |
|----------|------|------|
| 单元测试 | 各 source plugin 解析 mock 响应 | `pytest`, `respx` (HTTP mock), 标准库 mock XML |
| 单元测试 | `plugin_loader` 扫描、启用、禁用、失败隔离 | `pytest` |
| 单元测试 | 聚合器合并去重逻辑 | `pytest` |
| 单元测试 | TTL 缓存过期与并发安全 | `pytest`, `pytest-asyncio` |
| 集成测试 | FastAPI `TestClient` 完整请求链路 | `fastapi.testclient.TestClient`, `respx` |
| 端到端 | 可选：用真实 API key 跑一次 smoke test（手动触发，不纳入 CI） | `curl` / 脚本 |

测试原则：
- 默认测试不依赖真实外部 API；
- 失败场景（timeout、429、5xx、解析错误、插件加载失败）必须覆盖；
- 去重场景（同一论文出现在 OpenAlex 和 arXiv）必须覆盖；
- 插件加载失败应被隔离，不影响其他插件注册。

## 14. 实现里程碑

| 阶段 | 交付物 |
|------|--------|
| M1 | 项目骨架：`pyproject.toml`、目录结构、`config.py`、`models.py`、健康检查 endpoint、YAML 配置加载 |
| M2 | 插件机制：`plugin_loader.py`、`SourcePlugin` 基类、内置 OpenAlex/arXiv/Serper 插件，各自独立实现 client 并带单测 |
| M3 | 聚合器：并行调用、合并去重、错误收集，带单测 |
| M4 | TTL 内存缓存接入 `/search` 链路 |
| M5 | `/search/metadata`、`/search/fulltext` endpoint + `/search` 通用入口 |
| M6 | Dockerfile、README、部署说明、集成测试 |

## 15. 风险与后续扩展

| 风险 | 缓解 |
|------|------|
| arXiv 限流严格（1 req/3s） | 配置低 QPS，超时设置合理，失败时由 OpenAlex/Serper 兜底 |
| Serper 返回非学术结果 | 查询模板优化，后期加域名白名单过滤 |
| 多 worker 内存缓存不共享 | 第一版接受，后续换 Redis 或 SQLite 共享缓存 |
| OpenAlex 免费额度用完 | polite pool + API key + 错误兜底 |
| 统一 schema 过早 | v0 先基于实际字段整理，保持 `raw` 字段，后续迭代 schema |
| 插件加载失败导致启动中断 | `plugin_loader` 隔离失败，记录日志，其余插件正常加载 |

后续可自然扩展：
- 接入 `src/retriever` 的 BM25/embedding ranker 做 rerank（以独立依赖包形式引入，而非直接 import）；
- 增加 `/rank` endpoint；
- 从 OpenAlex 补充被引量、共被引、作者 h-index 等元数据；
- PageRank 等图算法作为独立 `/graph` 服务。
