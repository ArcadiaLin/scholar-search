# widi-scholar 原型开发路线图

> 状态：执行手册
> 读者：推进本原型开发的 agent
> 本文只读，进度写在 `docs/06-progress.md`。

## 0. 目标

把 `design.md` / `search-service.md` / `prototype.md` 描述的检索架构，
落成一个能在 WIDI TUI 里实际运行的 **widi-scholar** 原型：
一个只会检索、不会写代码的学术检索 agent，加上它背后的工具集、
偏好载体与可观测轨迹。

推进方式：按 §3 的 stage 顺序做，进度记在 `docs/06-progress.md`。
每个 stage 都定义了落点、验收命令和独立价值。

两条贯穿始终的要求：

- **停在可验收的点上。** 一个 stage 做完、验收通过、提交，再看下一个。
  不要为了赶进度把两个 stage 混进一个 commit——那会让部分采纳失效（§1.4、§5）。
- **卡住就如实记录。** `BLOCKED` 比假装 `DONE` 有用得多（§1.5）。
  依赖是线性的，跳过一个卡住的 stage 只会积累返工。

---

## 1. 硬约束

违反这些，产出就不可用，不管功能是否跑通。

### 1.1 Extension First

学术检索的一切逻辑都实现为 `widis/.widi-scholar/extensions/<id>/` 下的 WIDI extension。

**只有两种情况允许修改 `packages/widi/`**：

1. extension API 无法表达所需能力，且该能力对 WIDI 本身有通用价值；
2. 已用**最小复现**确认是 WIDI 原生缺陷，无法在 extension 内正确修复。

两种情况都必须先在 progress 里记录最小复现，再动手；`packages/widi/` 是 submodule，
改动要在 submodule 内单独提交并更新父仓库 gitlink，不得留下未提交的 submodule 改动。
**默认答案是"不改"**——先花力气找 extension 内的做法。

### 1.2 概念模块 ≠ 代码模块

设计文档里的四个模块是**行为抽象**，不是目录结构。落到 WIDI 上的映射：

| 设计概念 | WIDI 载体 |
| --- | --- |
| Main Search Agent | `widis/.widi-scholar/profiles/search.md`（profile） |
| $T^M$ 工具集 | extension 的 `registerTool` |
| $SP_M$ 静态部分 | profile 的 body |
| $NP_k^{agent}$ | profile `projectContext` 指向的受控文件 |
| $HP_k$ / $\theta^S_k$ | Search Service 的配置，经工具入参传递 |
| Search Service | 已有的 Python HTTP 服务 `src/search-service/` |
| Evidence Store | Service 侧 episode 作用域状态 |
| $\bar{\tau}_t$ | extension observer 收集 + Service 返回的 `SearchState` |
| Sidecar Reviewer | 另一个 profile + extension 的 `observe` / event bus |

**不要为了对齐概念而造目录。** 例如 Preference Persistence 不需要一个
`preference/` 代码模块——它就是一个 markdown 文件加 profile 的 `projectContext` 引用。
只有出现真实复用点时才抽象公共模块（`AGENTS.md` §3.2）。

### 1.3 本仓库的实际坑

**不要照抄 `develop-widi-extension/SKILL.md` 里的 `Type.Object` 示例。**
jiti 无法从 `widis/` 解析裸 `typebox` 导入，且固定版本里 typebox 的 `TSchema`
结构上是空的。参数 schema **手写 JSON Schema 字面量**。
先看本仓库已有的先例：`widis/.widi-pasa/extensions/pasa-tools/index.ts`，
它是同构的 Core-half extension，结构、schema 写法、测试布局都可以照着做。

其余易错点见 `SKILL.md` §6，尤其是：工具失败必须 `throw`、
工具自己限制输出大小、执行前检查 abort signal、路径基于 `context.workspace.cwd`。

### 1.4 提交纪律

- 分支 `feature/widi-scholar-prototype`，**从不直接提交 main**；
- 一个 stage 一个 commit，message 首行以 `[S<n>] ` 开头；
- 只 stage 本 stage 改动的文件，禁止 `git add -A` / `git add .`；
- 提交前 `git status` 确认没有夹带无关改动、凭据、大文件、运行缓存；
- **不修改已 DONE 的 stage 产出**，除非它有 bug；那种情况另开一个 commit 并在
  progress 里注明修的是哪个 stage。

这条纪律是为了让用户可以只取前 N 个 stage：每个 commit 单独可 `cherry-pick`，
后续 stage 不回头改前面的文件，否则部分采纳就会断。

### 1.5 诚实报告

失败就写失败，附实际命令与输出。不得靠放宽断言、忽略异常、硬编码样例、
无界重试来让检查变绿。跑不通的 stage 标 `BLOCKED` 比标 `DONE` 有用得多。

---

## 2. 环境与命令

```bash
npm run bootstrap                     # 首次：初始化 submodule + npm ci + uv sync
npm run build                         # widi:scholar 跑的是 dist
npm run widi:scholar                  # ← 用这个：Search Service + 检索 agent TUI
npm run widi:scholar:dev              # 同上，WIDI 跑 TypeScript 源码
npm run test:widis                    # 跑所有 namespace extension 测试
```

**`npm run widi:scholar` 是看这个原型的入口。** 它做三件事
（`scripts/run-scholar.mjs`）：起 Python Search Service 并等它真的应答 `/health`、
把地址经 `SCHOLAR_SEARCH_SERVICE_URL` 传给 extension、以 `--profile search`
打开 TUI。退出 TUI 时它起的那个 Service 一起结束。

为什么要合成一条命令：九个检索工具是 Search Service 的瘦客户端，
Service 没起时它们**全部**失败，而失败信息（"服务不可达"）看起来像 extension
的 bug。把两半绑在一起，这个误诊就不会发生。

两个行为值得知道：已经在跑的 Service 会被复用而不是再起一个（先探 `/health`），
退出时也不会去关别人的进程；uvicorn 的日志写到 `runs/logs/search-service.log`
而不是终端，否则会把全屏 TUI 冲花。

要开别的角色就传 profile，例如 `npm run widi:scholar -- --profile reviewer`；
`main`（有 shell 与文件系统的通用 agent）是 `npm run widi`。

`widi` / `widi:dev` / `widi:rpc` 保留不动——S9 的 eval runner 按名字调用
`widi:rpc`，而且它们不该顺带起 Service：评测需要自己控制 Service 的地址与生命周期。

单个 extension 的类型与格式检查（`npm run check` **不覆盖**动态加载的 extension）：

```bash
npm --prefix packages/widi exec -- tsgo --noEmit \
  -p widis/.widi-scholar/extensions/<id>/tsconfig.json
npm --prefix packages/widi exec -- biome check \
  --config-path packages/widi/biome.json widis/.widi-scholar/extensions/<id>
```

Python 侧（Search Service）：

```bash
cd src/search-service && uv run pytest -q
```

Core half 改完在 TUI 里 `/reload`；TUI half 改完重启应用。

---

## 3. Stage 定义

依赖关系是线性的：S<n> 依赖 S<n-1> 全部 DONE。
每个 stage 都标了**独立价值**——即用户只取到这里、后面全不要，能得到什么。

### 关于下面每个 stage 的"验收"

**这些验收判据是必要条件，不是充分条件。** 它们检验的是"这条链路真的通了、
真的在跑"，写得刻意可执行——一条命令、一个能贴进 progress 的输出。
但**通过验收不等于对应的设计要求已经被满足**：判据在若干处比
`design.md` / `prototype.md` 的要求宽。

已经发生过的两个例子（S0–S9 跑完之后回看）：

- S8 验"至少产生一条 `provide_advice`"——那验的是通道连通性，
  不是 §5.2 要求的 checkpoint 时机；结果是通道通了而介入影响不到被审的那次搜索。
- S5 验"轨迹形状明显不同"——没有预先规定观察量，于是观察量只能事后选，
  得到的分离度不能当效应量。

所以：**验收通过就照 §1.4 提交并继续，但如果你发现判据没覆盖到设计要求的某一部分，
把差额写进 `06-progress.md` 的"验收缺口"一节**（那一节的格式在文件里），
不要为了让它看起来完整而放宽或重新解释判据。一个带着已知缺口的 `DONE`
是可用的；一个把缺口解释掉的 `DONE` 会让后面所有依赖它的实验结论失效。

这条比"卡住就记 BLOCKED"更容易被漏掉：BLOCKED 是你走不下去，
而这里你走得下去，只是走到的地方比设计要求浅一层。

---

### S0 — 分支、进度骨架、局域网模型接入

**目标**：能用局域网 vllm 模型启动 Scholar TUI。

**落点**
- 新分支 `feature/widi-scholar-prototype`
- `widis/.widi-scholar/agent/models.json`：新增 `vllm` provider
- `widis/.widi-scholar/settings.json`：`enabledModels` 加 `"vllm/*"`
- `docs/06-progress.md`：初始化全部 stage 为 `TODO`

**做什么**

在 `models.json` 的 `providers` 下新增（与现有 `moonshot` / `anthropic` 同级）：

```json
"vllm": {
  "name": "vllm",
  "baseUrl": "http://192.168.163.112:8003/v1",
  "api": "openai-completions",
  "apiKey": "EMPTY",
  "models": [
    {
      "id": "qwen3.6-35b-a3b",
      "name": "Qwen3.6 35B A3B (local vllm)",
      "reasoning": true,
      "contextWindow": 262144,
      "maxTokens": 32768,
      "compat": { "supportsDeveloperRole": false, "thinkingFormat": "qwen-chat-template" }
    }
  ]
}
```

`enabledModels` 追加 `"vllm/*"`。**不要**改 `defaultProvider` / `defaultModel`——
让用户自己在 TUI 里 `/model` 切换，默认值属于用户偏好，不属于本路线图。

**验收**
```bash
npm run widi:dev      # 启动后 /model 能看到并切到 vllm/qwen3.6-35b-a3b，发一句话有回复
```
局域网不可达时：记录实际错误，标 `BLOCKED`，**不要**改成公网模型绕过。

**独立价值**：本地模型可用的 Scholar TUI，与后续全部无关。

---

### S1 — extension 骨架与最短链路

**目标**：一个能被 WIDI 加载的 extension，注册一个工具，打通到 Python Search Service。

**落点**
- `widis/.widi-scholar/extensions/scholar-search/`：`index.ts`、`tsconfig.json`、
  `core/service-client.ts`、`tests/service-client.test.ts`
- `widis/.widi-scholar/settings.json`：`enabledExtensions: ["scholar-search"]`

**做什么**

先读 `widis/.widi-pasa/extensions/pasa-tools/`（入口、tsconfig、tests 布局），
按同样形状建 scholar 侧的骨架，注意 tsconfig 的相对路径深度相同（`../../../../`）。

只注册**一个**工具 `list_providers`：无参数，调用 Search Service 的
provider 能力表接口，返回各源的能力、当前可用字段与配额余量。
选它作为第一个工具的理由见 `prototype.md` §7.1——它是 `provider_query` 的前置条件，
也是最简单的只读链路。

`core/service-client.ts` 是纯函数边界：显式输入输出、注入 baseUrl 与 fetch、
有超时与有界重试、错误可观察。**不要**把 HTTP 细节写进 `index.ts`。
Service 地址从环境变量读，带默认值（如 `SCHOLAR_SEARCH_SERVICE_URL`），
不硬编码在代码里，也不写进提交的配置。

**验收**
```bash
npm --prefix packages/widi exec -- tsgo --noEmit -p widis/.widi-scholar/extensions/scholar-search/tsconfig.json
npm --prefix packages/widi exec -- biome check --config-path packages/widi/biome.json widis/.widi-scholar/extensions/scholar-search
npm run test:widis
```
外加：另起一个终端跑 Search Service，`npm run widi:dev` 里让模型调用一次
`list_providers`，确认拿到能力表。测试用 fixture，**不依赖实时服务**。

**独立价值**：一个可加载、可类型检查、有测试的 extension 骨架，
证明 widi ↔ Python service 的链路成立。后续所有工具都长在这上面。

---

### S2 — 核心检索工具

**目标**：Agent 能真正检索。

**落点**：`extensions/scholar-search/index.ts` 新增工具 + `core/` 对应模块 + tests

**做什么**

按 `prototype.md` §7.1 的签名注册三个工具：

| 工具 | 要点 |
| --- | --- |
| `search_metadata` | `(query, subqueries?, intent?, top_k, judge_level?)`，主检索 |
| `provider_query` | `(provider, raw, normalize?)`，passthrough |
| `get_paper` | `(paper_id)`，单篇详情 |

三条契约必须落地：

1. **工具描述里不写 provider 语法**，只写职责和"调用前先 `list_providers`"
   （`prototype.md` §7.1「provider 语法的载体」）；
2. **`provider_query` 是单一工具**，provider 作枚举参数，不按源拆成
   `openalex_query` / `arxiv_query`；
3. **语法/字段被拒绝时返回可操作诊断**（哪个字段不可用、去哪查），不是笼统报错。

工具输出必须自己限长：候选列表返回引用与摘要视图，不把完整记录灌进上下文
（`design.md` §4.1——Agent 不在上下文里搬运候选集）。

**验收**：同 S1 三条命令，外加 TUI 里一次真实检索能返回结构化结果。

**独立价值**：一个能在 TUI 里做多源学术检索的 agent。到这里已经是可用产品雏形。

---

### S3 — search profile：把工具集收紧

**目标**：Main Search Agent 作为一个受限 profile 存在，没有通用 coding 能力。

**落点**：`widis/.widi-scholar/profiles/search.md`，`settings.json` 的 `enabledProfiles`

**做什么**

参考 `widis/.widi-scholar/profiles/` 下已有 profile 的 frontmatter 写法。关键：

- `tools:` **只列** S1/S2 注册的检索工具，**不含** `bash`、`write`、`edit`；
  这不是权限偏好，是架构必需——有 coding 能力就无法强制预算与 `end_date`，
  且 agent 在代码里做的事不进 $\bar{\tau}_t$（见 `05-skill-decomposition.md` §0）；
- profile body 就是 $SP_M$ 的**静态部分**：角色、工具调用协议、输出契约、安全边界。
  **不要**在这里写检索策略——那属于 $NP_k^{agent}$，是 S5 的事。
  这条最容易违反：写 profile 时会很自然地想加"先分解子查询再检索"这类话，
  一旦写进去，Reviewer 就对它没有作用面（`prototype.md` §7.3 约束一）。

**验收**：`npm run widi:dev` → 切到 search profile → 确认工具列表里没有 bash/write/edit，
且一次完整检索问答能跑通。

**独立价值**：一个"只会检索、不会写代码"的学术检索 agent，可直接演示。

---

### S4 — 概念到实现的映射文档 + Preference 载体

**目标**：把 $PH_k$ 落成一个真实存在、可版本化、可被改写的对象。

**落点**
- `docs/07-widi-mapping.md`：设计概念 → WIDI 载体的完整映射（本文 §1.2 的展开版，
  含实际文件路径、为什么这样映射、以及哪些概念**故意没有**对应代码模块）
- `widis/.widi-scholar/preference/` 下的偏好文件
- `profiles/search.md` 的 `projectContext` 指向它

**做什么**

$NP_k^{agent}$ 作为 profile `projectContext` 引用的 markdown 文件存在。
本 stage 只建**空载体与版本约定**（文件布局、版本号怎么表示、如何回放到某一版），
内容留给 S5。理由：载体和内容分开两个 commit，用户可以只要载体不要我们写的初值。

映射文档要显式回答：为什么 Preference 不是一个代码模块，
为什么 Evidence Store 在 Python 侧而不是 extension 侧，
Reviewer 用 observer 还是 subagent（给出选择与理由）。

**验收**：`npm run widi:dev` 下 profile 能加载，`projectContext` 内容进入上下文
（在 TUI 里确认 agent 能复述偏好文件里的内容）。

**独立价值**：一份把抽象设计接到具体 WIDI 机制上的对照表——即使后面代码全不采纳，
这份映射本身就是设计资产。

---

### S5 — $NP_0^{agent}$ 条目化

**目标**：策略先验以可逐条改写、可逐条关闭的形式进入系统。

**落点**：S4 建立的偏好文件；`extensions/scholar-search/` 的注入逻辑

**做什么**

来源是 `05-skill-decomposition.md` 的 36 个 `NPa` 标记。**先做合并与展开**
（清单 §6.1 的待办：有 10 处标注"并入"，CF-B-21 要展开成 5 条），
得到 25–30 条的实际列表，形式见 `prototype.md` §7.3「落地形式」：
每条有 `id`、`text`，示例式条目额外有 `kind` 与 `origin`。

注入点是 $SI_k = \mathrm{Compose}(RQ, NP_k^{agent})$。在 WIDI 上有两种实现：
`projectContext` 静态注入，或 `input` interceptor 动态组装。
**选一种并在 progress 里写明理由**；如果选 interceptor，注意它也会收到 agent 与
runtime 注入的消息，必须检查 `event.source`（`SKILL.md` §6）。

许可证前置条件见 `prototype.md` §7.3 末节：条目是对策略思想的重述与重新分层，
**不得逐字复制** MetaScientist 的 skill 原文。

**验收**：关掉全部条目与打开全部条目，同一查询的轨迹形状**明显不同**。
不变就说明策略还藏在 profile body 或工具序列里，S3/S5 有一处没做对——
这是 `05-skill-decomposition.md` §0 定义的验收判据，也是整条路线最关键的一次检查。

**独立价值**：可消融的策略先验。P 轴实验（`prototype.md` §6.5）的 P1 组到此具备。

---

### S6 — 公开轨迹 $\bar{\tau}_t$

**目标**：Reviewer 能看见的东西成为一个真实对象。

**落点**：extension 的 `observe` 注册；Service 侧 `SearchState` 的补齐

**做什么**

$\bar{\tau}_t$ 的字段边界见 `design.md` §5.1，内容契约见 `search-service.md` §5.3。
两侧都要：Service 产出发现溯源与过程账目，extension observer 收集工具调用序列。

**关键边界**：$\bar{\tau}_t$ 里**不能有** Main Agent 的私有推理。
observer 拿到的事件要过滤，不是把上下文整个转录。

注意 observer 事件**没有顺序保证**（`SKILL.md` §6），不要假设
`agent_spawned` 一定先于 `agent_status_changed`。

**验收**：跑一次检索，导出 $\bar{\tau}_t$，人工核对：
子查询、候选计数、失败分类、预算消耗都在，私有推理不在。

**独立价值**：可观测性。即使 Reviewer 永远不做，这也是调试与评测的基础设施。

---

### S7 — 其余检索工具

**目标**：补齐 $T^M$ 的九个工具。

**落点**：extension 新增 `expand_citations`、`rank_candidates`、`facet_probe`、
`search_fulltext`、`get_budget`

**做什么**：照 S2 的形状补齐。特别注意 `expand_citations` 的深度、扇出、
并发与总候选数**必须有界**（`design.md` §4），边界值来自 $\theta^S_k$ 而非硬编码。

**独立价值**：完整的检索能力面。到这里 $T^M$ 齐了，可以开始跑 benchmark。

---

### S8 — Reviewer 通道

**目标**：独立上下文的旁路审查跑起来。

**落点**：`profiles/reviewer.md`；extension 的 event bus / observer 联通

**做什么**：$C^R_t \neq C^M_t$ 是**硬机制**不是实现细节——
Reviewer 必须是独立 agent runtime，只吃 $\bar{\tau}_t$，不共享 Main 的上下文。
在线工具集见 `prototype.md` §7.2；**离线的六个工具本 stage 不做**
（held-out 阶段它们根本不注册）。

Reviewer 是**旁路观察者，不是被调用方**：Main 不能主动向它求助
（`design.md` §3——那会使介入率成为内生变量并破坏 $\Delta_{\mathrm{sidecar}}$ 归因）。

**验收**：一次检索中 Reviewer 至少产生一条 `provide_advice`，
且能证明它的上下文里没有 Main 的私有推理。

**独立价值**：M 轴实验的 M3 组具备。

---

### S9 — RPC 评测入口

**目标**：benchmark 能无头驱动 widi-scholar。

**落点**：evaluation runner 走 `npm run --silent widi:rpc`

**做什么**：见 `AGENTS.md` §3.3——**不得抓取 TUI 文本或读 session 文件**。
每次运行记录 namespace、RPC protocol version、WIDI revision、profile、模型、
extension 版本与生效预算。

**独立价值**：可复现评测。`experiments.md` 的阶段 0 前置到此具备。

---

### S10 起

S0–S9 是**已经执行完**的一个单元。后续 stage 的定义在
**`docs/09-next-stages.md`**：S10（结构化答案池与召回评测回路）、
S11（$NP_k^{judge}$ 载体与 L3b 判别层），以及它们之前必须先修的
`08-retrieval-defects.md` F-1。

另起一篇而不是在这里追加，是因为那两个 stage 各自涉及一个需要论证的架构选择，
理由比 stage 条目本身长，塞进上面这个格式会把论证挤掉。

---

## 4. 进度记录

`docs/06-progress.md` 是这条路线的唯一状态来源，状态取值：

| 状态 | 含义 |
| --- | --- |
| `TODO` | 未开始 |
| `IN_PROGRESS` | 已开始但未验收，备注里写清做到哪一步 |
| `DONE` | 验收命令全通过，已提交 |
| `BLOCKED` | 卡住，写清卡在哪、试过什么、需要什么才能解 |

除状态表外还有两处要维护：

- **决策记录**：stage 执行中做出的、路线图没有规定的选择，连同理由一起记下来。
  后续不要推翻已记录的决策，除非它被证明是错的。
- **上游缺陷记录**：每一次动 `packages/widi/` 都要记最小复现、submodule commit
  与父仓库 gitlink 更新（§1.1）。

同一处反复卡住且没有新信息时，停下来把问题交给用户，不要继续空转。

---

## 5. 用户如何部分采纳

每个 stage 一个 commit，后续 stage 不回头改前面的文件，因此：

```bash
git log --oneline feature/widi-scholar-prototype   # 看 [S0]..[S9]
git cherry-pick <S0..Sn 的 commit>                 # 只取前 n 个
git checkout feature/widi-scholar-prototype -- <path>   # 只取某些文件
```

采纳分界点建议：**S3 之后**（可演示的检索 agent）、**S5 之后**（可消融的策略先验）、
**S7 之后**（完整工具面）。这三处都是自洽的停止点。
