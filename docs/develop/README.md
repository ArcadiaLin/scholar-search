# develop/ — 推进工作的入口

> 你要接手推进这个原型，从这里开始。
> 设计文档在上一级 `../`，本目录只管**做什么、怎么做、什么是坏的**。

---

## 1. 现在在哪

**S0–S12 全部执行完。** 逐项状态与每一条验收判据的实测结果在
**`worklog.md`**（进度表在 §1，验收记录在 §4/§5/§7/§8）。
S0–S9 的压缩记录在 `history.md`。

三条前置修复（F-1 / F-2 / F-10）已修，`backlog.md` §1 那个 **0/4 → 4/4** 的
对照在完整系统上复跑通过。S10 之后有了第一个可复现的 Recall@k，
S11 之后 Reviewer 在 episode 中途给出建议（G-1 关闭），
S12 之后 `judge_level=l3b` 真实生效、J0/J2 两组都有数字。

**四段都带着已知的验收缺口**，标 `DONE†`：~~G-6（S10）~~、G-7 / G-8（S11）、
G-9 / G-10（S12）。它们在 `backlog.md` 的"验收缺口"一节，
每条都写了"在补上之前哪些结论不能下"。

2026-08-22 的会话动了其中三条：**G-6 可以关闭**（活的 Reviewer 确实读到了池子），
**G-7 与 G-9 被改写**——它们不再是"等一次合适的运行"，而是各自有了前置缺陷
（G-7 ← F-17，G-9 ← F-19）。

**最要紧的两个数字**：

1. `AutoScholarQuery_train_1` 上端到端 Recall@4 仍是 **0/4**，
   而 L0 召回层在同一条查询上能到 4/4。差额全在策略上——这是 S11 的测量对象，
   不是它的失败；
2. 2026-08-22 的双模型对照（`backlog.md` §1.5）：同一条查询、同一 profile，
   run2 用 **2.6 倍的工具调用、4.5 倍的时长、3 倍大的答案池**，
   **F1 反而从 0.273 掉到 0.195**。

在读任何"接上了什么"之前，先读这两个数字。第二个是新的，
它说明瓶颈已经从召回层移到**策略层与证据层**——
`backlog.md` 新增的 F-14..F-20 七条全部只在 agent 路径上发作，
批量评测碰不到，所以 S10–S12 的验收全绿而它们一直在。

## 2. 下一步

```
前置修复          S10              S11              S12
F-1 / F-2 / F-10  答案池 +         Reviewer v0 +    NP_judge 载体 +
✅ 已修           召回评测回路      NP_0 重写        L3b 判别层
                  ✅ DONE†         ✅ DONE†         ✅ DONE†
```

四段的完整定义、落点、验收判据与排序论证在 **`plan.md`**；
**它是定义，不是状态**——状态看 `worklog.md`。

已排定的路线走完了，所以"下一步"现在是一个需要决定的问题。
按 `backlog.md` 的"修改顺序"一节，最靠前的几件是：

- **F-14**（答案池校验 id 来自本会话）与 **F-17**（Reviewer 的 target 必填）——
  2026-08-22 新增，两条都是很小的改动：前者堵住"模型背出来的论文进最终答案"，
  后者恢复整个 S11 的作用面（当前每种 action 一个 episode 只能用一次，
  长 episode 后半段无人复核）。**两条都能用 §1.5 的会话回溯验证**；
- **F-15**（工具输出截断，agent 看不见大部分召回）——改动更大，但它是
  **任何新的 agent 路径测量的前置**：不修它，测到的"策略"是截断的产物；
- **F-4**（`call_ledger` 接上成本模型与上游 `x-ratelimit-*` 头）——
  它是 R7 检测器的数据源，`plan.md` §7 就把它排在 S10 之后；
- **F-12 / F-13**（S12 期间实测到的两条新缺陷）——它们让任何绕过 agent 的
  批量评测在数据集原问句上召回为 0，J 轴消融已经因此改用夹具查询；
- **G-2**（Evidence Store）与 **U-03**（采样固定）——两件正交的事，
  后者需要用户拍板选路径。

F-14..F-20 与 F-12 / F-13 的分工是清楚的、互不阻塞：前者只在 agent 路径上发作，
后者只在绕过 agent 的批量评测路径上发作。

**如果你只读一份文档，读 `plan.md`；如果你要接着往下做，先读 `worklog.md` §1。**

## 3. 本目录的六份文档

| 文档 | 回答什么问题 | 什么时候读 |
| --- | --- | --- |
| **`plan.md`** | 我该做什么？按什么顺序？做完怎么验？ | **必读，先读** |
| `backlog.md` | 现在什么是坏的？哪些实验结论暂时不能下？ | 动手前读对应条目 |
| `decisions.md` | 这个选择为什么是这样定的？ | 想改某个既定做法之前 |
| `worklog.md` | 实施到哪了？实施中做过哪些计划外的小选择？ | 接手时、以及做完一项之后 |
| `mapping.md` | 某个设计概念的代码在哪？ | 找不到东西的时候 |
| `history.md` | S0–S9 怎么走过来的？环境有什么坑？ | 需要背景或撞上环境问题时 |

`worklog.md` 与 `decisions.md` 的分界：worklog 是**一行一条的现场记录**
（含撞见但按纪律没修的问题），decisions 是**格式完整的 `D-nn`**。
worklog 里标了"实验对照"的条目最终要升格成 `D-nn`。

编号体系（全局唯一，不复用）：

| 前缀 | 含义 | 在哪 |
| --- | --- | --- |
| `S-n` | stage | `plan.md`（S10 起）/ `history.md`（S0–S9） |
| `F-n` | 检索缺陷（已落地的部分本身坏了） | `backlog.md` |
| `G-n` | 验收缺口（验收过了但设计要求没满足） | `backlog.md` |
| `D-n` | 决策 | `decisions.md` |
| `U-n` / `SV-n` / `E-n` | 上游 / Service / 环境缺陷 | `history.md` |
| `B-n` | 会话中的 agent 行为观察 | `backlog.md` |

### 3.1 路径约定

本目录四份文档出现的裸文件名按下表还原，正文不再重复前缀。

| 写法 | 实际路径 |
| --- | --- |
| `index.ts` / `core/*.ts` | `widis/.widi-scholar/extensions/scholar-search/` 下 |
| `profiles/*.md` / `preference/*.md` / `np-*.md` | `widis/.widi-scholar/` 下 |
| `config.yaml` | `src/search-service/config.yaml`（**只有这一份**，属于 Python 服务） |
| `aggregator.py` / `schemas/*.py` / `api/*.py` / `plugins/*.py` | `src/search-service/src/search_service/` 下 |
| `run.mjs` | `experiments/eval-runner/run.mjs` |
| `extensions.md` / `orchestrator.md` | `packages/widi/apps/widi/docs/` 下 |
| `SKILL.md` | `packages/widi/.widi/skills/develop-widi-extension/SKILL.md` |

同目录的 `.md` 直接写文件名（`plan.md`）；上一级的设计文档写 `../`（`../design.md`）。

## 4. 上一级的设计文档

推进工作时最常回查的三份：

- **`../design.md`** — 形式化：两个时间尺度、四个模块、$NP/HP/PH$。
  **动架构之前必读**，尤其 §5.2 的四个 checkpoint 与 §4 的模块边界。
- **`../prototype.md`** — 可实现的具体方案：九个工具的签名、排序栈 L0–L3、评价协议。
  实现检索或排序时照它做，**不要自创方案**。
- **`../reviewer-design.md`** — S11 的设计全文。做 S11 之前必读。

其余：`../search-service.md`（Service 契约）、`../experiments.md`（五个消融轴）、
`../skill-decomposition.md`（94 条检索指导的逐条归属）、
`../metascientist-rerank-design.md`（rerank 算法）、
`../agentic_search_preference_reviewer_research_design.md`（研究理念）。

完整的四层阅读顺序在 `AGENTS.md` §11。

---

## 5. 环境与命令

```bash
npm run bootstrap            # 首次：初始化 submodule + npm ci + uv sync
npm run build                # widi:scholar 跑的是 dist
npm run widi:scholar         # ← 入口：Search Service + 检索 agent TUI
npm run widi:scholar:dev     # 同上，WIDI 跑 TypeScript 源码
npm run test:widis           # 跑所有 namespace 的 extension 测试
```

**`npm run widi:scholar` 是看这个原型的入口。** 它做三件事
（`scripts/run-scholar.mjs`）：起 Python Search Service 并等它真的应答 `/health`、
把地址经 `SCHOLAR_SEARCH_SERVICE_URL` 传给 extension、以 `--profile search` 打开 TUI。
退出 TUI 时它起的那个 Service 一起结束。

为什么要合成一条命令：九个检索工具是 Search Service 的瘦客户端，Service 没起时
它们**全部**失败，而失败信息（"服务不可达"）看起来像 extension 的 bug。
把两半绑在一起，这个误诊就不会发生。

两个行为值得知道：已经在跑的 Service 会被复用而不是再起一个（先探 `/health`），
退出时也不会去关别人的进程；uvicorn 的日志写到 `runs/logs/search-service.log`
而不是终端，否则会把全屏 TUI 冲花。

要开别的角色就传 profile，例如 `npm run widi:scholar -- --profile reviewer`；
`main`（有 shell 与文件系统的通用 agent）是 `npm run widi`。

`widi` / `widi:dev` / `widi:rpc` 保留不动——eval runner 按名字调用 `widi:rpc`，
而且它们不该顺带起 Service：评测需要自己控制 Service 的地址与生命周期。

**单个 extension 的类型与格式检查**（`npm run check` **不覆盖**动态加载的 extension）：

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

## 6. 本仓库的实际坑

**不要照抄 `develop-widi-extension/SKILL.md` 里的 `Type.Object` 示例。**
jiti 无法从 `widis/` 解析裸 `typebox` 导入，且固定版本里 typebox 的 `TSchema`
结构上是空的。参数 schema **手写 JSON Schema 字面量**。
先看本仓库已有的先例：`widis/.widi-pasa/extensions/pasa-tools/index.ts`，
它是同构的 Core-half extension，结构、schema 写法、测试布局都可以照着做。

其余易错点见 `SKILL.md` §6，尤其是：工具失败必须 `throw`、工具自己限制输出大小、
执行前检查 abort signal、路径基于 `context.workspace.cwd`。

**observer 事件没有顺序保证**，不要假设 `agent_spawned` 一定先于
`agent_status_changed`（`packages/widi/apps/widi/docs/extensions.md:167`）。
S11 的 Reviewer 启动机制就是按这条设计成无状态的，见 `../reviewer-design.md` §5.2b。

**extension 只读环境变量，不读 `config.yaml`。** `config.yaml` 只有一份、
在 `src/search-service/`、属于 Python 服务。要让 extension 拿到 Service 侧配置，
得加端点，见 D-15。

---

## 7. 工作纪律

四条，前两条是 `AGENTS.md` §11.3 的展开，后两条是本路线特有的：

1. **停在可验收的点上。** 一个 stage 做完、验收通过、提交，再看下一个。
   不要为了赶进度把两个 stage 混进一个 commit。
2. **判据先于实现，且不得事后放宽。** 实现完成后发现判据没满足，
   把差额写进 `backlog.md` 的验收缺口，不要改判据去迁就实现。
   详细论证见 `plan.md` §8——这条已经被违反过两次（G-1、G-3）。
3. **卡住就如实记录。** `BLOCKED` 比假装完成有用得多。
   同一处反复卡住且没有新信息时，停下来把问题交给用户，不要继续空转。
4. **路线没规定而你做出的选择，记成 `D-nn`** 写进 `decisions.md`，
   理由、代价、被否决的替代方案三项都要写。
