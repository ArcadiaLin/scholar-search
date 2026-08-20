# Search Service /search 多源聚合实现方案

> 依据：`docs/design.md`、`docs/search-service.md`、当前 `src/search-service/` 实现
> 状态：已确认，待实施
> 范围：把 `POST /search` 从单一 OpenAlex 召回升级为多源并行聚合，支持按 provider 分发原生参数、跨源 ID 归一与去重、RRF 排序。

---

## 1. 目标

- `/provider/{name}/query` 保持为各 provider 的原生参数转发入口。
- `/search` 作为**统一聚合入口**：
  - 并发调用所有启用且支持 `search_keyword` 的 provider；
  - 支持在请求中按 provider 传入原生参数，由服务自动分发；
  - 对召回结果做跨源 ID 归一与精确去重；
  - 使用 RRF（Reciprocal Rank Fusion）对多源结果重排；
  - 部分 provider 失败时仍返回可用结果，并把失败记录到 `SearchState.failures`。

---

## 2. 关键设计决策（已与用户确认）

| # | 决策 | 选择 |
| --- | --- | --- |
| 1 | `/search` 是否支持按 provider 传原生参数 | **是**。请求体中 `provider_params` 字段按 provider 名分发原生参数。 |
| 2 | 去重策略 | **精确 ID 去重**。按 `DOI > arxiv_id > openalex_id > source_native_id` 优先级生成稳定 `paper_id`。 |
| 3 | 多源排序 | **RRF**。`score = Σ 1 / (k + source_rank_i)`，默认 `k = 60`。 |
| 4 | 部分 provider 失败 | **记录 failures，返回 200（至少一源成功）**。全部失败时返回 502。 |

---

## 3. 请求/响应契约

### 3.1 `POST /search` 请求体

```json
{
  "query": "transformer architecture",
  "top_k": 20,
  "end_date": "2024-12-31",
  "sources": ["openalex", "arxiv"],
  "timeout_ms": 15000,
  "provider_params": {
    "openalex": {
      "filter": "publication_year:2020-2024",
      "sort": "cited_by_count:desc"
    },
    "arxiv": {
      "search_query": "ti:transformer AND cat:cs.LG",
      "sortBy": "submittedDate",
      "sortOrder": "descending"
    }
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 统一检索词，分发到各 provider。 |
| `top_k` | int | 否，默认 20 | 返回结果上限。 |
| `end_date` | string | 否 | 出版日期上边界（ISO 8601）。 |
| `sources` | list[string] | 否 | 指定调用的 provider；默认取所有启用且支持 `search_keyword` 的 provider。 |
| `timeout_ms` | int | 否，默认 15000 | 整体超时。 |
| `provider_params` | dict[string, dict] | 否 | 按 provider 名传入原生参数，与统一参数合并后调用。 |

### 3.2 参数合并规则

对每个 provider：

1. 基础参数由 `query` 映射而来：
   - OpenLex：`search = query`（可被 `provider_params.openalex.search` 覆盖）。
   - arXiv：`search_query = all:query`（仅当 `provider_params.arxiv.search_query` 为空时注入）。
2. 合并 `provider_params[<provider>]`，provider 原生参数优先级更高。
3. 注入治理参数：
   - `end_date` 映射为 OpenAlex 的 `filter=to_publication_date:{end_date}`；arXiv 不处理（arXiv 原生无简单日期过滤，靠结果过滤）。
4. `top_k` 作为内部每个 provider 的召回上限，不直接作为原生参数透传。

### 3.3 响应体

保持 `SearchResponse` 结构：

```json
{
  "papers": [ /* list of RankedPaper */ ],
  "search_state": {
    "issued_queries": [
      {"provider": "openalex", "mode": "aggregated", "query": "transformer architecture", "raw": {...}},
      {"provider": "arxiv", "mode": "aggregated", "query": "transformer architecture", "raw": {...}}
    ],
    "selected_sources": ["openalex", "arxiv"],
    "filters": {"end_date": "2024-12-31"},
    "candidate_counts": {"recalled": 40, "returned": 20},
    "failures": []
  },
  "provenance": {
    "per_paper_sources": {
      "W123456789": ["openalex"],
      "10.1234/example": ["openalex", "arxiv"]
    }
  },
  "cost_usd": 0.0,
  "elapsed_ms": 1234
}
```

---

## 4. 模块改动计划

### 4.1 新增/修改文件

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/search_service/schemas/requests.py` | 修改 | 重写 `SearchRequest`，支持 `provider_params`。 |
| `src/search_service/schemas/state.py` | 修改 | 扩展 `CandidateCounts` 增加 `recalled` / `returned` / `after_dedup`（可选）。 |
| `src/search_service/schemas/paper.py` | 修改 | 新增 `SearchResultItem` → `Paper` 转换函数。 |
| `src/search_service/aggregator.py` | 新增 | 多源并发召回、归一、去重、RRF 排序核心。 |
| `src/search_service/api/search.py` | 重写 | `/search` 调用 aggregator，返回 `SearchResponse`。 |
| `src/search_service/api/providers.py` | 修改 | 统一 OpenAlex 与 arXiv 的 passthrough 路径（可选，但建议）。 |
| `tests/` | 新增 | 多源聚合、去重、RRF、失败场景测试。 |

### 4.2 `SearchResultItem → Paper` 归一化

`SearchResultItem`（插件内部简单模型）与 `Paper`（API 输出模型）字段不完全一致，需要转换：

- `authors: list[str]` → `authors: list[Author]`
- `venue` 直接透传
- `urls` 透传
- `source` 放入 `sources: [source]`
- `raw` 透传
- `paper_id` 已经是稳定 ID

### 4.3 跨源去重逻辑

```python
def stable_id(item: SearchResultItem) -> str:
    return item.doi or item.arxiv_id or item.openalex_id or item.paper_id
```

同一 `stable_id` 只保留一条 `Paper`，字段按以下优先级合并：

- 非空优先；
- 若多源都非空，OpenAlex 优先于 arXiv（按 `source_preference` 配置，默认 `["openalex", "arxiv"]`）。

`sources` 字段累积所有来源；`per_paper_sources` 记录来源列表。

### 4.4 RRF 排序

```python
def rrf_score(ranks: list[int], k: int = 60) -> float:
    return sum(1.0 / (k + r) for r in ranks)
```

对每个去重后的 paper，收集它来自各 source 的 `source_rank`，计算 RRF score，按 score 降序排列，取前 `top_k`。

---

## 5. 实现步骤

1. **Schema 层**
   - 重写 `SearchRequest`。
   - 新增 `SearchResultItem → Paper` 转换函数。
   - 扩展 `CandidateCounts`。

2. **Aggregator 层**
   - 新建 `Aggregator` 类。
   - 实现 `aggregate(query, top_k, end_date, sources, timeout_ms, provider_params)`。
   - 内部并发调用各 provider 的 `search()`。
   - 实现归一、去重、RRF。

3. **API 层**
   - 重写 `api/search.py`，调用 `Aggregator`。
   - 移除 OpenAlex 特有参数映射逻辑。

4. **Provider 适配**
   - 确认 OpenLex 与 arXiv 的 `search()` 都能接收 `query`/`top_k` 并返回 `SearchResultItem`。
   - 如有需要，调整 `search()` 以支持 `provider_params` 覆盖。

5. **测试**
   - Mock 多源并发返回。
   - 验证去重合并。
   - 验证 RRF 排序。
   - 验证部分失败返回 200 并记录 failures。
   - 验证 `ruff check` / `pytest` 全绿。

---

## 6. 风险与注意事项

1. **参数冲突**：统一 `query` 与 `provider_params.search` 同时存在时，以 `provider_params` 为准，但需要记录实际发出的 query。  
2. **arXiv 无原生日期过滤**：`end_date` 对 arXiv 只能做结果后过滤；OpenAlex 可通过 `filter` 注入。  
3. **结果上限语义**：`top_k` 是最终返回数，每个 provider 内部召回数可设为 `top_k * 2` 或 `top_k` 加配置，保证 RRF 有足够候选。  
4. **超时控制**：整体 `timeout_ms` 用 `asyncio.wait_for` 包装聚合调用。  
5. **向后兼容**：当前 `/search` 请求体是 OpenAlex 参数形态；改动后会打破旧请求，需要同步更新测试和调用方。

---

## 7. 验收标准

- `POST /search` 并发调用 OpenAlex + arXiv，返回统一 `RankedPaper` 列表。
- 同一 DOI/arXiv ID 被多源召回时只出现一次，且 `sources` 包含多个来源。
- RRF 排序后 `rank` 字段从 1 开始连续递增。
- 部分 provider 失败时返回 200，`SearchState.failures` 非空；全部失败时返回 502。
- `ruff check src tests` 与 `pytest tests/ -q` 全绿。
