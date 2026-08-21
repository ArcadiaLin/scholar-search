# 设计概念 → WIDI 载体映射

> 状态：对照表，随实现推进而更新
> 读者：要在这个仓库里找到某个设计概念的实际位置的人
> 前置：`design.md`（形式化）、`search-service.md`（Service 契约）、
> `prototype.md`（原型形态）、`06-widi-scholar-roadmap.md` §1.2（映射摘要）

`06-widi-scholar-roadmap.md` §1.2 给了一张五行的摘要表。本文是它的展开版：
每个概念的**实际文件路径**、**为什么这样映射**，以及——同样重要——
**哪些概念故意没有对应的代码模块**。

---

## 1. 总表

| 设计概念 | WIDI 载体 | 实际路径 | 状态 |
| --- | --- | --- | --- |
| Main Search Agent | profile | `widis/.widi-scholar/profiles/search.md` | S3 已落地 |
| $T^M$ 工具集 | extension 的 `registerTool` | `widis/.widi-scholar/extensions/scholar-search/index.ts` | S7 已补齐九个 |
| $SP_M$ 静态部分 | profile body | `profiles/search.md` 正文 | S3 已落地 |
| $NP_k^{agent}$ | profile `projectContext` 指向的受控文件 | `widis/.widi-scholar/preference/np-agent.md` | S4 载体，S5 内容 |
| $PH_k$（偏好载体） | 同上 + git 历史 | 同上 | S4 已落地 |
| $HP_k$ / $\theta^S_k$ | Service 配置，经工具入参传递 | `src/search-service/config.yaml` + 工具参数 | 部分：排序权重与 tier 阈值仍硬编码在 `api/probe.py`（G-5） |
| Search Service | 已有的 Python HTTP 服务 | `src/search-service/` | 已有，S2/S7 扩展到十个端点 |
| Evidence Store | Service 侧 episode 作用域状态 | `src/search-service/`（见 §3.2） | 未落地（G-2） |
| $\bar{\tau}_t$ | extension observer + Service 的 `SearchState` | `core/trajectory.ts` + `SearchState` | S6 已落地 |
| Sidecar Reviewer | 另一个 profile + extension 的 observer/event bus | `profiles/reviewer.md` + `core/review.ts`（见 §3.4） | S8 通道已通；介入时机偏在 episode 之后（G-1） |

"状态"列是**当下**的实话，不是计划。路线图的 stage 状态在 `06-progress.md`；
`G-n` 指向该文件的"验收缺口"一节——那里记的是 stage 验收已通过、
但本表所述的设计要求尚未满足的部分。

---

## 2. 已落地的映射

### 2.1 Main Search Agent = 一个 profile，不是一个类

`profiles/search.md`。WIDI 的 profile 恰好就是"角色"这个概念的载体：
它同时决定系统提示词、可见工具集、注入哪些上下文文件。三者是一体的——
这正是 §3 要求的"$T^M$ 是依据 $\theta^S_k$ 生成的受约束工具视图"在 WIDI 上的形态。

`tools:` 里只有四个检索工具，**没有** `bash` / `write` / `edit`。
这不是权限偏好而是架构必需，理由在 `05-skill-decomposition.md` §0：
有 coding 能力就无法强制预算与 `end_date`，且 agent 在代码里做的事不进 $\bar{\tau}_t$。
一个能写 Python 去 `curl` 的 agent，它的检索行为对 Reviewer 是不可见的。

### 2.2 $T^M$ = `registerTool`，而不是九个文件

`extensions/scholar-search/index.ts` 里每个工具一次 `registerTool`，
检索逻辑在 `core/` 下作为纯函数。工具**不按数据源拆分**：
`provider_query` 是单一工具、provider 作枚举参数。
理由见 `search-service.md` §2.1——按源拆开会让"新增一个源"变成"修改工具集"，
而统一工具加运行时能力表只需要注册一条记录。

### 2.3 $SP_M$ 的静态/动态切分 = profile body / `projectContext`

这是整张表里最容易做错的一处，所以单独说。

- **profile body** 只放静态部分：角色、工具调用协议、输出契约、安全边界。
- **`projectContext` 指向的文件** 放 $NP_k^{agent}$：策略先验。

判据很简单：**Reviewer 能改写的东西不能写进 profile body。**
profile 是提交进仓库的静态文件，Reviewer 在运行时改不动它；
一旦"先分解子查询再检索"这类策略写进了 body，它就脱离了 $PH_k$ 的管辖，
`prototype.md` §7.3 约束一（策略先验必须有可作用的载体）随之失效，
S5 的消融实验也就测不出东西——关掉全部条目，轨迹形状不变。

具体切在哪里，`06-progress.md` 的 S3 条目里有逐项清单。
两个看起来像策略、实际归入协议的例外，也在那里给了依据：
`provider_query` 前置 `list_providers`（接口契约，`prototype.md` §7.1 末段明说
"前置探查是接口契约而非策略判断"），以及 `end_date` 必须携带
（评测契约与治理约束，不是"检索得好不好"的判断）。

### 2.4 $PH_k$ / $NP_k^{agent}$ = 一个 markdown 文件 + git

载体：`widis/.widi-scholar/preference/np-agent.md`，由 `profiles/search.md` 的
`projectContext` 引用。布局与版本约定见
`widis/.widi-scholar/preference/README.md`。

**为什么它不是一个代码模块。** 这是本文要显式回答的第一个问题。

$PH_k$ 在形式化里是"跨 episode 的偏好状态"，很容易读成"需要一个
`preference/` 模块来管它的读写、版本与合并"。不需要，理由有三条：

1. **它的读取路径已经存在。** WIDI 的 `projectContext` 就是"把这些文件的内容
   注入系统提示词"。写一个模块去读同一个文件再拼进提示词，是把运行时已经做的事
   重做一遍，而且做得更差——绕开了 WIDI 的资源加载、缺失诊断与 profile 覆盖语义。
2. **它的版本管理已经存在。** git 就是版本存储。"回放到第 k 版"是
   `git show <commit>:<path>`，不是一个自建的版本表。`AGENTS.md` §3.2 明确
   "只有出现真实复用点时才抽象公共模块，禁止预建无调用方的框架"。
3. **一个模块会把它变成不可审计的。** $PH_k$ 的价值在于人能读、能逐条改、
   能逐条关掉（`prototype.md` §7.3）。markdown 文件加 git diff 直接就是这个界面。
   一旦经过代码序列化，"第 3 版和第 4 版差在哪"就要靠工具才能回答。

会需要代码的只有一处：$SI_k = \mathrm{Compose}(RQ, NP_k^{agent})$ 的注入点，
如果选 `input` interceptor 而不是 `projectContext` 静态注入。那是 S5 的决策，
且即使选了 interceptor，它也只是 extension 里的一个 handler，不是一个
`preference/` 模块。

---

## 3. 尚未落地的映射，以及已经定下的选择

### 3.1 $HP_k$ / $\theta^S_k$：一半在 Service 配置，一半在工具入参

$\theta^S_k$ 是"Service 侧的可调参数"。它在 WIDI 上没有单一载体，而是分成两层：

- **不由 Agent 决定的**（凭据、限流、退避、每源配额、成本口径）在
  `src/search-service/config.yaml`，Agent 既不持有也不感知
  （`prototype.md` §7.1 末段）。
- **由 Agent 每次调用决定的**（`top_k`、`end_date`、`sources`、`judge_level`）
  是工具入参。

这个切分不是实现方便，而是 §3 的要求：$T^M$ 是依据 $\theta^S_k$ 生成的**受约束**
工具视图。所以能力表必须在运行时返回并随 $\theta^S_k$ 收窄——这正是
`list_providers` 存在的理由，也是 provider 语法不写进工具描述的理由
（静态文本无法随 $\theta$ 收窄，会教 Agent 写出必被拒绝的检索式）。

**当前缺口**：`config.yaml` 里还没有"按 $\theta$ 禁用某个字段"的开关，
所以 `list_providers` 返回的字段集目前等于 provider 的全集，不是"当前 $\theta$ 下
实际可用的子集"。`prototype.md` §7.1 要求的是后者。这是 S7 之后的事，记在这里免得被当成已完成。

### 3.2 Evidence Store 为什么在 Python 侧而不是 extension 侧

这是本文要显式回答的第二个问题。

跨工具调用积累候选是检索的固有需求：$t$ 步召回的论文要在 $t+3$ 步参与引文扩展
与排序。承载它的状态放哪一侧，`design.md` §4.1 已经给了三条界定，
落到 WIDI 上就只有一个答案：**Service 侧**。

1. **放 extension 侧会把候选集搬进 Agent 的进程边界。**
   extension 与 Agent 同进程，它持有的候选集迟早会被格式化进工具输出——
   而 `design.md` §4.1 的第一条要求正是"Agent 不在上下文里搬运候选集"。
   S2 的 `PaperSummary` 就是为此存在：它刻意丢掉 `raw`、`field_provenance`、
   `references`、`citations`、`counts_by_year`。这些字段必须有地方存，
   而那个地方不能是 extension。
2. **排序、去重、指标计算是领域算法，按 `AGENTS.md` §3.2 不该在 extension 里。**
   extension 负责适配与编排，不重复实现领域算法。Evidence Store 是这些算法的
   工作内存，跟着算法走。
3. **它必须能进 $\bar{\tau}_t$。** §4.1 第三条：它的统计量与结构化诊断要进入
   公开轨迹，否则 Reviewer 无法判断覆盖缺口。Service 已经在产出 `SearchState`，
   把 Evidence Store 的账目挂在同一个结构上是自然的；放 extension 侧则要
   再造一条上报通道。

一个容易误读的点：`design.md` §4 说"Service 不持有独立状态"，
指的是**跨 episode 的决策状态**，不是禁止在一次 episode 内累积证据。
Evidence Store 与 `RunSnapshot` 同生共死，episode 结束即销毁。
跨 episode 的记忆只有一个合法载体，即 $PH_k$（见 §2.4）。

**当前状态**：未落地。`src/search-service/` 现在是无状态的——
每次 `/search` 独立聚合，没有 episode 概念。要落地它需要一个 episode 标识
穿过工具入参，这不属于任何已完成的 stage。

### 3.3 $\bar{\tau}_t$：两侧各出一半

`design.md` §5.1 定字段边界，`search-service.md` §5.3 定内容契约。落到 WIDI：

- **Service 侧**产出发现溯源与过程账目。这部分**已经有了**：
  `SearchState`（`issued_queries` / `selected_sources` / `filters` /
  `candidate_counts` / `failures`）与 `Provenance`。S2 已经让它端到端可见——
  工具输出里就带着"哪些源被查、发了几个查询、召回多少、什么失败了"。
- **extension 侧**产出工具调用序列，靠 `api.observe(...)` 收集。**未落地**（S6）。

**关键边界**：$\bar{\tau}_t$ 里不能有 Main Agent 的私有推理。
observer 拿到的事件要过滤，不是把上下文整个转录。这条不是实现细节——
Reviewer 看得见 Main 的推理，$C^R_t \neq C^M_t$ 就名存实亡了。

实现时注意 observer 事件**没有顺序保证**（`SKILL.md` §6），
不要假设 `agent_spawned` 一定先于 `agent_status_changed`。

### 3.4 Reviewer 用 observer 还是 subagent

这是本文要显式回答的第三个问题。**答案是两个都用，因为它们不是同一个层面的选项。**

先把硬约束摆出来：

- $C^R_t \neq C^M_t$ 是**硬机制**。Reviewer 必须是独立 agent runtime，
  只吃 $\bar{\tau}_t$，不共享 Main 的上下文。
- Reviewer 是**旁路观察者，不是被调用方**。Main 不能主动向它求助——
  那会使介入率成为内生变量并破坏 $\Delta_{\mathrm{sidecar}}$ 的归因（`design.md` §3）。

于是：

**Reviewer 本体必须是 subagent（一个 profile）。** 它要做判断，需要模型和自己的
上下文窗口。observer 是 extension 里的一个函数，不是 agent runtime，
装不下一个会推理的审查者。所以 `profiles/reviewer.md` 是必需的。

**observer 是喂给它的传输层，不是替代品。** `api.observe(...)` 负责收集
Main 的工具调用序列、过滤成 $\bar{\tau}_t$，再交给 Reviewer。

**由 extension 而不是 Main 来 spawn Reviewer**，这一条是"旁路"落地的关键。
WIDI 的 `ExtensionActions` 提供 `spawnAgent()` 与 `prompt(text, { target })`，
所以 extension 可以自己起一个 Reviewer agent 并把 $\bar{\tau}_t$ 投递给它。
Main 全程没有它的 handle：`profiles/search.md` 的 `tools:` 里没有
`spawn_agent`、也没有 `send_message`，因此 Main **结构上**无法向 Reviewer 求助。
"Main 不能主动求助"不靠提示词里的一句禁令维持，而是工具集里没有那个动作。

被否决的两个方案，记下来免得后面重新捡起：

- **让 Reviewer 成为 Main 的一个工具**（`ask_reviewer`）：直接违反旁路要求，
  介入率变成 Main 的策略变量，$\Delta_{\mathrm{sidecar}}$ 无法归因。
- **只用 observer、不起 subagent**（在 observer 里直接调模型）：绕开了 WIDI 的
  agent runtime，于是 Reviewer 的上下文、预算、轨迹都不在任何 session 里，
  既不可复现也不可审计。而 $C^R_t \neq C^M_t$ 恰恰需要它**是**一个有自己 session
  的 agent 才能被证明。

在线工具集见 `prototype.md` §7.2；**离线的六个工具在 held-out 阶段根本不注册**，
不是注册了不用。

**当前状态（S8 之后）**：上面这套结构全部落地了——`profiles/reviewer.md` 是独立
agent、由 extension spawn、Main 的工具集里没有 `spawn_agent` 也没有 `send_message`、
gate 是 `core/review.ts` 里的纯函数、$C^R_t \neq C^M_t$ 有逐片段查证的证据。

**但触发时机还不对**：review 挂在 `agent_idle` 上，也就是 Main 已经产出最终 $SO$
之后，而 `design.md` §5.2 的四个 checkpoint 有三个在 episode 中途。
所以现在的 $A_t$ 影响不了它所审查的那次搜索，M 轴（在线拓扑）因此还没有测量对象。
完整记录与补法见 `06-progress.md` 的 **G-1**。

这一条要单独点明，是因为"通道通了"和"介入有作用面"看起来很像：
两者都能产出一条 `provide_advice` 并落盘，区别只在于 Main 有没有机会读到它。

---

## 4. 故意没有对应代码模块的概念

前面几节里散落着这个判断，这里集中列一次。**这一节是本文最有用的部分**：
它挡住的是"为了对齐概念而造目录"这类返工。

| 概念 | 为什么没有模块 |
| --- | --- |
| Preference Persistence / $PH_k$ | 一个 markdown 文件加 `projectContext` 引用就是全部。读取路径与版本管理都已存在，见 §2.4 |
| $SP_M$ / $NP_k^{agent}$ 的"组装器" | `Compose` 由 WIDI 的系统提示词组装完成。只有选 interceptor 注入时才有一个 handler，那也不是模块 |
| "四个概念模块" | `design.md` 的四个模块是**行为抽象**，不是目录结构。仓库里没有、也不应该有 `main-agent/`、`reviewer/`、`service/`、`preference/` 四个平行目录 |
| Reviewer 的"调度器" | Reviewer 由 extension 在 observer 里 spawn，WIDI 的 orchestrator 就是调度器 |
| 工具的"注册表" | `registerTool` 就是注册表 |

判据统一是 `AGENTS.md` §3.2：只有出现真实复用点时才抽象公共模块，
禁止预建无调用方的框架、兼容层或占位接口。

---

## 5. 这份映射本身的价值

即使后面的代码全不采纳，这张对照表也是设计资产：它记录的是
"这套形式化在一个真实 agent runtime 上的唯一合理落法"，
以及每一处**不**落成代码的理由。后者比前者更难重建——
一个空目录不会告诉任何人它为什么不该存在。
