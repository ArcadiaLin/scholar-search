# widi-pasa：用 WIDI 原语重建 PaSa 的 Agent 架构

## 结论

目标不是运行 `bytedance/pasa` 的官方代码，而是把 PaSa 论文描述的
**Crawler / Selector 双 Agent 结构**用 `widis/.widi-pasa/` 的 profile 和
extension 重新表达，模型使用本仓库已配置的 provider。

本项目**不做模型训练**。凡是只有在自训模型上才有意义的机制
（单 token logprob 打分、阈值标定、SFT/PPO 复现）一律不进入本架构。

当前已落地：namespace 隔离、启动脚本、`pasa-tools` extension 与
`main` / `crawler` / `selector` 三个 profile。确定性编排器、预算拦截器
和评分器仍是延后项，见 §7。

## 权威来源

- 论文：https://arxiv.org/abs/2501.10120
- 官方仓库（只读镜像）：`references/repos/pasa`，固定
  `2aaa6a9b1e48d24a2b7e21e8551f863dad9eeb84`，登记在
  `references/sources.yaml` 的 `repositories:` 段
- 官方 prompt：`references/repos/pasa/agent_prompt.json`
- 官方控制流：`references/repos/pasa/paper_agent.py`
- 官方结果结构：`references/repos/pasa/paper_node.py`
- 官方评分实现：`references/repos/pasa/metrics.py`
- WIDI extension 契约：`packages/widi/apps/widi/docs/extensions.md`
- WIDI 作者 API：`packages/widi/apps/widi/src/core/extension/api.ts`
- 本项目数据清单：`benchmarks/sources.yaml`
- 本项目 benchmark 协议：`benchmarks/protocol.md`

## 1. 数据集与外部依赖

`benchmarks/sources.yaml` 固定：

```text
repo_id: CarlanLark/pasa-dataset
revision: 232428b0c867268c3b8ded90db4d98c1b30501d6
```

`benchmark` profile 含 `AutoScholarQuery/test.jsonl`（1000 条）和
`RealScholarQuery/test.jsonl`（50 条）；HF 数据集为 gated，需先接受条款
再通过 `HF_TOKEN` 下载：

```bash
HF_TOKEN=... uv run python benchmarks/download.py \
  download pasa --profile benchmark
```

`full` profile 另含约 2.5 GB 本地论文库
（`id2paper.json` + `cs_paper_2nd.zip`），目前**未接入**，见 §4.3。

检索链路的外部依赖：

- **Serper**（`https://google.serper.dev/search`）：`[Search]` 动作，
  查询附加 `site:arxiv.org` 与 `before:<end_date>`，key 取自
  `SERPER_API_KEY` 环境变量。官方代码中变量名为 `GOOGLE_KEY`，
  README 有 SerpAPI/Serper 混用，实际 endpoint 以 `utils.py` 为准。
- **arXiv API**：按 ID 取 metadata，按标题做精确匹配解析被引论文。
- **ar5iv**：取全文 HTML，切章节、抽引用，支撑 `[Expand]`。

## 2. Namespace 架构

“WIDI 版本”不是多份 runtime fork，而是同一份 `packages/widi/` runtime
搭配不同配置 namespace：

```text
packages/widi/          # 唯一固定的 WIDI runtime submodule
widis/
├── .widi-scholar/      # Scholar 配置
└── .widi-pasa/         # PASA benchmark 配置
```

每个 namespace 拥有独立的 `settings.json`、`profiles/`、`themes/`、
`agent/`、extensions。启动器按 namespace 选择 `--agent-dir`：

```text
npm run widi:dev        # scholar, ts 源码
npm run widi:rpc        # scholar, JSONL RPC
npm run widi:pasa:dev   # pasa, ts 源码
npm run widi:pasa:rpc   # pasa, JSONL RPC
```

`scripts/run-widi.mjs` 负责把 namespace 映射到
`widis/.widi-<namespace>`、注入 `--cwd` / `--agent-dir` / 默认 profile，
对未知 namespace 给出明确 stderr 错误，且不向 WIDI CLI 转发
`--namespace`。两个 namespace 的 auth、session、lock、runs 互不读取，
也**不需要**第二份 WIDI 源码、node_modules 或 lockfile。

正式 benchmark runner 必须通过对应 namespace 的 RPC 启动入口驱动，
不得抓取 TUI 文本或读取内部 session 文件。每次运行记录 namespace、
WIDI git commit、RPC protocol version、profile、模型、extension 版本
和预算。

## 3. 论文结构到 WIDI 原语的映射

PaSa 的 Crawler 只有两个对外动作：`[Search]` 和 `[Expand]`；
Selector 不需要外部工具。模型只出现在四个位置：Crawler 生成查询
（1 次）、Crawler 选章节（批量）、Selector 打分（两处，批量），
其余全部是确定性代码。

| PaSa 论文 / 官方实现 | widi-pasa 承载物 | 状态 |
| --- | --- | --- |
| Crawler：由 user query 生成搜索式 | `profiles/crawler.md`，prompt 取自 `generate_query` | 已实现 |
| Crawler：由论文选择要展开的章节 | 同一 profile，prompt 取自 `select_section` | 已实现 |
| Selector：判断 (query, title, abstract) 相关性 | `profiles/selector.md`，prompt 取自 `get_selected` | 已实现 |
| `google_search_arxiv_id` | `pasa-tools` 的 `pasa_search` | 已实现 |
| `search_paper_by_arxiv_id` | `pasa-tools` 的 `pasa_fetch_paper` | 已实现 |
| `search_arxiv_id_by_title` | `pasa-tools` 的 `pasa_resolve_title` | 已实现 |
| `search_section_by_arxiv_id`（ar5iv） | `pasa-tools` 的 `pasa_expand_refs` | 已实现 |
| 本地论文库 `id2paper.json` + `cs_paper_2nd.zip` | `pasa_fetch_paper` 的第一优先来源 | 未接，见 §4.3 |
| `touch_ids` 去重、`papers_queue`、`expand_layers`、topk | 确定性编排器 | 延后 |
| `PaperNode` 论文树 | 结构化 RPC 输出 | 延后 |
| `metrics.py` | Python 侧 scorer | 延后 |

检索流程（按 `paper_agent.py` 还原）：

```text
SEARCH:  query -> Crawler 生成多个互斥搜索式
         -> pasa_search (Serper, "<q> before:<end> site:arxiv.org", num=10)
         -> touch_ids 去重 -> pasa_fetch_paper -> Selector 批量判定
         -> PaperNode(depth=0) -> papers_queue
EXPAND:  papers_queue 按 select_score 降序（depth 0 全展开，之后 top 20）
         -> pasa_expand_refs (ar5iv 章节->被引条目)
         -> Crawler 批量选章节 -> pasa_resolve_title 解析被引标题
         -> touch_ids 去重 -> Selector 批量判定 -> PaperNode(depth+1)
层数固定为 2（run_paper_agent.py:34）
```

## 4. 已实现形态与硬约束

### 4.1 `extensions/pasa-tools`

四个动作合并为**一个** extension：两组工具共用 HTTP 客户端、arXiv 解析
和标题归一化，拆开会复制同一份代码。检索逻辑在 `core/` 下是纯函数，
`index.ts` 只做 WIDI 工具契约适配。

已落实的约束：

- `end_date` 在三处强制：JSON Schema 的 `required`、execute 前置检查、
  `normalizeEndDate`。WIDI 运行时不校验工具参数，原先无法解析的日期
  会静默退化为无界搜索，直接污染 F1；
- 显式 timeout、指数退避、区分可重试状态码，耗尽后重抛
  （`core/http.ts`）；
- arXiv ID 与标题归一化是内部纯函数，不注册为工具；
- 工具输出有界（`MAX_*_CHARS`）；
- `SERPER_API_KEY` 取自环境变量，回退到被忽略的 `.env`；
- 参数 schema 手写为纯 JSON Schema：jiti 无法从 `widis/` 解析裸
  `typebox` 导入，而 WIDI 把 schema 原样透传给 Pi。

测试：45 条解析器与 HTTP 测试，`scripts/widis-test.mjs` 用
`node --test` 加 WIDI 自带的 tsx 运行（extension 不属于任何 npm
workspace，引入测试框架会在仓库根建第二份 lockfile）。Fixture 是
2026-08-15 录制的真实响应，整体排除在 lint/format 之外；限流、超时、
abort 用本地 HTTP server 驱动，不打真实 API。

### 4.2 Profiles

- `profiles/crawler.md`：四个 pasa 工具加 `send_message`，
  `persist: false`。system prompt 承载 `generate_query` 与
  `select_section` 策略，但**不保留 `[Search]` / `[Expand]` 文本动作
  格式**——在 WIDI 里动作就是工具调用，工具调用日志即动作轨迹。
- `profiles/selector.md`：仅 `send_message`，`persist: false`。
  移植 `get_selected` 的「fully satisfies」判据，输出扩展为批量
  JSON 数组（见 §4.4）。
- `profiles/main.md`：`read`、`list_agents`、`spawn_agent`、
  `send_message`、`watch_agent`、`dispose_agent`。**不持有 pasa 检索
  工具**——main 是编排入口，若它也能检索，模型会倾向自己做完，
  双 agent 结构就不会被真正走到。该驱动路径不可复现，只作 smoke test。

`settings.json` 的 `enabledProfiles` 与 `profiles/` 目录实际存在的
文件对齐；`packages/widi/preset/` 只是 `install.sh` 的播种模板，
不是运行时解析源。

### 4.3 实测硬约束

以下约束已在当前 submodule 版本上核实：

1. **profile 不能声明模型**。`AgentProfile`
   （`core/agent-profile.ts:17-28`）没有任何 model/provider 字段；
   模型只能在 `spawn_agent` / `actions.spawnAgent` 时绑定。
   因此「crawler/selector 各用哪个模型」属于**运行配置**，必须随每次
   运行记录。
2. **extension 工具拿不到 `actions`**。`ToolExecutionContext`
   （`core/tools/types.ts:25-52`）没有 spawn/驱动子 agent 的能力；
   只有 observer、interceptor 和 event bus handler 拿得到
   `context.actions`。所以确定性编排器的入口只能是 event bus handler
   （见 §7）。
3. **本地论文库未接**。PaSa 是本地库优先、arXiv 兜底；全走 arXiv API
   慢、受限流、且拿不到 sections。接入时必须走显式配置项，不得依赖
   「碰巧存在」的文件（`AGENTS.md` §8）。

### 4.4 Selector 的打分退化与批处理

PaSa 的 `select_score` 是单 token logprob（`models.py:35-45`，阈值
0.5），还用于排序和 Recall@20/50/100。本项目不训练，改为结构化判定：

```text
decision:   true | false
confidence: high | medium | low     # 自报，未校准
reason:     <string>
```

必须承认的后果：`confidence` 未经校准，只允许用于 expand 阶段的候选
排序，不得进入任何对外指标；官方 Recall@20/50/100 依赖连续分数全序，
**不可比**，不得与论文表格并列。赛题主指标不受影响——`AGENTS.md`
§5.3 的权重是 F1 70%、运行效率 20%、结构化回复 10%。

Selector 单条查询调用量在数百量级，且对每篇论文是**无状态**判断
（同一 agent 的历史判定会污染后续 turn）。因此 selector 一个 turn
处理一批论文、返回结构化数组，`persist: false` 用完即弃，批大小
固定并记录为运行配置。

## 5. 与论文的已知偏差登记

任何一次运行都必须显式记录以下偏差，不得默认与论文表格比较：

| 偏差 | 论文 / 官方 | widi-pasa |
| --- | --- | --- |
| Crawler 模型 | `pasa-7b-crawler`（SFT + PPO） | 本仓库配置的通用对话模型，未训练 |
| Selector 模型 | `pasa-7b-selector`（SFT） | 同上 |
| 相关性分数 | 单 token `True` 概率，阈值 0.5 | 离散判定 + 未校准 confidence |
| Recall@20/50/100 | 依赖连续分数全序 | 不可比，不报告 |
| 日期边界 | `published_time - 7 天`（`run_paper_agent.py:48`） | 显式 `end_date`；RealScholarQuery 全部为 `20241001`，减 7 天后与 `benchmarks/protocol.md` 声明不一致 |
| `search_queries` 生效值 | 传入的是 `args.expand_papers`，实际为 20（`run_paper_agent.py:56`） | 显式取值并记录 |
| 网络错误 | 无 timeout、宽异常吞掉 | 显式 timeout、有界重试、错误进入分母 |
| ar5iv 章节粒度 | 二级章节，子章节文本聚合进父节点，有停用词过滤 | 按 `<h[2-4] class="ltx_title">` 扁平切块，无停用词过滤 |
| 被引条目 | 解析后标题 | 返回原始 reference 字符串（官方 `utils.py:250` 自己建议的做法），标题抽取交给模型 |

## 6. 两种运行口径不得混比

- `pasa-official-repro`：官方权重 + 官方 transformers fork + 官方
  `metrics.py`。由于不训练，它只用于校验外部工具链和数据边界，
  不是本项目的基线。
- `pasa-widi-native`：论文架构 + 本仓库模型 + WIDI 运行时，
  是赛题实现的真正基线。

两者结果不得放在同一张表里比较。

## 7. 明确延后的内容

| 项 | 内容 | 前置条件 |
| --- | --- | --- |
| `extensions/pasa-orchestrator` | 确定性 PaSa 循环：`search()` → `expand(0)` → `expand(1)`、`touch_ids` 去重、topk、论文树。入口只能是 event bus handler | 本轮四项已完成，可开始 |
| `profiles/reviewer.md` | 对失败样本与检索轨迹做经验总结，回流到 crawler 查询策略 | crawler/selector 走通且有可复核运行记录 |
| `extensions/pasa-budget` | `intercept("tool_call")` 强制调用预算与时间边界 | 编排器落地后 |
| Python scorer | 官方 `metrics.py` 口径与赛题口径分别报告 | 论文树输出稳定后 |
| MCP | 把检索能力反向暴露给外部客户端 | 有基线之后 |

编排器的可行形态已核实：入口是 `emitExtensionEvent("pasa:run", ...)`，
handler 里用 `actions.spawnAgent` + `actions.prompt({target})` 驱动
子 agent；等子 agent 靠 `observe("agent_idle")` 自建 promise map
（`waitForIdle()` 没有 target 参数）；取子 agent 输出靠子 agent 上
那份 extension 的 `observe("agent_harness_event")` 中继回传
（`agent_harness_event` 不广播，只给事件主体 agent 自己）；
`agent_idle` 语义是「停了」不是「做完了」，必须判 `reason`。
Crawler 可长驻复用，**Selector 不行**——无状态要求每批
spawn/dispose 一次。

正式 benchmark 必须等 `pasa-orchestrator` 落地；当前 `main` 驱动路径
不可复现，不得用于产出对外数字。

## 8. 实施记录与验收

已完成：

1. namespace 隔离与启动脚本（`scripts/run-widi.mjs`、`package.json`
   增加 `widi:pasa*` 命令）；
2. `extensions/pasa-tools` 四个工具，`end_date` 三处强制；
3. `main.md` / `crawler.md` / `selector.md` 三个 profile，
   `enabledProfiles` 对齐；
4. `scripts/widis-quality.mjs` 发现式覆盖 `widis/` 下每个 namespace
   的配置与 extension（biome + 逐 extension `tsgo --noEmit`）；
5. 45 条解析器与 HTTP 测试（`scripts/widis-test.mjs`）。

待做：单条 AutoScholarQuery 查询端到端 smoke test（由 `main` 驱动）。

本轮验收标准：

- extension 在 `npm run widi:pasa:dev` 下加载无诊断，`/reload` 后
  工具仍可用；
- 每个工具有显式 timeout 与有界重试，失败可观测，默认测试不依赖
  实时 API；
- crawler 的工具调用与 selector 的批量判定输出都能被确定性解析，
  解析器有固定 fixture 覆盖；
- smoke test 记录 crawler/selector 各自的 `provider/id`、时间边界、
  批大小、工具调用数、Token 和延迟；
- §5 的偏差表随运行记录一同保存。

## Git 提交流程

- 默认只生成或修改 `tutorial/` 指导，不自动提交 Git。
- 用户审核指导后，再按用户明确要求实现代码；用户明确要求提交时才
  整理 commit，且只包含已审核范围内的文件。
- 不把 API key、模型缓存、论文数据库、原始响应和运行输出提交到 Git。
