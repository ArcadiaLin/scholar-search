# WIDI Workflow 扩展：以 PaSa 为试点

## 结论

PaSa 发布的推理实现不是 agent，是一个**固定 workflow**，里面嵌了两个学习到的组件。
我们要的东西因此也不是「更好的 agent 编排」，而是一个**成本可静态预算的执行器**：
步骤顺序、扇出上限、去重、预算和停止条件由引擎拥有，模型只提供步骤参数。

路线是：先写死成 `pasa-orchestrator` 跑通并拿到基线，
**第二个 workflow 出现时**再把引擎抽出来，不预建框架（`AGENTS.md` §3.2）。

本文件是规划，不代表已实现。三处待定决策集中在 §10。

## 1. 为什么判定 PaSa 是 workflow

证据全部来自 `references/repos/pasa`（固定 `2aaa6a9`）：

1. **控制流是常量**。`run()` = `search()` + `for depth in range(2): expand(depth)`
   （`paper_agent.py:218-221`）。层数写死，不由模型决定。
2. **模型从不选择动作**。全仓库只有四个模型调用点
   （`paper_agent.py:98,119,184,215`）。119 行的输出**只**用 `search_template`
   解析，215 行的**只**用 `expand_template` 解析——
   动作类型由调用点决定，模型只填参数：哪个查询串、哪个章节名。
3. **`[Stop]` 在发布代码里不存在**。全仓库 grep `stop`（排除 `stop_word`）零命中。
   论文的动作空间里有 Stop，实现里没有，因为终止条件就是 `range(2)`。
4. **Selector 是分类器不是 agent**。`infer_score`（`models.py:28-45`）返回一个
   float，没有任何选择权。
5. 每次调用都重建 chat template（`models.py:48,77`），无跨步记忆。

Agent 性存在于 Crawler 的**训练**方式（PPO），不在它的**运行**方式里。

这条判断的直接后果：`widis/.widi-pasa/profiles/crawler.md` 目前持有四个工具、
自行决定何时 search 何时 expand，**比 PaSa 更自由，不是更像**。
确定性引擎才是忠实形态；`main` 用 LLM 驱动是另一件事，不是它的低精度版本。

## 2. 成本可预测性——这是选 workflow 的真正理由

serper 只在 search 阶段消耗；expand 走 arxiv.org 标题搜索，不用 serper。
每条查询的 serper 调用数等于 crawler 生成的查询数，上限 `search_queries`。
而 `run_paper_agent.py:56` 传的是 `args.expand_papers`，实际生效值是 20 而非 5。

| 形态 | 每条查询 | AutoScholarQuery test 全量 |
| --- | --- | --- |
| 官方实际（参数 bug 生效） | ≤ 20 | ≤ 20,000 |
| 官方意图 | ≤ 5 | ≤ 5,000 |
| 当前 agentic 形态 | **无上限** | **无法预估** |

第三行是现状，也是这份计划最紧迫的动机。
赛题权重里运行效率占 20%，而一个能在**运行前**打印
「本次最多 N 次 serper、M 次模型调用」的引擎，同时也是挡在 API key 前面的闸。

## 3. 实测约束

以下已在当前 submodule 版本核实，是设计的前置事实。

### 3.1 extension 无法直接调用模型

`ExtensionActions` 里只有 `registerProvider`（`extension/types.ts:857`）负责注册，
**没有任何 `callModel` 类原语**。要跑一次推理，只能经由一个 agent。

因此「无工具 profile 退化成一次 LLM call」在概念上成立，
但 WIDI 会按 agent 收费：profile 解析、system prompt 组装、session 落盘，
**以及把每个 extension 的 Core half 激活一遍**（`docs/extensions.md:52`）。
fan-out 50 次就是 50 次 extension 激活。

结论：**批处理不是优化，是必需**。Selector 一个 turn 判一批，
同时摊薄这份固定开销、避免上下文污染、并贴合官方的 `batch_infer`。

### 3.2 工具拿不到 `actions`

`ToolExecutionContext`（`core/tools/types.ts:25-52`）只有 `signal`、`workspace`、
`onUpdate`、`extension`、`human`、`agents?`、`humanInterrupts?`；
`ToolExtensionContext` 只有 `extensionId` 和标注为 "Future" 的 `host?: unknown`。

所以 workflow 的入口不能是一个 `workflow_run` 工具，只能是事件。

### 3.3 extension API 缺了三个 RPC 已有的原语

`rpc.md` §9.6 对 `read_report` 的自述几乎逐字描述了我们的问题：

> 没有它，客户端要拿一个**不是自己 prompt 的** agent（某个 agent 自己 spawn
> 的下级）的最终输出，只能从事件流里自己重建 `message_end`。

| 能力 | core 方法 | RPC 命令 | `ExtensionActions` |
| --- | --- | --- | --- |
| 拿子 agent 最终输出 | `readAgentReport` | `read_report` | **无** |
| 等某个 agent 停下 | `waitForAgentStop` | `wait_stop` | 只有 `waitForIdle()`，且只等自己 |
| 等整棵树静默 | — | `wait_tree_idle` | **无** |
| 成本口径 | — | `run_summary` | **无** |

`readAgentReport` 按 `rpc.md` 自己的说法「运行时全域、不绑调用方身份」，
没有理由不暴露给 extension，只是当初没做。

不补的话，每个 workflow 都要自己实现一遍中继：
同一个 extension 在子 agent 上也激活了一份，那份 `observe("agent_harness_event")`
抓 turn 流，再 `emitExtensionEvent` 回传。能用，但正是 §9.6 说的
「自己重建 message_end」。

### 3.4 RPC 无法触发 extension event

RPC 命令表（`rpc.md` §4）里没有任何「发一个 extension event」的命令。
benchmark driver 因此无法直接触发 `workflow:run`。三条路：

1. `intercept("input")` 识别结构化 prompt 后启动——可行，
   但 `input` 拦截器异常是 fail-closed，把触发逻辑放在会阻断输入的路径上不理想；
2. 给 RPC 加一条 emit 命令，与 §3.3 的三个原语算同一批改动；
3. 只从 TUI 触发，benchmark 走 RPC client 自带引擎（即 §4 的架构 A）。

### 3.5 可用的能力

- `spawnAgent({ origin, model, thinkingLevel })`、`prompt(text, { target })`、
  `disposeAgent`（`extension/types.ts:438-560`）；
- `agent_idle` 是树内广播（`types.ts:174-180`），载荷含 `agentId` 与 `reason`
  （`core/types.ts:118-125`）；
- `agent_harness_event` **不**广播，只交给事件主体 agent 自己的 extension；
- `intercept("tool_call")` 可用于强制预算；
- `exec(command, options)`（`types.ts:564`）提供 shell 逃生舱，需 project trust。

## 4. 两个架构

### 架构 A：引擎写在 Python RPC client 里

今天就能做，零 WIDI 改动。`spawn` → `prompt`（返回整个 run 的最终 assistant
message）→ `wait_stop` / `read_report` / `run_summary`。
确定性、可测、可跨进程 checkpoint，且 `AGENTS.md` §5.3 本来就要求 benchmark 走 RPC。

代价：它不是 extension，TUI 里跑不了，长不成通用 workflow 扩展。

### 架构 B：引擎写成 WIDI extension

需要先补 §3.3 的三个原语（可能外加 §3.4 的 emit 命令），
否则只能用中继凑。回报是 TUI 集成天然成立，且能长成通用能力。

**倾向 B**，依据是 `AGENTS.md` §3.1 的第一条例外：
extension API 无法表达所需能力，且新增能力对 WIDI 本身具有通用价值。
这里证据很硬——core 方法已存在、RPC 已投影、只有 `ExtensionActions` 漏了；
补的是投影，不是新机制。

### 关于「RPC 比进程内慢」

大概率是伪问题。RPC 那层是 JSONL 序列化，微秒级；
模型调用是本地 vllm 上的 35B MoE，秒级，差几个数量级。
真正的差别是可观测性与可续跑（RPC）对 TUI 集成（进程内），不是吞吐。

该测的是另一个数：**spawn + prompt + dispose 一个无工具 agent，
相对一次裸模型调用的固定开销**。它决定 fan-out 的批大小和并发度，
两种架构都要付。vllm 在本地，测这个数不花钱。见 §9。

## 5. Workflow 语言：必须静态有界

PaSa 实际需要的控制流只有四种：sequence、在集合上 fan-out（带并发上限）、
**有界循环**（`for depth in range(2)`）、步骤间的纯变换（排序/截断/去重）。
它不需要 goto，也不需要任意条件分支。`range(2)` 是有界循环，不是 while。

设计红线：**一旦语言里有 goto 和任意条件，就失去了静态成本上界**，
那等于用 YAML 重新实现一遍 agent loop，还更难写。
GitHub Actions、Argo、早期 Airflow 都走过这条路。

因此约定：

- 循环必须声明最大迭代次数，编译期可读；
- 条件只能在**已声明的步骤之间路由**（`when:` 与 `next:`），不得 goto 任意标签；
- 引擎在运行前静态计算最坏情况的模型调用数、工具调用数和外部 API 调用数，
  并与 `budget:` 比对，超出即拒绝启动而不是跑到一半才失败。

真需要无界控制流的场景，那是 agent 该干的活。两种形态保持可区分。

## 6. 步骤类型

| 类型 | 语义 | 备注 |
| --- | --- | --- |
| `call` | 调用 extension 注册的纯函数 | 进程内，非模型可见的 tool |
| `agent` | spawn profile → prompt → 收结果 → dispose | 唯一花模型调用的类型 |
| `fanout` | 在集合上并行执行子步骤 | 必须声明 `max_items` 与 `max_concurrency` |
| `transform` | 纯数据变换（排序、截断、去重） | 进程内 TS |
| `loop` | 有界重复 | 必须声明 `max_iterations` |
| `exec` | shell 逃生舱 | 需 project trust；不作为步骤间默认胶水 |

`call` 调的是 `core/` 里导出的纯函数，**不是注册给模型的工具**。
`pasa-tools` 现有的 `core/` 与 `index.ts` 分离正好使两种形态共用同一份实现：
`index.ts` 是面向模型的投影，`core/` 是面向引擎的函数。

纯变换不要 shell-out：PaSa 的 fan-out 是数百个 selector 结果，
每步起一个进程不可接受。

## 7. YAML 草案：PaSa

用来验证语言是否够用，不是最终 schema。

```yaml
name: pasa
version: 1

inputs:
  question:  { type: string, required: true }
  end_date:  { type: date,   required: true, contract: true }

# contract: true 的输入由调用方注入，任何步骤不得覆盖。
# end_date 是评测契约的一部分，丢失它会静默召回查询日期之后的论文。

budget:
  serper_calls:  5
  model_calls:   400
  wall_clock_ms: 600000

state:
  seen_arxiv_ids: { type: set }     # 对应 pasa 的 touch_ids

steps:
  - id: generate-queries
    type: agent
    profile: crawler
    model: vllm/qwen3.6-35b-a3b
    task: { template: generate_query, question: $inputs.question }
    output: { queries: string[] }

  - id: search
    type: fanout
    over: $steps.generate-queries.queries
    max_items: 5
    max_concurrency: 5
    body:
      - id: hits
        type: call
        fn: searchArxivViaSerper
        args: { query: $item, endDate: $inputs.end_date, num: 10 }
      - id: fetch
        type: call
        fn: fetchPapersByArxivId
        args: { arxivIds: $steps.hits.arxivIds }
        dedup: { against: $state.seen_arxiv_ids, key: arxivId }

  - id: judge-search
    type: agent
    profile: selector
    model: vllm/qwen3.6-35b-a3b
    batch: { over: $steps.search.fetch, size: 10 }
    output: { verdicts: Verdict[] }

  - id: expand
    type: loop
    max_iterations: 2
    body:
      - id: frontier
        type: transform
        fn: sortAndTake
        args:
          items: $state.pending
          by: confidence
          take: { iteration_0: all, default: 20 }

      - id: sections
        type: fanout
        over: $steps.frontier.items
        max_concurrency: 8
        body:
          - { id: refs, type: call, fn: fetchAr5ivCitationMap, args: { arxivId: $item.arxivId } }

      - id: pick-sections
        type: agent
        profile: crawler
        model: vllm/qwen3.6-35b-a3b
        batch: { over: $steps.sections.refs, size: 5 }
        output: { sections: string[] }

      - id: resolve
        type: fanout
        over: $steps.pick-sections.sections
        max_concurrency: 8
        body:
          - id: resolved
            type: call
            fn: resolveArxivByTitle
            args: { title: $item.title }
            dedup: { against: $state.seen_arxiv_ids, key: arxivId }

      - id: judge-expand
        type: agent
        profile: selector
        batch: { over: $steps.resolve.resolved, size: 10 }

outputs:
  papers: { from: $state.accepted, order_by: confidence }
```

静态预算由此可算：
`generate-queries` 1 次模型调用；`search` ≤ 5 次 serper；
`expand` 2 轮，每轮 `pick-sections` 与 `judge-expand` 的批数由 `max_items` 与
`size` 定上界。启动前与 `budget:` 比对。

值得注意的一处：`take: { iteration_0: all, default: 20 }`
对应 `paper_agent.py:210-211`——depth 0 不截断，depth > 0 才取 top 20。
这是官方行为，容易被当成笔误抹平。

## 8. Core / TUI 契约

两半不得互相 import，只能走 event bus 传 JSON
（`docs/extensions.md` §9，drill 的 `protocol.ts` 是范例）。激活粒度正好匹配：

- **Core half**（每 agent 一次，引擎跑在 main agent 上）：
  发 `workflow:started`、`workflow:step-started`、`workflow:step-finished`、
  `workflow:budget-spent`、`workflow:finished`；
- **TUI half**（全应用一次）：订阅上述事件，
  `setStatus` 放页脚（当前步、fan-out N/M、已花预算），
  `publishMessage` 留持久化的步骤结果，
  `registerMessageRenderer` 画 workflow 视图，
  注册启动与取消命令。

这一块没有阻塞项，是 WIDI 现有能力。

## 9. 账本与待测数据

每个 `agent` 步骤必须记录：profile、`provider/id`、thinking level、
输入输出 token、延迟、工具调用数、成本、终止 `reason`。
`agent_idle` 的语义是「停了」不是「做完了」，被中断的 agent 也是 idle，
必须判 `reason`（`core/types.ts:114-117` 的注释明说）。

工作流状态**不得写进 session branch**：
`context.session.appendEntry` 写入的条目每轮重放进上下文、并 fork 给子 session
（`docs/extensions.md` §6）。中间态放在 session 旁边。

动手前应先测的一个数：

```text
spawn(无工具 profile) + prompt + dispose  相对  一次裸模型调用的固定开销
```

vllm 在本地，不花钱。这个数直接决定 `fanout` 的默认 `max_concurrency`
与 `batch.size`。在它出来之前，YAML 里的并发与批大小都是猜的。

## 10. 待定决策

| # | 决策 | 建议 | 影响 |
| --- | --- | --- | --- |
| 1 | workflow 语言是否静态有界 | **是**（§5） | 决定它是「可预算的执行器」还是「YAML 写的 agent」 |
| 2 | 引擎放 Core extension 还是 RPC client | **Core**（架构 B） | 选 Core 需补 §3.3 三个原语，是一次 submodule 改动 |
| 3 | 是否先测 §9 的固定开销 | **是** | 不测则 fan-out 参数无依据 |

决策 2 若选 Core，按 `AGENTS.md` §3.3：
必须先固定失败复现与客户端契约，改动至少覆盖类型、运行时分派、公开协议文档，
以及真实子进程级集成测试；破坏性变更须提升 `RPC_PROTOCOL_VERSION`。
提交流程走 `tutorial/02-widi-version-management.md` 的 gitlink 步骤。

## 11. 实施顺序

1. `pasa-budget`：`intercept("tool_call")` 强制调用预算与时间边界。
   **排在所有事情之前**——目前没有任何东西挡在 API key 与一个无界循环之间。
2. 测 §9 的固定开销，定下 fan-out 与批大小。
3. 决策 2 若选 Core，补三个原语并按 §10 的要求验证。
4. 写死的 `pasa-orchestrator`：先只做 `search()`，不展开。
5. 加入两层 expand 与 topk，产出与 `paper_node.py` 同构的论文树。
6. 与当前 agentic 形态做对照，报告 F1、成本与方差的差异。
   这本身是可发表的结论——PaSa 论文没测过，因为它的 Crawler 是训练出来的。
7. **第二个 workflow 出现之后**，才把引擎从 `pasa-orchestrator` 抽出来。
   抽出后可放 `widis/extensions/workflow/`，由各 namespace 通过
   `settings.json` 的 `extensions` 显式路径引用，不必复制。

## 12. 不做的事

- 不预建通用引擎再往里填 PaSa（`AGENTS.md` §3.2）。
- 不在 workflow 语言里引入 goto 或无界循环（§5）。
- 不抓取 TUI 文本或解析终端控制序列（`AGENTS.md` §3.3）；
  收集输出只在 RPC JSONL 上成立。
- 不把 PaSa 领域逻辑下沉进引擎；域知识留在 `pasa-tools` 与 YAML 里。

## Git 提交流程

本文件是规划，不代表已实现，也不自动提交 Git。
用户审核后再按明确要求实现代码。
不把 API key、模型缓存、论文数据库、原始响应和运行输出提交到 Git。
