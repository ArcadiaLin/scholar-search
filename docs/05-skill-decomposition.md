# MetaScientist Skill 拆解清单

> 状态：待评审
> 项目：Agentic Search
> 位置：`prototype.md` §7.3 的穷尽版。§7.3 给了 6 行示例说明「先拆分，再灌入」，
> 本文把参照来源的每一条内容都落到具体归属，供 §7.1 的工具集定稿与 $NP_0^{agent}$ / $HP_0$ 初始化使用。

## 0. 本文要回答的问题

MetaScientist 用 skill（自然语言指导）+ 预定义脚本（`cf.*` / `ds.*` 工具）实现了一套检索方案。
本项目要在**没有通用 coding 能力**的前提下复现同等能力，因此必须先回答：
**skill 里的每一句话，在本架构里属于哪一层。**

这不是文风迁移，是分层归属。做不到穷尽，就会出现三种后果：

1. 本该被训练的数值藏进自然语言 → 不可枚举、不可 gate、不可冻结，离线优化器搜不到它；
2. 本该被 Reviewer 改写的策略写进静态 prompt 文件 → 脱离 $PH_k$，$k$ 尺度失去一半作用对象（§7.3 约束一）；
3. 本该由 Agent 决策的动作做成工具 → 固定管线以工具调用序列的形式复活，M 轴消融观察不到差异。

---

## 1. 范围

**纳入**（检索方案相关，共 10 份文档、约 1180 行）：

| 来源 | 行数 | 状态 | 编号前缀 |
| --- | --- | --- | --- |
| `metasci-citeflow/SKILL.md` | 63 | 现役，§7.3 指定的 $NP_0^{agent}$ 来源 | `CF-S` |
| `metasci-citeflow/references/query-search.md` | 107 | 现役 Phase 1 | `CF-Q` |
| `metasci-citeflow/references/backward-expansion.md` | 189 | 现役 Phase 2 | `CF-B` |
| `metasci-citeflow/references/forward-expansion.md` | 94 | 实验性 Phase 3 | `CF-F` |
| `metasci-deepsearch/references/l1/iterative-search.md` | 76 | ARCHIVED | `DS-I` |
| `metasci-deepsearch/references/l1/citation-expand.md` | 105 | ARCHIVED | `DS-C` |
| `metasci-deepsearch/references/l1/rank-and-filter.md` | 83 | ARCHIVED | `DS-R` |
| `metasci-deepsearch/references/l2/*.md` | 199 | ARCHIVED | `DS-L2` |
| `metasci-citation-lookup/SKILL.md` | 114 | 现役 | `CL` |
| `metasci-data-fetch/SKILL.md` | 114 | 现役 | `DF` |

ARCHIVED 的 deepsearch 仍然纳入：它被 citeflow 取代的原因是「固定管线 → agent 决策」，
这正是本项目要检验的那一步，它的参数取值与停止条件是最完整的一份 $HP_0$ 候选来源。

**排除**：`metasci-analysis`、`metasci-report-writer`（分析与报告，不属检索方案）；
`metasci-skills/AGENTS.md`（skill 之间的路由表，本架构由工具集取代）。

---

## 2. 归属标签与判据

| 标签 | 含义 | 判据 |
| --- | --- | --- |
| `TOOL` | 进 $T^M$（`prototype.md` §7.1 的 9 个工具） | 固定计算或 API 序列，输入自足，不做动作选择 |
| `SVC` | Service 内部实现，不对 Agent 暴露 | 同上，且 Agent 无需感知其存在 |
| `HP` | $HP_k$ 可训练参数 | 是数值/阈值/预算/权重，且换一个取值系统仍然合法 |
| `CAP` | provider 能力表（§2.1） | 是关于数据源的**可证伪断言**，应被实测推翻 |
| `NPa` | $NP_k^{agent}$ 策略条目 | 是策略判断，由语言模型消费，Reviewer 可能想改写它 |
| `NPj` | $NP_k^{judge}$ 判别准则 | 是相关性判定标准，由 Service 内的判别器消费 |
| `AGENT` | Agent 在 $t$ 尺度的自主决策 | 需要看当前轨迹才能决定，不落任何静态载体 |
| `RT` | 运行时状态 / 轨迹 | RunSnapshot、episode-scoped evidence store、$\bar{\tau}_t$ 的字段 |
| `EXP` | 待检验命题 | 是经验断言且本项目有能力证伪，进 `experiments.md` |
| `SKILL` | 受限 skill（静态操作手册） | 不参与偏好学习、Reviewer 不会想改、可整体冻结 |
| `DROP` | 不迁移 | 依赖 coding 能力、属固定管线、或对本架构无意义 |

判定顺序（先命中先归属）：

```text
是数值/阈值/预算/权重吗           → HP
是关于 provider 的事实断言吗      → CAP
是固定计算或 API 序列吗           → TOOL / SVC
需要看当前轨迹才能决定吗          → AGENT
是相关性判定标准吗                → NPj
是策略判断吗                      → NPa
是可证伪的经验断言吗              → EXP
以上皆非，且永不改写              → SKILL / DROP
```

`HP` 排在最前是刻意的：**凡能写成数值的，一律先当参数处理**。
一条指导里若同时含语义与数值（"结果少于 15 条就去掉最严格的词"），
拆成两条：阈值进 `HP`，动作语义进 `NPa`。清单中这类条目标注为「拆分」。

---

## 3. 逐条拆解

### 3.1 `metasci-citeflow/SKILL.md`

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| CF-S-01 | :16 | "tools execute, agent decides" | `DROP` | 本架构 §4 已内化为模块边界，不作为偏好条目 |
| CF-S-02 | :20-25 | 四 phase 表（查询分析→共被引后向→前向→打分） | `NPa` | `phase-order-hint`，只能是建议顺序（§7.3 约束三） |
| CF-S-03 | :29-37 | `ms.list_tools()` 运行时探测 | `DROP` | 工具发现由 harness 提供，不需要 agent 写代码 |
| CF-S-04 | :39 | 所有 `cf.*` 共享 session_id，先 `cf.session.open` | `RT` | episode-scoped store，见 §6 开放问题 O-1 |
| CF-S-05 | :44 | 原则 1：agent 决策，工具执行 | `DROP` | 同 CF-S-01 |
| CF-S-06 | :45-46 | 原则 2：方向覆盖优先于深度 | `NPa` | `direction-coverage`（§7.3 已有） |
| CF-S-07 | :47-48 | 原则 3：每次检索后先诊断再行动 | `NPa` | `diagnose-before-act`（§7.3 已有） |
| CF-S-08 | :49-50 | 原则 4：每阶段有工具调用预算，在预算内排优先级 | 拆分 | 语义→`NPa` `budget-priority`；数值→`HP` |
| CF-S-09 | :54-58 | 前向扩展未设为默认：更多扩展可提升 store 覆盖却降低 top-K | `EXP` | 命题「召回增益 ≠ 排序增益」，见 §6 O-4 |
| CF-S-10 | :60-63 | PaperStore 是每个 session 背后的持久证据库，负责身份消解、发现溯源、领域内引用信号、打分与最终排序 | `RT` + `SVC` | 身份消解与打分归 Service；store 生命周期见 O-1 |

### 3.2 `references/query-search.md`（Phase 1：查询分析 + 自适应检索）

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| CF-Q-01 | :7 | 检索工具预算：最多 6 次调用 | `HP` | `budget.phase1_search_calls = 6` |
| CF-Q-02 | :13 | 抽取 3–5 个关键词组 | `HP` | `query.subquery_count = [3,5]` |
| CF-Q-03 | :17-19 | 通过松散句法解析识别研究要素：research_task（必有）、contribution、methodology、时间、数据源、领域 | `NPa` | 新增条目 `decompose-by-research-elements` |
| CF-Q-04 | :21-23 | 形容词修饰中心名词→留在组内；独立名词短语→单独成组 | `NPa` | 并入 CF-Q-03 同一条目 |
| CF-Q-05 | :25 | 每组 2–4 词（极少数 5） | `HP` | `query.terms_per_group = [2,4]`，上限 5 |
| CF-Q-06 | :25 | 用词元形式；保留复合术语（"hate speech"） | `SVC` | 查询归一化，Service 实现，不是 Agent 的判断 |
| CF-Q-07 | :27 | 优先级：research_task 优先，其余按检索重要性 | `NPa` | 并入 CF-Q-03 |
| CF-Q-08 | :29-32 | 若假设隐含了文本中未出现的相关研究社区，为它补一个关键词组——"这是 agent 智能高于句法解析的地方" | `NPa` | `infer-implicit-directions`（§7.3 已有） |
| CF-Q-09 | :34-44 | machine unlearning × conformal prediction 的示例 | `NPa` | 示例式条目 `decompose-example-cross-community`，见 `prototype.md` §7.3「示例式条目」（O-6 已决） |
| CF-Q-10 | :46-52 | 副产物 discriminative_terms，1–10 打分：语言名、专名、罕见方法学高分，"model"/"learning"/"network" 低分 | `SVC` | §3.2 的 $\rho_j$；**打分不由 Agent 做** |
| CF-Q-11 | :57-58 | 先取前 2 个关键词组，S2 起手 | 拆分 | 首轮组数→`HP`；起手源→`CAP` |
| CF-Q-12 | :65-70 | 诊断判据表：标题相关 ≥6/10、年份分布混合、被引分布混合、merged ≥30 | `HP` | `diagnose.*` 四个阈值，可训练 |
| CF-Q-13 | :69 | 结果数 <15 视为过窄，=limit 视为过宽 | `HP` | `diagnose.too_narrow = 15` / `too_broad = limit` |
| CF-Q-14 | :74-76 | S2 语义匹配更好；S2 失败或漏方向时切 OpenAlex；OA 覆盖广、无限流 | `CAP` | §2.1 能力表，**P0 无 S2，作为断言存档**（§7.3 已判定） |
| CF-Q-15 | :80-83 | 何时重写：跑题（关键词歧义，"LoRA"→LoRa 无线）、过窄（去掉最严格的词）、过宽（加更具体的词）、缺方向（新建组） | 拆分 | 动作语义→`NPa` `rewrite-on-failure`；触发阈值→CF-Q-13 |
| CF-Q-16 | :87-89 | 预算分配：1–2 首两组走 S2，3 走 OA 补覆盖，4–6 留给诊断驱动的调整 | `HP` | `budget.phase1_allocation`；**不写进 NP**，否则调用序列被固化 |
| CF-Q-17 | :91 | 别盲目耗尽 6 次；1–2 次结果好就省下预算 | `NPa` | 并入 `budget-priority` |
| CF-Q-18 | :99-107 | 持久化到 session：query、structured_keywords、search_queries、discriminative_terms、rerank_query | `RT` | 进 episode 状态并出现在 $\bar{\tau}_t$（Reviewer 需要看见子查询） |

### 3.3 `references/backward-expansion.md`（Phase 2：共被引诊断 + 后向扩展）

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| CF-B-01 | :7-8 | agent 的职责：诊断 hub、选扩展源、为缺失方向补检索、决定是否第二轮 | `DROP` | 是对 CF-S-01 的复述 |
| CF-B-02 | :14-17 | `co_cite` 返回 co_cited top-50 与 expansion_candidates top-25 | 拆分 | 能力→`TOOL` `expand_citations`；top-N→`HP` |
| CF-B-03 | :21-27 | hub 健康检查：count ≥3 的共被引数 ≥20 健康 / 5–20 弱 / <5 回 Phase 1 | 拆分 | 三档阈值→`HP`；「信号弱就回退重来」→`NPa` 新条目 `retreat-on-weak-signal` |
| CF-B-04 | :33-37 | hub 三分类 A 方向核心 / B 相关但宽泛 / C 噪声 | `NPj` | 判别准则集（§4.2），不是 Agent 的策略 |
| CF-B-05 | :40 | C 类判据：通用 ML/DL 工具且 cc >5000（Adam、ResNet、Attention Is All You Need） | 拆分 | 阈值→`HP`；「通用工具类论文应排除」→`NPj` |
| CF-B-06 | :41-42 | C 类判据：与假设无语义联系；宽泛综述 | `NPj` | 同上 |
| CF-B-07 | :43-54 | **邻接社区过载**：术语真实重叠但论文属于复用同一批词汇的另一个研究社区；朴素的"无语义联系"检测抓不到，要看是谁在引它。若某关键词组的结果偏向一个意外的应用领域，该领域的经典一律判 C | `NPj` | 判别准则中最有价值的一条；**证据是引用它的社区，不是标题** |
| CF-B-08 | :56-61 | 标题歧义时用 python 从 store 取摘要 | `TOOL` | `get_paper`；这正是「脚本→工具」的典型 |
| CF-B-09 | :63-66 | 把 A 类 hub 按方向分组，标记强/弱/缺失 | `NPa` | 并入 `direction-coverage` |
| CF-B-10 | :76-81 | 扩展源四条筛选：co_cited_works_cited ≥2、标题与方向相关、非综述/通用经典（cc >5000）、聚焦本轮方向 | 拆分 | 两个数值→`HP`；两条语义→`NPj` |
| CF-B-11 | :83-86 | 源数量 7–18；不足 7 放宽到 ≥1；超过 18 按 co_cited_works_cited 取前 18 | `HP` | `expand.source_count = [7,18]` 及放宽规则 |
| CF-B-12 | :88-103 | expansion_candidates 本身被污染时（top-25 多数判 C）不要硬选，改从 search_rank 好的店内论文直接指定 source_ids | `NPa` | 新条目 `bypass-corrupted-candidate-pool`；**故障恢复策略，价值高** |
| CF-B-13 | :107 | 调 `expand_refs_guided(source_ids=[...])` | `TOOL` | `expand_citations`，`direction=backward` |
| CF-B-14 | :118-122 | 增长检查：3x+ 健康 / 2–3x 中等 / <2x 弱（源选得差） | 拆分 | 阈值→`HP`；「用增长率诊断源质量」→`NPa` |
| CF-B-15 | :124-131 | 补充检索最多 3 次，独立于 Phase 1 的 6 次预算 | `HP` | `budget.phase2_supplementary_calls = 3` |
| CF-B-16 | :127-128 | agent 此时比 Phase 1 更理解假设，补充关键词会更精准 | `NPa` | 新条目 `late-queries-are-better-informed` |
| CF-B-17 | :138-143 | 是否跑第二轮：单方向已覆盖好 / hub <10 / 补充检索已补上缺口 → 跳过；多方向但首轮只深化了一个 / 补充检索带来新论文 → 跑 | 拆分 | hub 阈值→`HP`；判断逻辑→`NPa` |
| CF-B-18 | :147-150 | 第二轮流程：重跑 co_cite → 有新 hub 才扩展 → 聚焦与第一轮**不同**的方向 | `NPa` | 并入 `direction-coverage` |
| CF-B-19 | :152 | Phase 2 结束时 store 预期 600–1200 篇 | `HP` | `candidate_pool_target`；本项目候选规模不同，需重估 |
| CF-B-20 | :161-178 | 持久化 direction_diagnosis：各方向强度、hub 数、关键 hub、已排除的噪声 hub、已补/未补缺口、phase 标记 | `RT` | 这是**结构化的覆盖诊断**，应进 $\bar{\tau}_t$——Reviewer 的覆盖缺口判断正需要它 |
| CF-B-21 | :184-189 | 五条 Key Rules：先读 co_cited 再扩展 / 每轮聚焦一个方向 / 不从噪声 hub 的施引论文扩展 / 源数量随候选质量而非固定 / 缺方向就立刻补检索 | `NPa` | 逐条成为独立条目，粒度即提案粒度 |

### 3.4 `references/forward-expansion.md`（Phase 3：前向扩展，实验性）

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| CF-F-01 | :7-9 | 实验性配方，不是默认管线阶段；更大的 store 本身不改善 top-K，前向扩展曾把已找到的相关论文压到 rank 100 之后 | `EXP` | 与 CF-S-09 同一命题，见 §6 O-4 |
| CF-F-02 | :13-16 | 前置条件：先完成 P1 P2、检查 store 与方向诊断、不复用已用过的种子、把种子与参数记入 ledger | 拆分 | 「不复用种子」→`RT`（运行时去重）；其余→`NPa` |
| CF-F-03 | :23-28 | `cf.seeds.select_citations` 内部：autoscore → 过滤 → 排序 → 判别 → 选种子 | **拆分** | 打分/过滤/排序→`SVC`；**选种子是动作选择**→`AGENT`，见 §4 |
| CF-F-04 | :30-32 | 取种子前先看种子集；优先覆盖 Phase 2 仍缺的方向；不要仅因全局高被引就选通用经典 | `NPa` | 新条目 `seed-for-coverage-not-fame` |
| CF-F-05 | :36-44 | `cf.store.distributions` → `cf.citations.decide_params`（LLM 决定 year_start / min_citations，Python 侧 clamp 到安全范围） | **拆分** | 分布统计→`TOOL`；**参数决定→`AGENT`**；clamp 范围→`HP`（即 §2.2 的 $P.\mathrm{limits}$） |
| CF-F-06 | :46-48 | 保留返回的 year_start 与 min_citations 与实验记录在一起 | `RT` | 进 $\bar{\tau}_t$ 与回放数据集 |
| CF-F-07 | :52-64 | `fetch_forward` 分页、归一为 CuraLib 记录、去重、写 ledger | `TOOL` | `expand_citations`，`direction=forward` |
| CF-F-08 | :66-72 | 重新打分与排序，检查排序影响 | `TOOL` | `rank_candidates` |
| CF-F-09 | :76 | 实验期最多 3 轮前向扩展 | `HP` | `expand.max_forward_rounds = 3` |
| CF-F-10 | :78-82 | 四条停止条件：上一轮新增很少 / 新结果重复已强方向 / 选不出新鲜种子 / held-out 上 recall@K 下降 | `NPa` | 前三条→策略条目；第四条→`EXP` 的验收判据 |
| CF-F-11 | :84-86 | 只为一个尚未解决的方向再跑一轮；不要把 store 增长当成功，要比较排序输出或 eval 分数 | `NPa` | 新条目 `growth-is-not-success`，与 CF-F-01 呼应 |
| CF-F-12 | :88-94 | 参考实现 `dev_scripts/run_forward_expand_9.py` 含 benchmark 专用路径，不是可移植 CLI | `DROP` | — |

### 3.5 `metasci-deepsearch`（ARCHIVED）——相对 citeflow 的增量

只列 citeflow 未覆盖的条目。deepsearch 的价值在于它把参数写全了。

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| DS-I-01 | iterative-search:5 | max_rounds 默认 3，search_limit 默认 50 | `HP` | — |
| DS-I-02 | :23-27 | 停止条件：successful_count ≥3 记一次成功轮；successful_rounds ≥2 即停 | `HP` | 与 design.md §3 的 `marginal_recall_gain_too_low` 对应 |
| DS-I-03 | :31-33 | 重写模式：有命中→`expand`（放宽），零命中→`regenerate`（换角度） | `NPa` | 细化 `rewrite-on-failure`：两种失败模式对应两种重写 |
| DS-I-04 | :55-57 | 首轮 0 结果时立刻 regenerate，不要机械耗尽轮数 | `NPa` | 并入 DS-I-03 |
| DS-I-05 | :60-64 | judge 的 top_k 默认 15；候选 <20 时全判；每轮判别不超过 20 篇（成本控制） | `HP` | 对应 §7.1 的 `judge_level` 预算 |
| DS-I-06 | :67-69 | 方法 × 应用领域型查询，交替聚焦：一轮方法、一轮应用 | `NPa` | 新条目 `alternate-facets-across-rounds` |
| DS-I-07 | :70-71 | 两次 regenerate 都失败就告诉用户并请求澄清，不要继续烧轮数 | `NPa` | 改写为 `report-and-degrade`：显式失败上报 + 降级返回，不追问用户、不向 Reviewer 求助。契约见 `design.md` §3（O-5 已决） |
| DS-C-01 | citation-expand:20-27 | 种子选择：优先 LLM 分数高**且**领域内被引高；避开 cc >5000；选 3–7 个 | 拆分 | 数值→`HP`；「两个信号都要高」→`NPa` |
| DS-C-02 | :43 | `fetch_refs` 每篇上限 60 | `HP` | `expand.refs_limit_per_paper = 60` |
| DS-C-03 | :47 | `co_cite` 的 min_count = 2 | `HP` | — |
| DS-C-04 | :55-60 | year_start 典型取（最早种子年份 −1），近期主题下限 2015；min_citations 冷门取 0、热门取 5–10；快速演进主题用更近的 year_start | `HP` | 这是 CF-F-05 那个 LLM decider 的**规则化版本**，可直接作为 $HP_0$ 初值 |
| DS-C-05 | :85-88 | 别用固定公式，看数据决定；store 已有 300+ 篇就把 min_citations 提到 10 | 拆分 | 阈值→`HP`；「按分布调参」→`AGENT` |
| DS-C-06 | :90-93 | 何时跳过前向扩展：纯历史主题；种子各自被引 <20 | 拆分 | 阈值→`HP`；条件→`NPa` |
| DS-C-07 | :78-81 | 坏种子（1 万被引的综述）会用边缘相关论文淹没 store | `NPa` | 并入 `seed-for-coverage-not-fame` |
| DS-R-01 | rank-and-filter:20-36 | 五组权重档：standard / LLM 分数可用 / 领域内引用可用 / 用户要最新 / 用户要奠基性 | `HP` | **意图 → profile 绑定**，正是 §7.2 `rebind_intent_profile` 的作用面；不由 Agent 现场挑 |
| DS-R-02 | :72-76 | top_k：完整综述 100，聚焦阅读清单 30–50 | `HP` | — |
| DS-R-03 | :69-71 | "别想太多，默认档适合大多数情况" | `DROP` | 在本架构里权重由离线搜索定，这句话没有作用面 |
| DS-R-04 | :78-83 | 可选：top_k ≤30 且要求高精度时，对 top-30 再跑一次 judge 并提高 llm_score 权重；很贵，仅在需要精选清单时做 | `HP` | `judge_level` 的触发条件与预算上限 |
| DS-L2-01 | citeflow.md、fast-search.md、citation-first.md 全文 | 三条固定管线（阶段顺序 + 每阶段参数 + checkpoint） | `DROP` | 本架构由 Agent 在 $t$ 尺度决定；固化即 M 轴消融失效 |
| DS-L2-02 | citeflow.md:41-52 | checkpoint 数值：Phase 1 后 store 50–150、<30 告警、Phase 2 后至少增长 50、增长 <20 视为冷门 | `HP` | 从管线里剥离出来的诊断阈值，保留 |
| DS-L2-03 | fast-search.md:36-41 | 何时升级到完整 citeflow：用户提到 comprehensive / all relevant / literature review；首轮 successful_count ≥5；主题是 2020 年前的奠基性领域 | 拆分 | 意图识别→`NPa`；意图→参数组绑定→`HP`（DS-R-01 同一机制） |
| DS-L2-04 | citation-first.md:19-49 | 用户已给种子论文时跳过关键词检索，直接标记种子并做引文扩展 | `NPa` | 新条目 `seeded-entry-skips-recall`；对应 §7.1 的 `expand_citations` 直接入口 |

### 3.6 `metasci-citation-lookup` 与 `metasci-data-fetch`

| ID | 出处 | 内容 | 归属 | 落点 |
| --- | --- | --- | --- | --- |
| CL-01 | citation-lookup:52-60 | 标识符优先级：OpenAlex ID > DOI > arXiv ID > S2 ID > S2 Corpus ID > 标题 | `SVC` | 与 §2.2 的合并主键优先级一致，Service 内部实现 |
| CL-02 | :62-63 | 标题查找返回多个候选时报告歧义并索取精确标识符 | 拆分 | 歧义上报→`SVC`（诊断字段）；是否追问→`NPa` |
| CL-03 | :67-80 | provider 降级链：OpenAlex 解析 → OpenAlex 取边 → 缺失且有 DOI 则先查 OpenCitations 并回填标识符 → 仍缺失才解析 S2 作最终补充 → 限流时保留部分结果 | `CAP` + `SVC` | 能力与配额→§2.1；执行→Service。O-3 已决：OpenCitations 纳入为引文边的补充源，S2 仍不接入；降级链机制见 `search-service.md` §3.4 |
| CL-04 | :86-88 | 绝不把真实 key 硬编码进 skill、示例、仓库文件或提交的文档 | `DROP` | 该规范在 MetaScientist 里必要，是因为它的 agent 有 `Bash(python *)` 能接触凭据；本架构中密钥封闭在 Service 内，Agent 不持有也不感知，作用对象不存在 |
| CL-05 | :102-103 | 失败信息为 `All connection attempts failed` 时在有网络许可的情况下重试 | `SKILL` | 错误码 → 处置的操作手册，典型的受限 skill 内容 |
| DF-01 | data-fetch:56-62 | 查询表示的路由：判断请求应表达为 query / topic_name / source_name / venue+year / author_id / institution_name 或其组合 | `NPa` | 新条目 `choose-query-representation`；本项目对应 `provider_query` 的字段选择 |
| DF-02 | :78-89 | 核心要素抽取清单（query / topic / source / venue / author / institution / 年份区间 / include / limit / sort_by） | `SVC` | 检索意图的结构化 schema，属 `search_metadata` 的入参定义 |
| DF-03 | :91-93 | 用户给了显式 ID 就优先用 ID；名称有歧义时先消歧再取依赖数据集 | `NPa` | 并入 CL-02 |
| DF-04 | :71-75 | 请求含多个独立数据集/实体时先写检索计划，一个实体一次检索；不要塌缩成一个过约束的查询 | `NPa` | 新条目 `no-over-constrained-merge`；与 `direction-coverage` 互补 |
| DF-05 | :99-104 | 默认规则：CLI 加 `--json`、不写空字段、冒烟测试用小 limit | `DROP` | CLI 运维细节，本项目无 CLI 层 |
| DF-06 | :108-117 | 输出规范：报告所用命令、产物路径、返回数与过滤总数、provider 与诊断；不要粘贴大段 JSON | `SKILL` | 并入输出契约（design.md §2.4 已覆盖大部分） |

---

## 4. `cf.*` 27 个工具 → $T^M$ 映射（Step 1 草案）

判据用 `search-service.md` §7.2 三条：有无跨调用状态、是否动作选择、输入是否自足。

| `cf.*` 工具 | 判定 | 去处 |
| --- | --- | --- |
| `cf.session.open` / `.info` / `.export` | 运行时 | 由 harness 与 RunSnapshot 承担，不暴露给 Agent |
| `cf.profiles.list` / `.show` | 运行时 | $\theta^S_k$ 由 `Configure` 生成，Agent 不选 profile |
| `cf.query.analyze` | **归 Agent** | 查询分解是 design.md §3 第 2 步的 Agent 职责，不做工具 |
| `cf.papers.search` | `TOOL` | → `search_metadata` |
| `cf.papers.repair` | `SVC` | 富集阶段自动执行，不需 Agent 感知 |
| `cf.citations.co_cite` | `TOOL` | → `expand_citations`（共被引诊断作为返回字段） |
| `cf.citations.expand_refs_guided` | `TOOL` | → `expand_citations(direction=backward)` |
| `cf.citations.fetch_forward` | `TOOL` | → `expand_citations(direction=forward)` |
| `cf.citations.decide_params` | **归 Agent** | 扩展参数是动作选择；clamp 范围留在 $P.\mathrm{limits}$ |
| `cf.seeds.select_refs` / `.select_citations` | **拆分** | 打分排序→`SVC`；选种子→Agent |
| `cf.seeds.mark` | `TOOL` | 并入 `expand_citations` 的 `seed_ids` 入参 |
| `cf.store.autoscore` | `SVC` | rank 阶段内部执行 |
| `cf.score.relevance` | `SVC` | §3.3 的 cross-encoder，L3a |
| `cf.score.keywords` | `SVC` | §3.2 的 noisy-OR |
| `cf.papers.filter` | `SVC` | L0/L1 |
| `cf.store.rank` | `TOOL` | → `rank_candidates` |
| `cf.papers.judge_relevance` | `SVC` | L3b；由 `judge_level` 控制，Agent 不直接调 |
| `cf.store.distributions` | `TOOL` | → `facet_probe` |
| `cf.store.stats` | `TOOL` | → `get_budget` + 轨迹字段 |
| `cf.rounds.list` / `.get` | `RT` | 属 $\bar{\tau}_t$，Agent 从观察里拿，不需专门工具 |
| `cf.eval.score` / `.compare` | 离线 | 评测通道，held-out 阶段不注册（§7.2 约束三） |

**27 → 9 的压缩里，最值得注意的是三个被判为「归 Agent」的工具**：
`cf.query.analyze`、`cf.citations.decide_params`、`cf.seeds.select_*` 的选择环节。
它们在 MetaScientist 里都是**内部调 LLM 的工具**——即用工具封装了一次决策。
本架构若照搬，Agent 的 $t$ 尺度自主性会被抽空：轨迹上看还是 ReAct，
实际决策发生在工具内部的固定 prompt 里，既不进 $\bar{\tau}_t$，也不受 $NP_k^{agent}$ 影响，
Reviewer 无从归因。这是整个移植过程中最容易犯且最难在事后发现的错误。

---

## 5. 汇总

原始条目 94 条；标记 114 个（"拆分"条目计入两到三类）。

| 归属 | 标记数 | 分布 |
| --- | --- | --- |
| `NPa` | 36 | CF-S 4、CF-Q 7、CF-B 8、CF-F 4、DS-I 4、DS-C 3、DS-L2 2、CL 1、DF 3 |
| `HP` | 33 | CF-S 1、CF-Q 7、CF-B 9、CF-F 2、DS-I 3、DS-C 6、DS-R 3、DS-L2 2 |
| `DROP` | 9 | CF-S 3、其余分散 |
| `SVC` | 8 | CL 3、CF-Q 2、CF-S/CF-F/DF 各 1 |
| `TOOL` | 6 | 全部落在既有 9 个工具内，无新增 |
| `RT` | 6 | 其中 CF-Q-18、CF-B-20、CF-F-06 要求进 $\bar{\tau}_t$ |
| `NPj` | 5 | 全部来自 CF-B 的 hub 分类 |
| `CAP` | 3 | 两条涉及 S2（P0 无此 provider），一条涉及 OpenCitations |
| `AGENT` | 3 | CF-F-03、CF-F-05、DS-C-05 |
| `SKILL` | 2 | CL-05、DF-06 |
| `EXP` | 3 | 对应 2 条命题（CF-S-09 与 CF-F-01 同一命题） |

**结论一**：$T^M$ 的 9 个工具足够，不需要扩充——94 条里没有一条要求新工具。
压力全在 $HP_k$：33 个参数标记远超 §5.1 模式 A 规划的搜索维度，需要分层，见 O-2。

**结论二**：$NP_a$ 的 36 个标记**不等于 36 个条目**。清单里有 10 处标注为"并入"既有条目
（`direction-coverage` 吸收 CF-B-09/CF-B-18，`budget-priority` 吸收 CF-S-08/CF-Q-17，等等），
而 CF-B-21 的一条要展开成 5 条独立 Key Rule。合并与展开之后的最终条目数
要等实际写 $NP_0^{agent}$ 时才能定，量级在 25–30 条。这是 Step 5 的工作，不是本文的。

**结论三**：受限 skill 这一层基本不成立。原本的候选内容有四项，逐一消解：

- provider 原生语法速查——改由 `list_providers` 运行时返回，见 `prototype.md` §7.1；
- CL-04 密钥规范——Agent 不持有凭据，作用对象不存在；
- DF-06 输出规范——已被 `design.md` §2.4 的输出契约覆盖；
- CL-05 错误码处置——**仅剩这一条**。

一条内容不值得引入一套独立机制。它是"永不随 $k$ 改写"的，直接并入 $SP_M$ 的静态部分。

---

## 6. 开放项的处置

六项已于 2026-08-21 决定，落点如下。

**O-1 — evidence store 归属：episode 作用域。** 已定。
绑定 `RunSnapshot`、由 Service 持有、统计量进入 $\bar{\tau}_t$、episode 结束即销毁；
跨 episode 的记忆只有 $PH_k$ 一个合法载体。
契约见 `design.md` §4.1，内容与生命周期见 `search-service.md` §5.3。
附带确立一条：Agent 不在上下文里搬运候选集，按 id 引用。

**O-2 — 参数分层：敏感性筛选升为必做步骤。** 已定。
`prototype.md` §5.1 增「前置步骤：参数分层与敏感性筛选」，
分可搜层 / 固定层 / 边界层，产出版本化的 `screening_report`；
数据切片或特征族变化后必须重跑。里程碑 M2 的完成判据与
`experiments.md` §10 的执行顺序（新增阶段 0.5）同步更新。

**O-3 — OpenCitations：纳入，仅作引文边的补充/兜底源。** 已定。
机制层写入 `search-service.md` §3.4（provider 的三种角色与降级链），
具体接入与四项待测项写入 `prototype.md` §2.1。
**尚未实测**——边覆盖增量、重叠一致性、preprint 缺口改善、限流与延迟四项任一不达标即退回两源方案。

**O-4 — 「召回增益 ≠ 排序增益」：立为 E 轴消融 + 预注册可证伪点。** 已定。
`prototype.md` §6.5 新增扩展轴 E0–E3，每格必须同时报告候选覆盖与 top-K；
`experiments.md` §8 写定处置方式：覆盖升而排序降时不得只报 top-K 就关闭扩展，
该组合指向排序器容量缺口。

**O-5 — 失败处置：显式上报并降级。** 已定。
不追问用户、不向 Reviewer 求助——后者会把 $A_t$ 的触发权移交给 Agent，
使介入率成为内生变量并破坏 $\Delta_{\mathrm{sidecar}}$ 的归因。
契约见 `design.md` §3；条目更名为 `report-and-degrade`。

**O-6 — 代表性示例：进 $PH_k$，不进 $SP$。** 已定。
`design.md` §6.1 确立陈述式与示例式条目同属偏好；
`prototype.md` §7.3 给出 `kind` / `origin` 字段与 P 轴消融要求。
CF-Q-09 相应地从 `DROP` 改判 `NPa`（汇总表已更新）。

### 6.1 由此产生的新待办

- **OpenCitations 四项实测**（O-3 的前置条件，未做）；
- **敏感性筛选的噪声带估计**需要先确定重复次数 $R$ 与 validation 切片大小，
  目前 `prototype.md` §5.1 只给了协议没给规模；
- **$NP_0^{agent}$ 的合并与展开**：36 个 `NPa` 标记落成实际条目列表，含新增的示例式条目（Step 5）。
