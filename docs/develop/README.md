# develop/ — 推进工作的入口

> 你要接手推进这个原型，从这里开始。
> 设计文档在上一级 `../`，本目录只管**做什么、怎么做、什么是坏的**。

---

## 1. 现在在哪

**S0–S9 已经全部完成**：一个只会检索、不会写代码的学术检索 agent 在 WIDI TUI 里
跑得起来，九个检索工具、受限 profile、偏好载体、公开轨迹、Sidecar Reviewer 通道、
RPC 评测入口都在位。压缩记录在 `history.md`。

**但它检索得不好**，而且原因已经查清：2026-08-21 的三次真实会话把问题定位到了
一处查询拼接错误（F-1），修掉它同一条查询的召回从 **0/4 变成 4/4**。
详见 `backlog.md` §1。

所以下一步不是加功能，是**先把召回修对、再把结果变成可测量的数据**。

## 2. 下一步

```
前置修复          S10              S11              S12
F-1 / F-2 / F-10  答案池 +         Reviewer v0 +    NP_judge 载体 +
                  召回评测回路      NP_0 重写        L3b 判别层
```

线性依赖，不要并行。完整定义、落点、验收判据与排序论证在 **`plan.md`**。

**如果你只读一份文档，读 `plan.md`。**

## 3. 本目录的五份文档

| 文档 | 回答什么问题 | 什么时候读 |
| --- | --- | --- |
| **`plan.md`** | 我该做什么？按什么顺序？做完怎么验？ | **必读，先读** |
| `backlog.md` | 现在什么是坏的？哪些实验结论暂时不能下？ | 动手前读对应条目 |
| `decisions.md` | 这个选择为什么是这样定的？ | 想改某个既定做法之前 |
| `mapping.md` | 某个设计概念的代码在哪？ | 找不到东西的时候 |
| `history.md` | S0–S9 怎么走过来的？环境有什么坑？ | 需要背景或撞上环境问题时 |

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
