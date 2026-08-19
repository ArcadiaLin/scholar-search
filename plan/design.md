# 检索架构设计

## 1. 设计目标与总体判断

本系统面向科研场景下的复杂学术查询，目标不是把一个“大而全”的
ReAct Agent 直接接到搜索 API 上，而是把**查询理解、受控检索、轨迹审查、
偏好沉淀和结构化输出**组织成一个可迭代、可观测、可预算的闭环。

系统由四个核心模块组成：

1. **Main Search Agent**：理解查询、规划检索步骤、调用检索工具，并生成最终结果。
2. **Search Service**：封装多源检索、缓存、跨源归一、去重、引文扩展和候选排序。
   它被 Search Agent 当作工具使用，但不负责自然语言决策。
3. **Reviewer Agent**：观察检索轨迹并提供过程建议；在检索结束后比较结果与参考答案
   或用户反馈，提出偏好更新。
4. **Preference Persistence**：持久化用户偏好，分为自然语言偏好和检索超参数偏好。

其中，Agent 负责需要语言推理的决策，Service 负责可测试的检索能力，
Preference Persistence 负责跨请求记忆。三者职责不能互相替代。

## 2. 核心对象与数据契约

### 2.1 输入与偏好

- `RQ (Raw Query)`：用户输入的原始自然语言查询。
- `PH (Preference Hint)`：一次请求读取到的偏好快照：

  ```text
  PH = NP + HP
  ```

  - `NP (Natural-language Preference)`：自然语言形式的偏好，例如“优先近五年的方法论文，
    同时保留少量高影响力经典论文”。
  - `HP (Hyperparameter Preference)`：可执行的检索参数，例如时间范围、各源的 top-k、
    召回/扩展开关、排序权重和最大预算。
- `P (Parameters)`：系统预设参数和安全上限。它是 HP 的基线，HP 只能覆盖允许调整的字段，
  不能突破系统级预算、日期边界和并发上限。

请求开始时建立不可变的 `RunSnapshot`：

```text
RunSnapshot = {
  rq: RQ,
  np: NP,
  hp: merge(P, HP),
  constraints: { end_date, budget, max_iterations, ... },
  preference_version
}
```

当前运行只使用这个快照。Reviewer 在本次运行结束后更新的偏好默认从下一次请求生效，
避免运行中的参数漂移破坏可复现性。

### 2.2 Search Agent 的输入、工具与输出

自然语言输入定义为：

```text
SI (Search Input) = RQ + NP + runtime constraints
```

`SI` 与 Search Agent 的 `SystemPrompt` 组成第一轮上下文：

```text
SearchContext_0 = SystemPrompt + SI
```

Search Agent 遵循：

```text
Agent = ReActLoop(Context + Tools)
Main Search Agent = ReActLoop(SearchContext + Search Tools)
```

Search Tools 不是直接暴露给模型的一组裸 API，而是由 `Search Service` 根据 HP 和 P
生成的受约束工具视图：

```text
SearchTools = ST(HP, P)
```

每次工具调用都应携带本次运行的查询约束、日期边界和预算上下文。工具返回结构化的
检索观察值，而不是要求 Agent 解析终端文本。

最终输出 `SO (Search Output)` 至少包含：

```text
SO = {
  papers: ranked paper list,
  answer: query-oriented synthesis,
  relations?: paper/citation graph,
  evidence?: supporting snippets or fields,
  metadata: { query_id, preference_version, budget, trace_summary }
}
```

`papers` 是评分主对象；`answer`、`relations` 和 `evidence` 用于满足结构化展示和可复核性要求。

## 3. Search Service：被 Agent 调用的检索能力层

Search Service 对 Agent 暴露少量稳定的领域工具，内部再编排多个检索源和本地算法。
建议的内部流水线如下：

```text
query plan
    -> multi-source recall
    -> ID normalization and deduplication
    -> metadata/full-text enrichment
    -> BM25/embedding/rule rerank
    -> citation or related-work expansion
    -> budgeted result selection
```

各环节职责如下：

- **召回**：根据查询意图和 HP 选择 OpenAlex、Semantic Scholar、arXiv 等来源。
  OpenAlex/Semantic Scholar 负责主要候选召回，arXiv 主要补充时间敏感的预印本、
  标题/ID 精确命中和全文入口；不把三个源的相关性分数直接相加。
- **归一与去重**：统一 DOI、arXiv ID、Semantic Scholar CorpusID、OpenAlex ID，
  通过外部 ID 映射和标题/作者等字段合并同一论文的多源记录。
- **富集**：按需补齐摘要、作者、venue、开放获取信息、引用计量、主题分类和引文关系。
  论文全文或引用内容只在后续筛选确实需要时获取，控制 token、延迟和 API 次数。
- **候选排序**：先用确定性的过滤、去重和 BM25 等低成本步骤缩小候选集，再使用
  embedding 或模型判别做精排。不同来源的分数不可直接比较时使用名次融合，
  并保留来源分数和排序依据。
- **扩展**：围绕高置信候选进行 references/citations/related works 扩展；扩展深度、
  扇出、并发和总候选数必须有界。

Search Service 必须满足以下横切约束：

- 所有网络调用有超时、有界重试、速率限制和明确失败分类；
- 每个入口显式接收 `end_date`，不得召回评测时间边界之后的论文；
- 记录来源、查询、命中数、耗时、缓存命中、API 调用数、Token 和费用；
- 跨源合并后只向 Agent 返回统一的 Paper schema，避免 Agent 自己重复实现去重；
- 超过预算时停止当前策略并返回可解释的部分结果，不静默丢弃失败请求。

因此，Search Service 是“能力与约束”的边界；Main Search Agent 是“策略与解释”的边界。

## 4. Main Search Agent：查询到结果的主循环

Main Search Agent 的每一轮都遵循“规划 -> 工具调用 -> 观察 -> 更新上下文”的过程。
它可以保留完整的私有上下文和 reasoning，但这部分内容不属于 Reviewer 的输入：

```text
MainContext_t =
  MainContext_(t-1)
  + tool_observation_t
  + reviewer_advice_(t-1)
```

这里的关键设计不是“让同一个模型再想一次”，而是将生产上下文与审查上下文分离：

- Main Agent 知道自己为什么选择某个检索策略；
- Reviewer 只知道查询最终产生了什么状态、证据和结果；
- Reviewer 不读取 Main Agent 的完整历史上下文、thinking blocks 或隐藏推理；
- Main Agent 只接收 Reviewer 输出的结构化建议，不共享 Reviewer 的内部推理。

这样可以减少主模型推理对 Reviewer 的 anchoring，使 Reviewer 更像独立的证据审查器，
而不是同一上下文中的第二次自我反思。

典型流程：

1. 从 `RQ` 和 `NP` 提取研究主题、方法、数据集、领域、venue、时间和其他约束。
2. 对复杂问题做子查询分解和查询改写，形成若干互补的检索策略。
3. 调用 Search Service 进行多源召回、候选合并和初步筛选。
4. 根据候选质量、覆盖缺口和 Reviewer advice 调整下一轮查询、过滤条件或引文扩展方向。
5. 对候选论文做相关性、权威性、时效性和多样性权衡，生成排序列表。
6. 按查询意图组织摘要、证据和可选关系图，形成 `SO`。

### 4.1 面向 Reviewer 的可观察状态

Search Service 和运行时必须生成不依赖 Agent 私有推理的结构化状态：

```text
SearchState_t = {
  issued_queries,
  selected_sources,
  filters,
  candidate_counts,
  dedup_stats,
  ranking_summary,
  expansion_frontier,
  budget_spent,
  failures
}

EvidenceState_t = {
  papers,
  abstracts_or_snippets,
  citation_edges,
  bibliometric_fields,
  source_ids,
  evidence_ids,
  coverage_signals
}
```

`SearchState` 表示“系统做了什么以及消耗了什么”，`EvidenceState` 表示“系统找到了
什么以及证据质量如何”。Reviewer 只依据二者判断覆盖缺口、噪声、重复、来源失衡、
证据不足和停止时机。

循环终止条件由四部分共同决定：

```text
stop =
  agent_stop
  OR budget_exhausted
  OR max_iterations_reached
  OR marginal_recall_gain_too_low
```

预算和最大迭代次数由运行时强制执行，不能只依赖模型自行遵守。

## 5. Reviewer Agent：独立上下文的旁路审查

Reviewer Agent 是一个拥有独立 session、工具集、system prompt 和 append-only context
的受控 ReActLoop：

```text
Reviewer Agent = ReActLoop(ReviewContext + Review Tools)
ReviewContext_0 = ReviewerSystemPrompt + ReviewPacket_0
ReviewContext_t = ReviewContext_(t-1) + ReviewPacket_t + prior_advice_metadata
```

逻辑上每次审查使用当前完整状态；传输上只发送初始快照和状态增量，避免重复消耗
Reviewer context：

```text
ReviewTransport_0 = ReviewPacket_0
ReviewTransport_t = Delta(ReviewPacket_(t-1), ReviewPacket_t)
```
### 5.1 ReviewPacket：审查输入边界

`ReviewPacket` 是运行时从可观察状态构造的审查工件，不是 Main Agent transcript 的镜像：

```text
ReviewPacket_t = {
  original_query: RQ,
  runtime_constraints,
  preference_memory: PH,
  search_state: SearchState_t,
  evidence_state: EvidenceState_t,
  current_output?: SO,
  feedback?: GoldenAnswer | UserFeedback
}
```

ReviewPacket 可以包含 Main Agent 已发出的查询串、筛选参数、工具结果和最终答案，
但不能包含：

- Main Agent 的完整私有上下文；
- thinking blocks、chain-of-thought 或隐藏推理；
- 未经 Search Service 计算和归一的原始内部对象。

因此，Reviewer 的输入有明确的 epistemic boundary：

```text
Main Agent: knows why it searched
Reviewer:   knows what the search produced
```

过程审查只使用 `RQ + runtime_constraints + PH + SearchState + EvidenceState`；
结果比较再额外加入 `SO` 与 `GoldenAnswer` 或 `UserFeedback`。

### 5.2 Reviewer 的模型和角色配置

Reviewer 与 Main Agent 的模型配置相互独立：

```text
MainModel       = model_main
ReviewerModel   = model_reviewer
```

但**不同模型不是架构前提**。默认实验先使用相同模型，以隔离上下文/角色分离的收益；
随后再将 `model_reviewer` 替换为成本更低或能力不同的模型，测量 model diversity 的
额外收益。角色分离是必选设计，模型异构是可选实验因素。

### 5.3 Provide Advice：受控的过程建议

```text
PA(ReviewPacket_t, reviewer_context) -> Advice
```

Reviewer 检查查询是否覆盖关键约束、结果是否存在明显噪声、是否需要补充来源或引文
扩展、证据是否足够、当前策略是否接近预算上限，并输出结构化建议：

```text
Advice = {
  advice_id,
  priority: high | medium | low,
  action: refine_query | add_source | expand_citation | rerank | stop,
  target,
  instructions,
  evidence_ids,
  confidence,
  expected_effect,
  novelty_key
}
```

Advice 先经过运行时 gate，再通过事件/消息通道交给 Main Agent。gate 至少执行：

- `advice_id` 和 `novelty_key` 去重；
- 检查建议是否引用当前 `EvidenceState` 中存在的 `evidence_ids`；
- 检查建议是否突破来源、并发、API、Token 或墙钟预算；
- 检查同一 action 是否连续无效或重复出现；
- 限制每轮和每次运行的 Reviewer 调用次数。

Reviewer 不直接改写 Main Agent 上下文，也不绕过 Search Service 调用未预算的 API。
重复的 `Stop`、`Done`、`No issue` 等无行动建议必须被 gate 丢弃或合并，不能持续干扰
主循环。

Reviewer 不需要在每个 token 或每个普通事件上运行。推荐只在以下 checkpoint 触发：

1. 初始召回完成；
2. 一轮候选合并或引文扩展完成；
3. 检测到覆盖不足、噪声突增、来源失衡或预算接近上限；
4. 生成最终 `SO` 之前。

这同时控制 reviewer 的额外成本，并避免把“持续说话”误当成审查质量。

### 5.4 Compare Answer：结果比较与偏好更新

```text
CA(SO, GoldenAnswer | UserFeedback, ReviewPacket) -> PreferenceUpdate
```

该过程用于分析漏召回、误召回、排序偏差、展示偏好和关系图缺失。Reviewer 通过
`update_preference` 工具向 Preference Persistence 提交带理由、证据引用、版本和置信度
的更新，而不是直接写入存储。

## 6. Preference Persistence：跨请求偏好

Preference Persistence 同时存储两类偏好，但必须保持两条转换路径：

```text
NP + RQ  ------------> Search Input / Agent behavior
HP + P  -------------> Search Service configuration
PH ------------------> Reviewer ReviewPacket
```

- `NP` 影响查询理解、子查询分解、结果组织和回答风格；
- `HP` 影响检索源选择、时间窗、top-k、扩展策略、排序权重和预算分配；
- `PH` 作为审查上下文中的显式偏好记忆，用于判断结果是否符合用户长期偏好；
- `P` 提供默认值、允许范围和安全上限；
- Reviewer 的 `PreferenceUpdate` 必须经过 schema 校验、冲突合并和版本化；
- 当前请求读取的 `RunSnapshot` 保持不变，更新后的 `PH_(t+1)` 用于后续请求。

这样既能利用用户反馈持续优化，又不会因一次异常反馈把当前或所有后续请求的检索行为
无界改变。

## 7. 端到端结构示意图

```text
+----------------------+       +----------------------+
| User / Benchmark     |       | Preference Store     |
| RQ / feedback/golden |       | PH = NP + HP         |
+----------+-----------+       +----------+-----------+
           | RQ                           | read PH
           +---------------+--------------+
                           v
                 +---------+----------+
                 | RunSnapshot        |
                 | SI = RQ + NP + ... |
                 | ST = Service(HP,P) |
                 +---------+----------+
                           |
                           v
                 +---------+----------+
                 | Main Search Agent  |
                 | private context X  |
                 | reasoning hidden   |
                 +---------+----------+
                           | tool calls
                           v
                 +---------+----------+
                 | Search Service     |
                 | recall / merge     |
                 | enrich / rerank    |
                 | expand / budget    |
                 +---------+----------+
                           | observable state + SO
                           v
                 +---------+----------+
                 | ReviewPacket       |
                 | RQ + PH            |
                 | SearchState       |
                 | EvidenceState + SO |
                 | no thinking X      |
                 +---------+----------+
                           |
                           v
                 +---------+----------+
                 | Reviewer Agent     |
                 | independent context|
                 | PA / CA            |
                 +----+-----------+---+
                      |           |
                Advice|           | PreferenceUpdate
                      v           v
             Main next turn   Preference Store
```

图中的关键数据流是：

```text
RQ + read(PH) -> RunSnapshot -> Main Search Agent
Main Agent -> Search Service -> SearchState / EvidenceState
observable state + SO -> ReviewPacket -> independent Reviewer
Reviewer -> gated Advice -> next Main turn
Reviewer -> validated PreferenceUpdate -> PH_(next run)
```

图中的 `private context` 只属于 Main Agent；运行时只把 Main Agent 已发出的查询、工具参数、
工具结果和阶段性输出等可观察 artifact 合并进 `ReviewPacket`，不传递隐藏推理。
Reviewer 通过 `ReviewPacket` 获得独立、可审计、可复现的输入；`SO` 既是最终输出，
也是结果比较阶段的审查工件。

## 8. 边界、可观测性与实现原则

1. **上下文隔离是核心机制**：Reviewer 默认只看 `ReviewPacket`，不看 Main Agent 的完整
   reasoning；不能用“复制主上下文后再调用另一个模型”冒充 cross-context review。
2. **角色分离优先于模型异构**：先验证同模型、独立上下文的收益，再评估便宜 Reviewer
   或不同模型带来的额外收益。
3. **Reviewer 是受控旁路控制器**：只在 checkpoint 触发，Advice 必须经过 gate，不能
   成为持续输出、重复建议或无界调用 API 的第二个主搜索器。
4. **Agent 与 Service 解耦**：模型只决定检索策略和参数；网络访问、去重、排序基础算子、
   状态构造、预算检查和记账由 Service/运行时负责。
5. **偏好不是隐式记忆**：所有偏好都要有 schema、版本、来源、置信度和生效范围。
6. **结果不是纯文本**：论文列表、证据、关系图、失败项和运行元数据都应能机器读取。
7. **成本是控制流的一部分**：在运行前估计并在运行中强制限制模型调用、API 调用、
   Reviewer 调用、并发、候选规模和墙钟时间；缓存命中与冷启动分别统计。
8. **评测可复现**：记录 query ID、`end_date`、偏好版本、模型/Provider 版本、预算、
   原始事件、`ReviewPacket`、Advice gate 结果和最终 `SO`，使 Precision、Recall、F1、
   延迟、调用数和 Token 可复核。

## 9. Reviewer 价值的验证假设与消融

新增设计的核心假设不是“多一个模型一定更好”，而是：

```text
Reviewer gain
  = context separation gain
  + role asymmetry gain
  + optional model diversity gain
  - extra compute / noise
```

Cross-context review 的已有结果和关于 OMP Advisor 的工程反馈只能作为设计依据，
不能直接当作本项目上的结论。尤其需要警惕 Reviewer 额外调用带来的纯算力收益、
浅层误判、重复 advice 和错误的 Stop 建议。

因此固定以下消融组：

```text
A. Main only
   baseline

B. Main + self-reflection
   same model / same context

C. Main + Reviewer
   same model / separate context

D. Main + Reviewer
   different model / separate context

E. Main + Reviewer
   separate context + Preference Memory
```

在相同 query、候选日期边界、最大预算、停止条件和输出 schema 下比较：

- Precision、Recall、F1；
- 端到端延迟、Main/Reviewer 模型调用数、API 调用数、输入/输出 Token；
- Advice 接受率、重复率、无效率、触发后候选增益；
- Reviewer 触发次数、预算超限率和失败请求数；
- 缓存命中与冷启动结果。

结果只在 `C-A`、`D-C`、`E-D` 等差异上解释对应机制，不能把 D 或 E 的绝对分数
直接归因于上下文隔离。若 Reviewer 的收益不超过额外成本或重复建议显著增加，
默认退化为较少 checkpoint 或 Main-only，而不是强制保留 Reviewer。

相关依据和限制：

- OMP Advisor 的实现说明其拥有独立 Agent、ToolSession、context 和 system prompt：
  <https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md>
- OMP 社区已有关于默认传入 thinking blocks 的配置讨论：
  <https://github.com/can1357/oh-my-pi/issues/8071>
- OMP 曾出现重复 advice 刷屏问题，说明 Reviewer 必须有去重、gate 和停止条件：
  <https://github.com/can1357/oh-my-pi/issues/3520>
- Self-correction、Cross-Context Review 和独立 critique model 的论文证据支持“隔离优先、
  异构可选”的假设，但其数据集、任务和样本规模不等同于本项目：
  <https://arxiv.org/abs/2310.01798>
  <https://arxiv.org/html/2603.12123v1>
  <https://arxiv.org/html/2509.20502v2>
  <https://arxiv.org/abs/2411.16579>

该版本保留原设想中的四个核心实体，同时将 Reviewer 从“读取主轨迹的旁路 Agent”
收紧为“读取 Search/Evidence State 的独立上下文审查器”，并把 Reviewer 的有效性、
成本和噪声纳入可验证的实验设计。

![架构图](./assets/figure1.png)