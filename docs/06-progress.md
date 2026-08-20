# widi-scholar 原型开发进度

> 这条路线的状态来源。stage 定义在 `docs/06-widi-scholar-roadmap.md`（只读）。

分支：`feature/widi-scholar-prototype`

## 状态表

| Stage | 内容 | 状态 | commit | 备注 |
| --- | --- | --- | --- | --- |
| S0 | 分支、进度骨架、vllm 接入 | DONE | `a069f87` | 用 RPC 无头验收替代交互式 TUI，见决策 D-01 |
| S1 | extension 骨架与最短链路 | DONE | `PENDING_S1` | 途中修了阻断性上游缺陷 U-01（Windows 上任何 extension 都加载不了） |
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

### 2026-08-20 — S1

- 做了：
  - `widis/.widi-scholar/extensions/scholar-search/` 建 extension 骨架，形状照
    `widis/.widi-pasa/extensions/pasa-tools/`（同样的 tsconfig 相对深度 `../../../../`、
    同样的 `core/` + `tests/` 布局、同样手写 JSON Schema 而不 import typebox）：
    - `core/service-client.ts`：到 Python Search Service 的唯一出口。显式输入输出、
      注入 `baseUrl` 与 `fetch`、硬超时、有界重试、`ServiceRequestError` 带
      `kind`/`status`/`bodySnippet`。wire 侧 snake_case 在这里翻成 camelCase。
      `index.ts` 里没有任何 HTTP 细节。
    - `index.ts`：只注册 `list_providers`（无参数），输出自己限长
      （每源字段截断 + 总长 6000 字符上限），完整记录只走 `details`。
    - `tests/service-client.test.ts` + `tests/fixtures/providers.json`。
  - `widis/.widi-scholar/settings.json`：`enabledExtensions: ["scholar-search"]`。
  - 修 `scripts/widis-test.mjs`（E-03）：否则 `npm run test:widis` 在 Windows 上
    一个测试文件都跑不起来。
  - 修 `packages/widi/` 的 U-01：**Windows 上任何 extension 都无法加载**，
    包括仓库原有的 `pasa-tools`。这是 S1 的硬阻断，处置见下方 U-01。

- Service 地址：从 `SCHOLAR_SEARCH_SERVICE_URL` 读，缺省
  `http://127.0.0.1:8000`（对应 `search_service/config.py` 里 `SEARCH_SERVICE_PORT`
  的默认 8000）。地址没有硬编码进任何提交的配置。

- 验收（实际命令与输出）：
  1. `npm --prefix packages/widi exec -- tsgo --noEmit -p widis/.widi-scholar/extensions/scholar-search/tsconfig.json`
     → 退出码 0，无输出。
  2. `npm --prefix packages/widi exec -- biome check --error-on-warnings --config-path packages/widi/biome.json`
     对 `index.ts` / `core/service-client.ts` / `tests/service-client.test.ts` / `tsconfig.json`
     → `Checked 4 files. No fixes applied.`
     （`fixtures/` 不交给 biome——`scripts/widis-quality.mjs` 就是这么排除的，
     录制的响应是字节不是源码。直接把整个 extension 目录喂给 biome 会因
     E-02 的 CRLF 报错，`pasa-tools` 同样如此：同一条命令在它身上报 23 errors。）
  3. `npm run test:widis` → `# tests 65 / # pass 65 / # fail 0`
     （其中 20 条是本 stage 新增的 service-client 测试，45 条是原有 pasa 测试。）
  4. 真实链路（roadmap 要求的"另起终端跑 Service + 让模型调一次"）：
     - Service：`cd src/search-service && PYTHONPATH=src uv run uvicorn search_service.main:app --host 127.0.0.1 --port 8000`
       `/health` → `{"status":"ok","sources":[arxiv:on, openalex:on, serper:off]}`
     - `--mode rpc` 里起一个只有 `list_providers` 的 agent 并提问：
       - `inspect` → `toolNames: ["list_providers"]`
       - `prompt` → `ok:true`，模型正确答出"openalex / arxiv 启用，serper 配置了但停用，
         openalex 支持 graph_citations"
       - `run_summary` → `tools: {calls:1, failed:0, byName:{list_providers:1}}`,
         `providerErrors: 0`
     - 模型实际看到的工具输出 1313 字符，形如：
       ```
       3 provider(s) configured at http://127.0.0.1:8000, 2 enabled. ...
       - openalex [enabled]
         capabilities: facet_group_by, graph_citations, ...
         fields: abstract, authors, biblio, ... (+10 more)
         cost: works_search ($0.001/call, 1000/day, 10 rps); ...
         quota remaining: not tracked by the service
       ```
  5. Python 侧未被本 stage 改动，回归确认：
     `cd src/search-service && uv run pytest -q` → `52 passed`
     （必须先 unset `all_proxy`，见 E-04。）

- commit: `PENDING_S1`

## 决策记录

stage 执行中做出的、路线图没有规定的选择，记在这里（含理由）。
不要推翻已记录的决策，除非它被证明是错的。

### D-04 — S1 的真实链路验收用一次性 profile 脚手架，不提前占用 S3

`list_providers` 注册进 runtime 后，profile 还得在 `tools:` 里点名它才可见——
仓库里 5 个 profile 的 `tools:` 都没有它（这是对的，`main` 不该有检索工具）。
而 5 个 profile 全是 `persist: true`，RPC 的 `profileOverride` 会被拒：
`"Profile 'main' override changes recoverable profile fields and cannot create a
persistent session."`

所以验收时临时建了 `profiles/zz-s1-smoke.md`（`tools: [list_providers]`）
并临时把它加进 `enabledProfiles`，跑完**已删除文件并还原 settings.json**
（提交前 `git status` 已确认）。

理由：S3 的落点是 `profiles/search.md`——一个设计过的、带 $SP_M$ 正文的受限 profile。
让 S1 顺手造一个 profile 会侵占 S3 的落点，也会让"部分采纳到 S1"的用户拿到一个
半成品 profile。脚手架用完即弃比留下一个将被 S3 覆盖的文件干净。

### D-05 — fixture 用真实录制的服务响应，不手写

`tests/fixtures/providers.json` 是从 `src/search-service/` 真实 `GET /providers`
录下来的（录制命令与日期写在 `tests/fixtures/README.md`），不是照 pydantic 模型
手写的。手写 fixture 会跟着我对 schema 的理解走，测的就变成"我以为服务返回什么"；
录制的会在服务真的改了 schema 时让解析测试红掉，那才是想要的信号。

保留 `serper`（配置了但 `enabled: false`）是刻意的：
"配置了但停用"和"不存在"必须能被 `list_providers` 区分开，这条有对应断言。

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

### U-01 — extension id 在 Windows 上取成整条绝对路径，`enabledExtensions` 永不匹配

**这条阻断 S1。** 记录时间点：动 `packages/widi/` 之前（§1.1 要求）。
定位起点是父仓库 gitlink `a48e68b`。

#### 症状

`widis/.widi-scholar/settings.json` 里 `enabledExtensions: ["scholar-search"]`，
extension 目录、`index.ts`、`tsconfig.json` 都在位且类型检查通过，但 profile
拿不到工具：

```
inspect → tools: {"toolNames":[],"activeToolNames":[]}
diagnostic → extension.factory_missing:
  "Extension 'scholar-search' is enabled but no factory is registered."
```

启动诊断里**没有**任何 `extension.*` 错误，所以第一眼看不出是加载失败。

#### 最小复现

不是我们新代码的问题——仓库里原有的、可用的 `pasa-tools` 同样加载不了：

```
$ node scripts/run-widi.mjs --namespace pasa --dev --mode rpc
  # spawn 一个 crawler agent（profile 的 tools 里有 4 个 pasa_* 工具）
inspect → tools: {"toolNames":["send_message"],"activeToolNames":["send_message"]}
diagnostic → extension.factory_missing:
  "Extension 'pasa-tools' is enabled but no factory is registered."
```

再用 `--extension <绝对路径>` 显式指名同一个目录，真正的 id 就露出来了：

```
$ node scripts/run-widi.mjs --namespace scholar --dev --mode rpc \
    --extension 'D:\VIVID\scholar-search\widis\.widi-scholar\extensions\scholar-search'
diagnostic → extension.id_conflict:
  "Extension 'D:\VIVID\scholar-search\widis\.widi-scholar\extensions\scholar-search'
   from D:\...\scholar-search/index.ts conflicts with an already registered factory
   and was skipped."
```

两件事同时被证明：agent_dir 那一轮**确实**发现并注册了这个 extension（否则不会
"conflicts with an already registered factory"），而它注册用的 **id 是整条绝对路径**，
不是 `scholar-search`。

#### 根因

`packages/widi/apps/widi/src/core/extension/loader.ts:1115`：

```ts
function basename(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? normalized : normalized.slice(index + 1);
}
```

只按 `/` 切。Windows 上目录路径是 `D:\...\extensions\scholar-search`，里面一个 `/`
都没有，于是 `lastIndexOf("/") === -1`，整条路径被当作 basename，
再被 `loader.ts:256` 与 `1092` 用作 extension id。
`enabledExtensions` 里写的是 `"scholar-search"`，永远匹配不上 → `factory_missing`。

同一目录下的 `joinPath` / `resolvePath` / `normalizePath` 也只认 `/`，但它们碰巧无害：
`D:\a\b` + `/index.ts` 的混合分隔符 Windows API 照样能打开，反斜杠段落原样保留。
**只有 id 派生这一处会坏**，所以补丁只改 `basename`。

#### 为什么必须改 `packages/widi/`（§1.1 第 2 种情况）

- extension 内无法修复：出错发生在 extension 被 import **之前**，
  是 runtime 决定"这个 factory 叫什么名字"的那一步。extension 代码还没跑。
- 绕不过去：`enabledExtensions` 是 settings 里的字符串。理论上可以把整条绝对路径
  写进 `enabledExtensions` 来"匹配上"，但那会把开发者的本机路径钉进提交的配置，
  换台机器、换个 checkout 目录就失效——比缺陷本身更糟。
- 对 WIDI 本身有通用价值：任何 Windows 用户的任何 extension 都加载不了。

这个缺陷能活下来的原因也清楚：`apps/widi/tests/core/extension-loader.test.ts`
的 `MemoryExecutionEnv` 把所有路径 normalize 成 `/` 形式，测试**无法表达**
一条 Windows 路径。所以补丁必须补一个用 `\` 分隔符的回归测试。

#### 处置

**补丁**（`apps/widi/src/core/extension/loader.ts`）：`basename` 认两种分隔符。

```ts
function basename(path: string): string {
	const normalized = path.replace(/[/\\]+$/, "");
	const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return index === -1 ? normalized : normalized.slice(index + 1);
}
```

只改这一个函数。同目录的 `joinPath` / `resolvePath` / `normalizePath` 没动：
它们也只认 `/`，但混合分隔符在 Windows 上照样能打开文件，不构成缺陷；
按 `AGENTS.md` §6"补丁最小"，不顺手重写。

**回归测试**（`apps/widi/tests/core/extension-loader.test.ts`）：
原有的 `MemoryExecutionEnv` 把路径全部 normalize 成 `/` 形式，
**结构上无法表达一条 Windows 路径**——这就是缺陷能活下来的原因。
所以给它加了一个分隔符参数（默认 `/`，原有 10 个测试不受影响），
再加一个 `describe("ExtensionLoader on a Windows host")`，3 条：
目录型 extension 的 id、文件型 extension 的 id、以及按 id 真正激活成功。

打补丁前这 3 条全红（`expected [] to deeply equal [ 'scholar-search' ]`），
打完全绿：`tests/core/extension-loader.test.ts → 13 passed`。

**验证**：`packages/widi/` 内 `npx tsgo --noEmit -p tsconfig.json` 退出 0；
`npx biome check --error-on-warnings` 对改动的两个文件 `No fixes applied`。
真实运行的确认见 S1 日志第 4 条（`toolNames: ["list_providers"]`）。

**submodule commit**：`1ab7905`
**父仓库 gitlink**：`a48e68b` → `1ab7905`（随 S1 的 commit 一起更新）

**尚未推送**：`packages/widi` 的 remote 是 `https://github.com/ArcadiaLin/widi.git`，
本环境没有推送凭据。所以这个 commit **只存在于本地 submodule**，
父仓库 gitlink 指向一个未推送的 commit——别人 clone 父仓库时
`git submodule update` 会拉不到它。需要用户执行：

```bash
cd packages/widi && git push origin HEAD:<branch>
```

在那之前，`AGENTS.md` §2 要求的"推送到 ArcadiaLin/widi 再由父仓库更新 gitlink"
只完成了后半截。这一点没有绕过的办法，如实记在这里。

**与 submodule 自己的 AGENTS.md 的冲突**：`packages/widi/AGENTS.md` 写
"Never commit unless the user asks"。本路线图 §1.1 明确要求
"改动要在 submodule 内单独提交并更新父仓库 gitlink，不得留下未提交的 submodule 改动"，
按后者执行。

**一个副作用，已收拾干净**：`packages/widi` 的 `npm run check` 跑的是
`biome check --write`（不是只检查），在本机 CRLF 环境下它一次改写了 393 个文件。
其中只有我改的 2 个有真实内容差异（`git diff --numstat` 只列出这 2 个，
其余 391 个是纯换行差异、内容 diff 为 0），已把那 391 个逐个
`git checkout --` 还原，`git status` 现在只剩我改的 2 个文件。
**后续 stage 不要在 submodule 里跑 `npm run check`**，改用
`npx biome check`（不带 `--write`）加 `npx tsgo --noEmit -p tsconfig.json`。

### U-02 — profile id 的 filename 派生同样只认 `/`（已知，未修）

每次启动都有一条假警告：

```
[warning] profile.id_filename_mismatch: Profile id "main" does not match
  filename-derived id "D:\VIVID\scholar-search\widis\.widi-scholar\profiles\main".
```

同一类错误，另一处代码：`packages/widi/apps/widi/src/core/agent-profile.ts:1166`
的 `basenameEnvPath` 与 U-01 的 `basename` 逐字同构，也只按 `/` 切。

**本 stage 不修。** 它只产生一条噪音警告，profile 本身按 id 正常加载
（S1 里用 id 起 agent 成功），没有阻断任何东西。`AGENTS.md` §6 要求触及 WIDI fork
时补丁最小，所以只修真正阻断 S1 的 U-01。留给用户决定是否要顺手一起修。

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

这条还有一个更危险的下游后果，见 U-01 处置末段：`packages/widi` 的
`npm run check` 带 `--write`，在 CRLF 环境下会一次改写几百个文件。

### E-03 — `npm run test:widis` 在 Windows 上一个测试都跑不起来（S1 已修）

最小复现：

```
$ npm run test:widis
Running 5 extension test files
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data,
and node are supported by the default ESM loader. On Windows, absolute paths must
be valid file:// URLs. Received protocol 'd:'
# tests 5 / # pass 0 / # fail 5
```

成因：`scripts/widis-test.mjs` 把 tsx 的 loader 路径原样传给 `node --import`：

```js
["--import", tsxLoader, "--test", ...]
```

`--import` 要的是 module specifier，不是路径。`D:\...\loader.mjs` 被解析成
scheme 为 `d:` 的 URL，ESM loader 直接拒绝。**5 个测试文件全部失败，
且失败原因跟测试内容无关**——所以在修它之前，`npm run test:widis`
这条 S1 验收命令没有任何信息量。

修法：`pathToFileURL(tsxLoader).href`。这是两个平台都接受的唯一写法
（POSIX 上原本"能用"只是因为绝对路径恰好以 `/` 开头）。

验证：修前 `# pass 0 / # fail 5`；修后（仅此一处改动，尚未新增任何测试）
`# tests 45 / # pass 45 / # fail 0`。

### E-04 — `all_proxy=socks5://` 让 Search Service 的 16 个测试报 ImportError

```
$ cd src/search-service && uv run pytest -q
16 failed, 36 passed
E  ImportError: Using SOCKS proxy, but the 'socksio' package is not installed.
```

本机 shell 里有 `all_proxy=socks5://...`。httpx 会从环境读代理，即使测试用的是
mock transport 也一样，于是没装 `socksio` 就直接 ImportError。

**未修**：这是本机 shell 环境，不是仓库问题；给 `pyproject.toml`
加 `httpx[socks]` 只是为了绕过一个本地环境变量，属于把环境问题固化进依赖。
跑 Python 测试时 unset 即可：

```
$ cd src/search-service && env -u all_proxy -u ALL_PROXY uv run pytest -q
52 passed
```

### E-05 — `packages/widi` 完整测试套件在 Windows 上有 12 个文件失败（未修，既有基线）

带着 U-01 的补丁跑 `npm --workspace apps/widi run test`：

```
Test Files  12 failed | 93 passed (105)
     Tests  64 failed | 1429 passed (1493)
```

12 个失败文件与各自的成因（四类，全部是平台/环境，无一与 extension 有关）：

| 文件 | 成因 |
| --- | --- |
| `tests/cli/args.test.ts` | 断言写死 POSIX 路径：`expected [ 'D:\a', 'D:\b' ] to deeply equal [ '/a', '/b' ]` |
| `tests/core/coding-{ls,read,write,edit,find,bash,tools-shared,tools-smoke}.test.ts` | Windows 建符号链接要权限：`EPERM: operation not permitted, symlink ...` |
| `tests/core/coding-grep-tool.test.ts` | `ripgrep (rg) was not found on PATH` |
| `tests/print/input.test.ts`、`tests/rpc/e2e.test.ts` | 同 E-01 一类：`e2e.test.ts:26` 拼的是 `node_modules/.bin/tsx`（**无 `.cmd`**，那个文件是 `#!/bin/sh` 脚本），Windows 上 `spawn` 起不来，7 条测试各等到自己 95–100 秒的 deadline |

**确认这不是 U-01 引入的回归**，两条证据：

1. 与 extension 相关的 10 个测试文件全部通过：
   `extension-loader`、`extension-runner`、`extension-divisions`、
   `extension-collaboration`、`extension-core-capabilities`、`extension-events`、
   `extension-limits`、`extension-profile`、`extension-runtime-control`、
   `audit-extension`。U-01 的补丁只动 `loader.ts` 里的 `basename`，
   能受影响的就是这批。
2. 基线对照：把补丁 `git stash` 掉，再单跑这 12 个文件：

   ```
   # 带补丁（完整套件 105 个文件）
   Test Files  12 failed | 93 passed (105)
        Tests  64 failed | 1429 passed (1493)

   # 不带补丁（只跑上面那 12 个文件）
   Test Files  12 failed (12)
        Tests  64 failed | 108 passed (172)
   ```

   失败文件集合逐个相同，失败测试数同为 **64**。补丁没有引入任何回归。

**未修**：这是给 WIDI 测试套件做 Windows 移植（写死的 POSIX 断言、符号链接权限、
缺 ripgrep、`.bin` shim），远超本路线范围，也违反 `AGENTS.md` §6 的"补丁最小"。

### D-03 — commit hash 由紧随其后的 docs-only commit 补录

把 stage 的 commit hash 写进该 stage 自己的 commit 里是不收敛的：
`--amend` 改文档就换 hash，换 hash 又让文档过期。
所以约定：stage commit 先落地，紧接着一个只改 `docs/06-progress.md` 的
`[S<n>] progress: 补录 commit hash` commit 把 hash 填上。

这不破坏 §5 的部分采纳：补录 commit 只碰进度文档，
`cherry-pick` 某个 stage 时带上或不带上它都不影响该 stage 的产出。
