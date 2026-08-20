# 从 MetaScientist 提炼的学术论文 Rerank 算法设计

> 状态：设计稿
>
> 本文从 `packages/metascientist` 中的 CiteFlow 实现提炼可复用的排序思想，形成独立于该包的 Search Service 算法设计。本文不是对 CiteFlow 工作流的原样移植，也不把现有参数当作已验证的生产配置。

## 1. 设计目标

Search Service 已经完成候选召回、跨源归一、去重和必要的元数据富集后，对候选论文执行有界的多信号重排：

```text
query + normalized candidates
    -> deterministic eligibility checks
    -> semantic cross-encoder scoring
    -> lexical and citation-graph feature extraction
    -> calibrated feature fusion
    -> stable top-k selection
```

算法必须满足：

1. 语义相关性是主信号，引用影响力不能替代主题相关性；
2. 语义、词法、图和元数据特征分别计算，保留可解释的中间值；
3. 所有付费或远程计算有候选数、时间、调用数和费用上限；
4. 同一输入、同一配置和同一模型版本应产生可复核的排序；
5. `end_date` 是硬约束，不是排序偏好；越界论文不能通过高分回到结果集；
6. 特征权重可以离线训练，episode 内只允许 `HP_k` 在安全范围内调整缩放系数。

## 2. 从参考库中保留的算法思想

### 2.1 Cross-Encoder 语义精排

参考实现位于：

```text
packages/metascientist/metasci-citeflow/src/metasci_citeflow/scoring/reranker.py
```

它使用模型同时读取 query 和论文文本，而不是分别编码后再计算向量距离。论文文本的第一版定义为：

```text
document_text(p) = title(p) + ". " + abstract(p)
```

新的服务将该信号命名为 `semantic_cross_encoder_score`，不再沿用参考库中容易误解的 `embedding_sim` 字段名。

设 $x_p$ 为论文文本，模型输出原始相关性分数 $g(q,x_p)$，则：

$$
 s_{\mathrm{sem}}(q,p) = \mathrm{Calibrate}_{v_c}\bigl(g_{v_m}(q,x_p)\bigr)
$$

其中 $v_m$ 是模型版本，$v_c$ 是分数校准版本。校准函数必须由离线实验固定，不能在每个请求的 batch 内用最大值重新缩放，否则不同 batch 的分数可能不可比较。

摘要缺失时允许退化为标题，但必须产生 `abstract_missing = 1` 特征，并在诊断中记录。标题-only 记录不能静默地和完整摘要记录视为同等证据。

### 2.2 词法相关性

参考库将查询分析得到的 discriminative terms 转换为 rarity-weighted 的词法分数。为了保留“多个独立术语共同命中”的效果，定义 noisy-OR 形式：

$$
 s_{\mathrm{lex}}(q,p)
 = 1 - \prod_{j \in M(q,p)} (1 - \rho_j)
$$

其中 $M(q,p)$ 是论文命中的查询术语集合，$\rho_j \in [0,1]$ 是术语 $j$ 的稀有度权重。该信号适合解释精确短语、方法名、数据集名和指标名，但不应单独承担语义召回。

### 2.3 领域内引用图特征

参考库的 `cocitation.py` 不实现 PageRank，而是计算共被引和领域内引用集中度。对候选集 $D$，令 $n_{\mathrm{dom}}(p)$ 为 $D$ 中论文对 $p$ 的引用数，$c(p)$ 为论文的总引用数，则参考信号为：

$$
 s_{\mathrm{dom}}(p)
 = n_{\mathrm{dom}}(p)
   \left(\frac{n_{\mathrm{dom}}(p)}{c(p)}\right)^2
$$

它倾向于识别“被当前主题论文集中引用”的工作，而不是简单偏向全球高被引论文。

当 $c(p)=0$ 或引文图缺失时，$s_{\mathrm{dom}}$ 记为缺失，并由 `citation_graph_missing` 承载该状态；不能把未观测到的领域引用当作真实的零分。

同时保留以下图特征：

```text
co_citation_count       当前候选集共同引用该论文的次数
in_domain_citation_count 当前候选集对该论文的引用次数
in_domain_ratio         in_domain_citation_count / total_citation_count
citation_graph_missing  引文边或总引用数缺失标记
```

这些特征是排序输入，不是硬过滤条件。缺少引文图的预印本不应因为缺失值被当作“图分数为零”而受到额外惩罚。

### 2.4 引用数与时效性

引用数和年份只作为辅助信号。原始引用数受年份、领域和论文类型影响，优先使用领域归一化指标；只有在归一化指标不可用时，才使用对数化的原始引用数。

时效性必须相对于请求中的 `end_date` 计算，而不是读取机器当前日期：

$$
 s_{\mathrm{rec}}(p \mid e)
 = \mathrm{Recency}\bigl(\mathrm{year}(p),\ \mathrm{year}(e)\bigr)
$$

其中 $e$ 是本次请求的 `end_date`。该定义保证离线评测和历史时间截面可以复现。

## 3. 分级排序管线

### 3.1 L0：硬约束与可排序性检查

L0 不产生“偏好分数”，只决定候选是否有资格进入排序：

```text
- publication date <= end_date
- not retracted / not paratext when policy excludes them
- stable paper_id exists
- candidate belongs to the current query scope
```

失败候选不能静默丢弃，应记录：

```text
excluded_papers: [{paper_id, reason}]
```

### 3.2 L1：低成本候选范围控制

对全部候选计算零 API 成本的词法、元数据和已有来源名次特征，并确定进入语义精排的上限 $N_{\mathrm{sem}}$。$N_{\mathrm{sem}}$ 是预算参数，不是固定的全量候选数。

候选选择优先保证：

1. 查询约束命中的论文；
2. 多个来源或子查询共同命中的论文；
3. 词法命中和元数据质量较高的论文；
4. 少量探索配额，避免低成本预筛选造成不可逆的召回损失。

### 3.3 L2：特征计算

对进入精排范围的论文计算：

$$
 \phi(q,p) =
 \bigl[
 s_{\mathrm{sem}},
 s_{\mathrm{lex}},
 s_{\mathrm{dom}},
 s_{\mathrm{cite}},
 s_{\mathrm{rec}},
 m_{\mathrm{abstract}},
 m_{\mathrm{graph}},
 m_{\mathrm{metadata}}
 \bigr]
$$

其中 $m$ 是缺失或质量指示特征。缺失指示位和数值特征必须同时保留，不能把“未知”与“确实为零”混淆。

### 3.4 L3：特征融合

第一版使用可解释的乘法相关性项，再加上图、计量和时效性辅助项：

$$
\begin{aligned}
 h_{\mathrm{rel}}(q,p)
   &= \bigl(1 + \lambda_{\mathrm{lex}}s_{\mathrm{lex}}(q,p)\bigr)
      \bigl(1 + \lambda_{\mathrm{sem}}s_{\mathrm{sem}}(q,p)\bigr) - 1 \\
 S(q,p)
   &= w_{\mathrm{rel}}h_{\mathrm{rel}}(q,p)
      + w_{\mathrm{dom}}s_{\mathrm{dom}}(p)
      + w_{\mathrm{cite}}s_{\mathrm{cite}}(p)
      + w_{\mathrm{rec}}s_{\mathrm{rec}}(p)
      + w_{\mathrm{quality}}s_{\mathrm{quality}}(p)
\end{aligned}
$$

乘法相关性项的作用是：词法和语义同时较高时获得协同增益；只有引用数高但主题相关性低的论文不能仅靠计量信号进入顶部。

当离线标注集足够大时，可以将该融合器替换为 LambdaMART 或其他 Learning-to-Rank 模型。无论使用公式还是模型，都必须输出每个特征和最终分数，保持可归因性。

### 3.5 Top-k 与稳定性

排序使用以下确定性规则：

```text
sort by (-final_score, -semantic_score, original_candidate_position)
```

同分时保持候选进入排序前的稳定顺序。返回结果至少包含：

```text
{
  "paper_id": "...",
  "rank": 1,
  "score": 0.83,
  "features": {
    "semantic_cross_encoder": 0.91,
    "lexical": 0.62,
    "in_domain_citation": 0.34,
    "citation": 0.48,
    "recency": 0.77
  },
  "rank_reason": ["semantic_match", "in_domain_citation"],
  "feature_missing": []
}
```

## 4. 配置与预算

固定模型和融合器属于离线版本；`HP_k` 只能调整有界运行参数：

```text
rerank.model
rerank.calibration_version
rerank.max_semantic_candidates
rerank.timeout_ms
rerank.semantic_weight_scale
rerank.graph_weight_scale
rerank.recency_weight_scale
rerank.exploration_fraction
```

配置必须通过基础参数和硬上限合成：

$$
 \theta^S_k
 = \mathrm{clamp}\Bigl(
     \mathrm{override}(P.defaults, HP_k),
     P.limits
   \Bigr)
$$

单次请求必须记录：

```text
reranker_model
feature_version
calibration_version
candidate_count
semantic_scored_count
cache_hits
api_calls
input_tokens / output_tokens when available
cost_usd
elapsed_ms
failure_class
```

远程 Cross-Encoder 失败时，服务应返回已计算的低成本特征排序，并在 `failures` 中记录 `timeout`、`rate_limited`、`provider_error` 或 `invalid_response`。不能把失败候选静默删除，也不能无限重试。

## 5. 与 Agent 和 Reviewer 的边界

Search Service 只负责计算和执行排序，不负责：

- 自行改写自然语言查询；
- 让 LLM 逐篇决定是否相关；
- 自行决定是否进行多轮引用扩展；
- 在当前 episode 内更新 `PH_k`；
- 把隐藏推理写入公开搜索轨迹。

CiteFlow 中的 query analyzer、seed selector、relevance judge 和 forward expansion 属于策略编排，可以作为 Main Agent 或实验 workflow 的参考，但不应成为本排序器的隐式副作用。

Reviewer 可以根据 `features`、`rank_reason`、候选覆盖和失败信息提出：

```text
refine_query
add_source
expand_citation
rerank
stop
```

但建议必须经过运行时 gate，不能直接改写排序器状态或绕过预算。

## 6. 训练和评测计划

### 6.1 消融组

固定 query、`end_date`、召回候选、预算和停止条件，比较：

```text
A. semantic only
B. semantic + lexical
C. semantic + lexical + citation features
D. C + cross-encoder top-N budget
E. trainable fusion model
```

### 6.2 指标

至少报告：

- Precision、Recall、F1；
- Recall@K、MRR 或 nDCG@K；
- 端到端延迟与 rerank 延迟；
- Cross-Encoder 调用数、缓存命中率和费用；
- 摘要缺失率、图特征缺失率；
- 新论文与经典论文分桶结果；
- 不同 query intent 下的结果；
- provider 失败率和降级后 F1。

候选覆盖必须与最终排序分开报告。论文没有进入候选集时，排序器无法补救该召回错误。

### 6.3 通过条件

只有在固定 benchmark 上同时满足以下条件，才允许把实验配置升级为默认配置：

1. 相对于 semantic-only baseline 的 F1 提升具有稳定性；
2. 增加的 Cross-Encoder 成本和延迟在预算内；
3. 图特征没有系统性压低新论文和预印本；
4. 失败和缺失字段不会造成静默结果偏差；
5. 每个排序结果都能由保存的特征和版本重新计算。

## 7. 参考实现边界与来源

本文提炼的实现依据：

```text
packages/metascientist/metasci-citeflow/src/metasci_citeflow/scoring/reranker.py
packages/metascientist/metasci-citeflow/src/metasci_citeflow/scoring/autoscore.py
packages/metascientist/metasci-citeflow/src/metasci_citeflow/graph/cocitation.py
packages/metascientist/metasci-universe/src/metasci_universe/memory/curalib.py
packages/metascientist/metasci-citeflow/HANDOFF.md
```

参考库中的 `embedding_sim` 是 Cross-Encoder 分数，当前算法不是 PageRank；参考库的最终权重、`0.93` 高相关阈值和多轮 CiteFlow workflow 都不作为本文的默认生产结论。

在复制代码而非复用算法思想之前，必须补齐上游仓库 URL、固定 commit、许可证、模型许可证和 provider 服务条款。当前参考目录未发现独立的 `LICENSE` 或 `NOTICE` 文件，因此来源合规仍是正式集成前置条件。
