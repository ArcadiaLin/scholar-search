# Reviewer v0 与 $NP_0$ 重写：从三次真实会话推出来的设计

> 状态：设计，尚未执行。stage 定义在 §6（S11）
> 读者：要实现 Reviewer 第一版、或要写 $NP_0^{agent}$ 条目的人
> 前置：`design.md` §5.2（四个 checkpoint）、`prototype.md` §7.2（Reviewer 工具集）、
> `08-retrieval-defects.md`（F-1..F-11 与行为观察 B-1..B-5）、`09-next-stages.md`（S10）

本文的每一条设计都有会话证据支撑，证据内嵌（`runs/` 被 gitignore）。
**最重要的一条是负结果**：一次手工的 $NP$ 消融显示，
陈述式偏好条目在当前模型上的执行率接近于零。这个结果决定了 Reviewer v0 的形态。

---

## 1. 证据基础：三次会话

| 会话 | 时间 | 输入 | 结果 |
| --- | --- | --- | --- |
| `search-d9w6` | 08-21 07:23 | `AutoScholarQuery_train_1`，无提示 | **1/4** |
| `search-98ar` | 08-21 14:43 | 同一条查询，无提示；末尾让 agent 自己提炼通用提示 | 首轮 **0/4**（拿到 gold 后靠标题查询补齐） |
| `search-k9u1` | 08-21 15:05 | 同一条查询 + **98ar 产出的四条通用提示**；另加 `AutoScholarQuery_train_5` | **0/4** 与 **1/5** |

`98ar` → `k9u1` 是一次**手工执行的 P 轴消融**：同一条查询、无上下文的新 agent、
唯一变量是提示前缀。三次会话的原始记录在
`widis/.widi-scholar/runs/--root-projs-scholar-search--/` 下。

---

## 2. 三个可量化的观察

### 2.1 九个工具里只用两个，而且从不使用诊断型工具

```
search-d9w6   共 40 次  6/9 种   search_metadata=22 get_paper=12 list_providers=2
                                 get_budget=2 provider_query=1 expand_citations=1
search-98ar   共 35 次  3/9 种   search_metadata=19 get_paper=15 list_providers=1
search-k9u1   共 64 次  4/9 种   get_paper=33 search_metadata=28 expand_citations=2
                                 list_providers=1
```

**三次会话加起来，`facet_probe`、`rank_candidates`、`search_fulltext` 一次都没有被调用过。**

这三个恰好是**诊断型**工具——不产生新召回，只用来看清已有的东西。
agent 只用两个**生成型**工具（`search_metadata` 检索、`get_paper` 取详情），
形成一个固定循环：搜 → 取 → 搜 → 取。**它从不检视，只不停地抓取。**

这解释了为什么 98ar 提炼的第 2 条提示（"每轮检索后先判断主题一致性"）
在 k9u1 里毫无效果：**提示要求一个动作，而那个动作没有对应的工具被点名**，
于是 agent 用"叙述"代替了"执行"（见 §2.3）。

### 2.2 负结果：四条提示，三条没有被执行

k9u1 的提示前缀是 98ar 自己提炼的，逐条对照它实际做了什么：

| 提示 | 是否执行 | 轨迹证据 |
| --- | --- | --- |
| 1. 并行检索至少 2–3 种常见理解 | **否** | 首轮 6 条子查询全部围绕 superpixel / region / patch，是**同一个**解释 |
| 2. 每轮检索后先判断主题一致性再决定下一步 | **否** | 全程 `facet_probe` 零调用；自评一律正面（§2.3） |
| 3. 同时尝试完整短语查询和关键词组合查询 | **否** | 全部 30 条查询都是关键词式，无一条短语查询 |
| 4. 扩展之前先确认方向 | 试了，但工具坏了 | `expand_citations` 因 F-10 的 id 问题失败，之后彻底放弃 |

第 3 条特别值得记录：agent 在 15:05:16 明确写下

> "根据策略，我会**同时尝试完整短语和关键词组合查询**，覆盖几个相关方向。"

然后发出的 30 条查询里**没有一条是短语查询**。
这是 `08-retrieval-defects.md` B-4 那个"声称 ≠ 执行"的现象，
但这一次提示就写在上下文里、agent 还复述了它——仍然没有执行。

**结论**：陈述式偏好条目在当前模型上，产出的是**对该条目的复述**，不是对它的执行。
召回从 1/4 变成 0/4，提示没有帮助。

### 2.3 自评单调为正，所以自评不能作为诊断

k9u1 全程的过程叙述：

```
"结果有些混杂，需要调整策略"          ← 唯一一次负面，但紧接着只是换了个关键词
"这轮结果中出现了一些更相关的论文！"
"找到了一些关键论文。"
"发现了更多直接相关的论文！"
"引文扩展找到了一些重要论文。"
"发现了更多相关论文。"
"找到了关键论文。"
"发现了大量重要论文。"
"发现了更多重要论文。"          ×3
"发现了关键论文。"
```

在一次最终召回为 **0/4** 的检索里，过程自评没有一次说"这批结果不对"。

这对架构有一个直接后果：**$C^R_t \neq C^M_t$ 不只是防止偏好泄漏，
更是因为同一个上下文里的自评会一路正面。** 诊断必须外部化到一个
看不见 Main 推理、只看轨迹的观察者手里——这正是 Sidecar Reviewer 存在的理由，
而 `design.md` §5.2 之所以要求四个 checkpoint 在 episode **中途**，
也正是因为事后自评没有信息量。

### 2.4 挫折下调用量上升、多样性下降

d9w6（无提示）用了 6/9 种工具；k9u1（有提示）调用量几乎翻倍（64 次）
但只用了 4/9 种。**压力让 agent 做更多的同一件事，而不是做不同的事。**

这与 `08-retrieval-defects.md` 的 B-3（策略在挫折下萎缩而非调整）一致，
现在有了第二个样本。

---

## 3. 从用户的交互里提炼出来的东西

三次会话中用户的每一次介入，本身就是一次人工 review。把它们归类，
得到的正是 Reviewer 需要的动作与纪律。

| 用户的原话 | 这是什么动作 | 落到哪里 |
| --- | --- | --- |
| "你不用检索，如实回复，你检索到这几篇论文了吗" | 对照 gold 自评 | benchmark 动作，**不是** Reviewer 动作（Reviewer 看不到 gold） |
| "不带着答案找问题，而是反思或者简单尝试，为什么这几篇论文没有被找到呢？" | 归因诊断，**且禁止用答案倒推** | §3.1 纪律一 |
| "是为什么呢？是你思考方向的问题吗？完全考虑错了？" | 方向质疑 | 对应 `refine_query` / `increase_diversity` |
| "不使用 active learning 这个关键词，使用 region-based methods for semantic segmentation 整体，尝试一下？" | 具体的查询改写建议 | 对应 `refine_query`，**$t$ 尺度**，允许针对本查询 |
| "你觉得如果给这个问题加上什么提示，能够让 search agent 更好地推进呢？" | 提炼可复用偏好 | **$k$ 尺度**，进 $PH_k$ |
| **"不要，要那种通用的提示，而不是这种针对问题的提示"** | **驳回一条从 gold 反推的条目** | §3.1 纪律二 |

### 3.1 两条必须制度化的纪律

**纪律一：不带着答案找问题（防泄漏）。**

Reviewer 在结构上看不到 gold——它只吃 $\bar{\tau}_t$，这一点 S8 已经落地。
危险发生在**人类种子 $NP_0$ 的时候**：人看得到 gold，
于是很容易写出一条"看起来通用、实际是从答案倒推"的条目。

这在 98ar 里**真实发生过并被当场拦下**。agent 提炼的第一条是：

> "当问题中提到 region-based methods for X 时……要考虑它可能指的是
> **region-based active learning**——即用区域/超像素来做主动学习的样本选择。"

这条如果写进 `np-agent.md`，在 `AutoScholarQuery_train_1` 上会立刻"生效"，
但它学到的不是策略，是**这一条题的答案**。用户的"不要"就是一次
anti-leakage gate 的手工执行。

**可执行的检查**：从失败会话提炼条目时，条目里出现的每一个领域术语，
都必须在**问题原文或该次轨迹**里出现过。gold 里有、轨迹里没有的词，
不得进入条目。这一条应当写进 `preference/README.md` 的写作规程。

**纪律二：$t$ 尺度可以针对本查询，$k$ 尺度不可以。**

用户的"不要针对问题的提示"看似与 Reviewer 的 `refine_query` 动作冲突
（后者天然是针对本查询的），其实不冲突——它们在不同尺度上：

- $A_t$（Reviewer 在 episode 内给出的建议）**可以且应该**具体到本查询，
  "去试 region-based methods for semantic segmentation 这个完整短语"是合法建议；
- $NP_k$（跨 episode 的偏好条目）**必须**是通用策略，
  不得包含具体论文标题、arXiv id、或某个具体查询串。

这条可以**部分自动化**：`scripts/widis-quality.mjs` 增加一条 lint,
`preference/np-*.md` 的条目正文里不得出现 `arXiv:\d{4}\.\d{4,5}` 或
`\d{4}\.\d{4,5}` 形式的 id。标注为 `kind: example` 的条目豁免，
但必须带 `origin`（`np-agent.md` 已有这个字段约定）。

---

## 4. 核心设计原则：条目必须绑定一个可从 $\bar{\tau}_t$ 读出的观察量

§2.2 的负结果给出的教训不是"提示没用"，而是
**不可观察的提示没用**。一条偏好条目如果无法判断它有没有被执行，
它就既不能被 Reviewer 检查、也不能被实验测量、还会被 agent 用复述蒙混过去。

所以：**每条 $NP$ 条目必须能改写成一个对 $\bar{\tau}_t$ 的断言。**

把 98ar 的四条提示按这个原则重写：

| 原提示（k9u1 实测未执行） | 可观察的改写 | 观察量（$\bar{\tau}_t$ 中） |
| --- | --- | --- |
| 每轮检索后先判断主题一致性 | 初始召回完成后、发起第二轮检索之前，调用一次 `facet_probe` | `callsByTool.facet_probe ≥ 1` 且首次调用早于第 2 次 `search_metadata` |
| 同时尝试短语查询和关键词查询 | 每个检索意图至少发一条带引号的短语查询 | `subqueries` 中含引号的条数 ≥ 1 |
| 不要假设唯一解释，并行 2–3 种理解 | 首轮子查询中至少存在一对，其核心名词不重叠 | 首轮 `subqueries` 两两 Jaccard < 0.5 的对数 ≥ 1 |
| 扩展前先确认方向 | **暂缓**——这条本身不可观察，且 F-10 让 `expand_citations` 不可用 | — |

第四条被砍掉是刻意的：**宁可少一条，不要留一条无法检查的**。
`06-widi-scholar-roadmap.md` §3 那段"判据弱于设计"的告诫，
在偏好条目这一层同样适用。

**这不等于把 $NP$ 变成参数。** 阈值（"至少一条"、"Jaccard < 0.5"）属于 $HP_k$，
按 `05-skill-decomposition.md` §2 的判定顺序应当拆出去；
留在 $NP$ 里的是**动作语义**（"要发短语查询"、"首轮要覆盖不同解释"）。
条目与观察量的绑定关系写在条目的元数据里，不写在正文里。

---

## 5. Reviewer v0 的形态

### 5.1 检测器计算条件，Reviewer 决定说什么

`design.md` 要求 Reviewer 是独立 agent（$C^R_t \neq C^M_t$ 是硬机制），
这一点不能退。但**触发**不能交给模型：如果介入与否取决于 Reviewer 模型的判断，
介入率就成了内生变量，$\Delta_{\mathrm{sidecar}}$ 无法归因
（这正是 `07-widi-mapping.md` §3.4 否决 `ask_reviewer` 方案的同一条理由）。

所以 v0 分两层：

1. **检测器**：纯函数，输入 $\bar{\tau}_t$，输出一组"已触发的条件"。
   确定性，可脱离模型测试，与 `core/review.ts` 的 gate 同构。
2. **Reviewer agent**：拿到轨迹 **加上** 已触发条件清单，
   决定就哪一条发建议、写 `instructions`、给 `expectedEffect`。

渲染层已经具备条件——`renderTraceForReviewer` 输出的
`PUBLIC SEARCH TRACE` 里已经有 `callsByTool`、`subqueries`、`evidence`、
`failures`（带 `errorType`）、`candidateCounts`。
**v0 的七个检测器全部只用这些已有字段，不需要新的轨迹通道。**

### 5.2 七个检测器

每个映射到 `ADVICE_ACTIONS` 里已有的动作，**不新增动作**。
`design.md` §5.2 的 checkpoint 编号一并标出。

| # | 检测器 | 触发条件（对 $\bar{\tau}_t$） | 建议动作 | checkpoint |
| --- | --- | --- | --- | --- |
| R1 | 从未勘察分布 | `search_metadata ≥ 3` 且 `facet_probe = 0` | `check_constraint` | ② |
| R2 | 查询单调 | 所有 `subqueries` 两两 Jaccard ≥ 0.5 | `increase_diversity` | ③ |
| R3 | 零短语查询 | `subqueries` 中无一条含引号 | `refine_query` | ① |
| R4 | 扩展缺席或全败 | `expand_citations = 0` 且 `evidence ≥ 10`；或调用数 >0 且全部落在 `failures` | `expand_citation` | ② |
| R5 | 来源失衡 | `evidence` 的 `sources` 全部单一，或同一 source 的 `failures ≥ 3` | `add_source` | ③ |
| R6 | 只抓不看 | `get_paper / search_metadata > 1.0` 且 `rank_candidates = 0` | `rerank` | ② |
| R7 | 预算接近上限 | `budget.totalCalls` 超过 $\theta^S_k$ 中的软上限 | `stop` | ③ |

R1、R3、R6 直接对应 §2.1 与 §2.2 里实测到的三个行为缺陷；
R4 对应 F-10 的后果；R5 对应 d9w6 里 OpenAlex 全挂却继续盲试的那一段。

**每个检测器至多产出一条建议**，再经 `core/review.ts` 现有的 gate
（`DEFAULT_MAX_PER_EPISODE = 6`、`DEFAULT_MAX_PER_ACTION = 2`、
novelty key 去重）过滤。检测器不绕过 gate。

### 5.3 触发时机

这是 G-1 的正面修法。当前 review 挂在 `agent_idle` 上、
`MAX_REVIEWS_PER_AGENT = 1`，即 $A_t$ 里的 $t$ 恒等于 $T+1$。

v0 改为挂在 `tool_execution_end` 上，检测器在每次工具调用结束后重跑，
条件**从未触发变为触发**的那一刻投递建议。这自然对上 §5.2 的前三个 checkpoint：

- ① 初始召回完成 = 第一次 `search_metadata` 成功返回后；
- ② 一轮候选合并或引文扩展完成 = 后续每次 `search_metadata` / `expand_citations` 结束后；
- ③ 检测到覆盖不足 / 噪声突增 / 来源失衡 / 预算接近上限 = R2/R5/R7 触发时；
- ④ 生成最终 $SO$ 之前 = **S10 的答案池给出的新钩子**——
  agent 首次写入答案池、或 `agent_idle` 之前，见 §5.4。

`MAX_REVIEWS_PER_AGENT` 相应从 1 提到与 gate 的 episode 上限一致（6）。

### 5.4 与 S10 答案池的关系

答案池（`09-next-stages.md` S10）给 Reviewer 提供了**它现在没有的东西**：
一个可以直接读出覆盖缺口的对象。

R2（查询单调）现在只能看查询词的重叠，这是个弱代理；
有了答案池，同一个判断可以直接看**已承诺论文的主题分布**——
"池中八篇全是 superpixel segmentation，没有一篇涉及标注策略"
比"子查询词重叠率高"强得多。

所以 §5.2 的检测器表里，R2 与 R6 在 S10 之后应当升级为读答案池。
**但 v0 不等 S10**：七个检测器全部只用现有字段就能实现，
先落地再升级，避免两个 stage 互相阻塞。

### 5.5 v0 明确不做的事

- **不做 LLM 触发**：见 §5.1。检测器保持确定性。
- **不新增 advice action**：`ADVICE_ACTIONS` 的七个够用，
  S10 之后若要加 `organize_answer` 再单独论证。
- **不修改 Main 的工具集**：Reviewer 的建议靠 `precede` 注入下一轮上下文，
  Main 结构上仍然无法向 Reviewer 求助（`07-widi-mapping.md` §3.4）。
- **不做建议采纳率的自动统计**：那需要把"Main 是否照做"从轨迹里判出来，
  属于 M 轴的测量工作，不在本 stage。

---

## 6. S11 — Reviewer v0 与 $NP_0$ 重写

**目标**：让 $A_t$ 在 episode 中途产生，并让每条偏好条目可被检查是否执行。

**前置**：F-1（arXiv AND 拼接）、F-2（失败原因透出）、F-10（id 归一）。
F-10 是 R4 检测器的前提——扩展工具坏着的时候，"建议去做引文扩展"是有害建议。

**落点**：

- `core/review.ts` 新增七个检测器（纯函数，与 gate 同文件同风格）
- `index.ts` 的 review 触发从 `agent_idle` 移到 `tool_execution_end`，
  `MAX_REVIEWS_PER_AGENT` 提到 6
- `renderTraceForReviewer` 增加 `DETECTED CONDITIONS` 段
- `preference/np-agent.md` 按 §4 重写：每条绑定观察量，阈值拆进 $HP$
- `preference/README.md` 补写作规程（§3.1 的两条纪律）
- `scripts/widis-quality.mjs` 增加 §3.1 纪律二的 lint

**做什么**：见 §4、§5。检测器的阈值来自配置，不硬编码
（`design.md` §4：一个硬编码的边界无法为实验收窄）。

**验收**：

1. 拿 `search-k9u1` 的轨迹作为固定输入喂给检测器，
   **R1、R3、R6 必须触发**——这三条是该次会话实测存在的缺陷，
   检测器认不出它们就是没写对；
2. 一次真实检索中，至少一条 `provide_advice` 的投递时刻**早于**
   最后一次 `search_metadata`（即建议有机会改变它所审查的那次搜索——
   这是 G-1 的正面判据）；
3. gate 的拒绝记录里能看到检测器重复触发被 novelty key 挡下的条目
   （说明检测器接在 gate 之内，没有绕过）；
4. `np-agent.md` 的每条条目都能指出它对应 $\bar{\tau}_t$ 的哪个字段；
   指不出的条目要么改写，要么删除；
5. lint 能拦下一条含 arXiv id 的条目。

**这些判据不检验什么**：建议的**质量**，以及 Main 是否采纳。
判据 2 只验"有机会被读到"，不验"读了之后变好了"——
后者是 M 轴的结论，需要 S10 的召回指标才能测。
按 `06-widi-scholar-roadmap.md` §3 的规矩，若发现两者被混谈，
差额写进"验收缺口"，不要放宽判据。

**独立价值**：G-1 关闭；$NP$ 条目从"不可检查的劝告"变成"可检查的断言"。

---

## 7. 尚未决定的问题

按用户的要求把路径写到"不留过多疑问"，但有三处确实还没有答案，
显式列出，不要在实现时临时拍板：

**Q1：检测器触发后，Reviewer agent 每次都要重新起吗？**
现在 `runReview` 每次 spawn 一个新 Reviewer。改成 `tool_execution_end` 触发后，
一个 episode 内最多 6 次 spawn，代价可能不小。
备选是复用同一个 Reviewer agent 实例（它有自己的 session，$C^R_t \neq C^M_t$ 仍成立），
但那样 Reviewer 就有了跨 checkpoint 的记忆——**这是否违反"旁路观察者"的定位，
需要回到 `design.md` §5.2 确认。** 建议实现时先按"每次新起"做，
把复用留作一次单独的优化，并测量它对 $\Delta_{\mathrm{sidecar}}$ 的影响。

**Q2：R2 的 Jaccard 阈值取多少？**
0.5 是本文的占位值，没有依据。它属于 $HP_k$，应当进 `config.yaml` 并可搜索。
落地时先取一个值跑通，把定值这件事留给 $HP$ 的搜索阶段，
**不要在代码里写死**。

**Q3：$NP_0$ 重写后，条目数会从 30 条降到多少？**
§4 的原则会砍掉相当一部分不可观察的条目。
`05-skill-decomposition.md` §5 结论二估的量级是 25–30 条，
那是按"能不能写成一条指导"估的，不是按"能不能被观察"估的。
重写后可能只剩十几条。**这不是损失**——一条无法检查的条目在实验里
提供的是噪声而不是信号。但它会影响 P 轴的设计（对照组的条目数变了），
落地时要在 `experiments.md` 里同步。
