# Search Service 设计

> 子系统设计文档
> 项目：Agentic Search
> 状态：设计稿。第一部分与具体 API 无关，第二部分给出首个原型

## 0. 文档定位

三层文档分工见 `agentic_search_preference_reviewer_research_design.md` 的"文档地图"。
上游契约来自 `design.md` §4；信息计量学信号的定位来自研究文档 §6.4：
h-index、共被引、文献耦合这些量**是排序特征，不是偏好本身**。

Search Service 的价值由两件事构成：

1. **可扩展的检索 API 接入**——既提供跨源聚合的统一检索，也提供任一 provider 的原样转发；
2. **可扩展、可训练的 rerank**——把信息计量学信号变成意图条件化的、能被 benchmark 优化的排序策略。

文档相应分两部分：

- **第一部分（§1–§8）服务设计**：接口、provider 抽象、管线、trainable rerank。
  这部分不绑定任何具体检索 API，换掉全部数据源它依然成立。
- **第二部分（§9–§11）原型**：首个可运行版本，只聚合两个源，给出具体的字段路由、
  权重初值与验收判据。

证据标记：**[实测]** 对真实 API 的探测结果；**[设计]** 本文的设计决策；
**[待验证]** 需要实验或标注集才能定论。

---

# 第一部分　服务设计

## 1. 职责边界

在系统契约中，Search Service 是被 Main Agent 当作工具调用的确定性能力层：

$$
o_t = \mathrm{SearchService}(u_t;\ \theta^S_k),
\qquad
\theta^S_k = \mathrm{Configure}(P,\ HP_k)
$$

**它负责**：provider 接入与转发、多源召回、跨源 ID 归一与去重、元数据与全文富集、
特征抽取、候选排序、引文扩展、预算与限流、可观察状态（$\bar{\tau}_t$ 中
`SearchState` / `EvidenceState` 部分）的生产。

**它不负责**：任何需要自然语言推理的决策。查询理解、子查询分解、停止判断、
结果解释属于 Main Agent；覆盖缺口判断与建议属于 Reviewer；偏好的存储与版本管理属于
Preference Persistence。

这条边界有一个实际后果：**Service 内部的排序策略可以被训练，但训练发生在离线，
不在 episode 内**。在线只允许通过 $HP_k$ 调整有界的旋钮（§7.9）。

## 2. 三种调用模式

只提供"打包好的聚合检索"是不够的。Main Agent 需要能自己写检索式——
这既是表达力问题，也是研究问题：如果 Service 把查询构造全部包办，
就无法观察 Agent 是否具备构造精确检索式的能力，而这正是研究文档中
tool-reducible 讨论所关心的对象。

| 模式 | 输入 | Service 做什么 | Service 不做什么 |
| --- | --- | --- | --- |
| **aggregated** | 结构化检索意图 | 多 provider 召回、归一、富集、rerank、统一 schema | — |
| **passthrough** | 某 provider 的**原生检索式** | 鉴权、限流退避、预算记账、`end_date` 兜底、轨迹落盘 | 不改写查询、不归一、不 rerank |
| **rank-only** | 已有候选集 | 特征抽取与打分 | 不产生新召回 |

### 2.1 Passthrough：原样转发

各 provider 的原生查询语言表达力远超任何通用参数集——布尔组合、字段限定、
嵌套过滤、分面、排序键、翻页游标。把它们压扁成 `query + top_k + date_range`
一定会丢东西。因此 Service 必须允许 Agent 直接写 provider 方言：

```json
POST /provider/{name}/query
{
  "raw": {"filter": "concepts.id:C41008148,publication_year:>2020",
          "search": "molecular property prediction", "per_page": 50},
  "normalize": false,
  "end_date": "2026-06-30",
  "trace_id": "ep_00123_step_5"
}
```

passthrough 是能力出口，**不是治理的后门**。以下四条即使在 passthrough 下也强制执行：**[设计]**

1. **时间边界**：provider 支持日期过滤就注入，不支持就在响应侧过滤。
   评测边界不是排序偏好，任何模式下都不能越界。
2. **预算与限流**：计入同一本 账，共享退避策略。
3. **可观察性**：原生检索式与命中数写入 `SearchState.issued_queries`。
   Reviewer 必须能看到 Agent 到底问了什么，否则轨迹审查失去依据。
4. **证据边界**：`normalize: false` 的结果是**原始 JSON**，默认不进入 `EvidenceState`；
   要作为候选参与后续排序，需显式 `normalize: true` 走字段映射。

`normalize: true` 只做 schema 映射与 ID 归一，仍然不做 rerank——
"我要原样的结果"和"我要它们被打分"是两个不同的请求。

### 2.2 三种模式的关系

```text
aggregated  = plan → [passthrough × N] → align → enrich → rank-only → select
passthrough = 一次 provider 调用 + 治理层
rank-only   = 特征抽取 + 打分
```

聚合检索不是第四种独立实现，而是前两者的编排。这个分解让三件事变简单：
新 provider 接入当天就能通过 passthrough 被使用；离线训练直接复用 rank-only；
消融实验可以只替换其中一段。

## 3. Provider 抽象

### 3.1 能力声明

管线**按能力编排，不按源名编排**。每个 provider 注册时声明一张能力表：

```yaml
name: <provider>
capabilities:
  search.keyword:        true     # 关键词/自然语言检索
  search.native_query:   true     # 原生检索式（passthrough 前提）
  search.field_filter:   true     # 结构化字段过滤
  facet.group_by:        false    # 分面聚合
  id.lookup:             true     # 按 ID 取单条
  id.mapping:            false    # 外部 ID 映射
  graph.references:      true     # 出边
  graph.citations:       false    # 入边
  metrics.raw_citations: true
  metrics.normalized:    false    # 领域归一化指标
  text.abstract:         true
  text.fulltext:         false
  recommend.related:     false
cost_model:
  {endpoint}: {usd_per_call, daily_quota, rate_limit, burst_policy}
field_map:  {provider_field -> unified_field}
reliability: {p50_latency_ms, error_taxonomy, retry_policy}
```

管线阶段与能力的绑定关系是固定的：探查需要 `facet.group_by`，
主召回需要 `search.keyword`，富集需要 `id.lookup`，图特征需要
`graph.references` 或 `graph.citations`。没有 provider 提供某项能力时，
对应阶段**跳过并在 `SearchState` 标注**，而不是报错或静默降级。

### 3.2 接入一个新 provider 需要什么

四件事，缺一不可：适配器（原生请求/响应 ↔ 统一契约）、能力表、成本模型、
字段映射。**不需要**改动管线代码——这是"可扩展接入"的判据：
如果接一个源要改 `rank/` 或 `merge/` 的逻辑，说明抽象漏了。**[设计]**

### 3.3 字段级溯源

同一个字段可能有多个 provider 能给，取值规则由**字段路由表**决定（§5.2），
每个字段保留 `field_provenance`，记录取自哪个 provider 的哪个原始字段。
这既服务于审计，也服务于训练：特征的可用性统计直接来自这张溯源表。

## 4. 对外接口

### 4.1 Endpoint

| Endpoint | 模式 | 用途 |
| --- | --- | --- |
| `POST /search/metadata` | aggregated | 主检索，返回统一 schema 的排序候选，不含全文 |
| `POST /search/fulltext` | aggregated | 带全文/段落证据的检索，按需触发全文获取 |
| `POST /provider/{name}/query` | passthrough | 原生检索式转发（§2.1） |
| `POST /rank` | rank-only | 对给定候选集重排 |
| `POST /expand` | aggregated | 引文扩展，深度与扇出有界 |
| `GET /facet` | aggregated | 分面勘察，需 `facet.group_by` 能力 |
| `GET /paper/{id}` | — | 单篇详情与富集字段 |
| `GET /providers` | — | 能力表与配额余量，供 Agent 选择模式 |
| `GET /budget` | — | 当前 episode 的预算余额与各源用量 |

`GET /providers` 是 passthrough 可用的前提：Agent 得先知道有哪些源、
各自支持什么语法、还剩多少配额，才谈得上自己写检索式。

### 4.2 请求与响应契约

请求必须显式携带 episode 上下文，Service 不从全局状态推断：

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

`intent` 是可选的意图标签；给出时 rerank 使用对应的权重 profile，
不给则回退到默认 profile（§7.2）。

响应返回统一 schema 加运行元数据：

```json
{
  "papers": [{"paper_id": "...", "score": 0.83, "rank": 1, "tier": "highly_relevant", "...": "..."}],
  "search_state": {"issued_queries": [{"provider": "...", "mode": "aggregated", "q": "..."}],
                   "candidate_counts": {"recalled": 240, "after_dedup": 187, "returned": 50},
                   "skipped_stages": ["facet"], "budget_spent": {"usd": 0.012, "api_calls": 9},
                   "failures": []},
  "provenance": {"per_paper_sources": {"...": ["..."]},
                 "ranker_version": "l2-lambdamart-v3", "feature_version": "f7",
                 "profile": "research_frontier"},
  "cost_usd": 0.012, "elapsed_ms": 3180
}
```

对 Agent 而言 aggregated 模式的工具语义是"检索"，不是"调用哪个 API"；
但 `provenance` 保留完整的来源与版本信息。这两点不矛盾：
**决策层不必见来源，审计层必须见来源。**

## 5. 数据模型

### 5.1 统一 Paper schema

| 组 | 字段 | 说明 |
| --- | --- | --- |
| identity | `paper_id`、`doi`、`arxiv_id`、`cluster_id`、`external_ids{}` | 合并层产出 |
| bibliographic | `title`、`abstract`、`authors[]`、`venue`、`year`、`published`、`updated`、`version`、`type` | 多源回退 |
| bibliometric | `citation_count`、`normalized_impact`、`citation_percentile`、`counts_by_year[]`、`author_h_index[]` | 计量特征的原料 |
| graph | `references[]`、`citations[]` | 局部引文图的边 |
| quality | `is_retracted`、`record_thinness`、`citation_confidence` | 合并层计算 |
| provenance | `field_provenance{}`、`sources[]` | 字段级溯源 |

### 5.2 合并与字段路由

**合并主键**按确定性从高到低排列，逐级回退：全局唯一标识符 → provider 间的
确定性 join key → 外部 ID 映射 → 归一化标题 + 年份 + 首作者。
每一级都要允许失败并回退，任何一级都不能假定 100% 命中。

**字段路由表**是一张"字段 × provider"的优先级表，取值规则由三件事决定：
覆盖率、可信度、以及**记录类型**。同一字段在不同记录类型下可能来自不同 provider——
这不是偏好问题，是事实问题，具体取值见原型部分 §9.3。

**缺失与冲突**都要显式表达：缺失不填 0 而是置 null 并配缺失指示位（§7.3）；
多源冲突超过阈值时置 `citation_confidence=low`，冲突本身作为一维特征进入模型，
因为分歧往往意味着版本合并有误或存在重复条目。**[设计]**

## 6. 检索管线

aggregated 模式的编排，每一阶段都可因能力缺失或预算耗尽而跳过：

```text
(0) probe    分面勘察：年份/主题/机构分布，判断查询是否过宽、领域边界在哪
(1) recall   主召回 + 正交补充召回；不同源的相关性分数不可比，只保留名次
(2) align    主键聚类与合并；同一作品的多形态记录（预印本/正式版）归入同一 cluster
(3) enrich   按需回填计量指标、主题、摘要、图边；优先走免费或低成本端点
(4) rank     L0 过滤 → L1 名次融合 → L2 特征打分 → L3 精排（§7.4）
(5) expand   围绕高分候选做出边/入边扩展，深度、扇出、总候选数有界，回流 (2)
(6) select   预算内截断，产出 papers + SearchState + EvidenceState
```

三条贯穿性规则：

- **探查先行**。分面勘察的成本通常远低于一次全文检索，却能在召回前暴露语义漂移。
  把它作为默认动作，比事后靠 Reviewer 发现噪声便宜得多。**[设计]**
- **不做多路取并集**。不同源的召回集正交度高、排序偏倚方向不同，
  直接并集会把噪声一起放大；正确做法是一路主召回 + 多路补全，融合发生在名次层。
- **失败分类而非静默**。超时 / 限流 / 解析失败 / 空结果分别记账，
  写入 `SearchState.failures`；超预算时停止当前策略并返回可解释的部分结果。

## 7. Trainable Rerank

### 7.1 定位：BIR 与三种用法

把信息计量学信号加入学术检索排序是一个有明确名字的研究方向——
**Bibliometric-enhanced Information Retrieval (BIR)**，即用统计科学模型与网络分析
增强学术检索（[Mayr & Mutschke](https://arxiv.org/abs/1309.7949)）。它有三种彼此不能混谈的用法：

| 用法 | 示例 | 训练什么 |
| --- | --- | --- |
| 固定计量排序 | citation count、h-index、PageRank 加权求和 | 通常不训练；权重人工设定时应称 heuristic bibliometric ranking |
| **作为 Learning-to-Rank 特征** | 语义相关性 + 引用 + 时间 + 作者特征 | **排序权重/排序模型** |
| 作为表示学习监督信号 | 用 citation graph 训练论文 embedding | 模型参数（编码器） |

第一类的代表是 [CiteRank](https://arxiv.org/abs/physics/0612122)：在 PageRank 上加论文年龄衰减，
平衡经典与新近。第二类的早期先例是
[Who Should I Cite?](https://dl.acm.org/doi/10.1145/1871437.1871517)，
把主题相似度、被引数、时效、作者行为、引用行为一起作为特征做监督学习，
而不是手工决定权重。第三类是 [SPECTER](https://aclanthology.org/2020.acl-main.207/)、
[SciNCL](https://aclanthology.org/2022.emnlp-main.802/)、
[BERT+GCN citation recommendation](https://arxiv.org/abs/1903.06464)、
[两阶段候选扩展](https://arxiv.org/abs/2001.08687) 这条线。

**本项目选择第二类，并有意停在第二类。** 第三类要训练文档编码器，
与"冻结基础模型、只优化持久化检索偏好"的研究主张冲突；第一类无法回答
"权重从哪来"这个问题。因此本文的 rerank 是：

> 不训练 LLM，也不训练论文 embedding；只优化一个可解释的、意图条件化的
> bibliometric ranking policy。

### 7.2 打分形式：相关性门控 + 意图条件化加权

$$
\mathrm{Score}_\theta(p \mid q, z) = G_{\mathrm{rel}}(q, p) \cdot \sum_j w_{z,j}\, f_j(q, p)
$$

- $q$：查询；$z$：检索意图；$f_j$：相关性与计量学特征；
- $w_{z,j}$：**意图 $z$ 下**第 $j$ 个特征的权重；
- $G_{\mathrm{rel}}$：相关性门控；$\theta$：全部可训练的排序偏好参数。

两个设计点各自解决一个失败模式：

**门控解决 $\mathrm{Popularity} \neq \mathrm{Relevance}$。** 只把 citation prior 加进排序，
会把高影响力但与查询无关的论文推到前面，这是被早期研究明确指出过的问题
（[Using Prior Information Derived from Citations](https://dl.acm.org/doi/10.5555/1931390.1931454)）。
门控是乘性的而非加性的：文本相关性不过关，任何计量加成都不能把它救回来。

$$
G_{\mathrm{rel}}(q,p) = \sigma\!\big(\gamma_{\mathrm{rel}} \cdot (\mathrm{Rel}_{\mathrm{text}}(q,p) - \tau_{\mathrm{rel}})\big)
$$

**意图条件化解决"一套权重必然在一半查询上是错的"。** 计量指标的有效方向依赖意图：

| 意图 | 应强调 | 应弱化 |
| --- | --- | --- |
| 领域综述 | relevance、coupling、diversity | 单纯高引用 |
| 奠基性工作 | citation、co-citation、centrality | recency |
| 前沿工作 | recency、semantic、coupling | h-index、co-citation |
| 找相似论文 | BC、CC、semantic similarity | 全局 citation count |
| 找最有影响力工作 | normalized citation、PageRank | author overlap |
| 找具体方法证据 | lexical/semantic relevance | 几乎所有 authority prior |

因此训练 $w_{z,j}$ 而不是 $w_j$。**[Core]** 全局权重是明确不推荐的路线。

意图 profile 以偏好的形式持久化：

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

数值是初值，最终由 benchmark 学习得到（§7.7）。

### 7.3 特征体系与可训练性

特征分六族；每一维的定义写进 `feature_version`，改定义必须升版本号，
否则历史训练数据与新模型不可比。

| 族 | 代表特征 |
| --- | --- |
| lexical | 词项匹配分（标题/摘要）、精确短语命中、标题词覆盖率 |
| semantic | 查询与标题、摘要的稠密向量相似度 |
| bibliometric | 归一化引用、领域归一化影响力、percentile、引用速度、作者 h-index |
| graph | personalized PageRank、对种子的文献耦合 BC、共被引 CC、参考覆盖率 |
| consensus | 命中源数、多套主题分类体系的投票一致度、跨源计量分歧 |
| constraint | 年份落在请求窗内、venue 命中、作者/机构命中、全文可得性 |

计量类特征逐项的可训练性与风险：**[设计，依据 BIR 文献]**

| 特征 | 可训练性 | 风险 | 推荐角色 |
| --- | --- | --- | --- |
| 原始被引次数 | 高 | 年份、学科偏差 | 低权重或先归一化 |
| Citation percentile / 领域归一化影响力 | 高 | 数据缺失 | 影响力主特征 |
| Bibliographic coupling (BC) | 高 | 依赖种子质量 | 相似论文、前沿检索 |
| Co-citation (CC) | 高 | 对新论文严重不利 | 经典/共识检索 |
| Citation PageRank | 高 | 仍有年龄偏差 | influential profile |
| Citation velocity | 高 | 短期噪声 | frontier profile |
| Author h-index | 可训练 | 强资历偏差 | 小权重 tie-breaker |
| Venue h-index | 可训练 | 容易变成 venue bias | 默认不启用 |
| Author overlap | 高 | 可能形成作者封闭圈 | 个性化 / seed-related |
| Publication recency | 高 | 可能牺牲经典论文 | 必须意图条件化 |

**缺失值不填 0**：每个可能缺失的特征配一个缺失指示位，让模型学"没有这个证据"
意味着什么。对计量字段缺失的新文献，这比补 0（等价于"影响力为零"）更诚实。**[设计]**

### 7.4 分级流水线

| 级 | 名称 | 输入规模 | 参数 | 成本 |
| --- | --- | --- | --- | --- |
| L0 | 确定性过滤 | 全部召回 | 无（仅约束） | 0 |
| L1 | 名次融合 | ~300 | $\kappa$、源权重 $\omega_s$ | 0 |
| L2 | 门控 + 意图加权打分 | ~150 | $w_{z,j}$、$\gamma_{\mathrm{rel}}$、$\tau_{\mathrm{rel}}$ | 本地 CPU |
| L3 | 精排 | ~30 | cross-encoder / LLM judge | 受预算门控 |

**L0** 执行时间边界、撤稿、类型与语言过滤，必须在最前面。

**L1** 用倒数名次融合把多源、多子查询的名次合成初排：

$$
\mathrm{RRF}(p) = \sum_{s \in \mathcal{S}} \frac{\omega_s}{\kappa + \mathrm{rank}_s(p)}
$$

用名次而非分数，因为跨 provider 的相关性分数量纲不可比、多数 provider 甚至不外露分数。

**L2** 是 §7.2 的打分函数，可训练的核心。

**L3** 只对 L2 的 top-N 触发且显式计入预算，是质量上限而非默认路径。

### 7.5 图特征

**构图**：节点 = L1 top-$N$ 候选 ∪ 一跳邻居（受 $N_{\max}$ 约束），
边来自 `references` / `citations`。不引入二跳，代价与噪声都不划算。

**Personalized PageRank**，重启分布 $v$ 由 L1 分数给出：

$$
\pi = \alpha v + (1-\alpha)\, P^\top \pi,
\qquad
v_p = \frac{\exp\big(s^{L1}_p / T\big)}{\sum_{p'} \exp\big(s^{L1}_{p'} / T\big)}
$$

**必须是 personalized 而非全局 PageRank**：全局 PageRank 在引文图上收敛到的是
领域声望先验，与 citation count 高度共线，加进特征只是把同一个信号数两遍。
Personalized 版本锚定在本次查询的高相关候选上，度量的是
"从本次检索意图出发，沿引文关系能走到多重要的位置"。**[设计]**

**文献耦合与共被引**。$R(p)$ 为参考文献集，$C(p)$ 为施引文献集，种子集 $S$ 为 L1 top-$m$：

$$
\mathrm{BC}(p_i, p_j) = \frac{|R(p_i) \cap R(p_j)|}{\sqrt{|R(p_i)|\,|R(p_j)|}},
\qquad
\mathrm{CC}(p_i, p_j) = \frac{|C(p_i) \cap C(p_j)|}{\sqrt{|C(p_i)|\,|C(p_j)|}}
$$

$$
\mathrm{CouplingToSeeds}(p) = \frac{1}{|S|} \sum_{s \in S} \mathrm{BC}(p, s)
$$

**耦合度不设硬阈值**：它是特征向量中的一维，阈值由训练决定。
硬阈值只保留在 L0 约束和扩展的预算上限上——把耦合度当过滤器会在综述类查询上
误杀跨簇的关键文献。**[设计]**

研究文档 §6.4 的 HubScore 在此实现为图族的组合特征：

$$
\mathrm{HubScore}(p) = \alpha_1 \pi_p
+ \alpha_2 \frac{\big|R(p) \cap \bigcup_{s\in S} R(s)\big|}{|R(p)|}
+ \alpha_3 \mathrm{CoCitationBreadth}(p)
$$

$\alpha$ 不手工设定，与 $w_z$ 一起训练。

**图特征对新文献天然不利**：预印本的参考文献列表常常缺失，入边更稀，
CC 对新论文尤其不友好。必须靠缺失指示位与意图分层评估监控，
不能让图族变成隐蔽的"老论文加成"。**[待验证]**

### 7.6 偏倚校正

**领域与年份归一化**。原始被引对年代和领域有系统性偏倚，直接排序会让旧综述
永远压过新方法。有现成的领域归一化指标就用；没有则用分组基线自建：

$$
\widetilde{c}(p) = \frac{\log\big(1 + c(p)\big) - \mu_{\mathrm{topic}(p),\,\mathrm{year}(p)}}{\sigma_{\mathrm{topic}(p),\,\mathrm{year}(p)}}
$$

$\mu, \sigma$ 由分面聚合在 (topic, year) 分组上估计并缓存。**[待验证]**

**引用速度**。区分"正在起势"与"吃老本"：

$$
\mathrm{Velocity}(p) = \frac{c_{Y} - c_{Y-2}}{2\,\big(1 + \bar{c}(p)\big)},
\qquad \bar{c}(p) = \frac{c(p)}{\max(1,\ Y - \mathrm{year}(p) + 1)}
$$

分母做平均年被引归一，避免高引老论文靠绝对增量取胜。

**计量数据本身会坏**。逐年被引序列出现断崖式下跌、或与反查计数严重不符时，
该记录的 bibliometric 族降权并置 `citation_confidence=low`，
由 consensus 族的分歧特征承载这一信息。

### 7.7 四种训练模式

| 模式 | 方法 | 产出 | 适用阶段 |
| --- | --- | --- | --- |
| **A** 直接优化加权公式 | 无梯度搜索：grid / random / coordinate descent / 贝叶斯优化 / CMA-ES / TPE | 一组权重 $\theta^*$ | **第一版** |
| **B** 监督式 Learning-to-Rank | pointwise / pairwise / listwise，LambdaMART、XGBoost ranking、RankSVM、小型 MLP | 轻量排序模型 | 标注量上来之后 |
| **C** 在线偏好学习 | contextual bandit、LinUCB、Thompson sampling | 在线更新的策略 | 上线个性化，非本阶段 |
| **D** Reviewer 提议 + 优化器验证 | Reviewer 归因 → 候选 $\Delta HP$ → 回放验证 | 经验证的偏好更新 | 与双 Agent 结构配套 |

**模式 A** 在训练集上直接搜索权重：

$$
\theta^* = \arg\max_\theta \frac{1}{|D_{\mathrm{train}}|} \sum_i J_i(\theta)
$$

不需要梯度，不产生复杂模型，训练的对象是 $PH_k \to PH_{k+1}$ 而非模型参数。
这是第一版最合适的方案。

**模式 B** 把每个 query–paper pair 转成训练样本（特征 + 标签），
标签可以是"是否在 gold set"、分级相关性、pairwise 偏序，或 Reviewer 依据 gold 生成的偏好对。
pairwise 目标：

$$
P(p_i \succ p_j) = \sigma\big(\mathrm{Score}(p_i) - \mathrm{Score}(p_j)\big)
$$

listwise 用 LambdaMART 近似优化 NDCG。采用模式 B 之后，论文中的表述必须相应改为
"We do not fine-tune the LLM, but train a lightweight bibliometric reranker"，
而不能再说"没有训练任何模型"。**[Core：表述纪律]**

**模式 C** 不适合第一阶段：反馈稀疏、位置偏差明显、探索会降低当前检索质量，
且难以与离线 F1 公平比较。

**模式 D 是与本项目架构最契合的一种**，也是 Reviewer 与优化器的正确分工：

```text
Search trajectory + Gold
          │
          ▼
       Reviewer            "共被引权重过高，新论文被压制"
          │
          ▼
    candidate ΔHP          {scope: {intent: frontier},
          │                 proposed_changes: {...},
          ▼                 hypothesis: "..."}
 Benchmark Replay / Optimizer
          │
     validation gain?
      ┌───┴───┐
     yes      no
      │        │
      ▼        ▼
   commit    reject
```

$$
\theta_{k+1} = \mathrm{ValidateOptimize}\big(\theta_k,\ \mathrm{Proposal}_R,\ D_{\mathrm{train}}\big)
$$

关键在于**最终数值不由 Reviewer 用语言直接决定**：
Reviewer 负责归因并提出搜索方向，优化器负责数值求解，验证器决定是否持久化。
这让 Reviewer 的贡献变成可测量的——它提出的方向是否比随机方向更快找到增益，
本身就是一个可做的消融（§7.10 的 B5 对 B4）。

### 7.8 训练目标与 K 的拆分

赛题的最终评价是论文集合的 F1，因此**不要只训练 NDCG**：

$$
J(\theta) = \alpha\,\mathrm{F1@}K + \beta\,\mathrm{Recall@}K + \gamma\,\mathrm{NDCG@}K
- \lambda_c\,\mathrm{Cost} - \lambda_l\,\mathrm{Latency}
$$

例如 $\alpha=0.6,\ \beta=0.2,\ \gamma=0.2,\ \lambda_c=0.02$。
把成本与延迟写进目标函数，而不是当作事后约束——否则优化器一定会用预算换分数。

$K$ 本身可训练：

$$
K^*(z) = \arg\max_K \mathrm{F1@}K
$$

但**不能把 topK 当成一个参数**。至少拆成四个，只有最后一个决定答案集合大小：

```text
provider candidate N     每个源召回多少
fused candidate N        名次融合后保留多少
graph enrichment M       进入图特征计算的规模
final output K           最终返回多少
```

前三个是成本旋钮，第四个是精确率/召回率的权衡点，混为一谈会让训练结果无法解释。

### 7.9 在线可调 vs 离线训练

| | 在线（episode 内，尺度 $t$） | 离线（尺度 $k$ 及以上） |
| --- | --- | --- |
| 可变对象 | profile 选择、有界缩放 $\lambda$、源开关、四个 N/K、L3 开关 | $w_{z,j}$、$\gamma_{\mathrm{rel}}$、$\tau_{\mathrm{rel}}$、特征集合、模型结构 |
| 谁触发 | Reviewer 的 $A_t$ | 训练管线 / 模式 D 的优化器 |
| 约束 | clamp 到 $[\lambda_{\min}, \lambda_{\max}]$，$\|\delta\|_\infty \le \delta_{\max}$ | schema 校验 + held-out 冻结 |
| 失败后果 | 单次检索质量下降，可回滚 | 模型漂移、测试集泄漏 |

在线的有界缩放叠加在训练好的权重上：

$$
w^{\mathrm{eff}}_{z,j} = w_{z,j} \cdot \mathrm{clamp}\big(\lambda_j,\ \lambda_{\min},\ \lambda_{\max}\big)
$$

Reviewer **不能**直接写 $w_{z,j}$。它能做的是在线切 profile 或做有界缩放，
以及离线提出 $\Delta HP$ 交给优化器验证。这样在线环仍然只读偏好、
学习环仍然只在拿到可验证反馈后运行，与 `design.md` §7 的两个循环划分一致。

持久化到偏好存储的结构：

```text
Preference Persistence
└── HP
    ├── retrieval parameters        provider 选择、时间窗、四个 N/K
    ├── bibliometric feature weights w_{z,j}
    ├── intent-specific profiles     z -> profile
    ├── relevance thresholds         gamma_rel, tau_rel
    ├── diversity parameters         lambda_MMR
    └── output Top-K                 K*(z)
```

**训练划分必须与研究文档 §7.1 一致**：排序参数只能在 train split 上优化，
held-out 上冻结。否则 rerank 会成为一条绕过 Preference 冻结协议的测试集泄漏通道。

### 7.10 评估与消融

排序器对比矩阵：

| 实验 | 排序器 |
| --- | --- |
| B0 | 词法/语义检索，无计量信号 |
| B1 | B0 + 固定 citation count |
| B2 | B0 + 固定完整计量公式 |
| B3 | B0 + 全局可训练权重 |
| B4 | B0 + intent-conditioned 可训练权重 |
| B5 | B4 + Reviewer proposal / validation（模式 D） |
| B6 | LambdaMART bibliometric reranker（模式 B） |
| B7 | citation-informed embedding / reranker（第三类，作为上界参照） |

关键消融：

```text
B4 - BC            文献耦合有没有用
B4 - CC            共被引有没有用
B4 - Citation      计量信号整体有没有用
B4 - Recency
B4 - Author H
B4 - Reviewer      Reviewer 是否比纯数值优化器多提供价值
B4 - Persistent HP 持久偏好是否能跨 query / 跨 benchmark 泛化
```

这组实验分别回答五个问题：计量特征有没有用；手工权重还是训练权重更好；
intent-conditioned 是否优于全局权重；Reviewer 是否优于纯优化器；持久偏好能否泛化。

补充要求：**按意图分层报告**，避免计量特征在总均值上的收益掩盖它在时效类查询上的损害；
报告成本-质量曲线（横轴 cost/latency，纵轴 F1@K）；
报告同一查询重复调用的排序稳定性（Kendall $\tau$），缓存命中与冷启动分开统计。

只有在**图族消融显示独立增益**时才保留 §7.5 的图计算成本，否则退回 L1+L2。**[待验证]**

## 8. 预算、限流与缓存

**预算**是控制流的一部分，不是事后统计。每次请求携带 `budget`，
Service 在阶段边界检查余额，超限时停止当前策略并返回可解释的部分结果，
在 `SearchState.failures` 标注被跳过的阶段。passthrough 与 aggregated 共享同一本账。

**限流**由 provider 的 `cost_model` 声明，Service 统一实现退避重试。
按日额度记账是不够的——瞬时速率限制会在额度充足时触发，客户端必须假定随时会被拒。

**缓存**分四层，键都包含时间边界与源版本：原始响应、合并后的 cluster、
稠密向量、特征矩阵。**特征矩阵缓存是离线训练回放的物理载体**：
训练与消融在缓存上回放，不重打 API。这一条同时解决成本、可复现、
以及"改了特征就要重跑全部 API"的问题。

---

# 第二部分　原型

## 9. 原型 P0：两源聚合 + 可训练 rerank

### 9.1 范围

**接入**：OpenAlex 与 arXiv 两个 provider，其余一律不做。
**模式**：aggregated、passthrough、rank-only 三种全部提供——
passthrough 是本原型验证 provider 抽象是否成立的关键，不能省。
**rerank**：模式 A（无梯度权重搜索）+ 意图条件化 profile。
**不做**：模式 B/C、L3 精排、全文检索链路、多 benchmark 聚合。

### 9.2 两个 provider 的能力声明 **[实测]**

| 能力 | OpenAlex | arXiv |
| --- | --- | --- |
| `search.keyword` | ✔ `title_and_abstract.search` | ✔ 但为宽松 OR 匹配，top-10 会混入离题结果 |
| `search.native_query` | ✔ `filter` 任意字段布尔组合 | ✔ 字段前缀 `ti`/`abs`/`au`/`cat` + AND/OR/ANDNOT |
| `search.field_filter` | ✔ | ✔ 含 `submittedDate` 范围 |
| `facet.group_by` | ✔ 单次返回全量分布 | ✘ |
| `id.lookup` | ✔ 免费不限次 | ✔ |
| `graph.references` | ✔ `referenced_works` | ✘ |
| `graph.citations` | ✔ `filter=cites:<id>` 反查 | ✘ |
| `metrics.raw_citations` | ✔ | ✘ |
| `metrics.normalized` | ✔ `fwci`、`citation_normalized_percentile` | ✘ |
| `text.abstract` | ✔ 倒排索引需重建 | ✔ `summary`，作者原文 |
| `text.fulltext` | 部分 | ✔ PDF |

**角色**：OpenAlex 是主召回、计量指标与引文图的唯一来源；
arXiv 是时效与版本、作者自报 category、精确摘要、`comment` 中 venue 信号的补全源，
**不做主召回**。

Semantic Scholar 暂不纳入：无 key 时只有 `/search/bulk` 与 `/{id}/citations` 稳定，
其余端点持续 429，申请周期不可控。**[实测]** 代价见 §11.1。

### 9.3 字段路由与主键 **[实测]**

主键优先级：

```text
1. 正式 DOI                          OpenAlex 覆盖约 98%
2. arXiv ID ↔ 10.48550/arXiv.<id>    确定性 join key，但需允许失败
3. 归一化标题 + 年份 + 首作者        兜底
```

第 2 级基于 arXiv 为每篇预印本分配的 DataCite DOI，OpenAlex 可直接解析；
但部分 arXiv DOI 会被 OpenAlex 从 works 主键降级为 location（实测
`10.48550/arxiv.1706.03762` 返回 404），必须回退到第 3 级。
arXiv API 自身只有约 3% 记录带 `arxiv:doi`（发表后回填的期刊 DOI），不能依赖。

字段路由：

| 字段 | 取自 | 依据与风险 |
| --- | --- | --- |
| 领域归一化影响力 | OpenAlex `fwci` / `citation_normalized_percentile` | article 覆盖 100%、**preprint 覆盖 0%**，预印本需自建基线 |
| 原始被引数 | OpenAlex `cited_by_count` | article 可信；**preprint 系统性低估 2–16 倍**，对策见 §9.5 |
| 图出边 | OpenAlex `referenced_works` | article 覆盖 99%、preprint 仅 39% |
| 图入边 | OpenAlex `filter=cites:<id>` | $0.0001/次，比逐条取引用列表便宜 |
| 主题 | OpenAlex `topics`+`keywords` ⊕ arXiv `category` | 生成机制独立（模型预测 vs 作者自报），可投票 |
| 摘要 | preprint 取 arXiv `summary`（96%）；article 取 OpenAlex（71–77%） | article 摘要缺口 23–29% 当前**无法补齐**，置缺失位 |
| 时效与版本 | arXiv `published`/`updated`、v1/v2、`comment` | 严格时间边界的唯一可靠来源；27% 有 v2+，14% comment 含发表状态 |
| 机构 / 国别 | OpenAlex `authorships[].institutions`（ROR 87%、ORCID 99%） | 不在顶层 `institutions` 字段 |
| 质量红旗 | OpenAlex `is_retracted` | — |

`record_thinness` 标记：OpenAlex 的 preprint 记录常常机构全空、`referenced_works` 为 0、
arXiv category 丢失、topic 由分类器猜测（实测 score 0.36）。薄记录参与图特征时降权。

### 9.4 管线实例化

```text
(0) probe    OpenAlex group_by 年份/topic/机构           $0.0001/次
(1) recall   OpenAlex title_and_abstract.search 主召回    $0.001/次
             arXiv Atom 仅用于 ID/标题精确命中与时间窗补充
(2) align    §9.3 主键；preprint 与正式版归入同一 cluster，计量字段取 article 侧
(3) enrich   OpenAlex 单实体端点（免费）回填 fwci/percentile/counts_by_year/topics
             arXiv 补 category / 版本 / comment / 精确摘要
(4) rank     L0 → L1 RRF → L2 门控加权（§9.5）
(5) expand   OpenAlex 出边 + cites 反查，深度 1，扇出上限 20
(6) select   预算内截断
```

阶段 (2) 的 preprint–article 合并是本原型的关键补偿：预印本自身计量字段不可信，
但只要正式版在 OpenAlex 里，同一 cluster 就能拿到可信的 `fwci` 与引用数。**[设计]**

### 9.5 rerank 原型

**特征清单**（12 维起步，全部可从两源获得）：

| # | 特征 | 族 | 计算 |
| --- | --- | --- | --- |
| 1 | `bm25_title` | lexical | 本地倒排 |
| 2 | `bm25_abstract` | lexical | 本地倒排 |
| 3 | `semantic_title` | semantic | 向量余弦 |
| 4 | `semantic_abstract` | semantic | 向量余弦 |
| 5 | `citation_percentile` | bibliometric | OpenAlex，缺失置 null + 指示位 |
| 6 | `fwci` | bibliometric | OpenAlex，preprint 缺失 |
| 7 | `citation_velocity` | bibliometric | `counts_by_year` 斜率（§7.6） |
| 8 | `author_h_max` | bibliometric | 作者 h-index 最大值 |
| 9 | `coupling_to_seeds` | graph | BC 对 L1 top-$m$ 均值 |
| 10 | `co_citation_breadth` | graph | CC，依赖 `cites` 反查 |
| 11 | `pagerank_personalized` | graph | 局部图幂迭代 |
| 12 | `recency` | constraint | $\exp(-\Delta t / \tau)$ |

加上每个可缺失特征的指示位，共 12 + 6 = 18 维。

**打分**：$\mathrm{Score} = G_{\mathrm{rel}} \cdot \sum_j w_{z,j} f_j$，
$G_{\mathrm{rel}}$ 取 $\sigma(\gamma_{\mathrm{rel}}(\max(f_1..f_4) - \tau_{\mathrm{rel}}))$。

**四个意图 profile**：`overview` / `seminal` / `frontier` / `similar`，
初值按 §7.2 的表填写，`frontier` 压低 CC 与 author_h、抬高 recency 与 coupling。

**训练配置**（模式 A）：

```text
optimizer     TPE (Optuna) 或 CMA-ES，200–400 trials
objective     J = 0.6·F1@K + 0.2·Recall@K + 0.2·NDCG@K - 0.02·Cost
search space  w_{z,j} ∈ [0,1] 单纯形约束；gamma_rel ∈ [1,20]；tau_rel ∈ [0.2,0.8]
              K ∈ {10,20,30,50}；四个 N/K 分别搜索
data          训练集回放缓存，不重打 API
split         train / validation / held-out，held-out 冻结
```

**preprint 计量缺失的三条对策**，按优先级：

1. 走 §9.4 阶段 (2) 的 cluster 合并，用正式版记录的计量字段；
2. 合并失败则 bibliometric 族全部置缺失（不是置 0），由指示位承载
   "这是一篇计量信息不可用的新文献"；
3. 排序不因此惩罚它——lexical、semantic、constraint 三族仍然完整可用。

后果是**预印本的排序几乎完全由文本相关性决定**。对 `frontier` 意图这可接受甚至是想要的；
对 `seminal` / 影响力类意图是明显缺口，属于接入第三个计量源后要重新评估的部分。**[设计]**

### 9.6 预算与限流 **[实测]**

| 源 | 约束 | 对原型的影响 |
| --- | --- | --- |
| OpenAlex `search` | $0.001/次，1k/天 | 主召回次数受控；`select=` 必用（响应可从 129KB 压到很小） |
| OpenAlex `filter` / `group_by` | $0.0001/次，10k/天 | 探查、结构化过滤、入边反查优先 |
| OpenAlex 单实体 | 免费不限次 | 富集与取边的主力 |
| OpenAlex 瞬时速率 | 余额充足时仍会 429 | 必须退避重试 |
| arXiv | 必须 https（http 返回 0 字节），间隔 ≥3s，单次 ≤2000 条 | 补全源，串行低频 |

### 9.7 验收判据

| 项 | 判据 |
| --- | --- |
| 接口 | 三种模式端到端跑通；`GET /providers` 返回真实配额余量 |
| passthrough | Agent 提交的原生检索式原样送达，且时间边界、预算、轨迹记录四条治理规则全部生效 |
| 合并 | 人工抽样核对 cluster 正确率；标题兜底触发率有统计 |
| rerank | 在一个 benchmark 上，B4（意图条件化训练权重）优于 B2（固定计量公式）与 B0 |
| 可复现 | 关掉网络，仅凭回放缓存能重跑全部训练与消融 |

## 10. 模块划分

```text
src/search_service/
  api/         # 路由：aggregated / passthrough / rank-only
  providers/   # 每源一个适配器 + 能力表 + 成本模型 + 字段映射
  merge/       # 主键聚类、字段路由、质量标记
  enrich/      # 富集调度与预算门控
  features/    # 六族特征抽取，带 feature_version
  graph/       # 局部引文图、personalized PageRank、BC/CC
  rank/        # L0–L3 编排、门控与意图 profile
  training/    # 回放数据集、模式 A 搜索、消融脚本
  governance/  # 预算、限流退避、轨迹落盘、时间边界强制
```

`governance/` 独立成模块是因为它同时服务于三种调用模式——
passthrough 绕过的是归一化与排序，绝不能绕过治理。

## 11. 缺口、未验证与风险

### 11.1 未接入第三方计量源的代价

| 失去的能力 | 影响 | 当前替代 |
| --- | --- | --- |
| 跨源 ID 枢纽 | 主键合并少一层兜底，标题匹配触发率上升 | arXiv DataCite DOI + 标题归一化 |
| 可信的 preprint 引用数 | 预印本计量特征整体不可用 | cluster 合并，否则置缺失（§9.5） |
| 实质性引用计数 | 无法区分实质引用与礼节引用 | 无 |
| 引用上下文与 intent | 无法做"只沿 method 类引用扩展"的定向游走，失去一类高质量证据文本 | 无 |
| 一句话摘要 | 粗筛少一个低 token 字段 | 摘要截断 |
| 正交平行召回 | 召回集正交性下降 | 无 |

引用语义类特征已从 §9.5 的特征清单中**移除**而非留空位，避免训练出依赖不可得字段的模型。
接入新计量源时作为一次显式的 `feature_version` 升级处理。

### 11.2 未验证 **[待验证]**

- 标题归一化兜底的合并准确率；
- OpenAlex 语义/向量检索（$0.001/次）能否作为第二召回源，弥补正交性损失；
- preprint 归一化基线（§7.6）的分组样本量下限与稳定性；
- "不同源排序偏倚方向相反"目前基于单个 query 的探测，跨学科稳定性未知；
- 相关性排序的 precision 尚未用赛题标注集评估；
- 意图标签 $z$ 的来源：由 Main Agent 声明、由分类器判定、还是二者兼有，尚未定案。

### 11.3 风险

- **图特征不划算**：PageRank 与耦合度需要额外的边获取与本地计算。
  若消融显示无独立增益，应当果断退回 L1+L2，而不是因为"算法看起来高级"保留它。
- **计量特征喧宾夺主**：训练数据不足时容易被学成主导权重，表现为"总是返回高引经典"。
  相关性门控是第一道防线，意图分层评估是第二道。
- **意图分类错误的连锁反应**：意图条件化权重把 $z$ 变成了单点故障。
  $z$ 判错等于用错一整套权重，需要单独测量意图分类的错误率与代价。**[待验证]**
- **单一元数据源**：OpenAlex 成为计量与引文图的唯一来源，其数据缺陷
  （碎裂引文图、preprint 薄记录）无法交叉校验，只能靠内部一致性检查发现。
- **缓存与真实调用发散**：离线回放训练出的权重在线上遇到不同的召回分布会失效。
  需定期用真实调用重建回放集，并比较两者的候选分布。
- **表述过强**：一旦采用模式 B，就必须改口为"训练了一个轻量 bibliometric reranker"，
  不能继续说"我们不训练任何模型"。

## Git 提交流程

本文件是设计文档，不代表已实现，也不自动提交 Git。
