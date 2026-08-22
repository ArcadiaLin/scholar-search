# 已完成的工作与环境缺陷

> 读者：想知道"这套东西是怎么变成现在这样的"、或者撞上了某个环境问题的人
> 这里**没有待办事项**。待办在 `plan.md`（要做什么）与 `backlog.md`（什么是坏的）。

S0–S9 是一个**已经执行完的单元**，2026-08-20 到 08-21 完成。
本文是它的压缩记录：状态、结果、以及留下的缺口指针。

完整的逐 stage 执行日志（约一千行，含每一步的命令与输出）保存在 git 历史里，
文件是 `docs/06-progress.md`，最后一版在 commit `286b0de`。
需要复核某个具体数字时去那里查；日常推进不需要它。

---

## 1. S0–S9 状态表

| Stage | 内容 | 状态 | commit | 结果与遗留 |
| --- | --- | --- | --- | --- |
| S0 | 分支、进度骨架、vllm 接入 | DONE | `a069f87` | 用 RPC 无头验收替代交互式 TUI（D-01） |
| S1 | extension 骨架与最短链路 | DONE | `6414773` | 途中修了阻断性上游缺陷 U-01（Windows 上任何 extension 都加载不了） |
| S2 | 核心检索工具 | DONE | `fae2073` | 给 Service 补了 `/paper/{id}` 与 subquery 扇出（D-06），并修了扇出暴露的并发缺陷 SV-01 |
| S3 | search profile：工具集收紧 | DONE | `8bd31a4` + `8559903` | 正文只放 $SP_M$ 静态部分；S5 途中发现两段策略泄漏，已在 `8559903` 修正 |
| S4 | 概念到实现映射 + Preference 载体 | DONE | `d990f67` | 只建载体与版本约定，条目内容归 S5 |
| S5 | $NP_0^{agent}$ 条目化 | DONE† | `9bec91a` + `4b46427` | 30 条条目；固定采样后验收通过。**判据为事后选定，见 G-3** |
| S6 | 公开轨迹 $\bar{\tau}_t$ | DONE | `bb6773c` | observer 白名单过滤 + Service `SearchState`；私有推理逐项 grep 为 0 |
| S7 | 其余检索工具 | DONE† | `ec7b377` | $T^M$ 补齐九个；Service 侧新增五个端点。**排序栈只有 L1 真实存在，见 G-5** |
| S8 | Reviewer 通道 | DONE† | `2bc0046` | extension spawn 而非 Main spawn；Main 的 16 个 thinking block 取 30 片段查 Reviewer session，leaks 0。**介入时机偏在 episode 之后，见 G-1** |
| S9 | RPC 评测入口 | DONE† | `fc225e9` | 只走 RPC 帧不读 session；provenance 逐项落地；失败样本进分母。**产出不可复现，见 G-4** |

**`DONE` 的含义严格限定为**：该 stage 的落点已完成，且它自己写明的验收命令通过。
它**不**意味着对应的设计概念已经完整落地——判据在若干处弱于
`design.md` / `prototype.md` 的要求。凡出现这种情况的 stage 标 `DONE†`，
缺口逐条记在 `backlog.md` 的验收缺口一节。

S0–S9 原本在分支 `feature/widi-scholar-prototype` 上，一个 stage 一个 commit，
已全部合入 `main`。

### 值得留住的两个数字

- **S5 的消融对照**：固定采样后，判据取**调用构成**而非调用总数——
  `provider_query` 全开 0/0/0 vs 全关 3/2/3，n=3/组。
  原判据（调用总数）不成立：全关 7–37，全开 22–40，区间大面积重叠。
  这两个数字是 G-3 的依据，也是 D-12 那条"关掉它会让轨迹不同"判据的来源。
- **S8 的隔离证据**：Main 的 16 个 thinking block 抽 30 个片段去 Reviewer 的
  session 里逐条 grep，leaks = 0。这是 $C^R_t \neq C^M_t$ 目前唯一的实证，
  S11 的验收判据 8 沿用同一方法。

---

## 2. S9 之后（不是 stage）

| 时间 | 事件 | 产物 |
| --- | --- | --- |
| 08-21 | 默认模型与 gitlink 维护 | — |
| 08-21 | **首次真实人机会话**，追出四个已落地部件的缺陷 | `backlog.md` F-1..F-7 |
| 08-21 | merge LLM provider 层（`aac617c`），排出 S10/S12 | `plan.md` §5；决策 D-09 |
| 08-22 | 三次会话的横向审阅，得到一个负结果，排出 S11 | `../reviewer-design.md`；决策 D-10..D-12 |
| 08-22 | 移交审阅：三处通路不存在 | 决策 D-13..D-15；本次文档重组 |
| 08-21 | 前置修复 F-1 / F-2 / F-10 落地 | `worklog.md` §4 的 0/4 → 4/4 复跑 |
| 08-21 | S10 落地 | 第一个 Recall@k：`AutoScholarQuery_train_1` 上 **0/4** |

### 一条不可跨越的对照线：`EXTENSION_VERSION` 1 → 2

**S10 之前跑过的任何检索行为数字都不能与之后的直接比较**，`plan.md` §3.8 第一条
预先声明过这件事，这里记下它实际的分界与原因：

| 变了什么 | 后果 |
| --- | --- |
| `update_answer_pool` 注册进 $T^M$（9 → 10 个工具） | step 预算里多了一项开销，调用构成必然变化。**S5 的验收判据正是"调用构成"，所以 S5 那张表不能与 S10 之后的运行对照**（决策 D-08 已写明） |
| `search_metadata` 的 `query` 契约从"自然语言陈述"改成"词项按 AND 组合" | agent 写查询的方式变了 |
| arXiv 的词间连接从隐含 OR 改成 AND（F-1） | 同一条查询的召回集完全不同 |
| `SearchState.issued_queries` 多了 `native_query`；`Failure.error_type` 多了 `bad_id` | 旧的 `.json` 轨迹没有这两项 |

分界点是 commit `8bc69de`（前置修复）与紧随其后的 S10 commit；
`EXTENSION_VERSION` 从 `1` 变成 `2`，每次 eval run 的 provenance 里都记着它，
所以"这个数字是哪一侧的"永远可查。

---

## 3. 上游缺陷（`packages/widi/`）

只有确认是 WIDI 原生缺陷、且 extension 内无法修复时才动 `packages/widi/`。
每一次都要记最小复现、submodule commit、父仓库 gitlink 更新。

### U-01 — extension id 在 Windows 上取成整条绝对路径（S1 已修）

`enabledExtensions: ["scholar-search"]` 永不匹配，profile 拿不到工具，
诊断只说 `extension.factory_missing`，启动诊断里**没有**任何 `extension.*` 错误，
所以第一眼看不出是加载失败。

根因：loader 里的 `basename` 只按 `/` 切，Windows 路径用 `\`。
补丁只动 `loader.ts` 的 `basename`。已确认无回归（10 个 extension 相关测试全过，
基线对照失败集合逐个相同）。

### U-02 — profile id 的 filename 派生同样只认 `/`（未修）

与 U-01 逐字同构，在 `apps/widi/src/core/agent-profile.ts:1166` 的 `basenameEnvPath`。
每次启动产生一条假警告，但 profile 本身按 id 正常加载，没有阻断任何东西。
**留给用户决定是否顺手一起修。**

### U-03 — WIDI 无法固定采样参数，可复现运行因此不可得（未修，需用户授权）

**这条是 G-4 的成因，也是唯一一条卡在 vendored 边界上的缺陷。**

**症状**：没有任何配置面能设置 temperature / top_p / seed。逐处确认过：

| 位置 | 结论 |
| --- | --- |
| `settings.json` / `setting-manager.ts` | 无 temperature/seed 键 |
| `models.json` 的三个 schema | 无采样字段 |
| `compat` 三个 schema | 无 `extraBody` 之类透传口 |
| 拦截器 `before_provider_request` | 其 patch 只有 transport / timeoutMs / maxRetries / maxRetryDelayMs / headers / metadata / cacheRetention |
| 拦截器 `before_provider_payload` | **不在**六个可用拦截器里 |
| `agent-orchestrator.ts:1182` | 只传 `request.settings.providerRetry` |

`SimpleStreamOptions`（pi-ai）本身**有** `temperature`，`packages/agent/src/proxy.ts`
就在转发它。缺的只是从 WIDI 配置到 `AgentHarnessStreamOptions` 这一段。

**为什么没修**：正经接通要往 `packages/widi/packages/agent/src/harness/types.ts`
加字段。那是 vendored 的 Pi fork，submodule 的 `AGENTS.md` 明确写
"Treat `packages/agent` as vendored upstream code... Do not modify it unless the
user explicitly asks"。**用户没有明确要求改它**，所以停在这里。
这与 U-01 不同：U-01 改的是 `apps/widi/`（WIDI 自己的代码）。

**当前绕法**：scratchpad 里一个反向代理，转发 vllm 请求时强制写入采样参数，
再把 `models.json` 的 `baseUrl` 临时指过去。够做一次实验，但**不进仓库**。

**三条路径互斥，需要用户拍板**：改 vendored 的 `packages/agent`（需明确授权）、
把 shim 变成仓库内的正式部件、或者在 vllm 服务端固定默认采样参数
（最省事，但把实验配置放到了仓库之外）。

**它不能靠"封装进 Search Service"绕过**——它卡的是调用点 A（Main 的推理），
见 `mapping.md` §3.5。

---

## 4. Search Service 缺陷

### SV-01 — provider 的共享 HTTP client 在并发下互相关闭（S2 已修）

S2 的 subquery 扇出暴露出来的既有 bug，不是新代码引入的：多个并发请求共享
同一个 client，先完成的那个把它关掉，后面的全部失败。

---

## 5. 环境与工具链

**这一节大部分是 Windows 时期的记录。** 当前开发环境是 WSL2 / Linux，
E-01 / E-03 / E-05 对现在的环境已经不适用，保留是因为仓库仍然声称跨平台。

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| E-01 | `npm run widi:dev` / `widi:rpc --dev` 在 Windows 上 spawn EINVAL | S0 已修 |
| E-03 | `npm run test:widis` 在 Windows 上一个测试都跑不起来 | S1 已修 |
| E-04 | `all_proxy=socks5://` 让 Search Service 的 16 个测试报 ImportError | 已修 |
| E-02 | CRLF 导致 biome 格式检查全表报错 | **未修，非本路线引入** |
| E-06 | `ruff format --check .` 本来就红（基线 17 个文件） | **未修，非本路线引入** |
| E-05 | `packages/widi` 完整测试套件在 Windows 上 12 个文件失败 | **未修，既有基线** |

三条未修的都有同一个理由：修它们会产生一个跟本路线无关的巨大 diff。
本路线只保证**不新增**这笔债——E-06 的对照是 S2 改动前 17 个不合格文件、
改动后 16 个，新增的四个文件都跑过 `ruff format` 因此干净。

**E-02 有一个更危险的下游后果**：`packages/widi` 的 `npm run check` 带 `--write`，
在 CRLF 环境下会一次改写几百个文件。判断"格式检查是否因本次改动变红"要用
LF 归一化后的单文件 biome 结果。
