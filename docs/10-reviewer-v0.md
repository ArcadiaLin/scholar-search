# Reviewer v0 与 $NP_0$ 重写：从三次真实会话推出来的设计

> 状态：设计，尚未执行。stage 定义在 §6（S11），关键决策 D-10..D-12 / D-14 / D-15 在 §7
> 读者：要实现 Reviewer 第一版、或要写 $NP_0^{agent}$ 条目的人
> 前置：`design.md` §5.2（四个 checkpoint）、`prototype.md` §7.2（Reviewer 工具集）、
> `08-retrieval-defects.md`（F-1..F-11 与行为观察 B-1..B-5）、`09-next-stages.md`（S10）

**路径约定**：本文出现的裸文件名按下表还原，正文不再重复前缀。

| 写法 | 实际路径 |
| --- | --- |
| `index.ts` / `core/*.ts` | `widis/.widi-scholar/extensions/scholar-search/` 下 |
| `profiles/*.md` / `preference/*.md` | `widis/.widi-scholar/` 下 |
| `config.yaml` | `src/search-service/config.yaml`（**只有这一份**，属于 Python 服务） |
| `run.mjs` | `experiments/eval-runner/run.mjs` |
| `extensions.md` / `orchestrator.md` | `packages/widi/apps/widi/docs/` 下 |

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

### 5.2b Reviewer 是常驻的，在启动时就起来

**决策 D-10。** Reviewer 不再"每次 checkpoint spawn 一个"，而是在
`npm run widi:scholar` 启动时随 search agent 一起起来，episode 全程存活。

理由有三条，第三条是决定性的：

1. **省掉每个 checkpoint 的 spawn 开销**。改成 `tool_execution_end` 触发后，
   一个 episode 内可能有六次介入，六次冷启动不可接受。
2. **用户可以直接跟它对话**。TUI 有 agent strip（`views/agent-strip.ts`，
   左右键在 agent 间移动），主视图停在 search，需要时切过去问 Reviewer
   "你为什么没提这一条"。**这正是 §3 那张表的用途**——
   人工 review 动作是 $NP_0$ 的种子来源，而现在人只能对着 Main 说话。
3. **常驻更贴合形式化，不是妥协**。`design.md` 写的是 $C^R_t$——
   **带 $t$ 下标**。Reviewer 的上下文本来就是随 $t$ 演化的，
   "每次新起一个无记忆的 Reviewer"反而是对形式化的削弱。
   一个记得"我上一个 checkpoint 已经提过多样性"的 Reviewer，
   比一个每次从零开始、靠 gate 的 novelty key 去重的 Reviewer 更接近设计意图。

**启动机制**：挂在 `agent_spawned` 上，条件是 `event.profile.id === "search"`。

`agent_spawned` 的载荷带 `profile: AgentProfile` 与 `spawnedBy?: AgentId`
（`packages/widi/apps/widi/src/core/types.ts:232`），所以规则可以写成一句：
**search agent 一建立，就给它附一个 Reviewer。**

递归是这条规则自动挡掉的，不需要额外状态。spawn/idle 一类事件
**向同一 agent tree 广播**（`packages/widi/apps/widi/docs/extensions.md:167`），
因此 Reviewer 自己的 `agent_spawned` 也会回到同一个 observer——
但它的 `profile.id` 是 `reviewer`，条件不成立，不会再生一个。
这比"维护一张 `reviewerToSubject` 表再查"更可靠，因为同一行文档还写着
**"事件到达顺序不保证；尤其处理其他 agent 时，必须容忍先收到状态事件、后收到
`agent_spawned`"**——任何依赖"先建表再判断"的守卫都可能来不及，
而按 `profile.id` 判断是**无状态**的，与顺序无关。

**三条机械约束**（核过 WIDI 的 orchestrator 契约，不要在实现时才发现）：

- **Reviewer 是 search 的子 agent，不是并列的第二个 main agent。**
  `packages/widi/apps/widi/docs/extensions.md` §"向模型发送文本"写明
  "`spawnAgent` 只会创建当前 agent 的子 agent"。这不影响任何设计属性——
  父子关系是**会话目录嵌套**（持久化事实），不是上下文共享；
  $C^R_t \neq C^M_t$ 照样成立，agent strip 里显示为一棵树，用户照样能切过去。
- **`prompt` 要求目标空闲，忙时拒绝而不排队。** 这条只影响
  **extension → Reviewer** 这个方向（投递轨迹）：Main 连续两次更新答案池时，
  第二次投递会被拒。必须在 extension 侧排队或跳过，并把跳过记进 gate 的拒绝日志——
  一条被静默丢掉的 review 触发，和一次从未发生的触发长得一模一样。
  **反方向（Reviewer → Main 的建议）没有这个问题**，见 §5.2d。
- **Reviewer 的生命周期 = Main 的 episode，不是 session。**
  TUI 里一个 session 通常就是一个 episode，两者重合；但 eval runner
  **每条查询 spawn 新 Main**（`run.mjs:208` 的注释写明理由：共享上下文会让
  查询 N 看到查询 N-1）。Reviewer 若跨查询存活，就会把这条隔离破坏掉。
  按上面的启动机制，这是**自动满足**的：每个 search agent 的 `agent_spawned`
  各配一个 Reviewer，随所审查的 Main 一起 dispose。

### 5.2c Reviewer 拿细节靠"拉轨迹"，不是"读 Main 的上下文"

**这是本文最硬的一条边界，单独成节。**

常驻 Reviewer 会自然产生一个需求：它想看得比摘要更细——
某次检索到底返回了什么、池子里那八篇的摘要各自在说什么。
**这个需求是合理的，但满足它的方式只有一种。**

- ✅ **拉取式工具，作用域限定在轨迹内。** `inspect_evidence` 已经是这个形态，
  它的描述里就写着 "limited to the trace - it cannot fetch anything the search
  did not already find"。要更多细节，就**扩宽 $\bar{\tau}_t$ 的白名单**，
  并把这次扩宽显式记录下来。
- ❌ **任何读取 Main 上下文的工具。** 这会一次性摧毁三样东西：
  S6 逐片段查证的 `leaks 0`、$C^R_t \neq C^M_t$ 这条硬机制，
  以及"建议可归因于可观察轨迹"这个前提。更远一点的后果是：
  由这种建议学到的偏好会把 Main 的推理编码进 $PH_k$，
  而 $PH_k$ 是要跨 episode 复用的——那就成了污染。

**判据不是"给多少细节"，而是"这条信息从过滤器的哪一侧来"**：

| 来源 | 归属 |
| --- | --- |
| Main 发出的工具调用入参 | 公开，可给 |
| 工具返回的结果 | 公开，可给 |
| Service 产出的 `SearchState` / `Provenance` | 公开，可给 |
| 答案池的内容（S10） | 公开，可给 |
| Main 的 thinking block、未落成工具调用的推理 | **私有，永不可给** |

细节可以任意多，只要它是**工具的输入输出**而不是**Main 的想法**。
按这条判据，v0 需要扩宽的白名单只有一处：`TraceEvidence` 现在只有
`paperId / title / sources / foundBy`，Reviewer 判断覆盖缺口需要**摘要或主题**。
这一处扩宽走 `core/trajectory.ts` 的 `COLLECTED_EVENTS` 白名单，
记成决策，不要顺手加。

### 5.2d 建议是"一条一发的消息"，不是"一池一推的清单"

**先说当前实现里的一个坑**，常驻化之后它会立刻发作。

`AdviceGate.admitted()` 返回的是**累计全量**——`core/review.ts:84` 的注释就写着
"Everything admitted, in order"。而 `index.ts:486` 在每次 review 结束时取的正是
`gate.admitted()` 的全量，拼成编号清单一次性 `precede` 给 Main。

现在不出问题，只因为 Reviewer 每次新起、gate 也跟着新建，一个 gate 只服务一次 review。
**改成常驻之后 gate 只有一个**：第三个 checkpoint 会把前两次已经投递过的建议再投一遍，
第六个 checkpoint 投六遍。Main 会看到同一条建议反复出现——
而 §2.3 已经证明这个模型对重复内容的反应是复述而不是执行。

**正确形态**：参照 WIDI 原生 `send_message` 的语义——**Reviewer 给 search agent 发消息**，
一条建议一条消息，在它被 gate 放行的那一刻发出，不攒池子。

原生工具的语义是（`packages/widi/apps/widi/src/core/tools/agents/send-message.ts:93`）：

> "delivers the text and returns once the other agent has it; **that agent reads it on its
> next turn**" —— 并且 "send\_message **never waits for a reply**"。

**extension 侧已经有语义完全相同的原语，就是 `precede`。** `index.ts:498` 的注释
早就说明了为什么选它而不是 `prompt` / `followUp`："advice is context for work not yet
started"——投进下一轮上下文、不唤醒、不等回复。所以**这里不需要新机制，
需要改的是载荷和时机**：

| | 现在 | 改成 |
| --- | --- | --- |
| 载荷 | `gate.admitted()` 全量清单 | 刚被放行的**那一条** |
| 时机 | review 结束时 | `provide_advice` 放行的当下 |
| 次数 | 每次 review 一次，内容累积 | 每条建议一次，内容不重复 |

**为什么不直接把原生 `send_message` 加进 Reviewer 的 `tools:`。**
那样建议就**绕过了 gate**——动作白名单、证据引用检查、novelty 去重、
长度上限（`DEFAULT_MAX_INSTRUCTION_CHARS = 1_000`）全部失效，
而这些正是 `design.md` 要求"建议是**有界**的"所指的东西。
所以工具仍然是 `provide_advice`：**它就是"发消息"的受闸版本**，
Reviewer 的动作语义不变，变的只是 extension 在放行之后立刻投递一条，而不是最后推一池。

副带的好处：`prompt` 忙时被拒的问题在这个方向上不存在——
`precede` 写的是下一轮上下文，不要求 Main 空闲。§5.2b 第二条只对
extension → Reviewer 那个方向成立。

### 5.2e 阈值放 Service 侧的 `config.yaml`，逻辑留在 extension（决策 D-15）

**先纠正一处会让实施者卡住的说法。** 本文早先写"检测器阈值进 `config.yaml`
作为 $HP$ 落位"，但：

- `config.yaml` 只有一份，在 `src/search-service/`，顶层键是
  `service` / `limits` / `llm_providers` / `plugins`，它是 **Python 服务**的配置；
- 检测器要写在 `core/review.ts`，是 **TypeScript extension**；
- extension 的配置来源**全部是环境变量**（`SCHOLAR_TRACE_DIR` / `SCHOLAR_REVIEWER` /
  `SCHOLAR_REVIEWER_MODEL`），代码里一次 yaml 都没有。

也就是说，原来那句话指的是一条**不存在的通路**。

**决定**：阈值确实应该纳入 Service 侧——它们是 $HP_k$，
而 $HP_k$ 的唯一权威载体就是 `config.yaml`（$\theta^S_k = \mathrm{Configure}(P, HP_k, NP_k^{judge})$
这条边的起点在那里）。散在环境变量里会让 $HP$ 搜索无从下手。

- `config.yaml` 新增 `review:` 段，放 R1–R7 的阈值（含 R2 的 Jaccard）；
- Service 新增一个只读端点返回该段，extension 在 spawn Reviewer 时取一次；
- `service-client.ts` 增加对应方法，与已有的 `getBudget()` 同形。

沿用 D-13 的口径：**多一次 API 调用是明确接受的**，一个 episode 只调一次。

**但检测器的逻辑留在 `core/review.ts`，不搬进 Service。** 这条要写清楚，
否则后来的人会以为"既然阈值都去 Service 了，逻辑也该去"，然后动手搬：

检测器读的是 `PublicSearchTrace`——一个由 WIDI 事件流装配出来的
**extension 侧类型**（`core/trajectory.ts`）。把检测器搬进 Service，
就必须在 Python 里镜像一份它的 schema，于是 Service 被绑死在 WIDI 的事件形状上。
`search-service.md` 开篇立的规矩是"只描述接口、机制与边界，
**不绑定任何具体数据源、算法或指标**"，这个耦合正好撞上它。
阈值是数据，跨进程传是廉价的；轨迹是结构，跨进程传要复制 schema。

### 5.3 触发时机

这是 G-1 的正面修法。当前 review 挂在 `agent_idle` 上、
`MAX_REVIEWS_PER_AGENT = 1`，即 $A_t$ 里的 $t$ 恒等于 $T+1$。

v0 有**两个触发源，取并集**：

**触发源一：答案池更新（决策 D-11）。** Main 每次调用 `update_answer_pool`，
extension 就向常驻 Reviewer 投递一次当前轨迹。这是个语义上很干净的
checkpoint——"Main 刚刚承诺了一批论文"正对上 `design.md` §5.2 的
第②与第④个 checkpoint，而且 Reviewer 此时有最具体的东西可看（§5.4）。

**触发源二：七个检测器（§5.2）。** 挂在 `tool_execution_end` 上，
检测器在每次工具调用结束后重跑，
条件**从未触发变为触发**的那一刻投递建议。这自然对上 §5.2 的前三个 checkpoint：

- ① 初始召回完成 = 第一次 `search_metadata` 成功返回后；
- ② 一轮候选合并或引文扩展完成 = 后续每次 `search_metadata` / `expand_citations` 结束后；
- ③ 检测到覆盖不足 / 噪声突增 / 来源失衡 / 预算接近上限 = R2/R5/R7 触发时；
- ④ 生成最终 $SO$ 之前 = **S10 的答案池给出的新钩子**——
  agent 首次写入答案池、或 `agent_idle` 之前，见 §5.4。

**`MAX_REVIEWS_PER_AGENT` 取消，不保留、也不改成别的数（决策 D-14）。**

原先写的是"从 1 提到与 gate 的 episode 上限一致（6）"，这是把两个不同的量当成了一个：

| 量 | 计什么 | 谁在管 |
| --- | --- | --- |
| `MAX_REVIEWS_PER_AGENT` | review **轮次** | `index.ts:272`，本次取消 |
| `DEFAULT_MAX_PER_EPISODE = 6` | 放行的**建议条数** | `core/review.ts:38`，保留 |

两者都设成 6 会得到一个坏结果：第一个 checkpoint 若一次吐满 6 条，
就把整个 episode 的建议预算耗尽，后面五次触发全部空转——
**而越靠后的 checkpoint 掌握的轨迹越多，建议本该越准。**

正确的边界只有一个：**限建议条数，不限观察次数。** 让 Reviewer 想看多少次看多少次，
真正流向 Main 的东西由 gate 管住。这也更贴合"Reviewer 是旁路观察者"的定位——
观察本身不该有配额，介入才该有。

（触发次数的天然上限来自检测器的形状：R1–R7 各自只在条件
**从未触发变为触发**时投递一次，见本节下文。所以轮次不会无界增长。）

**为什么必须保留触发源二，而不是只用答案池。** 答案池更新是 Main 的动作，
如果它是唯一触发源，Main 就**间接控制了介入率**——不写池子就不被审查。
这会让 $\Delta_{\mathrm{sidecar}}$ 的归因重新变成内生的，
正是 `07-widi-mapping.md` §3.4 否决 `ask_reviewer` 时担心的那件事。
检测器是**地板**：不管 Main 写不写池子，R1–R7 到了条件就触发。

（一个相关的可测风险：Main 若学到"写池子会召来 Reviewer"，可能少写或多写。
这与 `09-next-stages.md` §2.6 第二条是同一类副作用，合并观察即可，
观察量是"池子首次写入时刻"与"池子写入次数"。）

### 5.4 与 S10 答案池的关系

答案池（`09-next-stages.md` S10）给 Reviewer 提供了**它现在没有的东西**：
一个可以直接读出覆盖缺口的对象。

R2（查询单调）现在只能看查询词的重叠，这是个弱代理；
有了答案池，同一个判断可以直接看**已承诺论文的主题分布**——
"池中八篇全是 superpixel segmentation，没有一篇涉及标注策略"
比"子查询词重叠率高"强得多。

所以 §5.2 的检测器表里，R2 与 R6 在 S10 之后应当升级为读答案池。

**"检测器不依赖 S10"不等于"S11 可以排在 S10 之前"。** 顺序仍然是
S10 → S11（`09-next-stages.md` §1）。这里说的是**降级路径**：
七个检测器只用 $\bar{\tau}_t$ 的现有字段就能实现，
所以万一 S10 延期，S11 的检测器部分不被阻塞。
但 §5.3 的**触发源一（答案池更新）确实依赖 S10**，
它是 D-11 的一半——只做检测器就只有触发源二，
$\Delta_{\mathrm{sidecar}}$ 的归因论证不完整。

### 5.5 v0 明确不做的事

- **不做 LLM 触发**：见 §5.1。检测器保持确定性。
- **不新增 advice action**：`ADVICE_ACTIONS` 的七个够用，
  S10 之后若要加 `organize_answer` 再单独论证。
- **不修改 Main 的工具集**：Reviewer 的建议靠 `precede` 注入下一轮上下文，
  Main 结构上仍然无法向 Reviewer 求助（`07-widi-mapping.md` §3.4）。
  注意常驻 Reviewer **不改变**这一点：`prompt` 的 `target` 是 extension 在用，
  不是 Main 在用；Main 的 `tools:` 里依然没有 `spawn_agent` / `send_message`。
- **不给 Reviewer 任何读取 Main 上下文的工具**：见 §5.2c。
- **不做建议采纳率的自动统计**：那需要把"Main 是否照做"从轨迹里判出来，
  属于 M 轴的测量工作，不在本 stage。

---

## 6. S11 — Reviewer v0 与 $NP_0$ 重写

**目标**：让 $A_t$ 在 episode 中途产生，并让每条偏好条目可被检查是否执行。

**前置**：F-1（arXiv AND 拼接）、F-2（失败原因透出）、F-10（id 归一）。
F-10 是 R4 检测器的前提——扩展工具坏着的时候，"建议去做引文扩展"是有害建议。

**落点**：

路径按仓库根写全，不要只写文件名。extension 的三个文件都在
`widis/.widi-scholar/extensions/scholar-search/` 下。

**extension 侧**

- `core/review.ts`：新增七个检测器（纯函数，与 gate 同文件同风格）
- `index.ts`：Reviewer 改为在 `agent_spawned` observer 里起，条件
  `event.profile.id === "search"`，episode 全程常驻（§5.2b）；
  review 触发从 `agent_idle` 移到 `tool_execution_end` 与 `update_answer_pool` 两处；
  **删除 `MAX_REVIEWS_PER_AGENT`**（`index.ts:272`，决策 D-14）；
  建议投递改为**每条放行即发一条**，不再取 `gate.admitted()` 全量（§5.2d）
- `core/trajectory.ts`：`TraceEvidence` 增加摘要/主题字段
  （§5.2c 的唯一一处白名单扩宽）
- `core/review.ts` 的 `renderTraceForReviewer`：增加 `DETECTED CONDITIONS` 段
- `core/service-client.ts`：增加读取 `review:` 配置段的方法，与 `getBudget()` 同形

**Service 侧**

- `src/search-service/config.yaml`：新增 `review:` 段，放 R1–R7 的阈值
  （含 R2 的 Jaccard，先取 0.5）作为 $HP$ 落位（§5.2e）
- `src/search-service/src/search_service/api/`：新增只读端点返回该段

**配置与偏好**

- `widis/.widi-scholar/profiles/reviewer.md`：`whenToUse` 现在写的是
  "extension starts it **at a review checkpoint**"，与常驻矛盾，需改写；
  `tools:` 保持 `[provide_advice, inspect_evidence, get_ranking_features]`
  **不变**——尤其不要加原生 `send_message`，理由见 §5.2d
- `widis/.widi-scholar/preference/np-agent.md`：按 §4 重写并分成两组（决策 D-12）
- `widis/.widi-scholar/preference/README.md`：补写作规程（§3.1 的两条纪律）
- 纪律二的 lint：**注意 `scripts/widis-quality.mjs` 是 biome 的驱动器**
  （对各 namespace 跑 lint / format / typecheck），它不检查 markdown 正文。
  这条 lint 要作为独立检查步加进去，不是往现有规则里塞一条

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
4. 一个 episode 内触发三次以上 review，Main 收到的建议**没有一条重复**——
   这条直接验 §5.2d：投递的是刚放行的那一条，不是 `gate.admitted()` 的累计全量；
5. Reviewer 常驻期间，`agent_spawned` 只为 `profile.id === "search"` 的 agent
   配 Reviewer，**一个 episode 里 Reviewer 恰好一个**（验 §5.2b 的递归防护）；
6. `np-agent.md` 的**绑定组**每条都能指出它对应 $\bar{\tau}_t$ 的哪个字段，
   且满足 D-12 的可绑定判据（关掉它轨迹会不同）；
7. lint 能拦下一条含 arXiv id 的条目；
8. TUI 里用户能切到 Reviewer 并直接与它对话，且切过去看到的上下文里
   **没有** Main 的私有推理（沿用 S8 的逐片段查证方法，leaks = 0）。

**这些判据不检验什么**：建议的**质量**，以及 Main 是否采纳。
判据 2 只验"有机会被读到"，不验"读了之后变好了"——
后者是 M 轴的结论，需要 S10 的召回指标才能测。
按 `06-widi-scholar-roadmap.md` §3 的规矩，若发现两者被混谈，
差额写进"验收缺口"，不要放宽判据。

**独立价值**：G-1 关闭；$NP$ 条目从"不可检查的劝告"变成"可检查的断言"。

---

## 7. 决策（原"尚未决定的问题"，2026-08-22 定）

### D-10 — Reviewer 常驻，随 search agent 一起启动

见 §5.2b。原先写的是"先按每次新起做"，被推翻了：
常驻不是性能妥协，而是更贴合 $C^R_t$ 这个**带 $t$ 下标**的记号，
并且解锁了用户直接与 Reviewer 对话这条通道——而人工 review 动作
正是 $NP_0$ 的种子来源（§3）。

三条机械约束（子 agent 而非并列、`prompt` 忙时被拒、生命周期 = episode）
写在 §5.2b，实现时按那里做。

### D-11 — 触发源取"答案池更新"与"七个检测器"的并集

见 §5.3。只用答案池会让 Main 间接控制介入率，
$\Delta_{\mathrm{sidecar}}$ 的归因重新变成内生的。检测器是地板。

### D-12 — $NP_0$ 重写后**分两组**，不追求某个条目数

原先的问法（"会从 30 条降到多少"）本身就问错了：答案不该是一个数字，
而该是一个划分。

- **绑定组 A**：条目携带 `observable:` 元数据，指明它断言 $\bar{\tau}_t$ 的哪个字段。
  **P 轴的消融只作用于这一组**，因为只有它的开关能产生可测的差异。
- **未绑定组 B**：条目保留在文件里，标 `observable: none`，
  **排除在消融之外**，并各自写清为什么暂时绑不了。

这样处理有四个好处：不丢失 `05-skill-decomposition.md` 追溯到的 CF-* 出处；
P 轴作用在一个良定义的集合上；B → A 的提升成为一条具体的、可增量推进的工作队列；
条目数这个问题自然消失。

**可绑定的判据**，一句话：

> 一条条目可绑定，当且仅当**关掉它会让轨迹不同**。
> 关掉它轨迹一模一样的条目，按构造就是不可观察的。

值得注意的是：**这与 S5 的消融判据是同一条**。
这也顺带解释了 S5 那次"轨迹形状明显不同"为什么难验——
如果当时 30 条里多数是不可绑定的，"关掉全部条目轨迹不变"本就是预期结果，
而不是实现出了问题。

落地时把 A / B 的划分结果同步进 `experiments.md` 的 P 轴定义。

### D-14 — 取消 `MAX_REVIEWS_PER_AGENT`，只限建议条数

见 §5.3。轮次与条数是两个量，把两者都设成 6 会让第一个 checkpoint
吃光整个 episode 的建议预算。观察不设配额，介入才设配额。

### D-15 — 检测器阈值进 Service 的 `config.yaml`，检测器逻辑留在 extension

见 §5.2e。阈值是 $HP_k$，唯一权威载体是 `config.yaml`，每 episode 取一次；
逻辑不搬，因为搬了就要在 Python 里镜像 `PublicSearchTrace` 的 schema，
把 Service 绑死在 WIDI 的事件形状上。

> 另有 **D-13**（答案池的身份归一通路）记在 `09-next-stages.md` §2.3b 与 §4，
> 因为它属于 S10 的落地决定。

---

## 8. 剩余的实现期风险

不是未决问题，是**已知会在实现时咬人的地方**，按顺序排：

1. **`prompt` 忙时被拒**（§5.2b 第二条）。**只在 extension → Reviewer
   这个方向**（投递轨迹）；反方向的建议走 `precede`，不受影响（§5.2d）。
   最可能的表现是：Main 连续两次写池子，第二次 review 静默消失。
   **必须显式排队或显式记录跳过**，不能让它变成"看起来没触发"。
2. **常驻 Reviewer 的上下文会涨**。六次 checkpoint 各投递一次完整轨迹，
   到后期上下文里有六份高度重复的 trace。
   建议投递**增量**（自上次 checkpoint 以来新增的调用与证据）+ 一份当前汇总，
   而不是每次重发全量。这不影响 $C^R_t$ 的语义。
3. **R2 的 Jaccard 阈值 0.5 没有依据**，是跑通用的占位值。
   它属于 $HP_k$，落位与取用的通路见 §5.2e（D-15），**不要写进代码**；
   定值留给 $HP$ 的搜索阶段。
4. **白名单扩宽有滑坡风险**。§5.2c 批准的是**一处**扩宽
   （`TraceEvidence` 加摘要/主题）。之后每一次"Reviewer 还想看点别的"
   都要回到 §5.2c 那张表判一次来源，不能因为"上次也加了"就顺手加。
