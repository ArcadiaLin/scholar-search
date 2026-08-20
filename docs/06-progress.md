# widi-scholar 原型开发进度

> 这条路线的状态来源。stage 定义在 `docs/06-widi-scholar-roadmap.md`（只读）。

分支：`feature/widi-scholar-prototype`

## 状态表

| Stage | 内容 | 状态 | commit | 备注 |
| --- | --- | --- | --- | --- |
| S0 | 分支、进度骨架、vllm 接入 | DONE | `a069f87` | 用 RPC 无头验收替代交互式 TUI，见决策 D-01 |
| S1 | extension 骨架与最短链路 | TODO | | |
| S2 | 核心检索工具 | TODO | | |
| S3 | search profile：工具集收紧 | TODO | | |
| S4 | 概念到实现映射 + Preference 载体 | TODO | | |
| S5 | $NP_0^{agent}$ 条目化 | TODO | | |
| S6 | 公开轨迹 $\bar{\tau}_t$ | TODO | | |
| S7 | 其余检索工具 | TODO | | |
| S8 | Reviewer 通道 | TODO | | |
| S9 | RPC 评测入口 | TODO | | |

状态取值：`TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`。
`IN_PROGRESS` 必须在备注里写清做到哪一步；`BLOCKED` 必须写清卡在哪、试过什么、需要什么。

## 日志

每完成一段追加一条，保持简短：做了什么、验收结果、commit。

### 2026-08-20 — S0

- 做了：
  - 建分支 `feature/widi-scholar-prototype`（从 `main` @ `5ed9cc1`）；
  - `widis/.widi-scholar/agent/models.json` 新增 `vllm` provider，与 `.widi-pasa`
    里已有的同名 provider 逐字一致（同一台局域网机器、同一模型）；
  - `widis/.widi-scholar/settings.json` 的 `enabledModels` 追加 `"vllm/*"`；
    **未动** `defaultProvider` / `defaultModel`（路线图 §3 S0 明确要求）；
  - 修 `scripts/run-widi.mjs` 的 Windows 启动缺陷（下方"环境与工具链缺陷" E-01），
    否则 S0 的验收命令根本起不来。

- 验收（实际命令与输出）：
  1. 服务可达性：
     `curl -s http://192.168.163.112:8003/v1/models`
     → `{"object":"list","data":[{"id":"qwen3.6-35b-a3b",...,"max_model_len":262144}]}`
  2. 经 WIDI 的无头验收（替代交互式 TUI，见 D-01），
     `node scripts/run-widi.mjs --namespace scholar --dev --mode rpc` 上依次发
     `set_model` / `inspect` / `prompt` / `run_summary`：
     - `ready`：`protocolVersion=1`，`rootAgentId=main-yzqs`，
       `agentDir=widis\.widi-scholar`
     - `set_model` → `ok:true`，解析到
       `provider=vllm`、`id=qwen3.6-35b-a3b`、`baseUrl=http://192.168.163.112:8003/v1`、
       `compat.thinkingFormat=qwen-chat-template`
     - `prompt`（body 为 `Reply with exactly the word: PONG`）→ `ok:true`,
       `kind=completed`，正文 `PONG`，`stopReason=stop`，
       `usage={input:10374, output:18}`
     - `run_summary` → `turns=1, providerResponses=1, providerErrors=0, durationMs=2279`
  3. 改动文件的静态检查：`npm run check:workspace` 报 4 个错，
     **全部是 CRLF/LF 格式差异且改动前就存在**（见 E-02）；把
     `scripts/run-widi.mjs` 换行归一为 LF 后单独跑 biome → `Checked 1 file. No fixes applied.`

- 已知但不属于 S0 的告警（`ready.diagnostics`，改动前就有，未处理）：
  - `profile.id_filename_mismatch`：`profiles/main.md` 的 id 与文件名派生 id 不一致；
  - `model.default_unavailable`：默认模型 `kimi-coding/k3` 未注册/无凭据。
    这正是 S0 不改默认值的后果，属预期；用户在 TUI 里 `/model` 切换即可。

- commit: `a069f87`

## 决策记录

stage 执行中做出的、路线图没有规定的选择，记在这里（含理由）。
不要推翻已记录的决策，除非它被证明是错的。

### D-01 — S0 验收改用 RPC 无头驱动，而非交互式 TUI

路线图 S0 的验收是 `npm run widi:dev` 后在 TUI 里 `/model` 切换并发一句话。
执行本路线的 agent 无法驱动交互式 TUI，所以改用同一份 namespace 配置的
`--mode rpc` 通道做等价验证：`set_model` 证明 provider 注册与模型可选，
`prompt` 证明真实补全可用，`run_summary` 给出 `providerErrors=0` 的账目。

理由：这条路径验证的是同一套 `models.json` / `settings.json` 解析与同一个 provider
客户端，覆盖面不弱于手动 TUI 操作，而且可复现、有机器可读证据。

注意边界：这**不是** S9。S9 要落的是提交进仓库的、带版本记录的 evaluation runner
入口；本 stage 只是一次性冒烟，驱动脚本停在 scratchpad，不进 Git，
以免占用 S9 的落点。

### D-02 — 修 `scripts/run-widi.mjs` 不违反 §1.1 Extension First

§1.1 限制的是 `packages/widi/`（submodule）。`scripts/run-widi.mjs` 是**父仓库自己的**
启动脚本，不是 WIDI 上游代码，也不是 extension 能表达的东西——它决定 WIDI 进程
怎么被 spawn。因此修它既不触发 §1.1 的两个例外条件，也不需要 submodule 提交。
`packages/widi/` 本 stage 未改动，gitlink 保持 `a48e68b`。

## 上游缺陷记录

只有确认是 WIDI 原生缺陷、且 extension 内无法修复时才动 `packages/widi/`。
每一次都要在这里记录最小复现、submodule commit、父仓库 gitlink 更新。

（暂无。gitlink 仍为 `a48e68b953924fbb531223208b59c97be9cdc0ae`。）

## 环境与工具链缺陷

父仓库脚本与本机环境的问题，不涉及 `packages/widi/`，与上面一节分开记。

### E-01 — `npm run widi:dev` / `widi:rpc --dev` 在 Windows 上 spawn EINVAL（S0 已修）

最小复现（Node v22.18.0 / Windows 11）：

```
$ node scripts/run-widi.mjs --namespace scholar --dev --mode rpc
Error: spawn EINVAL
    at file:///D:/VIVID/scholar-search/scripts/run-widi.mjs:63:15
  errno: -4071, code: 'EINVAL', syscall: 'spawn'
```

成因：`run-widi.mjs` 的 dev 分支把 `command` 设为 `node_modules/.bin/tsx.cmd`，
再用 `spawn(command, args, { stdio: "inherit" })`（无 `shell`）启动。
Node ≥ 20 出于 CVE-2024-27980 不再允许不带 `shell: true` 地 spawn `.cmd`/`.bat`。
所以在 Windows 上 dev 模式（TUI 与 RPC 两者）100% 起不来。

修法：不走 `.bin` shim，直接用当前 Node 跑 tsx 自己的 JS 入口
`packages/widi/node_modules/tsx/dist/cli.mjs`。
选它而不是 `shell: true` 的理由：单一跨平台代码路径，且不引入 shell 的路径引号问题
（本仓库路径含盘符与大写目录名，将来含空格时 `shell: true` 会静默截断参数）。

验证：修后同一条命令拿到 `ready` 帧并跑完一次 `prompt`（见 S0 日志）。

### E-02 — 本机 CRLF 导致 biome 格式检查全表报错（未修，非本路线引入）

`git config core.autocrlf` 为 `true` 且仓库无 `.gitattributes`，
所以工作区里所有文本文件是 CRLF，而 biome 期望 LF。后果：

```
$ npm run check:workspace
Checked 4 files in 45ms. Found 4 errors.     # package.json + 三个 scripts/*.mjs 全部只报换行差异
```

四个文件里只有 `scripts/run-widi.mjs` 被 S0 改过，其余三个未改也报错，
可见是环境问题而非改动引入。把单个文件换行归一为 LF 后单独跑 biome 即通过。

**未在本 stage 处理**：修它要么改全局 git 配置（超出仓库范围），
要么加 `.gitattributes` 并重新归一化全仓库文本文件——那会产生一个跟 S0
无关的巨大 diff，破坏 §1.4 的单 stage 单 commit 与 cherry-pick 语义。
建议由用户单独决定；在那之前，判断"格式检查是否因本次改动变红"要用
LF 归一化后的单文件 biome 结果。

### D-03 — commit hash 由紧随其后的 docs-only commit 补录

把 stage 的 commit hash 写进该 stage 自己的 commit 里是不收敛的：
`--amend` 改文档就换 hash，换 hash 又让文档过期。
所以约定：stage commit 先落地，紧接着一个只改 `docs/06-progress.md` 的
`[S<n>] progress: 补录 commit hash` commit 把 hash 填上。

这不破坏 §5 的部分采纳：补录 commit 只碰进度文档，
`cherry-pick` 某个 stage 时带上或不带上它都不影响该 stage 的产出。
