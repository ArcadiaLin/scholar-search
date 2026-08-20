# Search Service 开发方案

> 依据：`docs/design.md`、`docs/search-service.md`
> 状态：待实施
> 范围：把 `src/search-service/` 从当前的多源并行聚合器，升级为 `design.md` 与 `search-service.md` 定义的“被 Main Agent 调用的确定性检索能力层”。

---

## 1. 目标与范围

### 1.1 总体目标

实现一个符合以下定位的 Search Service：

- 对 Main Search Agent 暴露少量稳定的领域工具；
- 内部编排多源检索、ID 归一、去重、富集、可训练 rerank、引文扩展；
- 强制 `end_date`、预算、限流、超时等治理规则；
- 生产 Public Search Trace（`SearchState` + `EvidenceState`）供 Reviewer 使用；
- 支持 `aggregated`、`passthrough`、`rank-only` 三种调用模式；
- 排序策略可被离线训练，但在线只通过 $HP_k$ 调整有界旋钮。

### 1.2 P0 范围（首个可运行版本）

按 `search-service.md` §9 的原型要求：

- **接入源**：仅 OpenAlex（主召回、计量、引文图）+ arXiv（时间窗、精确摘要、版本、category 补全）。
- **调用模式**：三种模式全部提供；`passthrough` 是验证 provider 抽象的关键，不能省。
- **rerank**：模式 A（无梯度权重搜索）+ 意图条件化 profile。
- **不做**：模式 B/C、L3 精排、全文检索链路、多 benchmark 聚合。

### 1.3 明确排除

- **Serper**：P0 不保留在主检索管线。其插件实现从默认启用中移除，但保留插拔结构，后续可重新注册为 provider 而无需改动管线代码。
- **src/retriever/**：P0 内将其能力并入 `search-service`，避免 BM25/embedding/ranker 两套逻辑并存。

---

## 2. 设计原则

1. **能力编排，不按源名硬编码**：管线阶段与 provider 的 `capabilities` 绑定；缺能力时跳过并记录，不报错。
2. **三种调用模式正交**：
   - `aggregated = plan → [passthrough × N] → align → enrich → rank-only → select`
   - `passthrough = 一次 provider 调用 + 治理层`
   - `rank-only = 特征抽取 + 打分`
3. **预算与限流是控制流**：不是事后统计；超预算时返回可解释的部分结果。
4. **`end_date` 强制**：任何模式下都不能召回评测时间边界之后的论文。
5. **缺失不填 0**：计量字段缺失时使用缺失指示位，或通过 cluster 合并从正式版记录获取。
6. **可观测性内建**：每次调用必须能产出 `SearchState` 与 `EvidenceState`。
7. **训练在离线**：在线只允许切换 profile、有界缩放、源开关等旋钮；权重训练在离线回放缓存上进行。

---

## 3. 阶段计划

| 阶段 | 周期 | 目标 | 可验证交付 |
| --- | --- | --- | --- |
| Phase 0 | 1 周 | 基线整理 | schema 模块、配置能力表、测试基线通过 |
| Phase 1 | 1–1.5 周 | 契约层升级 | 新端点全部可访问，请求/响应 schema 符合文档 |
| Phase 2 | 1–1.5 周 | Provider 能力化 | OpenAlex 主召回、arXiv 补全、能力表可查询 |
| Phase 3 | 2 周 | 检索管线 | probe/recall/align/enrich/rank/expand/select 跑通 |
| Phase 4 | 1.5–2 周 | 可训练 rerank | L0–L2 实现、意图 profile、特征矩阵缓存 |
| Phase 5 | 1.5–2 周 | 训练与评估管线 | 模式 A 权重搜索、消融、离线回放 |
| Phase 6 | 1–1.5 周 | Agent 集成 | RunSnapshot 接入、τ̄_t 生产、工具映射 |

---

## 4. Phase 0：基线整理

### 4.1 任务

1. **统一 schema 模块**
   - 新建 `src/search_service/schemas/`（或重构 `models.py`）：
     - `paper.py`：统一 `Paper` schema（identity / bibliographic / bibliometric / graph / quality / provenance 六组字段）。
     - `requests.py`：`SearchRequest`、`RankRequest`、`ExpandRequest`、`PassthroughRequest`。
     - `responses.py`：`SearchResponse`、`RankResponse`、`ProviderInfo`、`BudgetResponse`。
     - `state.py`：`SearchState`、`EvidenceState`、`Provenance`。
   - 废弃旧的 `SearchResultItem`，迁移已有调用方。

2. **升级配置**
   - 在 `config.yaml` 中为每个 provider 增加 `capabilities`、`cost_model`、`field_map`、`reliability`。
   - OpenAlex 保持启用；arXiv 保持启用但标记为补全源；Serper 默认禁用。

3. **合并 `src/retriever/` 能力**
   - 评估 `src/retriever/bm25.py`、`embedding.py`、`ranker.py`、`text.py`、`tokenizer.py`。
   - 将可复用代码迁移到 `src/search_service/features/` 或 `src/search_service/rank/`。
   - 保留原有接口兼容性，或一次性迁移全部调用方。
   - 在 `src/retriever/` 顶层添加 deprecation 说明，或删除并统一入口到 `search-service`。

4. **测试基线**
   - 保证现有 `/search`、`/health` 测试全部通过。
   - 新增 fixture：OpenAlex works 响应、group_by 响应、arXiv Atom 响应。
   - 使用 `respx` 或 `httpx` mock，避免默认测试依赖实时 API。

### 4.2 验收标准

- `pytest` 全绿。
- `ruff check` 无错误。
- `src/search_service/schemas/` 包含完整 schema 定义。
- `config.yaml` 包含 OpenAlex 与 arXiv 的能力表。
- Serper 在配置中默认禁用，但插件文件保留。

---

## 5. Phase 1：契约层升级

### 5.1 请求契约

所有 aggregated 请求必须显式携带 episode 上下文：

```json
{
  "query": "graph neural network drug discovery",
  "subqueries": ["molecular property prediction GNN"],
  "intent": "research_frontier",
  "end_date": "2026-06-30",
  "top_k": 50,
  "theta_ref": "cfg_2026w33_a1",
  "budget": {"usd": 0.05, "wall_ms": 20000, "api_calls": 40},
  "trace_id": "ep_00123_step_3"
}
```

### 5.2 响应契约

```json
{
  "papers": [{"paper_id": "...", "score": 0.83, "rank": 1, "tier": "highly_relevant", "...": "..."}],
  "search_state": {
    "issued_queries": [{"provider": "...", "mode": "aggregated", "q": "..."}],
    "candidate_counts": {"recalled": 240, "after_dedup": 187, "returned": 50},
    "skipped_stages": ["facet"],
    "budget_spent": {"usd": 0.012, "api_calls": 9},
    "failures": []
  },
  "provenance": {
    "per_paper_sources": {"...": ["..."]},
    "ranker_version": "l2-lambdamart-v3",
    "feature_version": "f7",
    "profile": "research_frontier"
  },
  "cost_usd": 0.012,
  "elapsed_ms": 3180
}
```

### 5.3 新增端点

| Endpoint | 模式 | 说明 |
| --- | --- | --- |
| `POST /search/metadata` | aggregated | 主检索，返回统一 schema，不含全文 |
| `POST /search/fulltext` | aggregated | 带全文/段落证据的检索 |
| `POST /provider/{name}/query` | passthrough | 原生检索式转发 |
| `POST /rank` | rank-only | 对给定候选集重排 |
| `POST /expand` | aggregated | 引文扩展，深度与扇出有界 |
| `GET /facet` | aggregated | 分面勘察 |
| `GET /paper/{id}` | — | 单篇详情与富集字段 |
| `GET /providers` | — | 能力表与配额余量 |
| `GET /budget` | — | 当前 episode 预算余额与各源用量 |

### 5.4 端点实现顺序

1. `GET /providers`：先实现，因为它是 `passthrough` 可用的前提。
2. `POST /provider/{name}/query`：验证 provider 抽象。
3. `POST /rank`：接入 `src/retriever/` 的 rank 能力。
4. `POST /search/metadata`：基于上述能力重新实现。
5. `GET /paper/{id}`、`POST /expand`、`GET /facet`：随后补齐。
6. `GET /budget`：与治理模块一起实现。

### 5.5 验收标准

- 所有端点可用 FastAPI 自动生成文档访问。
- 每个端点至少一个契约测试。
- `POST /provider/openalex/query` 能原样发送 OpenAlex `filter` 并返回原始 JSON。
- `POST /rank` 能接收候选集并返回带 `score`/`rank`/`tier` 的结果。

---

## 6. Phase 2：Provider 能力化改造

### 6.1 Provider Capability 抽象

每个 provider 注册时声明：

```yaml
name: <provider>
capabilities:
  search.keyword:        true
  search.native_query:   true
  search.field_filter:   true
  facet.group_by:        false
  id.lookup:             true
  id.mapping:            false
  graph.references:      true
  graph.citations:       false
  metrics.raw_citations: true
  metrics.normalized:    false
  text.abstract:         true
  text.fulltext:         false
  recommend.related:     false
cost_model:
  {endpoint}: {usd_per_call, daily_quota, rate_limit, burst_policy}
field_map:  {provider_field -> unified_field}
reliability: {p50_latency_ms, error_taxonomy, retry_policy}
```

### 6.2 OpenAlex

角色：**主召回、计量指标、引文图**。

能力声明：

| 能力 | OpenAlex |
| --- | --- |
| `search.keyword` | ✔ `title_and_abstract.search` |
| `search.native_query` | ✔ `filter` 任意字段布尔组合 |
| `search.field_filter` | ✔ |
| `facet.group_by` | ✔ |
| `id.lookup` | ✔ 免费不限次 |
| `graph.references` | ✔ `referenced_works` |
| `graph.citations` | ✔ `filter=cites:<id>` 反查 |
| `metrics.raw_citations` | ✔ |
| `metrics.normalized` | ✔ `fwci`、`citation_normalized_percentile` |
| `text.abstract` | ✔ 倒排索引需重建 |
| `text.fulltext` | 部分 |

实现要点：

- 所有请求使用 `select=` 减少响应体积。
- 实现 `works` 搜索、单 work lookup、`group_by`、引用反查。
- 将 OpenAlex 字段映射到统一 Paper schema。
- 保留原始响应的 `raw` 字段用于审计。

### 6.3 arXiv

角色：**时效与版本、精确摘要、category 补全**；不做主召回。

能力声明：

| 能力 | arXiv |
| --- | --- |
| `search.keyword` | ✔ 但为宽松 OR 匹配 |
| `search.native_query` | ✔ 字段前缀 `ti`/`abs`/`au`/`cat` + AND/OR/ANDNOT |
| `search.field_filter` | ✔ 含 `submittedDate` 范围 |
| `facet.group_by` | ✘ |
| `id.lookup` | ✔ |
| `graph.references` | ✘ |
| `graph.citations` | ✘ |
| `metrics.raw_citations` | ✘ |
| `metrics.normalized` | ✘ |
| `text.abstract` | ✔ `summary`，作者原文 |
| `text.fulltext` | ✔ PDF |

实现要点：

- 默认只用于精确 ID/标题命中和时间窗补充。
- 解析 Atom 响应，提取 `summary`、`published`、`updated`、`arxiv:comment`、`category`。
- 遵守 polite usage：间隔 ≥3s，单次 ≤2000 条，https 强制。

### 6.4 Serper 的处理

- 默认配置中 `enabled: false`。
- 插件文件 `plugins/serper.py` 保留，但能力表不进入默认管线。
- 后续如需重新启用，只需修改 `config.yaml` 的 `enabled` 字段，无需改动 `aggregator` 或 `rank`。

### 6.5 验收标准

- `GET /providers` 返回 OpenAlex 与 arXiv 的真实能力表。
- OpenAlex 能完成主召回并返回统一 Paper schema。
- arXiv 只在请求明确指定或用于补全时调用。
- Serper 默认不启用，但注册表中可见。

---

## 7. Phase 3：检索管线实现

### 7.1 管线阶段

```text
(0) probe    → 分面勘察：年份/主题/机构分布
(1) recall   → 主召回 + 正交补充召回
(2) align    → 主键聚类与合并
(3) enrich   → 按需回填计量指标、主题、摘要、图边
(4) rank     → L0 过滤 → L1 名次融合 → L2 打分 → L3 精排
(5) expand   → 围绕高分候选做 references/citations 扩展，回流 (2)
(6) select   → 预算内截断，产出 papers + SearchState + EvidenceState
```

### 7.2 各阶段实现要点

#### probe

- 调用 OpenAlex `group_by=publication_year,primary_topic.field,authorships.institutions`。
- 成本低（$0.0001/次），用于判断查询是否过宽。
- 结果写入 `SearchState.probe_summary`。

#### recall

- OpenAlex 主召回：`title_and_abstract.search`。
- 支持 `subqueries`：每个子查询独立召回，结果进入 L1 RRF。
- arXiv 仅用于：
  - 精确 ID/标题命中；
  - `end_date` 时间窗补充。
- 不做多源并集，而是主召回 + 补全。

#### align

主键优先级：

1. 正式 DOI（OpenAlex 覆盖约 98%）。
2. arXiv ID ↔ `10.48550/arXiv.<id>`（允许失败）。
3. 归一化标题 + 年份 + 首作者兜底。

preprint 与正式版归入同一 cluster，计量字段优先取 article 侧。

#### enrich

- 优先走免费或低成本端点。
- OpenAlex 单实体 lookup：回填 `fwci`、`citation_normalized_percentile`、`counts_by_year`、`topics`。
- arXiv 补 `category`、版本、`comment`、精确摘要。
- 按需获取 `referenced_works` 和 citations 反查（受预算门控）。

#### rank

见 Phase 4。

#### expand

- 围绕 L2 top-N 候选做 depth=1 扩展。
- OpenAlex 出边 `referenced_works` + 入边 `filter=cites:<id>`。
- 扇出上限 20，总候选数有界。
- 扩展结果回流 align，重新合并去重。

#### select

- 按最终预算截断。
- 返回 `papers`、`search_state`、`evidence_state`。
- 超预算时返回已完成的阶段结果，并在 `failures` 中标注被跳过的阶段。

### 7.3 横切治理

- 每个阶段检查 `budget.usd`、`budget.wall_ms`、`budget.api_calls`。
- 每次 provider 调用前检查 `end_date`。
- 失败分类：timeout、rate_limit、auth、http、parse、disabled、unknown。

### 7.4 验收标准

- 一个完整查询能从 probe 走到 select 并返回结构化结果。
- 任意阶段因预算耗尽跳过时，返回部分结果且 `failures` 非空。
- 合并准确率通过人工抽样核对。

---

## 8. Phase 4：可训练 rerank

### 8.1 分级流水线

| 级 | 名称 | 输入规模 | 成本 |
| --- | --- | --- | --- |
| L0 | 确定性过滤 | 全部召回 | 0 |
| L1 | RRF 名次融合 | ~300 | 0 |
| L2 | 门控 + 意图加权打分 | ~150 | 本地 CPU |
| L3 | 精排 | ~30 | 受预算门控 |

### 8.2 L0 过滤

- `end_date` 过滤。
- `is_retracted` 过滤。
- 类型与语言过滤（若数据可用）。

### 8.3 L1 RRF

$$
\mathrm{RRF}(p) = \sum_{s \in \mathcal{S}} \frac{\omega_s}{\kappa + \mathrm{rank}_s(p)}
$$

- 跨 provider、跨子查询使用名次而非分数。
- 初设 $\kappa=60$，$\omega_s$ 可配置。

### 8.4 L2 门控加权

$$
\mathrm{Score}_\theta(p \mid q, z) = G_{\mathrm{rel}}(q, p) \cdot \sum_j w_{z,j}\, f_j(q, p)
$$

其中相关性门控：

$$
G_{\mathrm{rel}}(q,p) = \sigma\!\big(\gamma_{\mathrm{rel}} \cdot (\max(f_{1..4}) - \tau_{\mathrm{rel}})\big)
$$

$f_{1..4}$ 为 lexical/semantic 特征。

### 8.5 特征清单（P0）

| # | 特征 | 族 |
| --- | --- | --- |
| 1 | `bm25_title` | lexical |
| 2 | `bm25_abstract` | lexical |
| 3 | `semantic_title` | semantic |
| 4 | `semantic_abstract` | semantic |
| 5 | `citation_percentile` | bibliometric |
| 6 | `fwci` | bibliometric |
| 7 | `citation_velocity` | bibliometric |
| 8 | `author_h_max` | bibliometric |
| 9 | `coupling_to_seeds` | graph |
| 10 | `co_citation_breadth` | graph |
| 11 | `pagerank_personalized` | graph |
| 12 | `recency` | constraint |

每个可缺失特征配一个缺失指示位，共 18 维。

### 8.6 意图 profile

四个意图：`overview`、`seminal`、`frontier`、`similar`。

初值示例：

```yaml
ranking_profiles:
  seminal:
    citation_percentile: 0.35
    co_citation:         0.25
    semantic:            0.25
    recency:             0.00
    author_h:            0.05
  frontier:
    citation_percentile: 0.05
    co_citation:         0.05
    coupling:            0.20
    semantic:            0.40
    recency:             0.30
    author_h:            0.00
```

### 8.7 L3 精排（占位）

- 第一版先提供接口和预算门控，不默认启用。
- 后续可接入 cross-encoder 或 LLM judge。

### 8.8 预印本计量缺失处理

按优先级：

1. 走 cluster 合并，用正式版记录的计量字段。
2. 合并失败则 bibliometric 族全部置缺失（不是置 0），由缺失指示位承载。
3. 排序不因此惩罚它：lexical、semantic、constraint 三族仍然完整可用。

### 8.9 验收标准

- `POST /rank` 返回带 `score`/`rank`/`tier` 的结果。
- 同一查询在不同意图下排序不同。
- 图特征若消融无增益，可退回 L1+L2。

---

## 9. Phase 5：训练与评估管线

### 9.1 训练模式 A：无梯度权重搜索

- 优化器：Optuna TPE 或 CMA-ES，200–400 trials。
- 目标函数：

$$
J(\theta) = 0.6 \cdot \mathrm{F1@}K + 0.2 \cdot \mathrm{Recall@}K + 0.2 \cdot \mathrm{NDCG@}K - 0.02 \cdot \mathrm{Cost}
$$

- 搜索空间：
  - $w_{z,j} \in [0,1]$，单纯形约束；
  - $\gamma_{\mathrm{rel}} \in [1,20]$；
  - $\tau_{\mathrm{rel}} \in [0.2,0.8]$；
  - $K \in \{10,20,30,50\}$；
  - 四个 N/K 分别搜索。

### 9.2 特征矩阵缓存

- 键：`(query, end_date, source_version, feature_version)`。
- 训练与消融在缓存上回放，不重打 API。
- 这是离线训练可复现的物理载体。

### 9.3 数据拆分

- 训练集：优化权重。
- 验证集：早停与超参选择。
- held-out：冻结 $PH_{k+1} = PH_k$，防止测试集泄漏。

### 9.4 消融矩阵

| 实验 | 排序器 |
| --- | --- |
| B0 | 词法/语义检索，无计量信号 |
| B1 | B0 + 固定 citation count |
| B2 | B0 + 固定完整计量公式 |
| B3 | B0 + 全局可训练权重 |
| B4 | B0 + intent-conditioned 可训练权重 |
| B5 | B4 + Reviewer proposal / validation |

关键消融：

- B4 - BC
- B4 - CC
- B4 - Citation
- B4 - Recency
- B4 - Author H

### 9.5 验收标准

- 关闭网络后，仅凭缓存能重跑训练与消融。
- B4 在一个 benchmark 上优于 B2 与 B0。
- 按意图分层报告 F1、Recall、NDCG、Cost、Latency。

---

## 10. Phase 6：Agent 集成

### 10.1 RunSnapshot 接入

Service 接收不可变的运行快照：

```text
RunSnapshot = {
  rq: RQ,
  si: SI_k,
  theta: θ^S_k,
  ph_version: k,
  constraints: { end_date, budget, max_iterations, max_reviewer_calls, ... }
}
```

### 10.2 工具映射

将 Main Agent 的工具调用 $u_t$ 映射到 Search Service 端点：

- `search` → `POST /search/metadata`
- `search_fulltext` → `POST /search/fulltext`
- `passthrough_query` → `POST /provider/{name}/query`
- `rank_candidates` → `POST /rank`
- `expand_citations` → `POST /expand`

### 10.3 Public Search Trace 生产

每次 Service 调用返回的响应必须包含：

```text
SearchState = {
  issued_queries, selected_sources, filters,
  candidate_counts, dedup_stats, ranking_summary,
  expansion_frontier, budget_spent, failures
}

EvidenceState = {
  papers, abstracts_or_snippets, citation_edges,
  bibliometric_fields, source_ids, evidence_ids, coverage_signals
}
```

Reviewer 只读取这些公开状态，不读取 Main Agent 的私有上下文。

### 10.4 验收标准

- Search Service 能被外部 Agent 通过 HTTP/RPC 调用。
- 每次调用返回的 `search_state` 和 `evidence_state` 可被序列化并用于 Reviewer。
- 预算超支时返回部分结果并正确记账。

---

## 11. 关键决策与风险

### 11.1 Serper 是否保留

**决策**：P0 不保留 Serper 在主检索管线中。

- 从默认配置中禁用。
- 保留插件文件与插拔结构，后续修改 `config.yaml` 的 `enabled` 即可重新启用，无需改动管线代码。

### 11.2 是否与 `src/retriever/` 合并

**决策**：P0 内将 `src/retriever/` 的能力并入 `search-service`。

- 迁移 BM25、embedding、tokenizer、text 等实现到 `src/search_service/features/` 或 `src/search_service/rank/`。
- 统一使用 `search-service` 的 Paper schema。
- 避免两套 rank 逻辑并存。
- 迁移完成后，`src/retriever/` 可标记为 deprecated 或删除，调用方统一改走 `search-service`。

### 11.3 预印本计量缺失

**决策**：严格按文档要求处理，缺失不填 0。

- 优先通过 cluster 合并获取正式版记录的计量字段。
- 合并失败则 bibliometric 族全部置缺失，由缺失指示位承载。
- 排序不因此惩罚预印本；lexical、semantic、constraint 三族仍然完整可用。

### 11.4 其他风险

| 风险 | 缓解措施 |
| --- | --- |
| 图特征不划算 | 若消融无独立增益，果断退回 L1+L2 |
| 计量特征喧宾夺主 | 相关性门控 + 意图分层评估 |
| 意图分类错误 | 单独测量意图分类错误率与代价 |
| 单一元数据源 | 通过内部一致性检查与缺失指示位处理；后续接入第三个源时升级 `feature_version` |
| 缓存与真实调用发散 | 定期用真实调用重建回放集，比较候选分布 |

---

## 12. 模块结构目标

```text
src/search_service/
  api/              # 路由：aggregated / passthrough / rank-only / facet / paper / providers / budget
  schemas/          # 请求、响应、Paper、SearchState、EvidenceState、Provenance
  providers/        # OpenAlex / arXiv 适配器 + 能力表 + 成本模型 + 字段映射
  merge/            # 主键聚类、字段路由、质量标记
  enrich/           # 富集调度与预算门控
  features/         # 六族特征抽取（复用原 src/retriever/ 能力）
  graph/            # 局部引文图、personalized PageRank、BC/CC
  rank/             # L0–L3 编排、门控与意图 profile
  training/         # 回放数据集、模式 A 搜索、消融脚本
  governance/       # 预算、限流退避、轨迹落盘、时间边界强制
  pipeline.py       # 7 阶段检索管线编排
  main.py           # FastAPI 应用入口
  config.py         # 配置加载
  cache.py          # 缓存（扩展为四层缓存）
```

---

## 13. 附录：验收判据汇总

| 项 | 判据 |
| --- | --- |
| 接口 | 三种模式端到端跑通；`GET /providers` 返回真实配额余量 |
| passthrough | Agent 提交的原生检索式原样送达，且时间边界、预算、轨迹记录全部生效 |
| 合并 | 人工抽样核对 cluster 正确率；标题兜底触发率有统计 |
| rerank | 在一个 benchmark 上，B4 优于 B2 与 B0 |
| 可复现 | 关掉网络，仅凭回放缓存能重跑全部训练与消融 |
| 治理 | 任意阶段超预算时返回可解释的部分结果 |
| 可观测性 | 每次调用都能生产 `SearchState` + `EvidenceState` |

---

## 14. 下一步行动

待本方案确认后，按 Phase 0 开始实施：

1. 新建 `src/search_service/schemas/` 并定义完整 schema。
2. 升级 `config.yaml` 增加 provider 能力表。
3. 将 `src/retriever/` 的可复用能力评估并标记迁移范围。
4. 补齐 schema 与端点契约测试。
