# Benchmark-Optimized Preference Reviewer for Agentic Literature Search

> 研究设计草案 / Discussion Synthesis  
> 项目：Agentic Search  
> 日期：2026-08-19  
> 状态：用于后续论文精读、系统实现与实验设计；并非定稿论文陈述

---

## 文档地图

本项目的设计文档分三层，职责不重叠：

| 文档 | 角色 | 回答的问题 |
| --- | --- | --- |
| 本文 `agentic_search_preference_reviewer_research_design.md` | **研究理念** | 这个架构在什么意义上不可约简？benchmark 信号如何变成可解释、可迁移的检索偏好？如何用实验而非概念论证来证明？ |
| `design.md` | **设计主文档** | 系统由哪些模块组成，数据契约、上下文边界、两个时间尺度上的控制流是什么？ |
| `search-service.md` | **子系统设计** | 检索能力层如何聚合多源，如何构造可被训练和持续改进的 rerank？ |

冲突时的裁决顺序：研究主张以本文为准，系统契约以 `design.md` 为准，检索实现细节以 `search-service.md` 为准。

本文的符号侧重"学习"，`design.md` 的符号侧重"运行"，对应关系如下：

| 本文 | `design.md` | 说明 |
| --- | --- | --- |
| $M_t$、$M_B^*$ | $PH_k$ | Preference Memory / Preference State。本文按训练样本步 $t$ 与 benchmark $B$ 计版本，`design.md` 按 episode 计版本 $k$ |
| $\tau_t$ | $\bar{\tau}_t$ | Reviewer 可见的轨迹。`design.md` 显式强调它是**公开**轨迹，不含 $C_t^M$ |
| $C_t^M$、$C_t^R$ | $C^M_t$、$C^R_t$ | 一致，context asymmetry 是同一条设计约束 |
| $\hat y_t$ | $SO$ | Agent 的最终输出 |
| $r_t$ | — | reward。`design.md` 只保留其可观测的对应物：Precision / Recall / F1 与预算计数 |

---

## 0. 文档目的与证据标记

本文系统整理目前围绕以下研究方向形成的讨论：

> 在不更新 LLM 参数的前提下，利用 benchmark 训练集持续学习检索偏好；由一个拥有独立上下文和持久化偏好状态的旁路 Reviewer，在线修正 Main Search Agent 的检索策略，并将经过验证的经验写回 Preference Memory。

本文重点回答六个问题：

1. 什么是 tool-reducible、skill-reducible 与 architecture-irreducible？
2. 为什么 Main Agent、Reviewer 与 Persistent Preference State 可能构成一种最小不可约架构？
3. Benchmark 信号如何转化为可解释、可更新、可迁移的检索偏好？
4. 系统从用户输入到最终检索结果、再到经验写回的完整生命周期是什么？
5. Ai2 Paper Finder、SPAR、PaperQA2、PaSa 等 baseline 在什么意义上可被约简？
6. 应该如何通过实验和消融验证“架构必要性”，而不是仅凭概念论证？

为避免把讨论中的推测误写成文献事实，全文使用以下标记：

| 标记 | 含义 |
|---|---|
| **[Core]** | 当前设计的核心命题或明确采用的定义 |
| **[Hypothesis]** | 有理论动机、但仍需实验验证的研究假设 |
| **[Literature-TBV]** | 需通过论文精读核对的文献性判断 |
| **[Experiment-TBV]** | 需通过实现、实验或消融验证的判断 |
| **[Risk]** | 已识别的失败模式、混杂因素或审稿风险 |

---

## 1. 一页摘要

### 1.1 核心问题

现有学术检索 Agent 往往采用以下一种或多种方式：

- 固定或半固定 workflow；
- 多个职责明确的 LLM worker / sub-agent；
- 单一 Agent 内部的多轮搜索；
- 通过监督学习或强化学习把 benchmark 经验写入模型参数；
- 用静态 prompt 或 skill 规定搜索协议。

本项目试图研究另一条路径：

> **冻结模型参数，把 benchmark 反馈写入外部的、结构化的、可解释的 Persistent Preference Memory；由独立 Reviewer 根据当前检索轨迹读取该状态、提出策略级建议，并在训练阶段聚合新的经验。**

### 1.2 最小系统骨架

系统只保留两个具有 Agent 身份的主体：

1. **Main Search Agent**：理解用户意图，编排搜索工具和无状态 worker，维护当前任务轨迹，并作出搜索、扩展、排序和停止决策。
2. **Preference Reviewer**：在独立上下文中观察轨迹摘要和检索统计，结合持久化偏好，对 Main 的 search policy 进行旁路批评与校正；训练时还负责提出、验证和聚合新的 preference update。

其他可以约简的能力尽可能降为 tool 或 worker：

- Search API → Tool
- Citation expansion → Tool
- Deduplication → Tool
- Metadata extraction → Tool
- Query parsing → Stateless worker
- Relevance judgement → Stateless worker
- Candidate reranking → Tool / worker

### 1.3 核心研究主张

**[Core]** 本项目不是通过“增加更多 Agent”来体现 agentic，而是通过架构消元寻找最小不可约部分：

$$
\boxed{\text{Main Agent} + \text{Reviewer Agent} + \text{Persistent Preference State}}
$$

**[Hypothesis]** 如果 Reviewer 具备以下性质，单一 tool、静态 skill 或同上下文 self-critique 将无法在保持相同行为和学习能力的前提下等价替代它：

1. **Context asymmetry**：$C_t^M \neq C_t^R$
2. **Persistent state dependence**：未来决策依赖跨样本演化的 $M_t$
3. **Cross-step feedback**：Reviewer 建议改变后续 action，而非只判断最终输出
4. **Independent update lifecycle**：Reviewer 状态的读取、写入、冻结和迁移具有独立生命周期

### 1.4 Benchmark 学习主线

单 benchmark：

$$
B_{train} \rightarrow M_B^* \rightarrow B_{heldout}
$$

多 benchmark：

$$
B_1+B_2+\cdots+B_k
\rightarrow \text{consolidation}
\rightarrow M_G
\rightarrow B_{unseen}
$$

目标不是记住某个 benchmark 的答案模式，而是从不同 benchmark 中抽象出可迁移的 search policy prior。

---

## 2. 研究定位：Benchmark 不只评测 Agent，也塑造 Agent

### 2.1 基本观察

Benchmark 的 gold result、评分函数和 query distribution 隐含定义了“什么是好的检索行为”。例如：

- 强调 exhaustive recall，还是精简 precision；
- 偏好 literal constraint satisfaction，还是语义相关性；
- 偏好 canonical / seminal work，还是 latest progress；
- 对 overview query，是奖励大量相关论文，还是少量高导航价值入口；
- 是否惩罚同一研究 cluster 的重复结果；
- 是否奖励 citation coverage、来源权威性、时间优先性或多样性。

传统模型训练把这些信号写入参数：

$$
\theta_{t+1}=\operatorname{Update}(\theta_t,D_{train})
$$

本项目则保持：

$$
\theta_{LLM}^{t+1}=\theta_{LLM}^{t}
$$

只更新外部偏好状态：

$$
M_{t+1}=U(M_t,\tau_t,y_t,\hat y_t,r_t)
$$

其中：

- $M_t$：第 $t$ 步的 Preference Memory；
- $\tau_t$：完整或压缩后的搜索轨迹；
- $y_t$：gold result；
- $\hat y_t$：Agent 输出；
- $r_t$：F1、NDCG、Recall@K 或复合 reward。

因此，虽然 LLM 参数不变，Agent policy 仍可变化：

$$
\pi(a\mid q,H,M_{t+1}) \neq \pi(a\mid q,H,M_t)
$$

可将这一点概括为：

> **Optimize the agent without training the model.**

### 2.2 研究问题

**RQ1 — In-benchmark adaptation**  
仅使用一个 benchmark 的训练划分学习 $M_B$，能否在 held-out 划分上稳定提升？

**RQ2 — Cross-benchmark transfer**  
在多个 benchmark 上学习并聚合偏好后，能否在未见 benchmark 上实现正迁移？

**RQ3 — Architectural necessity**  
相较于 tool、静态 skill、single-agent self-reflection 和 fixed workflow，独立 Reviewer 是否带来不能由等算力替代的增益？

**RQ4 — Preference representation**  
Rule、weight、example 三类记忆分别承担什么作用？混合形式是否优于任一单一形式？

**RQ5 — Generalization vs benchmark hacking**  
什么样的 abstraction / consolidation 机制能把样本级经验提升为可迁移策略，而不是过拟合 gold pattern？

---

## 3. 可约简性术语与操作性定义

### 3.1 Context 的分解

把任一模块在时间 $t$ 可用的信息写成：

$$
C_t=(X_t,H_t,M_t)
$$

其中：

- $X_t$：当前显式输入；
- $H_t$：当前 session 的 trajectory / history；
- $M_t$：跨 step、跨 query 或跨 session 保持的 persistent state。

不能只问“模块是否用了 LLM”或“内部是否有多个 Agent”；真正的问题是：

> 如果改变模块边界、角色名称或实现方式，是否仍能保留相同的信息条件、状态演化和外部行为？

### 3.2 Tool-reducible

若模块的关键行为可写为：

$$
y=f(x)
$$

或随机版本：

$$
P(y\mid x)
$$

并且一次调用的显式输入已构成充分统计量，则称其为 **Tool-reducible**。

操作性判据：

> 将完成本次调用所需信息全部显式传入后，历史上下文与独立长期状态是否还提供不可替代的信息？

典型例子：

- `search(query)`
- `deduplicate(papers)`
- `extract_constraints(query)`
- `judge_relevance(query, paper)`
- `expand_citations(seed_paper)`

内部复杂、含多次 LLM call，甚至内部有多个 worker，都不自动否定 tool-reducibility。

### 3.3 Skill-reducible

Skill 更像对宿主 Agent policy 的临时条件化：

$$
\pi'(a\mid H)=\pi(a\mid H,I_{skill})
$$

若给单个 Main Agent 充分的 instruction、scripts 与当前完整 context，就能保留原系统的关键行为，则称其为 **Skill-reducible**。

例如：

> 先识别 query intent，再决定 keyword search、citation expansion 或 author expansion；每轮后检查 coverage；最后进行多样性重排。

这是一套跨 trajectory 的 protocol，不一定适合一次函数调用，但可以写入静态 skill，并不天然要求第二个有独立状态和信息边界的主体。

### 3.4 Architecture-irreducible

若系统必须维护独立状态、独立上下文或独立生命周期，且这些因素改变未来行为，则称其具有 **Architectural Irreducibility**。

设独立状态为 $S_t$：

$$
S_{t+1}=U(S_t,O_t)
$$

未来 action 为：

$$
a_t\sim\pi(a\mid H_t,S_t)
$$

若：

$$
P(a_t\mid H_t,S_t)\neq P(a_t\mid H_t)
$$

即使 Main 已获得完整 session history，独立状态仍提供新的决策信息，则该状态不是普通静态 skill 的同义替代。

### 3.5 三层退化测试

| 测试 | 问题 | 若答案为“能” | 若答案为“不能” |
|---|---|---|---|
| Tool reduction | 将必要信息塞进一次函数调用，能否保持关键行为？ | Tool-reducible | 进入下一层 |
| Skill reduction | 给同一 Main Agent 足够详细的静态指令、脚本和当前上下文，能否等价完成？ | Skill-reducible | 进入下一层 |
| State/context reduction | 是否必须保留独立状态、信息边界或跨 session 更新过程？ | Architecture-irreducible 的候选 | 说明尚未建立不可约性 |

### 3.6 一个必要的边界澄清

任何复杂系统都可以在外部接口层被包装成：

```text
agentic_search(query, persistent_state) -> result
```

但：

> **Externally composable as a tool ≠ internally reducible to a tool.**

“能作为工具被另一个 Agent 调用”只描述外部组合性；内部可约简性要求证明：去掉内部独立主体或状态后，系统仍能保持同等能力。

---

## 4. 总体架构：Preference-Optimized Dual-Context Search

### 4.1 图例

```text
Legend
────────────────────────────────────────────────────────────────────
[ A ]     = Stateful Agent / 独立上下文与决策循环
( T )     = Stateless Tool or Worker / 无独立持久状态
{ M }     = Persistent Memory / 可跨样本更新的状态
 ───→     = Main execution path / 主执行路径
 ···→     = Side-channel observation or advice / 旁路观察或建议
 ═══→     = Validated persistent update / 持久状态写回
[X]       = Intentionally unavailable / 有意隔离的信息
────────────────────────────────────────────────────────────────────
```

### 4.2 在线检索生命周期

```text
                         ┌─────────────────────┐
                         │      User Query     │
                         └──────────┬──────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────┐
                 │        [ MAIN SEARCH AGENT ]        │
                 │                                     │
                 │ Context C_M                         │
                 │ - original query                    │
                 │ - active intent hypothesis          │
                 │ - current trajectory                │
                 │ - candidates and evidence           │
                 │ - Reviewer advice                   │
                 │                                     │
                 │ Decide: search / expand / rerank /  │
                 │         inspect / revise / stop      │
                 └────────┬───────────┬────────────────┘
                          │           │ actions
                          ▼           ▼
                 ┌─────────────┐  ┌────────────────────┐
                 │ ( SEARCH )  │  │ ( STATELESS       │
                 │ APIs/tools  │  │   WORKERS )       │
                 │             │  │ query parse       │
                 │ keyword     │  │ relevance judge   │
                 │ citation    │  │ metadata extract  │
                 │ author      │  │ clustering        │
                 │ graph       │  │ reranking         │
                 └──────┬──────┘  └─────────┬──────────┘
                        │                   │
                        └─────────┬─────────┘
                                  ▼
                       Search Observation O_t
                                  │
                  ┌───────────────┴────────────────┐
                  │                                ·
                  ▼                                · observe summary,
          Main updates H_t                         · candidates, stats
          and continues                            ·
                                                   ▼
                    ╔══════════════════════════════════════════════╗
                    ║         [ PREFERENCE REVIEWER ]              ║
                    ║                                              ║
                    ║ Independent Context C_R                      ║
                    ║ - query and intent hypothesis                ║
                    ║ - trajectory summary                         ║
                    ║ - candidates / coverage / diversity stats    ║
                    ║ - active Preference Memory slice             ║
                    ║ - benchmark mode when training               ║
                    ║                                              ║
                    ║ [X] Main private chain of thought             ║
                    ║                                              ║
                    ║ Critique: strategy, bias, missing coverage,  ║
                    ║           constraint failure, stop decision  ║
                    ╚══════════════╤══════════════╤════════════════╝
                                   · advice         ║ validated update
                                   ▼                ║ (training only)
                           [ MAIN SEARCH AGENT ]     ║
                                                    ▼
                       ┌────────────────────────────────────────┐
                       │ { PERSISTENT PREFERENCE MEMORY M }     │
                       │ global / intent / benchmark / episode  │
                       │ rules / weights / exemplars / evidence │
                       └────────────────────────────────────────┘

                 Main decides STOP after one or more loops
                                  │
                                  ▼
                       ┌────────────────────────┐
                       │ Final ranked paper set │
                       │ + traceable evidence   │
                       └────────────────────────┘
```

### 4.3 为什么 Preference 不应直接等同于 Main Prompt

容易退化的设计：

```text
Persistent Preference -> append to prompt -> Main Agent
```

这会令 Preference 更像一份动态变长的 skill，难以证明 Reviewer 的独立必要性。

当前更合适的设计是：

```text
Persistent Preference
          │
          ▼
Independent Reviewer
          │  select + interpret + contextualize
          ▼
Trajectory-specific advice
          │
          ▼
Main Agent's next decision
```

Reviewer 不只“读取规则”，还要完成：

1. 从大规模 memory 中选择当前 query / intent 相关的 slice；
2. 将统计偏好翻译为当前轨迹可执行的建议；
3. 识别当前搜索的 failure pattern；
4. 判断建议是否应在下一步执行，还是继续观察；
5. 训练阶段把 reward 差异归因到可复用的 preference candidate。

**[Hypothesis]** 只有当 Reviewer 实际承担这些依赖独立上下文和状态的职责时，双 Agent 架构才可能通过 skill-reduction test。

---

## 5. 两个主体的明确职责与信息边界

### 5.1 Main Search Agent

Main 的目标是完成当前用户任务，而不是学习 benchmark：

$$
a_t^M \sim \pi_M(a\mid C_t^M, advice_t)
$$

核心职责：

- 解析和修正 query intent；
- 选择检索源与检索动作；
- 调度 keyword、citation、author、venue、graph 等搜索；
- 组织候选集、证据和当前假设；
- 根据 Reviewer 建议调整 query、探索方向与候选排序；
- 决定是否停止以及返回多少结果；
- 生成最终结构化输出。

Main 应持有：

- 当前用户原始需求；
- 当前任务的完整交互历史；
- 当前候选和证据；
- 当前使用过的 tool action；
- Reviewer 返回的显式建议。

### 5.2 Preference Reviewer

Reviewer 的目标是修正 search policy，而不是替 Main 完成检索：

$$
advice_t,\Delta M_t \sim \pi_R(C_t^R,M_t)
$$

在线职责：

- 审查 query intent 与当前搜索策略是否匹配；
- 检测遗漏约束、结果同质化、citation cluster 偏置；
- 识别 recall / precision / novelty / authority / recency 的失衡；
- 对下一轮动作提出有限、可执行、可归因的建议；
- 质疑过早停止或无效的继续搜索；
- 记录建议是否被 Main 采纳及其后果。

训练职责：

- 比较 $\hat y$ 与 gold $y$；
- 分析哪类策略导致 reward 改善或恶化；
- 生成 candidate lesson；
- 将 sample-specific observation 抽象为 intent-conditioned preference；
- 合并重复或冲突规则；
- 维护置信度、适用范围、证据计数与版本；
- 在 train 结束后冻结 memory 供 held-out 评估。

### 5.3 有意设计的 Context Asymmetry

建议初始设定：

| 信息 | Main | Reviewer | 设计理由 |
|---|---:|---:|---|
| 原始 query | ✓ | ✓ | 两者都需理解目标 |
| 当前候选与证据 | ✓ | ✓ | Reviewer 需检查 coverage 与偏置 |
| 完整 tool trace | ✓ | 摘要 | 降低噪声，形成不同视角 |
| Main 私有推理 | ✓ | ✗ | 避免 Reviewer 只复述 Main 的解释 |
| 聚合检索统计 | 可选 | ✓ | 让 Reviewer 看到跨轮结构性信号 |
| Persistent Preference Memory | ✗ 或有限 | ✓ | 保持 preference 的独立解释层 |
| Reviewer 建议 | ✓ | ✓ | 构成显式反馈通道 |
| Benchmark gold | ✗ | 仅训练后评估阶段 | 防止 Main 直接泄漏答案 |

这里的 context asymmetry 不是 token 限制导致的偶然差异，而是架构协议的一部分。

### 5.4 Reviewer 不应做什么

为了保持职责可辨识，Reviewer 不应：

- 直接调用所有检索工具并另做一套完整搜索；
- 直接生成最终 paper list 覆盖 Main；
- 只做逐篇 relevance binary classification；
- 读取 Main 的全部私有推理后简单同意或改写；
- 每一轮都无条件写入 memory；
- 把 benchmark ID 当作唯一的策略选择依据；
- **修改系统实现，或扩展自己的工具集**。

最后一条是动作空间有界性的前提。一旦 Reviewer 能够改写检索实现或自行定义新工具，
其动作空间由有限变为开放：无法枚举、无法 gate、无法版本化，
也无法在 held-out 阶段冻结，消融组之间的差异将混入实现变更的效应而不再可解释。
系统实现的演进属于离线工程流程，由人与脚本承担，不建模为本架构的一部分。

否则 Reviewer 容易分别退化为第二个 Main、relevance worker、self-reflection prompt 或 benchmark lookup table。

---

## 6. Preference Memory 的结构设计

### 6.1 四层语义结构

$$
M=(M_{global},M_{benchmark},M_{intent},M_{episode})
$$

#### Global preference

跨多个 benchmark 和 intent 反复成立的检索原则。例如：

- 明确约束必须满足；
- 候选反复来自同一 cluster 时边际收益下降；
- 缺乏来源或证据的高分候选需要降权；
- 停止判断要同时考虑新增收益和未覆盖约束。

#### Benchmark-specific preference

某个 benchmark distribution、gold construction 或 metric 特有的偏好。例如：

- gold set 通常更精简或更 exhaustive；
- 对 canonical paper 或 exact title match 权重更高；
- 某类 query 中 precision 对最终分数更敏感。

这一层只能在训练与同分布 held-out 中显式启用；跨 benchmark 测试时应禁用或通过 distribution match 谨慎路由。

#### Intent-conditioned preference

按查询意图组织的可迁移策略，是本项目最重要的泛化层：

| Intent | 主要偏好 |
|---|---|
| `field_overview` | representativeness、coverage、navigation hub、survey value |
| `latest_progress` | recency、frontier relevance、时间过滤 |
| `origin_of_method` | temporal priority、citation ancestry、术语演化 |
| `papers_using_dataset_X` | exact constraint satisfaction、dataset evidence |
| `alternative_to_method_X` | conceptual distance、diversity、functional equivalence |
| `seminal_work` | historical centrality、influence、field recognition |
| `comprehensive_list` | recall、query expansion、cluster coverage |

#### Episodic preference

保存高信息量的成功或失败经验，不保存答案本身：

```yaml
pattern: "field overview query"
context_signature:
  intent: field_overview
  early_result_shape: many_individually_relevant_papers
failure:
  action: continued_keyword_search
  consequence: redundant_cluster_and_low_navigation_value
better_behavior:
  action: survey_or_citation_hub_search
lesson:
  rule: prefer_representative_navigation_nodes_over_result_count
evidence:
  benchmark: B1
  sample_ids: [train_021, train_087]
  observed_delta_f1: 0.11
confidence: 0.74
```

### 6.2 三种记忆表示

建议采用 rule + weight + example 的混合形式：

#### Rule

用于可解释的条件—动作约束：

```text
IF intent=field_overview
AND cluster_concentration>0.7
THEN increase hub_search priority
```

优点：可审查、可消融、可直接生成 advice。  
风险：规则冲突、阈值脆弱、抽象过度。

#### Weight

用于连续排序或策略打分：

$$
U(p\mid q,i)=
w_rR+w_cC+w_tT+w_aA+w_dD+w_hH
$$

可能特征：

- $R$：semantic relevance
- $C$：constraint satisfaction
- $T$：temporal fit / recency
- $A$：authority / citation impact
- $D$：diversity contribution
- $H$：hub / navigation value

权重应由 intent 与 benchmark condition 控制，而不是全局固定。

#### Example

保存最典型的 trajectory fragment 与 lesson，供相似情形检索：

- 成功策略范例；
- 失败模式；
- Reviewer 曾给出的有效建议；
- 相同规则在不同 benchmark 上相反的案例。

优点：保留上下文和例外。  
风险：变成 nearest-example imitation 或泄漏训练答案。

### 6.3 推荐的存储字段

```yaml
preference_id: pref_000123
scope:
  level: global | benchmark | intent | episode
  benchmark_ids: []
  intents: []
condition:
  query_features: {}
  trajectory_features: {}
  candidate_set_features: {}
recommendation:
  action_type: search | expand | rerank | inspect | stop
  target: null
  rationale: ""
effect:
  metric: f1
  estimated_delta: 0.0
evidence:
  support_count: 0
  contradict_count: 0
  sample_refs: []
confidence: 0.0
status: candidate | active | deprecated | quarantined
created_at: ""
updated_at: ""
version: 1
```

### 6.4 信息计量学信号的位置

H-index、citation coupling、co-citation、local citation graph 等指标不应直接等同于 preference；它们更适合作为：

1. Reviewer 可观察的 candidate / graph features；
2. rule condition 的输入；
3. ranking utility 的特征；
4. 本地索引扩展和搜索动作选择的依据。

例如：

$$
HubScore(p)=
\alpha\cdot LocalCitationCentrality(p)
+\beta\cdot ReferenceCoverage(p)
+\gamma\cdot CoCitationBreadth(p)
$$

但 Reviewer 学到的应是：

> 在什么 intent、什么 trajectory shape 下，提高或降低这些信号的权重。

而不是无条件认为高 citation 或高 h-index 等于高 relevance。

---

## 7. Benchmark Optimization 生命周期

### 7.1 Train / held-out 协议

```text
                   BENCHMARK DATASET B
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
            70% TRAIN              30% HELD-OUT
                 │                     │
                 │ sequential          │ memory frozen
                 ▼                     │
       query_i + hidden gold_i         │
                 │                     │
                 ▼                     │
      Main ↔ Search Tools              │
        ·          ·                   │
        · observe  ·                   │
        ▼          ·                   │
      Reviewer + M_t                   │
        │ advice                       │
        ▼                              │
      result_i + trajectory_i          │
                 │                     │
                 ▼                     │
       score against gold_i            │
                 │                     │
                 ▼                     │
      failure/success attribution      │
                 │                     │
                 ▼                     │
       candidate preference ΔM         │
                 │                     │
                 ▼                     │
       abstract / validate / merge     │
                 ║                     │
                 ▼                     │
               M_{t+1}                 │
                 │                     │
                 └── next train item   │
                                       │
                           after train: freeze M_B*
                                       │
                                       ▼
                         evaluate held-out once
```

### 7.2 更新不是“看见错误就写规则”

推荐更新管线：

```text
training example
      │
      ▼
trajectory + output + gold + metric
      │
      ▼
counterfactual failure/success analysis
      │
      ▼
candidate lesson
      │
      ▼
scope estimation
(episode / intent / benchmark / global)
      │
      ▼
support and conflict check
      │
      ▼
activate, merge, quarantine, or reject
      │
      ║
      ▼
Preference Memory
```

关键保护机制：

- 最低支持样本数；
- validation buffer 或滚动验证；
- contradictory evidence counter；
- rule TTL / decay；
- 每条 preference 的 provenance；
- memory versioning；
- held-out 阶段禁止更新；
- gold title、paper ID 等答案实体禁止进入通用 rule；
- 对 benchmark-specific rule 限定激活范围。

### 7.3 动作空间：在线建议与离线提案

Reviewer 的动作必须落入**有限且可枚举**的集合，便于归因，也便于 gate。
这条约束覆盖两个时间尺度：episode 内的在线建议（尺度 $t$），
以及拿到反馈之后的离线提案（尺度 $k$）。

#### 在线动作（尺度 $t$）

```text
CONTINUE_CURRENT_STRATEGY
REFORMULATE_QUERY
SWITCH_SEARCH_MODE
EXPAND_CITATION_GRAPH
EXPAND_AUTHOR_OR_VENUE
SEARCH_FOR_SURVEY_OR_HUB
CHECK_EXACT_CONSTRAINT
INCREASE_RESULT_DIVERSITY
REWEIGHT_CANDIDATES
INSPECT_SUPPORTING_EVIDENCE
DEFER_STOP
RECOMMEND_STOP
```

每条 advice 至少包含：

```yaml
action: SEARCH_FOR_SURVEY_OR_HUB
trigger: high_cluster_concentration_and_overview_intent
rationale: current_count_does_not_imply_reference_coverage
expected_effect: improve_recall_with_fewer_redundant_candidates
confidence: 0.78
memory_refs: [pref_000123]
```

#### 离线提案（尺度 $k$）

只在取得可验证反馈 $F$ 之后解锁。Reviewer 不直接写入任何持久状态，
而是调用一组**类型化的更新工具**提交提案：

```text
PROPOSE_PREFERENCE_UPDATE     修改结构化偏好参数
PROPOSE_JUDGE_CRITERIA_EDIT   修改判别标准的自然语言表述
REQUEST_PARAMETER_SEARCH      在指定子空间上重新求解参数
REQUEST_ABLATION              请求一次消融，产出报告而非配置变更
REBIND_INTENT_PROFILE         修改意图到参数组的绑定
SET_JUDGEMENT_POLICY          调整判别的档位与触发条件
```

三条约束使离线通道与在线通道同构：

1. **工具返回提案与验证结果，而不是"已生效"**。所有提案统一经过
   $\theta_{k+1}=\operatorname{ValidateOptimize}(\theta_k,\mathrm{Proposal}_R,D_{\mathrm{train}})$，
   验证不通过即拒绝，Reviewer 不能覆盖。
2. **必须携带 evidence 与 hypothesis**，evidence 需引用轨迹、输出或反馈中真实存在的标识符。
3. **held-out 阶段这些工具不注册进 $T^R$**——不是调用后无效，而是根本不可见。
   这比"冻结 memory"更硬，杜绝绕过冻结协议的通道。

`REQUEST_PARAMETER_SEARCH` 的语义需要特别精确：Reviewer 提交的是
**搜索子空间与目标函数偏置**，不是参数数值。它具备语义层面的归因能力
（判断某类查询上某个信号方向有害），不具备数值求解能力（不知道具体应取何值）。
让它出子空间、由优化器求解、由验证器决定是否持久化，能力边界与职责边界因此对齐。

### 7.4 Demo 级训练伪代码

```python
memory = initialize_memory()

for example in benchmark_train:
    trajectory = []
    state = main.initialize(example.query)

    while not state.stop:
        action = main.decide(state, last_reviewer_advice)
        observation = execute(action)
        state = main.update(state, observation)

        review_view = summarize_for_reviewer(
            query=example.query,
            state=state,
            trajectory=trajectory,
            retrieval_stats=compute_stats(state.candidates),
        )
        last_reviewer_advice = reviewer.advise(review_view, memory)
        trajectory.append((action, observation, last_reviewer_advice))

    prediction = main.finalize(state)
    reward = evaluate(prediction, example.gold)

    candidate_updates = reviewer.reflect(
        query=example.query,
        trajectory=trajectory,
        prediction=prediction,
        gold=example.gold,
        reward=reward,
        memory=memory,
    )
    memory = validate_and_consolidate(memory, candidate_updates)

frozen_memory = freeze(memory)
evaluate_once(benchmark_heldout, frozen_memory)
```

---

## 8. 从单 Benchmark 到通用 Search Policy Prior

### 8.1 单 benchmark 优化

$$
M_B^*=\arg\max_M
\mathbb E_{q\sim B_{train}}
[\operatorname{Score}(\pi(q;M))]
$$

held-out 测试：

$$
q\sim B_{test},\qquad \pi(q;M_B^*)
$$

这一步验证系统是否真的能从训练题获得可复用偏好，而不是只有在线 self-critique 能力。

### 8.2 多 benchmark 聚合不能直接相加

不同 benchmark 的“审美”可能冲突：

- A 偏 exhaustive retrieval；
- B 的 gold 很精简，precision 更重要；
- C 重 semantic relevance；
- D 偏 canonical / seminal papers；
- E 偏最新论文；
- F 只奖励满足全部显式约束的结果。

因此不能简单：

$$
M=M_1+M_2+M_3
$$

而应执行层级 consolidation：

```text
Bench A -> Preference A --┐
Bench B -> Preference B --+--> conflict detection
Bench C -> Preference C --┘          │
                                     ▼
                         scope-aware consolidation
                           │         │          │
                           ▼         ▼          ▼
                        Global     Intent    Benchmark-only
                         prior      prior       exceptions
                           └─────────┬──────────┘
                                     ▼
                              Unseen benchmark
```

### 8.3 理想的泛化路径

低层学习结果：

> “Benchmark A 的 overview query 常只有一个 gold paper，所以返回一个结果。”

这是 benchmark hack。

更高层抽象：

> “对于 overview intent，提高 representativeness、reference coverage 与 navigation value；不要把 result count 当作 coverage proxy。”

这是可迁移 preference。

**[Hypothesis]** intent-conditioned abstraction 是从 benchmark-specific optimization 走向 benchmark-agnostic policy prior 的关键。

---

## 9. Architecture Irreducibility 的理论论证

### 9.1 系统状态

完整系统状态写为：

$$
S_t=(C_t^M,C_t^R,M_t)
$$

其中：

$$
a_t^M\sim\pi_M(a\mid C_t^M,advice_t)
$$

$$
advice_t,\Delta M_t\sim\pi_R(C_t^R,M_t)
$$

且：

$$
C_t^M\neq C_t^R
$$

$$
M_{t+1}=U(M_t,\tau_t,r_t)
$$

系统行为因此依赖：

```text
query
+ current trajectory
+ Main state
+ Reviewer state
+ persistent preference
+ feedback history
```

而非仅仅：

```text
search(query)
```

### 9.2 三种不可压缩性质

#### 1. Context asymmetry

Reviewer 与 Main 拥有不同信息投影和 system objective：

$$
C_t^R=Proj_R(O_{1:t},M_t),\quad
C_t^M=Proj_M(q,H_t)
$$

它们的差异必须是设计性的，而非偶然的 token 截断。

#### 2. Persistent state dependence

同一个 query 和相同即时轨迹，在不同 preference version 下可能触发不同 advice：

$$
P(advice\mid q,\tau,M_i)\neq
P(advice\mid q,\tau,M_j)
$$

#### 3. Cross-step feedback

Reviewer 输出不是最终答案，而是改变未来决策：

$$
advice_t\rightarrow a_{t+1}^M\rightarrow O_{t+1}
\rightarrow advice_{t+1}
$$

系统形成闭环：

```text
Main -> Environment/Search -> Observation
 ^                              ·
 │                              ·
 └──────── Reviewer advice <····┘
```

### 9.3 最小性论证

架构设计原则：

```text
Agent component
      │ reduction test
      ▼
Can be stateless? ------ yes -----> Tool / Worker
      │ no
      ▼
Can be one static protocol? yes --> Skill
      │ no
      ▼
Requires independent context,
persistent state, and feedback ---> Agent / Architecture
```

经过消元后，只保留：

```text
Main search policy      -> Agent
Trajectory critic      -> Reviewer Agent
Persistent preference  -> Independent State
```

这构成 **Minimal Irreducible Multi-Agent Architecture** 的候选。

### 9.4 目前论证的限制

**[Risk]** 仅用符号说明 $C_M\neq C_R$ 并不能自动证明第二个 Agent 必要。一个足够强的单 Agent 也可能模拟两个角色。

因此最终主张应从绝对的“无法模拟”收敛为可实验检验的版本：

> 在相同模型、相近 token / tool-call budget 和相同可用外部信息下，显式双上下文、独立状态和旁路反馈是否比单上下文 prompt/skill 获得更稳定的泛化、校准和可控更新能力？

换言之，不应声称计算意义上的绝对不可模拟，而应证明：

- 结构删除会导致可测能力下降；
- 等预算 prompt 加长不能恢复；
- 下降与信息边界、状态持久性或 feedback timing 有明确对应；
- 独立状态提供更好的可解释性、迁移性或抗干扰性。

---

## 10. Baseline 的可约简性分析

> 本节是待论文精读验证的工作假设，不应在论文中未经引用直接写成事实。

### 10.1 总览

| Baseline | Tool-reducible | Skill-reducible | 架构不可约性 | 当前判断 |
|---|---:|---:|---:|---|
| Ai2 / Asta Paper Finder | 强 | 是 | 弱 | 复杂但偏 workflow |
| SPAR | 部分 | 强 | 大概率弱 | multi-agent 更像模块职责划分 |
| PaperQA2 | 部分 | 强 | 中等或弱 | specialized agent loop，可作为 Agent-as-Tool |
| PaSa | 搜索策略不可简单 tool 化 | 部分 | policy 强，双 Agent topology 未必强 | 最需谨慎区分 |
| Proposed system | 局部组件可约简 | 单一静态 skill 不应等价 | 待实验证明 | dual context + persistent preference + feedback |

### 10.2 Ai2 / Asta Paper Finder

**[Literature-TBV]** 当前理解是：其核心可抽象为 query parsing、execution planning、预定义 workflow、relevance judgement 与 ranking 的组合。

```text
Query -> Parse -> Route -> Workflow_i -> Judge -> Rank
```

即使内部很复杂，上层仍可将其作为：

```text
paper_finder(query) -> papers
```

当前可约简性论点：

- 关键能力主要存在于 workflow 和组件组合；
- 不明显要求与上层 Main 共享跨样本演化的独立状态；
- 去掉 Agent 身份、保留 planner 和 workflow 后，核心算法可能仍在。

适合作为“复杂 workflow 不等于 architecture irreducibility”的 baseline。

精读需确认：

- Planner 的 action space 是否固定；
- 是否存在跨 query memory；
- 是否在线更新 search policy；
- 哪些节点真正依赖长期 trajectory；
- 官方实现对 “agent” 与 “workflow” 的定义。

### 10.3 SPAR

**[Literature-TBV]** 当前理解是：SPAR 使用模块化 multi-agent framework，包含 query understanding、retrieval、query evolution、judgement / reranking 等阶段。

```text
Query Understanding
       -> Retrieval
       -> Query Evolution
       -> Judgement
       -> Reranking
```

这些角色都可映射为明确局部函数：

```text
query_understand() -> worker
retrieve()         -> tool
evolve_query()     -> worker
judge()            -> worker
rerank()           -> tool/worker
```

当前可约简性论点：

> Multi-agent decomposition 不自动意味着 Agent identity 是必要的；若改为多个 stateless LLM call 加一个 orchestrator，RefChain、query evolution 与 judgement 等算法思想可能仍被完整保留。

精读需确认：

- 每个 Agent 是否维护独立长期状态；
- Agent 之间是否存在非固定、双向、跨步反馈；
- 角色边界是否只是工程模块边界；
- 替换为同模型 worker 后是否理论上保持行为；
- 是否存在训练或 benchmark-conditioned adaptation。

### 10.4 PaperQA2

**[Literature-TBV]** 当前理解是：PaperQA2 是执行全文检索、来源或 passage 评价以及答案综合的 scientific literature agent。

它可作为一个自主的专业能力模块：

```text
General Research Agent
          │
          └── PaperQA2 Agent
                 ├ search
                 ├ gather
                 ├ evaluate evidence
                 └ synthesize
```

当前可约简性论点：

- 它的内部 trajectory 本身有意义，因此不应粗暴称为 stateless tool；
- 但它可能整体作为 specialized Agent-as-Tool 被上层调用；
- 尚未看到其必须依赖独立 Reviewer context、跨 benchmark preference state 和持续经验写回。

精读需确认：

- 是否维护跨任务 memory；
- evidence selection 是否被在线 critic 反复修正；
- agent loop 的 stop / search policy 如何实现；
- 是否含可学习的非参数状态；
- 其 benchmark 优化是 prompt、pipeline、模型参数还是外部 memory。

### 10.5 PaSa

PaSa 是最不能被简单归为 tool-reducible 的对照。

**[Literature-TBV]** 当前理解是：Crawler 执行 Search / Expand / Stop 的 sequential decision，依赖当前 paper queue 与 context，并通过 RL 学习；Selector 判断候选是否满足 query。

当前应采用的谨慎论点：

> PaSa 的 sequential search policy 有不可约价值，但这种不可约性主要位于经过训练的 Crawler policy 中；Crawler–Selector 的双 Agent topology 本身是否必要，仍需另外证明。

Selector 可能接近：

$$
Selector(q,p)\rightarrow\{Select,Drop\}
$$

因此可能约简为 relevance worker；而难以约简的是写入 $\theta_{Crawler}$ 的策略。

关键对照：

| PaSa 候选解释 | Proposed system |
|---|---|
| benchmark experience 写入 Crawler 参数 $\theta$ | experience 写入外部 $M_{preference}$ |
| policy 通过训练内化 | policy 通过 Reviewer 读取可解释状态来调节 |
| Selector 可能是无状态 judge | Reviewer 是策略 critic，不是逐篇 judge |
| 迁移需考察模型 policy 泛化 | 可单独迁移、合并、冻结或删除 preference |

精读需确认：

- Crawler 的具体 observation、action 和 reward；
- Selector 是否有独立状态或仅执行分类；
- 两者的信息边界；
- RL 数据与 benchmark test 的划分；
- 参数训练对跨 benchmark 泛化的影响；
- 是否已有 memory / self-improvement 对照。

### 10.6 比较谱系

```text
                    Architecture Necessity
                             ↑

 HIGH       Proposed Main <··> Reviewer
               │                 │
               │          independent context
               │          persistent preference
               │          cross-step feedback
               └─────────────────┘
                       [to be proven]
                              ▲
                              │
                        PaSa Crawler
                 sequential learned policy
                              ▲
                              │
                         PaperQA2
                   specialized agent loop
                              ▲
                              │
                           SPAR
                 modular multi-agent workflow
                              ▲
                              │
                    Ai2/Asta Paper Finder
                     semi-rigid workflow

 LOW  ─────────────────────────────────────────→
                    Workflow Reducibility
```

这张图目前是理论定位图，不是已有实验结论。

---

## 11. 如何实验证明架构必要性

### 11.1 不能只比较最终 F1

如果 Proposed system 比 baseline 高 2 个点，仍无法知道增益来自：

- 更多 token；
- 更多检索调用；
- 更长 prompt；
- 更强模型；
- gold 泄漏；
- Reviewer 本身的额外推理预算；
- persistent memory；
- dual context；
- feedback timing；
- 简单 ensemble effect。

因此必须做严格的 capacity- and budget-matched ablation。

### 11.2 最关键的架构消融

| ID | 变体 | 独立 Reviewer | 独立 Context | Persistent M | 跨步建议 | 用途 |
|---|---|---:|---:|---:|---:|---|
| A0 | Plain single agent | ✗ | ✗ | ✗ | ✗ | 最低基线 |
| A1 | Static search skill | ✗ | ✗ | 静态规则 | ✓，由 Main 自查 | 检验 skill reducibility |
| A2 | Main + retrieved preference prompt | ✗ | ✗ | ✓ | ✓，由 Main 自用 | 检验 memory 是否只需塞 prompt |
| A3 | Single-agent self-reflection | 角色模拟 | ✗ | 可选 | ✓ | 检验第二主体身份 |
| A4 | Stateless Reviewer | ✓ | ✓ | ✗ | ✓ | 检验 persistent state |
| A5 | Shared-context Reviewer | ✓ | ✗ | ✓ | ✓ | 检验 context asymmetry |
| A6 | End-only Reviewer | ✓ | ✓ | ✓ | ✗ | 检验 feedback timing |
| A7 | Random / shuffled preference | ✓ | ✓ | 错配 | ✓ | 检验 memory 内容而非容量 |
| A8 | Full system | ✓ | ✓ | ✓ | ✓ | Proposed |

必须控制：

- 同一基础模型；
- 尽可能相近的总输入/输出 token；
- 相同 tool-call 上限；
- 相同检索源；
- 相同最大 wall-clock 或 agent steps；
- 相同候选池访问权限；
- 相同 train / held-out split；
- 多 seed 或 query order 重复。

### 11.3 Preference 表示消融

| 变体 | Rule | Weight | Example |
|---|---:|---:|---:|
| R | ✓ | ✗ | ✗ |
| W | ✗ | ✓ | ✗ |
| E | ✗ | ✗ | ✓ |
| RW | ✓ | ✓ | ✗ |
| RE | ✓ | ✗ | ✓ |
| WE | ✗ | ✓ | ✓ |
| RWE | ✓ | ✓ | ✓ |

观察指标不仅是 F1，还应包含：

- memory size；
- rule conflict rate；
- advice acceptance rate；
- advice causal success rate；
- 跨 benchmark transfer；
- 可解释性人工评分；
- update stability；
- 对 query order 的敏感性。

### 11.4 Benchmark 学习实验矩阵

#### Experiment 1 — In-benchmark learning curve

逐渐增加训练样本比例：

$$
0\%,10\%,30\%,50\%,70\%
$$

固定同一 held-out set，画出 score 与 memory size / training examples 的关系。

#### Experiment 2 — Frozen held-out evaluation

训练完成后冻结 $M_B^*$，在 held-out 上只评一次主结果；开发过程中另设 validation set，避免反复看 test。

#### Experiment 3 — Leave-one-benchmark-out transfer

$$
B_1+\cdots+B_{k-1}\rightarrow M_G\rightarrow B_k
$$

轮流把每个 benchmark 当作 unseen target。

#### Experiment 4 — Conflict stress test

有意选择偏好冲突的 benchmarks，观察层级 memory 是否能：

- 将共同规律上升到 global；
- 将冲突限制在 benchmark-specific；
- 将可迁移规律转写为 intent-conditioned；
- 避免负迁移。

#### Experiment 5 — Memory intervention

手动删除、反转或错配关键 preference，测量行为变化：

$$
\Delta Score=Score(M)-Score(M\setminus pref_i)
$$

这是证明外部状态具有因果贡献的重要实验。

### 11.5 指标体系

#### 任务指标

- Precision / Recall / F1
- NDCG@K
- MAP
- Constraint satisfaction rate
- Cluster coverage
- Result diversity
- Citation/reference coverage

#### 过程指标

- Tool calls / query
- Tokens / query
- Latency
- Search depth
- Unique candidates inspected
- Reviewer interventions / query
- Advice acceptance rate
- Marginal gain after advice
- Premature-stop rate

#### 学习指标

- Improvement per training example
- Preference support / contradiction ratio
- Memory growth rate
- Rule merge rate
- Catastrophic interference
- Cross-benchmark transfer gain
- Negative-transfer rate
- Forgetting after sequential benchmark training

#### 架构指标

- Full vs shared-context gap
- Full vs prompt-injected-memory gap
- Full vs stateless-reviewer gap
- Full vs end-only-review gap
- Budget-normalized score
- Variance across seeds and query order

---

## 12. 主要风险与反驳准备

### 12.1 Benchmark overfitting / Goodhart

错误学习：

```text
overview -> always return one paper
```

期望学习：

```text
overview -> increase representativeness,
            navigation value,
            and reference coverage
```

缓解：

- abstraction step；
- scope tagging；
- leave-one-benchmark-out；
- entity leakage filter；
- conflict-aware consolidation；
- human audit of top-impact rules。

### 12.2 Reviewer 只是额外算力

审稿人可能认为增益来自第二次 LLM call。

缓解：

- budget-matched single-agent reflection；
- 相同 token 的长 prompt 对照；
- shuffled memory 对照；
- end-only Reviewer 对照；
- 报告 unit improvement per 1K tokens / tool call。

### 12.3 Context asymmetry 是人为制造的

反驳不能只说“两个 context 不一样”。需要证明不同投影带来：

- 更少 confirmation bias；
- 更好的 error detection；
- 更稳定的 preference application；
- 更低的 prompt interference；
- 更容易单独冻结和审计。

### 12.4 Reviewer 退化成 relevance judge

若建议主要是“保留/删除某篇论文”，则与 PaSa Selector 或普通 reranker 难区分。

需要将评价单位提升为：

- query strategy；
- coverage state；
- cluster distribution；
- action selection；
- stop decision；
- trajectory-level failure pattern。

### 12.5 Memory 无限增长

缓解：

- support threshold；
- merge / subsume；
- confidence decay；
- episodic reservoir；
- rule deprecation；
- memory retrieval top-k；
- 定期 consolidation checkpoint。

### 12.6 Preference 冲突与灾难性干扰

缓解：

- 层级 scope；
- benchmark router；
- intent-conditioned activation；
- contradiction counter；
- per-benchmark evaluation dashboard；
- sequential-learning order randomization；
- 保存 memory version 并支持回滚。

### 12.7 “Architecture-irreducible”表述过强

理论上，单一通用计算系统可以模拟多 Agent 系统。因此论文应明确：

- 这里讨论的是操作性、信息结构与预算约束下的 reducibility；
- 不是计算理论意义的不可模拟；
- 最终证据应来自 matched ablation 与 intervention，而非拓扑图本身。

推荐表述：

> **Operational architectural irreducibility under fixed information and compute budgets.**

或更保守：

> **A minimal stateful dual-context architecture whose key behaviors are not preserved by tool- or skill-level reductions under matched budgets.**

---

## 13. Demo 级最小实现方案

### 13.1 MVP 范围

第一版只实现：

- 一个 benchmark；
- 一个固定基础 LLM；
- Main + Reviewer；
- 2–3 种检索动作；
- 4–6 个 query intent；
- JSON / SQLite Preference Memory；
- rule + episodic example 两种表示；
- F1 主指标；
- train/validation/held-out 严格划分；
- A0、A1、A2、A4、A8 五个关键消融。

暂不实现：

- 大规模多 benchmark consolidation；
- 复杂 learned reranker；
- 全量 citation graph；
- 自动阈值搜索；
- 多 Reviewer ensemble；
- 模型参数训练。

### 13.2 最小模块

```text
src/
  main_agent.py
  reviewer.py
  orchestrator.py
  preference_memory.py
  preference_update.py
  trajectory_summary.py
  evaluation.py
  tools/
    keyword_search.py
    citation_expand.py
    metadata.py
    deduplicate.py
configs/
  intents.yaml
  actions.yaml
  experiment.yaml
data/
  benchmark_train.jsonl
  benchmark_validation.jsonl
  benchmark_heldout.jsonl
memory/
  preferences.jsonl
  versions/
traces/
  train/
  eval/
```

### 13.3 一轮检索的接口草案

Main action：

```json
{
  "action": "citation_expand",
  "arguments": {"seed_ids": ["P123"], "direction": "both"},
  "reason_code": "need_ancestry_and_descendants"
}
```

Reviewer observation：

```json
{
  "query": "...",
  "intent": "field_overview",
  "step": 3,
  "actions_so_far": ["keyword_search", "keyword_search"],
  "candidate_stats": {
    "count": 18,
    "cluster_concentration": 0.81,
    "year_span": [2019, 2026],
    "constraint_satisfaction": 0.94
  },
  "trajectory_summary": "..."
}
```

Reviewer advice：

```json
{
  "action": "search_for_survey_or_hub",
  "priority": 0.86,
  "rationale": "High cluster concentration under overview intent",
  "memory_refs": ["pref_000123"],
  "stop_assessment": "defer"
}
```

### 13.4 可复现实验日志

每个 query 至少保存：

- benchmark、split、sample ID；
- memory version；
- 模型与 prompt version；
- 每步 action / observation；
- Reviewer 可见输入和 advice；
- Main 是否采纳 advice；
- 最终候选及排序；
- gold 与 metric；
- candidate preference update；
- 总 token、tool call、latency；
- 随机 seed。

---

## 14. 论文精读框架

后续精读每个 baseline 时，建议不要只总结“它有几个 Agent”，而按以下模板记录。

### 14.1 Paper note template

```markdown
## Paper / System Name

### Claimed contribution
-

### Task and benchmark
- Dataset:
- Train/dev/test split:
- Metric:

### System state
- Per-call input X:
- Session trajectory H:
- Persistent state M:
- Model parameters trained?:

### Agent roles
| Role | Inputs | Outputs | Persistent state | Can be a worker/tool? |
|---|---|---|---|---|

### Control loop
- Who chooses actions?
- Who decides stop?
- Is feedback online or end-only?
- Are contexts asymmetric?

### Reducibility tests
- Tool reduction:
- Skill reduction:
- State/context reduction:

### Evidence for or against irreducibility
-

### Relevant ablations already reported
-

### What our system must compare against
-

### Confidence and unresolved questions
-
```

### 14.2 优先核对的问题

#### Ai2 / Asta Paper Finder

- manual-coded components 与 LLM decision 的准确边界；
- execution planner 的灵活性；
- workflow 是否可在 session 中重规划；
- 是否保存跨 query 状态。

#### SPAR

- RefChain / query evolution 的具体状态依赖；
- 每个 Agent 是否只是带 prompt 的 worker；
- 是否存在双向 feedback；
- multi-agent 对应的消融是否充分。

#### PaperQA2

- agent loop 与 evidence selection 的控制策略；
- 是否具有外部 memory 或跨 query 学习；
- 专业 Agent 被整体 tool 化后会损失什么；
- benchmark 优化落在何处。

#### PaSa

- Crawler MDP 的 state、action、reward；
- Selector 的独立性与状态性；
- RL 训练信号来源；
- dual-agent topology 的消融；
- 与冻结 LLM + 外部 memory 的公平比较方式。

---

## 15. 可形成的论文贡献叙事

### 15.1 最保守、最容易守住的版本

> We introduce an external, interpretable retrieval preference memory learned from benchmark feedback, and a dual-context Reviewer that applies this memory to improve an otherwise frozen search agent.

贡献点：

1. 非参数 benchmark adaptation；
2. 结构化、可解释的 preference memory；
3. 轨迹级旁路 Reviewer；
4. in-benchmark 与 cross-benchmark transfer 实验。

### 15.2 架构贡献版本

> We derive a minimal stateful dual-context architecture by reducing all stateless capabilities to tools or workers and retaining only a Main policy agent, a persistent preference critic, and their cross-step feedback channel.

需要强消融支撑：

- static skill；
- prompt-injected memory；
- self-reflection；
- stateless Reviewer；
- shared-context Reviewer；
- end-only Reviewer。

### 15.3 更有野心的版本

> Benchmark-conditioned learning can be consolidated into an intent-conditioned, benchmark-agnostic search policy prior without modifying model parameters.

需要至少多个 benchmark 和 leave-one-benchmark-out transfer 结果支撑。

### 15.4 推荐暂定名称

系统：

- **Preference-Optimized Dual-Context Search Architecture**
- **Benchmark-Adaptive Retrieval Critic**
- **Preference-Aware Search Critic**

记忆：

- **Adaptive Retrieval Preference Memory (ARPM)**
- **Persistent Retrieval Preference State**

架构性质：

- **Context Asymmetry**
- **Persistent State Dependence**
- **Cross-Step Policy Feedback**
- **Operational Architectural Irreducibility**

当前最清楚的一句系统定义：

> Tool 负责完成搜索动作，Main Agent 决定如何搜索，Reviewer 根据独立上下文和长期 benchmark preference 持续修正 Main Agent 的 search policy。

---

## 16. 当前结论、工作假设与待验证项

### 16.1 已形成的核心设计结论

- 不训练 LLM 参数，训练外部 Preference Memory；
- Preference 至少分为 global、benchmark、intent、episode 四层；
- memory representation 采用 rule、weight、example 混合形式；
- Main 负责当前任务执行，Reviewer 负责 trajectory-level policy critique；
- Preference 主要由 Reviewer 读取，不直接全量注入 Main；
- 可约简能力尽量降为 tool / worker；
- held-out 阶段冻结 memory；
- 多 benchmark 聚合必须处理 scope 和 conflict，不能简单相加；
- 架构主张必须由 matched ablation 支撑。

### 16.2 当前最重要的工作假设

- Intent-conditioned preference 是跨 benchmark 泛化的关键层；
- 独立 Reviewer 比 single-agent self-reflection 更不易受确认偏差影响；
- 结构化 memory 比不断增长的 prompt 更稳定、更可审计；
- online cross-step advice 比 end-only critique 更能提升 search policy；
- 外部 preference state 可以在不更新模型参数时实现可测的 agent learning；
- Main + Reviewer + Memory 是一种最小的操作性不可约架构。

### 16.3 必须通过论文精读确认

- 四个 baseline 的真实状态、上下文和控制边界；
- 它们是否已有跨 query memory 或 benchmark adaptation；
- multi-agent topology 是否做过必要性消融；
- PaSa 的 policy 与 Selector 分工；
- 可直接复用的 benchmark、数据划分与评价脚本；
- 现有个性化检索、memory agent 和 critic learning 文献中的相近表述。

### 16.4 必须通过实验回答

- dual-context 是否在等预算下优于单 Agent；
- persistent memory 的真实边际增益；
- memory 写入是否稳定；
- 是否发生 benchmark hacking；
- preference 能否跨 benchmark 正迁移；
- 规则冲突与 query order 是否导致灾难性干扰；
- Reviewer advice 是否有可测的因果贡献；
- 性能提升是否足以覆盖额外成本。

---

## 17. 建议的下一步顺序

1. **精读四个 baseline**：按第 14 节模板补齐事实证据，先纠正可约简性矩阵。
2. **确定首个 benchmark**：明确 query 类型、gold 构造、metric 与合法 train split。
3. **定义 4–6 类 intent taxonomy**：避免一开始做过细分类。
4. **固定 Reviewer observation schema**：先决定 Reviewer 看什么，再写 prompt。
5. **实现无学习的 A0/A1/A4**：Plain、Static Skill、Stateless Reviewer。
6. **加入最简单 Preference Memory**：rule + episode，带 provenance 和 confidence。
7. **实现 train-update-freeze-heldout loop**。
8. **先验证单 benchmark learning curve**。
9. **完成关键架构消融**：尤其 A2、A3、A5、A6。
10. **结果成立后再扩展多 benchmark consolidation 和信息计量学特征**。

---

## 18. 最终研究锚点

本项目最值得坚持的不是“双 Agent”这个表面结构，而是以下方法论：

> **先把所有可被函数化、工具化、worker 化或静态 skill 化的部分逐一约简；只有当一个模块必须拥有不同的信息边界、持续演化的状态和跨步反馈职责时，才保留其 Agent 身份。**

在这一原则下，最终候选骨架是：

$$
\boxed{
\text{Main Search Agent}
+\text{Side-channel Preference Reviewer}
+\text{Persistent Retrieval Preference Memory}
}
$$

其学习主线是：

$$
\boxed{
\text{Benchmark-conditioned learning}
\rightarrow
\text{multi-benchmark consolidation}
\rightarrow
\text{benchmark-agnostic search policy prior}
}
$$

如果实验只能证明第一步，它仍可成为一个可解释的非参数 benchmark adaptation 方法；如果能证明第二、第三步，则可能进一步说明：benchmark 经验可以在不训练模型参数的情况下，塑造一个具有持续状态和迁移能力的 Search Agent。

