# widi-scholar 原型开发进度

> 这条路线的状态来源。stage 定义在 `docs/06-widi-scholar-roadmap.md`（只读）。

分支：`feature/widi-scholar-prototype`

## 状态表

| Stage | 内容 | 状态 | commit | 备注 |
| --- | --- | --- | --- | --- |
| S0 | 分支、进度骨架、vllm 接入 | DONE | `a069f87` | 用 RPC 无头验收替代交互式 TUI，见决策 D-01 |
| S1 | extension 骨架与最短链路 | DONE | `6414773` | 途中修了阻断性上游缺陷 U-01（Windows 上任何 extension 都加载不了） |
| S2 | 核心检索工具 | DONE | `fae2073` | 途中给 Service 补了 `/paper/{id}` 与 subquery 扇出，并修了扇出暴露的并发缺陷 SV-01 |
| S3 | search profile：工具集收紧 | DONE | `8bd31a4` + `8559903` | 正文只放 $SP_M$ 静态部分；S5 途中发现两段策略泄漏，已在 `8559903` 修正 |
| S4 | 概念到实现映射 + Preference 载体 | DONE | `d990f67` | 只建载体与版本约定，条目内容归 S5 |
| S5 | $NP_0^{agent}$ 条目化 | DONE† | `9bec91a` + `4b46427` | 30 条条目；固定采样后验收通过，判据取调用构成而非总数（`provider_query` 全开 0/0/0 vs 全关 3/2/3）。判据为事后选定，见 G-3 |
| S6 | 公开轨迹 $\bar{\tau}_t$ | DONE | `bb6773c` | observer 白名单过滤 + Service SearchState；私有推理逐项 grep 为 0 |
| S7 | 其余检索工具 | DONE† | `ec7b377` | $T^M$ 补齐九个；Service 侧新增五个端点；有界性来自配置且夹取对模型可见。排序栈只有 L1 真实存在，见 G-5 |
| S8 | Reviewer 通道 | DONE† | `2bc0046` | extension spawn 而非 Main spawn；一条 provide_advice 落地；Main 的 16 个 thinking block 取 30 片段查 Reviewer session，leaks 0。介入时机偏在 episode 之后，见 G-1 |
| S9 | RPC 评测入口 | DONE† | `fc225e9` | 只走 RPC 帧不读 session；§5.3 provenance 逐项落地；失败样本进分母。产出不可复现，见 G-4 |

状态取值：`TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`。
`IN_PROGRESS` 必须在备注里写清做到哪一步；`BLOCKED` 必须写清卡在哪、试过什么、需要什么。

`DONE` 的含义严格限定为：**该 stage 的落点已完成，且它自己在路线图里写明的验收命令通过。**
它**不**意味着对应的设计概念已经完整落地——路线图的验收判据在若干处弱于
`design.md` / `prototype.md` 的要求，通过那条判据不等于设计要求被满足。
凡出现这种情况的 stage 标 `DONE†`，缺口逐条记在下一节，不折叠进备注。

## 验收缺口

这一节记的是"**stage 验收通过、但设计要求尚未满足**"的部分。

单独成节而不是塞进备注里，是因为这两件事的性质不同：备注写的是这个 stage
做了什么，而这里写的是**下一步必须补什么，以及在补上之前哪些实验结论不能下**。
把它们混在一起，缺口就会随着状态表变绿而消失在视线外。

每条的格式固定：设计要求 → 实际实现 → 后果（尤其是哪条实验轴因此失去测量对象）
→ 补上它需要什么。

**另见 `docs/08-retrieval-defects.md`**（`F-1..F-7`）。那份文档记的是另一类问题：
不是"设计要求没落地"，而是**已落地的部分本身有缺陷**——2026-08-21 的首次真实
人机会话把它们暴露了出来，其中 F-1（arXiv 查询退化成 OR）会让 L0 召回层
系统性漏掉正确答案，在修掉它之前 B/E/J/M 四条轴上的对比都是在噪声上做的。

### G-1 — Reviewer 的介入时机偏在 episode 之后（S8）

**设计要求**：`design.md` §5.2 列了四个 checkpoint，**前三个都在 episode 中途**
（初始召回完成 / 一轮候选合并或引文扩展完成 / 检测到覆盖不足、噪声突增、
来源失衡或预算接近上限），第四个是"生成最终 $SO$ **之前**"。

**实际实现**：

- `index.ts` 的 `api.observe("agent_idle", ...)` 触发 review——即 Main 已经产出
  最终 $SO$ **之后**；
- `MAX_REVIEWS_PER_AGENT = 1`，一个 episode 只审一次；
- 投递用 `precede`，建议落在**下一轮**的上下文里。

也就是说 $A_t$ 里的 $t$ 实际恒等于 $T+1$。**这条建议不可能改变它所审查的那次搜索。**
四个 checkpoint 一个都没落地，连第四个也不是——它在最终 $SO$ 之后而不是之前。

**后果**：与 S9 的组合尤其要命。eval runner 每条查询 spawn 新 agent、prompt 一次、
dispose，所以在评测路径上 Reviewer 的建议会被写进 `.review.json` 然后原地蒸发，
没有任何一轮会读到它。**M 轴（在线拓扑）的 sidecar 组与无 sidecar 组在当前实现下
输出完全相同，$\Delta_{\mathrm{sidecar}}$ 恒为 0。** 在补上 G-1 之前，
任何关于 sidecar 在线贡献的结论都不能下。

**为什么验收还是过了**：S8 的两条判据是"至少产生一条 `provide_advice`"与
"Reviewer 上下文里没有 Main 的私有推理"。这两条验的是**通道连通性**与**隔离性**，
两者都真的成立且证据充分。它们没有验的是**介入有没有作用面**——
而那才是 §5.2 存在的理由。判据弱于设计，这是路线图的问题，不是执行的问题。

**补上它需要**：

1. checkpoint 判定从 `agent_idle` 移到工具执行边界（`tool_execution_end`），
   按 §5.2 的三个条件判定是否触发；
2. 投递改用能被**当前 episode** 读到的原语，同时不制造
   "投递 → 唤醒 → 再次 idle → 再次 review"的回路（这正是当初选 `precede` 的原因，
   换原语时必须重新解决这个问题）；
3. `MAX_REVIEWS_PER_AGENT` 从"每 agent 一次"改成"每 episode 上限 N 次"，
   与 §5.2 最后一条的调用次数限制对齐。

### G-2 — Evidence Store 未落地，gate 的证据校验落在替代物上（S4 决策 / S7 / S8）

**设计要求**：O-1 的决定（`design.md` §4.1、`search-service.md` §5.3、
`07-widi-mapping.md` §3.2）——Evidence Store 是 episode 作用域的运行时状态，
由 Service 持有，与 `RunSnapshot` 同生共死。

**实际实现**：未落地。Service 至今没有 episode 概念，`get_budget` 的 `scope`
如实标 `process` 而不是 episode。S8 需要"可引用的 id"才谈得上 gate 的证据校验，
于是在 extension 侧做了 `TraceEvidence`（`core/trajectory.ts`）。

`TraceEvidence` 本身**不违规**：它是轨迹的证据视图（只有 id、标题、来源、
由哪次调用发现），不是 Store，也没有把候选集搬进 Agent 上下文。

**后果**：Reviewer 只能引用**已经进过 Main 上下文**的论文 id。它看得到
`recalled: 589 / returned: 110` 这样的差额，却无法对被丢弃的那 479 篇里的缺口
提出任何可被 gate 接受的具体建议——因为那些 id 不在轨迹里。而"召回了但没进最终名单
的那批里有没有系统性缺口"恰恰是 sidecar 最有价值的观察面。

**补上它需要**：一个 episode 标识穿过工具入参到 Service，Service 侧按该标识维护
Store 并在 `SearchState` 上挂出它的账目。这不属于任何已完成的 stage。

### G-3 — S5 的验收判据是看到数据之后选定的（S5）

**实际过程**：原判据"关掉全部条目与打开全部条目，轨迹形状明显不同"以调用总数衡量
时不成立（全关 7–37，全开 22–40，区间大面积重叠）；固定采样后改用**调用构成**
（`provider_query` 全开 0/0/0 vs 全关 3/2/3）才判定通过，n=3/组。

**问题不在于结论错**，而在于观察量是在看过数据之后选的。这样得到的分离度不能
当作效应量的估计——它至少一部分来自选择本身。当前记录足以支持
"策略先验有作用面"这一定性判断，**不足以支持任何定量结论**。

**补上它需要**：把观察量与重复次数写进 `experiments.md` 做**预注册**——先定
判据再跑，而不是在 progress 里事后定。另外记一条已经发现的依赖问题：
30 条条目里有 11 条讲引文扩展，而 `expand_citations` 到 S7 才注册，
所以 S5 的锐利判据本来就应当排在 S7 之后——路线图的线性依赖假设在这里破了。

### G-4 — S9 的产出不可复现：采样固定依赖仓库外的器材（S9 / U-03）

**设计要求**：`experiments.md` 的等算力比较要求同一配置可重跑。

**实际实现**：S9 的 runner 把 provenance 记全了（namespace、RPC protocol version、
WIDI revision、profile、模型、extension 版本、生效预算、启动诊断、父仓库 revision
与 dirty 标志），但**没有确定性**——同一条查询重跑时采样是自由的。
固定采样目前只能靠 scratchpad 里一个强制写入采样参数的反向代理，**它不进仓库**。

**后果**：S5 那张对照表无法在仓库内一键复现；将来任何用 S9 跑出来的数字同样如此。

**补上它需要**：见 U-03。三条路径互斥，需要用户拍板选一条——
改 vendored 的 `packages/agent`（需明确授权）、把 shim 变成仓库内的正式部件、
或者在 vllm 服务端固定默认采样参数（最省事，但把实验配置放到了仓库之外）。

### G-5 — 排序栈只有 L1 真实存在，判别器完全没有（S7）

**设计要求**：`prototype.md` 的 L0–L3 排序栈——L0 资格过滤、L1 RRF 候选控制、
L2 可训练特征融合、L3 预算内判别。

**实际实现**：

- **L1 真实存在**：`aggregator.py` 的 RRF（κ=60）。
- **L2 / L3 没有**。`POST /rank` 是词面重叠加引用数先验的占位实现
  （`api/probe.py` 的 `_relevance`），权重 `2.0 / 1.0 / 0.1` 与 tier 阈值
  `0.6 / 0.2` 硬编码在函数里。它的 docstring 诚实标注了自己是 placeholder。
- `judge_level` 参数存在但无实现，工具在传入非 `off` 时显式告知未实现——
  **这个处理是对的**，不算缺口，只是说明判别器整个还不存在。

**后果**：**B 轴（ranker）与 J 轴（judge tier）目前没有实现面**，对应的消融实验
无法开始。另外 O-2 要求的敏感性筛选建立在"那批参数可配"之上，
而现在其中一部分是代码里的常量——在参数外提之前，筛选协议跑不起来。

**补上它需要**：单独讨论，不在本节展开。

---

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

- commit: `6414773`

### 2026-08-20 — S2

- 做了（extension 侧）：
  - `core/service-client.ts` 增加三个方法：`searchMetadata` / `getPaper` / `providerQuery`。
    `getJson` 改成 `requestJson`（支持 POST 与 body）；错误对象新增 `bodyJson` 与
    `detail`，让上层能读到 Service 自己给的原因，而不是只有一段序列化前缀。
  - 新增 `PaperSummary` 视图：**刻意不是** Service 的完整 `Paper`。
    `raw` / `field_provenance` / `references` / `citations` / `counts_by_year`
    不进摘要（`design.md` §4.1，Agent 不在上下文里搬运候选集），
    有一条测试专门断言"fixture 里有 `raw`、摘要里没有"。
  - `index.ts` 注册三个工具，按 `prototype.md` §7.1 的签名：
    - `search_metadata(query, subqueries?, intent?, top_k, end_date?, sources?, judge_level?)`
    - `get_paper(paper_id)`
    - `provider_query(provider, endpoint?, raw)`
  - 三条契约的落地：
    1. **工具描述里不写任何 provider 语法**。`provider_query` 的描述只写职责
       与"先调 list_providers"，语法由运行时能力表给。
    2. **`provider_query` 是单一工具**，provider 是参数，不拆成
       `openalex_query` / `arxiv_query`。
    3. **被拒绝返回可操作诊断**：`describeHttpFailure` 按状态码分流——
       400/422 说"改这个参数别重试"，404 说"查 list_providers 和标识符"，
       501 说"这是能力上限，换个源"，502 说"provider 挂了，别的源也许还行"。
  - 输出自己限长：候选列表最多列 20 条（其余进 `details` 并在正文里说明省略了几条）、
    摘要 280 字符、passthrough 4000 字符、总长 6000 字符。

- 做了（Service 侧，S2 需要但原来没有的）：
  - **新增 `GET /paper/{paper_id}`**（`api/paper.py`）：按 `id_lookup` 能力路由而非
    按 provider 名，ID 形状只用来排序不用来过滤，返回 `tried_sources` 与 `failures`。
    没有这个端点 `get_paper` 根本无法诚实实现，理由见 D-06。
  - **实现 `ArxivPlugin.lookup()`**：arXiv 的能力表一直声明 `id_lookup=True`，
    而基类是 `raise NotImplementedError`——按能力路由的调用方会拿到崩溃而不是记录。
    用 arXiv 自己的 `id_list`（精确，不是 `search_query` 的模糊匹配）。
  - **`OpenAlexPlugin.lookup()` 改为返回归一化记录**（原来返回 raw work），
    这样按能力路由的调用方不需要知道是谁应答的。
  - **`subqueries` 端到端打通**：`SearchRequest.subqueries`（上限 8，空串丢弃）
    → aggregator 对每个 (provider, query) 发一次召回 → 全部一起做 RRF 融合。
    被多个子查询同时命中的论文因此排得更高，这正是融合存在的理由。
    `search_state.issued_queries` 现在每个 (源, 查询) 一条，
    `filters.subqueries` 记录实际用了哪些分解。
    原来两个 plugin 的 `search()` 都接收 `subqueries` 参数但**直接丢掉**。
  - **修 SV-01**（下方"Search Service 缺陷"）：扇出暴露的并发缺陷。
  - **放宽 OpenAlex 4xx 错误体截断** 200 → 1200 字符：OpenAlex 的拒绝信息里
    带"合法字段列表"，200 字符正好把这个列表切断，而它恰恰是契约 3 里
    "去哪查"的答案。实测见下。

- 未实现、且**不假装**已实现的两个参数（Service 侧没有对应能力）：
  - `judge_level`：这个 Service build 里没有任何判别器。工具接受该参数，
    但传入非 `off` 的值时会在输出里明确写"本 build 未实现判别，下面的候选未经判别，
    把排序当召回顺序而不是相关性"。不静默忽略。
  - `intent`：记录在调用上，明确写"不影响排序"。
  两者保留在签名里，是为了 S5/S7 不必再改工具契约。

- 验收（实际命令与输出）：
  1. `tsgo --noEmit -p .../scholar-search/tsconfig.json` → 退出 0。
  2. `biome check --error-on-warnings` 对 5 个非 fixture 文件 → `No fixes applied.`
  3. `npm run test:widis` → `# tests 87 / # pass 87 / # fail 0`
     （S1 是 65 条，本 stage 新增 22 条。）
  4. Python 侧：`uv run pytest -q` → `76 passed`（S1 时是 52，本 stage 新增 24 条）；
     `uv run ruff check .` → `All checks passed!`；
     `ruff format --check .` → 16 files（基线 17，见 E-06），新增文件都是干净的。
  5. 真实检索（Service 起在 127.0.0.1:8125，模型 vllm/qwen3.6-35b-a3b，
     打真实 OpenAlex + arXiv API）：
     - 提问："找 2020-01-01 前关于 transformer attention 的论文，
       用 subqueries 覆盖 self-attention 与 sequence transduction，
       再用 get_paper 取头条的完整记录"
     - `run_summary` → `tools: {calls:2, failed:0, byName:{search_metadata:1, get_paper:1}}`,
       `providerErrors: 0`
     - 工具输出里的过程账目：`sources queried: arxiv, openalex`,
       `queries issued: 6 | candidates recalled: 149 | returned: 20`,
       `filters applied: {"end_date":"2020-01-01","subqueries":["self-attention","sequence transduction"]}`,
       `failures: 0`
     - 6 = (1 主查询 + 2 子查询) × 2 个源，与扇出设计一致。
  6. `provider_query` 真实调用（同一会话形态）：
     模型先 `list_providers`，再对 openalex 写原生 filter。
     `run_summary` → `tools: {calls:14, failed:9, byName:{list_providers:1, provider_query:13}}`。
     **9 次失败是真实发生的**，值得记下来：模型在试 OpenAlex 的 filter 语法，
     每次被拒都拿到形如
     `"'search' is not a valid field. Valid fields are ... abstract.search, ..."`
     的诊断，最后成功拿到 `is_oa` + `publication_year` 的正确写法。
     这条链路正是契约 3 想要的可观测形态（Reviewer 据此能区分"在试探边界"和"在乱写"），
     但 9 次里有相当一部分是因为合法字段列表被截断在 200 字符——这就是上面
     放宽到 1200 字符的直接原因。修完后直接验证：
     ```
     $ curl -X POST .../provider/openalex/query -d '{"endpoint":"works","params":{"filter":"bogus_field:1"}}'
     {"detail":"... bogus_field is not a valid field. Valid fields are ...
      abstract.search, ..., authorships.institutions.type, ..."}   # 1281 字节
     ```

- commit: `fae2073`
### 2026-08-20 — S3

- 做了：
  - 新建 `widis/.widi-scholar/profiles/search.md`；
  - `settings.json` 的 `enabledProfiles` 追加 `"search"`。

- `tools:` 只有 S1/S2 注册的四个检索工具：
  `[list_providers, search_metadata, get_paper, provider_query]`。
  没有 `bash` / `write` / `edit`，也没有 `read` / `grep` / `find` / `ls` /
  `spawn_agent`。`includeCwd: false`、`skillsListing: false`——
  一个没有文件系统工具的 agent，注入 cwd 只是噪音。

- **正文写了什么、故意没写什么**（这条是 S3 最容易做错的地方）：

  正文只有 $SP_M$ 的静态部分，四块：

  | 块 | 内容 |
  | --- | --- |
  | 角色 | 只做检索；没有 shell/编辑器/文件系统，需要写代码就说明并停下 |
  | 工具调用协议 | `provider_query` 前必须 `list_providers`；`end_date` 每次都带且不得放宽或编造；读完返回再发下一个调用；被拒绝时拒绝信息本身指出该改什么；标题/作者/年份/标识符一律来自工具结果，不得凭记忆写 |
  | 输出契约 | 用工具给的 `id` 原文引用；报告过程（哪些源应答、召回量、什么失败了）；区分"文献本来就少"/"某个源不可用"/"检索表达不了这个约束"；明确说没覆盖到什么 |
  | 安全边界 | 不执行代码、不改文件、不编造引用 |

  **故意不写的**（这些属于 $NP_k^{agent}$，是 S5 的内容）：
  - 要不要分解子查询、分解成几个、怎么保证子查询互不重叠；
  - 先 facet 勘察还是直接召回；
  - 什么时候该从统一检索升级到 `provider_query`；
  - 什么时候该沿引文扩展、扩几层；
  - 优先找综述、优先找高被引之类的启发式；
  - 预算怎么分配、什么时候停。

  为什么这条边界重要：`prototype.md` §7.3 约束一要求策略先验必须有一个
  Reviewer 能作用的载体。任何一句写进 profile body 的策略，Reviewer 都改不动，
  S5 的消融实验（关掉全部条目 vs 打开全部条目，轨迹形状应当明显不同）
  就会失效——因为策略还藏在 profile 里。

  对照：`widis/.widi-pasa/profiles/crawler.md` 把两者混在一起
  （"turn the research question into several mutually exclusive queries"、
  "include at least one query aimed at surveys" 都是策略）。
  那对 PaSa 复现是合适的，对本路线不是——本路线要能消融策略。

  边界判定上有两处需要说明，不是随手放进去的：
  - **`provider_query` 前置 `list_providers`** 写进了协议。
    依据是 `prototype.md` §7.1 末段的原文："前置探查是接口契约而非策略判断，
    因此可以由运行时强制，不与'策略归 Agent'冲突"。
  - **`end_date` 必须携带且不得放宽** 写进了协议。
    它不是"检索得好不好"的策略，而是评测契约与治理约束
    （`05-skill-decomposition.md` §0 把强制预算与 `end_date` 列为
    "有 coding 能力就无法强制"的那类硬约束）。

- 没有设 `projectContext`：S4 才建偏好载体并由它指向。
  也没有像 `main` / `research` 那样注入 `AGENTS.md` / `problem.md`——
  那是仓库工程契约，对一个只会检索的 agent 是噪音，而且会顺带注入工程策略。

- 验收（实际命令与输出）：
  1. `inspect` 一个 `profileId: "search"` 的 agent：
     - `profile: {"id":"search","label":"Scholar Search Agent"}`
     - `toolNames: ["list_providers","search_metadata","get_paper","provider_query"]`
     - 对 `bash`/`write`/`edit`/`read`/`grep`/`find`/`ls`/`spawn_agent` 逐个检查
       → `forbidden tools present: NONE`
  2. 一次完整检索问答（Service 在 127.0.0.1:8125，打真实 OpenAlex + arXiv）：
     提问"我要 retrieval-augmented generation 用于问答的文献，
     2023-06-30 之后发表的不要"
     → `run_summary`: `tools: {calls:13, failed:0,
       byName:{list_providers:1, search_metadata:3, get_paper:9}}`,
       `providerErrors: 0`
     模型的回答里带了"Search methodology"一节，自己报告了
     `sources queried: OpenAlex and arXiv (serper was disabled)`、
     实际发出的主查询与子查询、`end_date strictly set to 2023-06-30`、
     `215 recalled`，以及一段 Limitations（说明哪些结果是关键词重叠带来的、
     以及 `judge_level=off` 所以没有影响力指标）。
     输出契约里"报告过程、说明没覆盖到什么"确实生效了。
  3. `npm run test:widis` → `87/87`（本 stage 没动代码，仅确认无回归）。

- 一个已知告警（与本 stage 无关）：启动诊断里仍有
  `profile.id_filename_mismatch`，但只针对默认 profile `main`，
  `search.md` 没有触发。根因是 U-02，未修。

- commit: `8bd31a4`
### 2026-08-20 — S4

- 做了：
  - `docs/07-widi-mapping.md`：`06-widi-scholar-roadmap.md` §1.2 那张五行摘要表的
    展开版。每个概念的实际路径、为什么这样映射、以及**当下真实状态**
    （"已落地/一半/未落地"写的是实话，不是计划）。
  - `widis/.widi-scholar/preference/np-agent.md`：$NP_k^{agent}$ 的载体，版本 0。
  - `widis/.widi-scholar/preference/README.md`：布局与版本约定（不进任何上下文）。
  - `profiles/search.md` 增加 `projectContext: [preference/np-agent.md]`。

- 本 stage 只建**载体与版本约定**，条目内容留给 S5（路线图要求）。
  所以 `np-agent.md` 的版本 0 是"载体已存在、条目为空集"，
  文件里明确写了这就是消融实验的"全关"基线。

- 版本约定（详见 `preference/README.md`）：
  - 版本号是正文第一行的 `<!-- np-version: k -->`，单调整数，从 0 开始；
  - 每次改条目 +1，单独一个 commit，message 首行含 `[NP v<k>]`；
  - **版本存储就是 git，没有第二份**：回放是
    `git show <commit>:widis/.widi-scholar/preference/np-agent.md`，
    比较两版是 `git diff <c1> <c2> -- <path>`。
    这套约定要保住的性质是"第 2 版和第 3 版差在哪"必须一个 `git diff` 就能回答——
    这也正是载体是 markdown 而不是序列化状态的理由。
  - 用 HTML 注释而不是 YAML frontmatter 放版本号：这个文件会被整体注入
    系统提示词，frontmatter 会变成一段像元数据的噪音。

- 映射文档显式回答了路线图点名的三个问题：
  1. **为什么 Preference 不是代码模块**（§2.4）：读取路径（`projectContext`）
     与版本管理（git）都已存在，再写模块是重做一遍且做得更差；
     而且经过代码序列化后，"两版差在哪"就不再是 `git diff` 能回答的问题，
     $PH_k$ 的可审计性就没了。
  2. **为什么 Evidence Store 在 Python 侧**（§3.2）：extension 与 Agent 同进程，
     它持有的候选集迟早会被格式化进工具输出，而 `design.md` §4.1 第一条要求
     "Agent 不在上下文里搬运候选集"——S2 的 `PaperSummary` 刻意丢掉的
     `raw`/`references`/`counts_by_year` 必须有地方存，而那个地方不能是 extension。
     另外排序去重是领域算法（`AGENTS.md` §3.2 不该在 extension 里），
     且它的账目必须能挂进 `SearchState` 才进得了 $\bar{\tau}_t$。
     顺带澄清一个易误读点：§4 说"Service 不持有独立状态"指的是**跨 episode**
     的决策状态，不是禁止一次 episode 内累积证据。
  3. **Reviewer 用 observer 还是 subagent**（§3.4）：**两个都用，因为不是同一层面的选项。**
     Reviewer 本体必须是 subagent（要模型、要自己的上下文窗口，observer 是个函数装不下）；
     observer 是喂给它的传输层。关键在于**由 extension 而不是 Main 来 spawn**：
     WIDI 的 `ExtensionActions` 有 `spawnAgent()` 与 `prompt(text, {target})`，
     所以 extension 能自己起 Reviewer 并投递 $\bar{\tau}_t$，而
     `profiles/search.md` 的 `tools:` 里没有 `spawn_agent` 也没有 `send_message`，
     Main **结构上**无法向它求助——"旁路"不靠提示词里的禁令维持。
     记下了两个被否决的方案：把 Reviewer 做成 Main 的工具（违反旁路，
     介入率变成内生变量），以及只用 observer 在里面直接调模型
     （绕开 agent runtime，Reviewer 的上下文/预算/轨迹都不在任何 session 里，
     而 $C^R_t \neq C^M_t$ 恰恰需要它**是**一个有 session 的 agent 才能被证明）。

- 映射文档还集中列了**故意没有对应代码模块**的概念（§4），
  以及在 §3.1 记下一个当前缺口，免得被当成已完成：
  `config.yaml` 里还没有"按 $\theta^S_k$ 禁用某个字段"的开关，
  所以 `list_providers` 现在返回的是 provider 全集字段，
  不是 `prototype.md` §7.1 要求的"当前 $\theta$ 下实际可用的子集"。

- 关于改动了 S3 的产出：`profiles/search.md` 加 `projectContext` 是路线图 S4
  落点里明写的要求，不是回头修 S3。除这一行外没动 S3 的任何内容。

- 验收（实际命令与输出）：
  1. profile 能加载：`inspect` → `profile: {"id":"search",...}`，
     `toolNames` 仍是那四个检索工具（`projectContext` 不影响工具集）。
  2. `projectContext` 内容确实进了上下文。提问刻意禁止检索：
     "不要搜索任何东西，只根据你自己的上下文回答：策略先验文件写了什么？
     逐字引用它的 np-version，并说明当前生效几条策略。"
     → `run_summary`: `tools: {calls:0, failed:0, byName:{}}`,
       `providerErrors: 0`
     模型回答：`np-version: 0`（并注明是从 `<!-- np-version: 0 -->` 逐字引用）、
     `Strategy entries in force: 0`，还原文引了"本版没有任何条目……
     这是消融实验的'全关'基线"那一句。
     **0 次工具调用**是这条验收的关键：内容只能来自注入的上下文。
  3. 启动诊断里没有 `resource.context_file.*` 相关告警，
     说明 `preference/np-agent.md` 这个相对路径被正确解析到 agent dir 下。

- commit: `d990f67`
### 2026-08-20 — S5（条目已落地，验收 BLOCKED）

- 做了（条目本身，S5 的落点部分**已完成**）：
  - `preference/np-agent.md` 推到 `np-version: 1`，**30 条**条目。
  - 完成了 `05-skill-decomposition.md` §6.1 点名的待办"36 个 `NPa` 标记落成实际条目列表"：
    - 应用了清单里全部"并入"标注：`CF-Q-04`/`CF-Q-07` → `decompose-by-research-elements`；
      `CF-S-08`/`CF-Q-17` → `budget-priority`；`CF-B-09`/`CF-B-18` → `direction-coverage`；
      `DS-I-04` → `rewrite-on-failure`（与 `DS-I-03` 一并）；
      `DS-C-07` → `seed-for-coverage-not-fame`；`DF-03` → `resolve-ambiguity-before-fetching`；
      `DS-C-01` 的语义半条也并入 `seed-for-coverage-not-fame`（三条都是"怎么挑种子"）。
    - 把 `CF-B-21` 的五条 Key Rules 展开成五个独立条目：
      `read-cocitation-before-expanding` / `one-direction-per-round` /
      `never-expand-from-noise-hub` / `source-count-follows-quality` /
      `fill-missing-direction-immediately`。
    - 结果 30 条，落在清单预估的 25–30 量级内。
  - 形式符合 `prototype.md` §7.3「落地形式」：每条有 `id` 与正文，`id` 稳定；
    示例式条目 `decompose-example-cross-community` 带 `kind: example` 与 `origin`
    （`status: rephrased`）。
  - **条目里不含任何阈值、预算或数量**。"几条子查询""被引多高算通用经典""预算几次调用"
    全部不在条目里——那些是 $HP_k$，由工具入参与服务配置承载。条目只写语义。
    文件开头明确写了这条纪律。
  - 许可证前置条件：条目是对策略思想的重述与重新分层，不是 MetaScientist skill 原文的
    逐字复制（原文是英文，条目是重写后的中文分层表述）。

- 途中发现并修了 S3 的一处违规（`8559903`，单独 commit）：
  profile 正文里有两段其实是策略而不是协议——一段等于 `diagnose-before-act`，
  一段等于 `rewrite-on-failure`。这正是路线图 §3 S3 警告的那种泄漏：
  策略留在正文里，"全关"组也仍然带着它。已改为只陈述接口事实。

### 注入点决策（D-07）见决策记录

### 验收：**未通过**。

路线图 S5 的验收判据是"关掉全部条目与打开全部条目，同一查询的轨迹形状**明显不同**"。
**做不到**——不是"轨迹相同"，而是**同一配置下的轮次方差本身就比两组之间的差异大**。

测量设置：同一个查询（"diffusion models for molecular conformer generation,
nothing after 2024-06-30"）、同一个模型（`vllm/qwen3.6-35b-a3b`）、
同一个 Service（127.0.0.1:8125，打真实 OpenAlex + arXiv）。
"全关"的操作方式是按 `preference/README.md` 的约定把 `projectContext` 从
`profiles/search.md` 去掉。

轨迹形状用三个量刻画：工具调用总数、turn 数、各工具调用次数。

| 组 | profile 正文 | 工具调用数 | turns | 各工具 |
| --- | --- | --- | --- | --- |
| 全关 run1 | 泄漏未修 | 7 | 6 | search_metadata 4, get_paper 3 |
| 全关 run2 | 泄漏未修 | 37 | 24 | search_metadata 17, get_paper 18, list_providers 1, provider_query 1 |
| 全关 run3 | 泄漏未修 | 20 | 19 | search_metadata 15, get_paper 4, list_providers 1 |
| 全关 run4 | 已修 | 35 | 23 | search_metadata 11, get_paper 18, list_providers 1, provider_query 5 |
| 全关 run5 | 已修 | 18 | 12 | search_metadata 9, get_paper 9 |
| 全开 run1 | 泄漏未修 | 22 | 15 | search_metadata 10, get_paper 11, list_providers 1 |
| 全开 run2 | 已修 | 36 | 30 | search_metadata 10, get_paper 9, list_providers 1, provider_query 16 |
| 全开 run3 | 已修 | 40 | 25 | search_metadata 20, get_paper 19, list_providers 1 |

全关的调用数落在 **7–37**，全开落在 **22–40**。两个区间大面积重叠，
n=3/组的情况下任何"明显不同"的结论都是在读噪声。

（`sampling` 没有被固定：`settings.json` 里没有 temperature 设置，
所以每一轮都是随机的。这是方差的最可能来源。）

#### 试过的、更锐利的观察量，也不成立

用调用总数当判据太钝，所以换了一个**单条条目的可证伪预测**：
`seeded-entry-skips-recall` 说"提问者已给种子论文时跳过关键词检索，直接从种子出发"。
观察量是**第一个检索调用是 `get_paper` 还是 `search_metadata`**——二值、低噪声、
可直接归因到这一条。

提问："I already have the key paper for this topic: arXiv 2206.01729.
Find me the closely related literature. Nothing published after 2024-06-30."

结果：**全关组 3/3 的第一个调用都是 `get_paper`**。
基线本来就会从种子出发，这一条条目没有作用空间——天花板效应，
这个观察量同样无法区分两组。

#### 结论与还需要什么

按 `05-skill-decomposition.md` §0，验收不通过有两种可能的解释，我能区分掉一部分：

- **"策略还藏在 profile body 里"**：确实存在，已经找到并修掉两段（`8559903`）。
  但修完之后（run4/run5 vs run2/run3）区间依然重叠，所以这不是全部原因。
- **"策略藏在工具序列里"**：不成立。工具是无状态的单次调用，
  没有任何固定管线被编码进去——全关组的调用顺序在 6 次运行里各不相同。

我判断真正的原因是第三种，路线图没有列出的一种：**测量本身不成立**。
在这个模型、这个采样设置下，轨迹形状的轮内方差量级与"策略先验是否在场"的效应量相当或更大。
这不是"策略没有作用面"的证据，而是"这个实验设计测不出作用面"的证据——两者结论完全不同，
不能混为一谈。

**卡在哪**：无法用当前的实验设计给出 S5 验收的是或否。

**试过什么**：见上表 8 次真实运行（另有 3 次种子查询运行、1 次换查询的对照），
共 12 次；两种观察量（总量型与二值型）；修掉 profile 正文的策略泄漏后重测。

**需要什么才能解**（要用户决定，我不替用户定）：

1. **固定采样**。`settings.json` 里没有 temperature/seed。把它固定下来
   （或改用贪心解码）是最便宜的降方差手段，可能直接让 n=3 变得够用。
   我没有动它——`defaultProvider`/`defaultModel` 这类属于用户偏好，S0 就已经定下不擅自改。
2. **确定重复次数与判据**。若维持随机采样，按目前方差，要检出小于 2 倍的效应
   大致需要每组 n≥15–20。这是十几到几十分钟量级的真实 API 调用，
   需要用户确认这个预算可以花。
3. **或者换一个基线会失败的观察量**。我选的 `seeded-entry-skips-recall`
   撞了天花板。需要挑一条**基线明确做不到**的条目来做判据——
   候选是 `never-expand-from-noise-hub` 或 `growth-is-not-success`，
   但这两条都要 `expand_citations`（S7 才注册），
   所以更锐利的判据可能本来就应该排在 S7 之后。

最后一点值得单独说：**S5 的验收也许本来就依赖 S7**。
30 条条目里有 11 条讲的是引文扩展与种子选择，而 `expand_citations`
在 S7 才注册——也就是说当前有三分之一的条目根本没有可作用的工具。
这是路线图线性依赖假设的一处漏洞，不是执行上的失误，但它确实影响验收能不能成立。

- commit: `9bec91a`
### 2026-08-20 — S6

- 做了：
  - `core/trajectory.ts`：$\bar{\tau}_t$ 的构造器，**写成过滤器而不是记录器**。
    只有 `COLLECTED_EVENTS = ["tool_execution_start", "tool_execution_end"]`
    这两种事件能贡献内容，其余一概返回 `false`。
    用白名单而不是黑名单：黑名单会让上游新增的事件类型默认泄漏，
    而必须永不泄漏的东西恰恰是上游那条流的主要成分。
  - `index.ts`：`api.observe("agent_harness_event", ...)` 喂给 collector，
    `api.observe("agent_idle", ...)` 时导出——写文件到 `runs/trajectories/<agentId>.json`
    （`runs/` 已在 `.gitignore`，且归档的 $\bar{\tau}_t$ 是 `search-service.md` §5.3
    允许离开 episode 的三样东西之一），并同时 `emitExtensionEvent("scholar-search:trace", ...)`
    供 S8 的 Reviewer 通道消费。
  - `tests/trajectory.test.ts`：15 条。

- **刻意不做成工具**。Main Agent 不能读自己的公开轨迹——否则"Reviewer 能看见什么"
  就变成了 Main 可以管理的东西。导出走文件与事件总线，不进 $T^M$。

- 两个容易做错的性质都有测试钉住：
  - **事件无顺序保证**（`SKILL.md` §6）：记录按 `toolCallId` 归并，
    `end` 先于 `start` 到达也能合成同一条调用。有一条测试专门反向投递两个半事件，
    断言结果是 1 条调用而不是 2 条。
  - **有界**：`maxCalls` / `maxArgChars` 上限，且**超限要报告**——
    `budget.droppedCalls` 不为 0 时消费者才知道这条轨迹不完整。
    静默截断会被读成"完整轨迹"。

- Service 侧不需要改：S2 已经在产出 `SearchState`
  （`issued_queries` / `selected_sources` / `filters` / `candidate_counts` / `failures`），
  collector 直接从工具结果的 `details.searchState` 取。

- 验收（实际命令与输出）：
  1. `npm run test:widis` → `# tests 102 / # pass 102 / # fail 0`（本 stage 新增 15 条）。
  2. `tsgo` 退出 0；`biome check --error-on-warnings` 对 7 个非 fixture 文件
     `No fixes applied.`
  3. 跑一次真实检索并人工核对导出的 `runs/trajectories/search-whr3.json`——
     路线图点名的四项**逐项都在**：
     - **子查询**：9 条，跨整个 episode 收齐并去重
       （`["message passing GNNs molecular property", "QM9 benchmark molecule property prediction", ...]`）
     - **候选计数**：`{"recalled":589,"returned":110}`
     - **失败分类**：`[{"source":"openalex","errorType":"rate_limit",
       "message":"query 'message passing GNNs molecular property': OpenAlex rate limit exceeded"}, ...]`
       ——分类是 Service 给的 `errorType`，且失败信息里带着是**哪个子查询**失败的
     - **预算消耗**：`{"totalCalls":9,"failedCalls":0,
       "callsByTool":{"search_metadata":4,"list_providers":1,"provider_query":4},
       "droppedCalls":0}`
     另有每次调用的 `searchState.issuedQueries` 逐条列出 (provider, query) 组合。
  4. **私有推理不在**，逐项 grep 导出的轨迹文件：
     `thinking` 0 次、`reasoning` 0 次、`assistantMessageEvent` 0 次、
     `message_update` 0 次、`thinkingSignature` 0 次、`"role":"assistant"` 0 次、
     `text_delta` 0 次。
     顶层键只有 `agentId, profileId, subqueries, calls, budget, candidateCounts, failures`；
     每条调用的键只有 `toolCallId, toolName, args, failed, searchState, seq`。
     另有单元测试投递 9 种带推理内容的事件（thinking_delta / thinking_end /
     text_delta / message_start / message_end / turn_end / agent_end / ...），
     断言全部被拒且轨迹里搜不到那段文本；
     还有一条测试在**被收集的**事件上挂了额外的 `reasoning` 与 thinking 字段，
     断言只有白名单里的字段被复制。

- 一个运行期观察（不是缺陷）：这一天的多次真实运行之后，
  OpenAlex 开始频繁返回 `rate_limit`。轨迹把它如实分类记下了，
  这正是失败分类字段存在的意义——覆盖变差的原因是限流而不是文献少，
  Reviewer 需要能区分这两者。

- commit: `bb6773c`
### 2026-08-21 — S5 验收补做（固定采样后通过）

用户选择"固定采样再重测"。做完了，**验收通过**。下面是过程与两条重要的修正。

#### WIDI 没有采样旋钮（先说清这个，它决定了做法）

想按用户的意思在配置里固定采样，结果**做不到**：

- `settings.json` 没有 temperature/seed 键（`setting-manager.ts` 里 grep 无结果）；
- `models.json` 的 `ModelDefinitionSchema` / `ModelOverrideSchema` / `ProviderConfigSchema`
  都没有采样字段，`compat` 三个 schema 也没有 `extraBody` 之类的透传口；
- extension 侧唯一能改请求的 `before_provider_request` 拦截器，
  它的 `AgentHarnessStreamOptionsPatch` 只有 transport / timeoutMs / maxRetries /
  maxRetryDelayMs / headers / metadata / cacheRetention——**没有 temperature**；
- 能改原始 payload 的 `before_provider_payload` **不在** `ExtensionInterceptorName`
  的六个可用拦截器里。

要正经接通就得改 `packages/widi/packages/agent/`（往
`AgentHarnessStreamOptions` 加字段并在 harness 里转发），
而那是 vendored 的 Pi fork，submodule 自己的 `AGENTS.md` 写明
"Do not modify it unless the user explicitly asks"。所以没动。

**改用一个实验专用的本地 shim**：scratchpad 里一个反向代理，
把 vllm 的 OpenAI 兼容请求原样转发，只在 `/chat/completions` 的 body 里
强制写入采样参数；再把 `models.json` 的 vllm `baseUrl` **临时**指向它，
跑完恢复（已恢复，`git status` 干净）。
shim 不提交——它是实验器材，不是产物，与 D-01 里 RPC 冒烟脚本同一类处置。

#### 修正一：temperature=0 是错的

第一次按 `temperature: 0` 跑，结果这个推理模型退化成重复循环：
25 次调用里 13 次失败，`durationMs: 540350` 正好撞上 540 秒的 prompt deadline。
贪心解码对 thinking 模型有害（Qwen 自己也建议 thinking 模式用 ~0.6）。

改成 **temperature 0.6 + top_p 0.95 + 固定 seed 12345**——
确定性来自 seed，不是来自把温度压到 0。
直接验证：同一个创造性提问连跑两次，输出逐字相同
（`"The lighthouse's beam wasn't light, but a physical rope that tethered the drifting stars..."`），
且 reasoning 尾部也相同。

#### 修正二：判据不能用调用总数，要用调用构成

固定采样后重测，同一查询（还是 diffusion/conformer 那条）各 3 轮：

| 组 | 调用总数 | turns | provider_query | 失败调用 | get_paper | search_metadata |
| --- | --- | --- | --- | --- | --- | --- |
| 全开 A | 29 | 20 | **0** | **0** | 15 | 13 |
| 全开 B | 29 | 13 | **0** | **0** | 18 | 10 |
| 全开 C | 21 | 17 | **0** | **0** | 7 | 13 |
| 全关 A | 21 | 19 | **3** | 0 | 4 | 13 |
| 全关 B | 32 | 25 | **2** | 1 | 13 | 16 |
| 全关 C | 44 | 45 | **3** | 3 | **0** | **40** |

**调用总数依然重叠**（全开 21–29，全关 21–44），
这印证了之前的判断：总数是个钝指标，不该当判据。

**构成则完全分开**：

- `provider_query`：全开 **0 / 0 / 0**，全关 **3 / 2 / 3**。三比三完全分离。
- 失败调用：全开 **0 / 0 / 0**，全关 0 / 1 / 3。
- `get_paper`：全开最少也有 7，全关有一轮是 **0**——
  全关 C 那一轮打了 40 次 `search_metadata`、一篇都没去核实，
  一路跑到 540 秒 deadline 才停。那正是
  `diagnose-before-act` / `growth-is-not-success` / `budget-priority`
  这几条要防的退化形态：只管继续搜，不管搜到的东西。

所以"轨迹形状明显不同"成立，条件是两件事同时做到：
**采样固定**，且**观察量取调用构成而不是调用总数**。

#### 仍要如实标注的三点

1. **n=3/组**。`provider_query` 那一列是 3:3 完全分离，但样本仍小。
2. **固定 seed 不等于轨迹确定**。全开 A 与 B 的调用总数都是 29，
   但构成不同（15/13 vs 18/10）、turns 不同（20 vs 13）。
   原因是工具打的是真实 OpenAlex/arXiv：一旦某次工具返回的字节不同，
   后续上下文就分叉，固定 seed 只保证"同样上下文下生成相同"。
   用户在选项里预判的风险（"若方差主要来自工具返回的真实数据波动，压不下来"）
   **部分成立**——压下来了大部分，但没有全压下来。
3. **复现需要 shim**。shim 不在仓库里。要复现这张表，
   得先起一个强制写入采样参数的反向代理，再把 vllm 的 `baseUrl` 临时指过去。
   要让它变成仓库里可复现的能力，只有一条路：给 WIDI 接通采样参数
   （见上，需要用户明确授权改 vendored 的 Pi fork）。这条记在下方 U-03。

- commit: `4b46427`
### 2026-08-21 — S7

$T^M$ 补齐到九个工具。**照 S2 的形状做**，但 Service 侧五个端点原来都不存在，
所以这个 stage 大头在 Python 侧。

- Service 侧新增：
  - `POST /expand/citations`（`api/expand.py`）：按 `graph_references` /
    `graph_citations` 能力路由的有界图遍历。
  - `POST /facet`、`POST /rank`、`GET /budget`（`api/probe.py`）。
  - `POST /fulltext`（`api/fulltext.py`）：arXiv 经 ar5iv 取正文分节。
  - `call_ledger.py`：调用计数，供 `/budget` 报真实数字而不是估计。
  - `config.yaml` 新增 `limits:` 段 + `config.get_limits()`。

- **有界性是按 `design.md` §4 的要求做的，而且边界来自配置不是请求**：
  `limits.expand` 给 `max_depth` / `max_seeds` / `max_fanout_per_seed` /
  `max_total_candidates` / `max_concurrency`。请求可以要**更少**并被照办，
  要更多则被夹到上限，**且响应里 `clamped` 列出被夹了哪些**。
  理由：一个调用方自己传的边界不是边界；而一个悄悄用了更小深度的遍历，
  会让"被配置截断的结果"看起来像"文献本来就少"。
  并发用 `asyncio.Semaphore` 而不是分批，这样一个慢 provider 不会串行化整个遍历，
  同时并发数永不超过配置值——有一条测试实测并发峰值 ≤ 4。

- **三个工具刻意不能增加候选**，因为"看了一眼"/"重排了"/"又搜了一次"
  必须在轨迹里可区分：
  - `facet_probe` 只看分布；
  - `rank_candidates` 是 rank-only，`provider_calls` 恒为 0
    （有一条测试把所有 provider 入口都打成抛异常，排序仍须成功）；
  - `search_fulltext` 只取**你点名的**论文的分节，`query` 是在这些论文的分节里筛选与排序，
    不会引入新论文（有测试断言只发了一次 ar5iv 请求）。

- **`search_fulltext` 的范围说清楚了**：这是**按标识符取正文**，不是全文检索索引。
  本服务背后没有全文索引，把它说成全文检索会让人以为它是一条召回路径。
  召回仍然只在 `/search`。这一点写在端点文档、工具描述和 profile 正文里。

- `get_budget` 的 `scope` 字段如实标 `process` 而不是 episode：
  按 episode 记账需要 episode 作用域的 Evidence Store，而它还不存在
  （`docs/07-widi-mapping.md` §3.2）。把进程累计报成 episode 消耗，
  会让一个长跑的服务看起来像一次极贵的检索。工具描述里也提醒了这一点。

- 途中修的一个真实缺陷（**是我自己引入的接口不一致**，实测发现）：
  `rank_candidates` 第一次真实调用时 **20 条候选全被跳过、scored=0**。
  原因是模型手里拿到的是我给的 `PaperSummary`（camelCase），
  而 `/rank` 校验的是 Service 的 `Paper`（snake_case）。
  更关键的是第二次实测发现：模型其实是**照工具输出的文本重建候选**的，
  而我的 `formatPaper` 把标识符渲染成 `id:`，所以它传的键是 `id`——
  既不是 `paperId` 也不是 `paper_id`。
  修法是在 client 边界做翻译（`toWirePaper`）：`id` / `paperId` 都映到 `paper_id`，
  作者名字数组还原成作者对象，`url` 还原成 `urls`，Service 不建模的派生字段丢掉，
  没有标识符时退回 DOI / arXiv id。
  **教训记下来**：工具输出的文本就是在教模型用什么词汇，
  边界必须接受自己教出去的那套词汇。
  修后同一条真实调用 `Ranked 20 candidate(s)`、skipped 0。

- 验收（实际命令与输出）：
  1. `tsgo --noEmit -p .../scholar-search/tsconfig.json` → 退出 0。
  2. `biome check --error-on-warnings` 对 8 个非 fixture 文件 → `No fixes applied.`
  3. `npm run test:widis` → `# tests 124 / # pass 124 / # fail 0`（S6 是 102，本 stage +22）。
  4. Python：`uv run pytest -q` → `111 passed`（S6 时 76，本 stage +35）；
     `ruff check .` → `All checks passed!`；
     `ruff format --check .` → 17 files，与基线持平（见 E-06）。
  5. 十个端点全部在线：
     `/search` `/search/metadata` `/providers` `/provider/{name}/query`
     `/paper/{paper_id}` `/expand/citations` `/facet` `/rank` `/budget` `/fulltext`
  6. 真实链路：一次会话里模型按要求依次调用了六个工具，
     `run_summary`: `tools: {calls:6, failed:0, byName:{get_budget:1, facet_probe:1,
     search_metadata:1, expand_citations:1, rank_candidates:1, search_fulltext:1}}`，
     `providerErrors: 0`。
     其中故意要它对 `expand_citations` 传 `depth: 5`，模型看到的输出里确实有：
     ```
     bounds in force: {"depth":2,"fanout":25,"max_seeds":10,
                       "max_total_candidates":200,"max_concurrency":4}
     REDUCED TO THE CONFIGURED CEILING: depth. This walk was cut short by
     configuration, so a thin result here does not mean a thin literature.
     ```
     夹取生效且对模型可见，这是 §4 有界性要求的实证。

- 一个运行期观察（不是缺陷）：用 arXiv id 作种子做 `expand_citations` 时，
  OpenAlex 返回 4xx——它的图接口认自己的 work id，不认裸 arXiv id。
  轨迹把它记成一条分类失败（`[http] seed '2206.01729': OpenAlex client error`），
  模型据此知道该先 `get_paper` 拿到 openalex id 再扩展。
  这正是失败分类要做的事，但也说明 `expand_citations` 的工具描述
  将来可以更明确地说"用 list_providers 里那个源的 id 空间"。

- commit: `ec7b377`
### 2026-08-21 — S8

Reviewer 旁路通道跑起来了。

- 落点：
  - `profiles/reviewer.md`：`tools:` 只有三个在线工具
    `[provide_advice, inspect_evidence, get_ranking_features]`。
    **没有任何检索工具**——它不能自己去搜。
    离线的六个工具**根本没注册**（不是注册了无效），符合 §7.2 第三条。
  - `settings.json` 的 `enabledProfiles` 追加 `"reviewer"`。
  - `core/review.ts`：advice gate（纯函数）+ 给 Reviewer 渲染轨迹。
  - `core/trajectory.ts` 增加 `evidence`（`EvidenceState`，`design.md` §5.1）：
    S6 只做了 `SearchState`，而 Reviewer 需要**可引用的 id** 才谈得上
    "evidence 必须真实存在"。只存 id + 标题 + 来源 + 由哪次调用发现，
    不存摘要（否则轨迹会随语料增长，正是摘要视图要避免的）。
  - `index.ts`：三个工具 + checkpoint 触发 + gate + 投递。

- **"旁路"是靠工具集保证的，不是靠提示词**：
  Reviewer 由 **extension** spawn，不是 Main spawn。
  `profiles/search.md` 的 `tools:` 里既没有 `spawn_agent` 也没有 `send_message`，
  所以 Main **结构上**无法向 Reviewer 求助。
  `design.md` §3 要求"Main 不能主动求助"，用一句禁令维持是不牢的，
  用"工具集里没有那个动作"维持才牢。

- **投递用 `precede` 而不是 `prompt`/`followUp`**：
  `precede` 是"落到分支上、等下一轮被读到，且不唤醒"。
  用会唤醒的原语会让 Main 再次变 idle → 再触发一次 review → 死循环。

- **gate 落实了 §5.2 列的每一条**（都有测试）：
  动作必须在七个之内、`novelty_key` 去重、同 (action,target) 去重、
  重复的无动作建议（第二个 `stop`）丢弃、
  引用的 evidence id 必须在轨迹里真实存在、每 episode 上限、每动作上限。
  每一次拒绝都带原因记进 `refusals`——**被静默丢掉的建议和从未产生的建议
  在数据上完全一样**，那会让 sidecar 的贡献无法度量。
  还有一条测试钉住"超限被拒时不消耗 novelty key"。

- 途中修的三个真实缺陷（都是实测发现的，不是想出来的）：

  1. **通道状态放错了作用域**。`gates` / `tracesUnderReview` 原来声明在
     `activate` 闭包里，而 extension 是**每个 agent 激活一次**——
     Reviewer 有自己的激活、自己的空 Map，于是它调 `provide_advice` 时
     查不到自己的 review。已提到模块作用域，按 agentId 归键。
  2. **Reviewer 起在了不可用的默认模型上**。spawn 不传 model 就用
     `defaultModel`，而本 namespace 的默认是 `kimi-coding/k3`（无凭据，
     启动诊断一直在报）。结果 Reviewer 的一轮产出**空内容**，
     看起来和"它没有建议"一模一样。
     新增 `SCHOLAR_REVIEWER_MODEL`（`provider/id`）。
     这也正是 M 轴实验需要的旋钮：审查模型是那个实验的变量。
  3. **投递给 Reviewer 的消息渲染成了 extension 通知而不是用户轮**。
     加 `source: {kind: "human"}`。

- 还有一个**不是产品缺陷、是我的测试脚手架的问题**，值得记下来：
  前几次 Reviewer 的 session 里是 `stopReason: aborted`、usage 全零——
  一次 provider 调用都没发。原因是我的驱动脚本在 prompt 返回后立刻
  `run_summary` + `shutdown`，而 Reviewer 恰好是在 Main 变 idle 时才被 spawn 的，
  于是整棵树连同 Reviewer 一起被 abort。
  加了 `wait_tree_idle` 之后才跑通。
  **诊断路径值得记**：是读 `widis/.widi-scholar/runs/.../reviewer-*/session.jsonl`
  看到 `aborted` + 零 usage 才定位的，从工具计数上完全看不出来。

- 验收（实际命令与输出）：
  1. `tsgo` 退出 0；`biome check --error-on-warnings` 对 10 个非 fixture 文件
     `No fixes applied.`；`npm run test:widis` → `150/150`（S7 是 124，本 stage +26）；
     Python 侧未改动，`pytest -q` → `111 passed`。
  2. **Reviewer 至少产生一条 `provide_advice`**：
     `run_summary` → `tools: {calls:24, failed:1,
     byName:{list_providers:1, search_metadata:7, get_paper:15, provide_advice:1}}`。
     `runs/trajectories/search-q1ql.review.json`：
     ```
     reviewer: reviewer-fbb4 | admitted: 1 | refusals: 0
     [rerank] target "result set"
       "The returned candidate set contains significant noise, including papers on
        unrelated topics such as audio deepfakes, video enrichment, and LLM security..."
       evidence: ["2404.13892","2405.17706","2404.16891","2402.14679","2309.15217"]
       novelty_key: "high noise in results"
     ```
     这条建议是**真的对**：那次检索问的是 RAG 用于代码补全，
     而结果里混进了音频深度伪造检测、第三方 API 攻击。
     引用的 5 个 id 全部通过了 gate 的"必须在轨迹里存在"检查。
  3. **证明 Reviewer 的上下文里没有 Main 的私有推理**，两条独立证据：
     - Reviewer 的 session 只有 4 个条目：一条输入（渲染后的轨迹）、
       它自己的 assistant 轮、一条 toolResult、收尾的 assistant 轮。
       没有任何来自 Main 的消息。
     - 从 Main 的 session 里提出它全部 16 个 thinking block（共 5355 字符），
       取 30 个各 60 字符的特征片段，逐个在 Reviewer 的**整个 session 文件**里搜索：
       **leaks found: 0**。

- 一个已知的运行期问题（未修）：`wait_tree_idle` 在 300 秒后超时，
  尽管 review 已经完成。Reviewer 是 `persist: true` 且不会自己 dispose，
  所以这棵树不会真正变 idle。对验收没有影响（review 已经跑完并落盘），
  但 S9 的评测 runner 需要一个明确的 episode 终止条件，
  不能依赖 `wait_tree_idle`。记在这里给 S9。

- commit: `2bc0046`
### 2026-08-21 — S9

benchmark 可以无头驱动 widi-scholar 了。

- 落点：`experiments/eval-runner/`
  - `rpc-client.mjs`：版本化的 JSONL RPC client（`RUNNER_VERSION = "1"`，
    与 WIDI 的 RPC protocol version 是两个版本号，各记各的）。
    经 `npm run --silent widi:rpc` 启动——文档化的入口，不绕过它直接拉
    `packages/widi`。
  - `run.mjs`：评测入口。单条查询或 JSON 查询文件，结果写 `runs/eval/<name>/run.json`
    （`runs/` 已 ignore，产物不入 Git，§5.2）。
  - `queries.example.json` + `README.md`。
  - 另外给 extension 加了 `EXTENSION_VERSION = "1"` 并让 `get_budget` 的
    `details` 携带它：`inspect` 只报 extension id 不报版本，
    而 §5.3 要求 run 记录 extension 版本。

- **§3.3 的边界**：不抓 TUI 文本、不解析控制序列、不读 session 文件。
  所有数字来自 RPC 帧；stdout 上出现非 JSON 行按协议违规直接报错，不猜。
  唯一例外是仓库 revision，用 `git rev-parse` 读——那是 checkout 的事实，
  不是 run 的。

- **§5.3 要求的 provenance 逐项落地**（实测输出核对过）：
  namespace、`rpcProtocolVersion: 1`、WIDI revision（`1ab7905…`）、
  profile `{id: search, source: agent_dir}`、model `{vllm, qwen3.6-35b-a3b, baseUrl}`、
  thinking level、extensions（含 runtime 的 stale 检查结果 `{stale: false}` 与
  `scholarSearchVersion: "1"`）、生效预算（经 `get_budget` 工具取得——
  边界在 Service 配置里，runtime 看不到）、启动诊断、
  父仓库 revision + dirty 标志。

- **每样本契约**（§5.3 最后一条）：稳定关联 `id`；`terminationStatus` 与 `ok`
  分开（超时和被拒都是"没有答案"，折叠就没有失败分类）；机器可读结果
  （答案只取 text part，推理不混入；带 usage）；**失败样本留在记录里进分母**。

- **隔离**：每条查询 spawn 新 agent、跑完 dispose。共享上下文会让第 N 条
  看见第 N-1 条的结果。

- 验收（实际命令与输出）：
  1. `npm run build` 成功（`widi:rpc` 跑 dist，S0 的 E-01 修复只动了 dev 分支，
     built 路径本来就用 `process.execPath`，无需改动）。
  2. 单查询：`node experiments/eval-runner/run.mjs --query ... --model vllm/qwen3.6-35b-a3b`
     → `queries 1: 1 ok, 0 failed`，`run.json` 里 §5.3 各项齐全（上面逐项列过）。
  3. 多查询（`queries.example.json`，2 条）→ `2 ok, 0 failed`，
     每条独立 agent、独立 `elapsedMs` 与 usage。
  4. 失败路径：`--deadline-ms 3000` 强制超时
     → `counts: {total:1, ok:0, failed:1}`，
     `terminationStatus: "timeout"`，`error: "prompt exceeded its 3000ms deadline."`，
     样本仍在记录里。
  5. `biome check --error-on-warnings` 对三个 runner 文件 → `No fixes applied.`；
     `tsgo` 退出 0；`npm run test:widis` → `150/150`。

- 两个如实标注：
  - runner 的 per-query 工具统计目前只有 run 级汇总（`run_summary` 是全 run 的）。
    要 per-query 的工具账目，用 S6 的轨迹文件（按 agentId 对应）或后续给 RPC 加
    per-agent summary——记为后续项，不假装已有。
  - S8 里记过：`wait_tree_idle` 因 Reviewer 常驻不会 idle。本 runner 用
    `prompt` 的完成 + `dispose` 作为样本终止条件，不依赖 `wait_tree_idle`，
    该问题不影响评测路径（评测时 `SCHOLAR_REVIEWER` 默认关闭）。

- commit: `fc225e9`

### 2026-08-21 — 维护：默认模型与 gitlink（不是 stage）

审查合并后的分支状态时处理的两件遗留事，都不属于任何 stage。

- **`packages/widi` gitlink 指回了不含 U-01 补丁的版本。** `76fb88d` 把它写成
  `a48e68b`，而 U-01 的补丁在 `1ab7905`、已经过 widi 的 PR #29 合入上游 `main`
  （`origin/main` = `c2aea3d`）。已改指 `c2aea3d`。U-01 那条记录里"尚未推送"
  的说明同步更新了。

- **默认模型改成局域网 vllm。** `defaultProvider` / `defaultModel` 原本是
  `kimi-coding/k3`，而 `kimi-coding` 这个 provider **在本 namespace 的
  `agent/models.json` 里根本没有定义**——它来自 `packages/widi/preset/settings.json`
  的预设，是被 namespace 初始化时继承下来的 WIDI 偏好，不是本项目的选择。
  后果是每次启动都报 `model.default_unavailable`，且任何不显式指定模型的
  spawn 都会落在一个无凭据的模型上（S8 的 Reviewer 静默产出空内容就是这么来的）。

  改为 `vllm` / `qwen3.6-35b-a3b`，并把 `enabledModels` 里同样悬空的
  `"kimi-coding/*"` 去掉。S0 当初不动默认值是对的（那时它属于用户偏好，
  不该由执行 stage 的 agent 擅自改）；现在是用户明确要求改。

  一个顺带的好处：`SCHOLAR_REVIEWER_MODEL` 从"实际必需"退回成"可选"——
  不设它时 Reviewer 现在会落在一个真实可用的模型上。它作为 M 轴的旋钮仍然保留。

- 验收（实际命令与输出）：
  1. `ready` 帧的 `diagnostics` 从两条告警变成 `[]`。
     `model.default_unavailable` 消失是本次改动的效果；
     `profile.id_filename_mismatch`（U-02）消失则**不是**——它是路径分隔符问题，
     只在 Windows 上出现，本次执行环境是 Linux。U-02 本身仍未修。
  2. **不传 `--model`** 跑一次 `experiments/eval-runner/run.mjs`
     （Service 在 127.0.0.1:8125，打真实 OpenAlex + arXiv）：
     ```
     runner v1 | rpc protocol v1
     profile search | model vllm/qwen3.6-35b-a3b
     widi c2aea3d40c9a | repo 76fb88d6322a (dirty)
     extensions scholar-search | scholar-search v1
     queries 1: 1 ok, 0 failed
       q1: completed in 428814ms, 4672 chars
     ```
     `model` 那一行是从 RPC provenance 读出来的，没有命令行指定——
     默认值端到端生效。`widi c2aea3d40c9a` 同时确认了 gitlink 改动已生效。
  3. 回归：`npm run test:widis` → `150/150`；
     `env -u all_proxy -u ALL_PROXY uv run pytest -q` → `111 passed`。

- **`npm run widi:scholar`：一条命令进到可用的检索 agent**（同一次维护）。

  之前要在 TUI 里试检索得做三件事：另起终端跑 Search Service、设
  `SCHOLAR_SEARCH_SERVICE_URL`、进 TUI 后切到 `search` profile。
  漏掉第一步时九个工具**全部**失败，而失败信息是"服务不可达"——
  看起来像 extension 的 bug。这个误诊值得用一个脚本消掉。

  新增 `scripts/run-scholar.mjs`：起 Service → 轮询 `/health` 直到真的应答 →
  把地址经环境变量传给 extension → 以 `--profile search` 开 TUI →
  TUI 退出时结束它起的那个 Service。

  三个设计点：
  - **已在跑的 Service 复用而不是再起一个**（先探 `/health`），
    退出时也只关自己起的那个——否则会去关掉别人正在调试的进程。
  - **uvicorn 日志写 `runs/logs/search-service.log`，不进终端**：
    每请求一行的日志会把全屏 TUI 冲花。
  - **脚本自己的状态行走 stderr 而不是 stdout**：`--mode rpc` 下 stdout 是
    JSONL 流，`rpc-client.mjs` 对非 JSON 行是直接判协议违规的。

  `widi` / `widi:dev` / `widi:rpc` 保留不动：S9 的 eval runner 按名字调用
  `widi:rpc`（`rpc-client.mjs` 的 `script` 默认值），而且评测**不该**顺带起
  Service——它需要自己控制 Service 的地址与生命周期。

  验收（`--mode rpc` 代替 TUI，其余同一条链路）：
  ```
  [stderr] Starting Search Service at http://127.0.0.1:8000 (log: runs/logs/search-service.log)
  [stderr] Search Service is up.
  diagnostics: []
  profile: {"id":"search","label":"Scholar Search Agent"}
  tools: ["list_providers","search_metadata","get_paper","provider_query",
          "expand_citations","facet_probe","rank_candidates","search_fulltext","get_budget"]
  ```
  另外三项：stdout 全程是合法 JSONL（探针会把非 JSON 行报出来，没有出现）；
  Service 日志里 `GET /providers` 出现 1 次，证明工具真的打到了 Service；
  退出后 `ss -ltn` 里 8000 端口已释放、Service 日志以
  `Application shutdown complete` 收尾。
  `npm run check:workspace` → `Checked 5 files. No fixes applied.`

### 2026-08-21 — 首次真实人机会话，追出四个已落地部件的缺陷（不是 stage）

`npm run widi:scholar` 落地后的第一次交互式使用。用户问的那句话逐字就是
`references/datasets/pasa/AutoScholarQuery/train.jsonl` 第 2 行
（`AutoScholarQuery_train_1`），四篇标准答案**全部有 arXiv ID**，
所以这次会话意外地成了一次有对照的评测。实际召回 **1/4**。

追因结果记在 `docs/08-retrieval-defects.md`（F-1..F-7 + 行为观察 B-1..B-5）。
最关键的一条：`plugins/arxiv.py:205` 把查询拼成 `all:{query}`，
arXiv 按 **OR** 展开（其 Atom 响应的 `<title>` 会回显解析结果，可直接验证），
于是每次检索都是词袋 OR 查询。同一条主题查询：

```
当前实现（隐含 OR）        → 命中 0/4
只把词间连接改成 AND       → 命中 3/4
再加一条 superpixel 子查询 → 命中 4/4
```

没有用 OpenAlex、没有重排、没有判别器。**这意味着 S7 之后关于排序栈的任何
对比都建立在一个系统性缺失正确答案的候选集上。**

第二条：OpenAlex 的 rate_limit 不是速率问题。实测 429 响应头显示它已改为
信用计费（匿名 IP 每天 1000 信用 = $0.10 = 100 次 list 查询，`Retry-After` 约 16 小时），
`config.yaml` 的 `rate_limit_rps` 对它无效，而 `cost_model` 里的单价其实写对了、
只是 `call_ledger.py` 没有去读。详见 F-3 / F-4。

会话记录在 `widis/.widi-scholar/runs/.../20260821T072357Z_search-d9w6/session.jsonl`，
该目录被 `.gitignore` 排除，所以 F-1..F-7 的证据全部内嵌在 08 文档里。

### 2026-08-21 — merge LLM provider 层，并排出 S10/S11（不是 stage）

`aac617c`（PR #10）给 Search Service 加了 LLM provider 抽象与 `POST /judge`
转发端点，765 行，`pytest -q` 126 passed。它解开的是一个真实阻塞——
在此之前 Service 根本没有调 LLM 的能力，$NP_k^{judge}$ 的消费者无处安放。

审阅得到三个判断，详见 `docs/09-next-stages.md`：

1. **它是传输层，不是判别器**。`api/judge.py` 的 docstring 自陈不含 prompt 模板
   与结果解析。离 NPj 落地还差四样：载体、Configure 通路、L3b 接进排序栈、
   判别结果进 provenance。
2. **判别器不会成为第十一个工具**。`prototype.md` §7.1 把
   "决定花多少预算做判别是 Agent 的策略，执行判别是 Service 的实现"
   写在了工具表下面；`05-skill-decomposition.md` 给 `judge_relevance`
   的归属是 `SVC` 不是 `TOOL`。这条性质当前守住了（`/judge` 未注册成工具），
   以后也要守住。
3. **这段代码没有对应的验收判据**（记为 D-09）。现在测的是"转发通不通"，
   而 `prototype.md` §4 要求的是"按准则分级、可归因、带版本号"。
   判据缺席时，能力缺口会以"看起来完成了"的形式沉淀下来——
   这正是本文 `DONE†` 那一套记号存在的理由。

同时新增潜伏缺陷 **F-9**：`llm/providers/openai_compatible.py:49` 用
`os.environ` 取密钥，而 pydantic-settings 读 `.env` 不写回 `os.environ`——
与刚修掉的 F-8 同族、同样静默。现在不发作只因为默认 provider 是 vllm 且
`config.yaml` 里写死 `api_key: "EMPTY"`。

另外把 `07-widi-mapping.md` 补了 §3.5，显式区分两个 LLM 调用点：
Main 的推理（**不可** tool-reducible，U-03 卡的是它）与 Service 侧的
无状态 worker（**必须**在 Service 内）。这个区分之前只在讨论里，没有落纸。




## 决策记录

stage 执行中做出的、路线图没有规定的选择，记在这里（含理由）。
不要推翻已记录的决策，除非它被证明是错的。

### D-07 — $SI_k$ 的注入点选 `projectContext` 静态注入，不选 `input` interceptor

路线图 S5 要求在两者中选一个并写明理由。选 **`projectContext` 静态注入**。

理由：

1. **它已经被验证可用，且不需要写代码。** S4 的验收就是这条路径：
   模型逐字引用了注入文件里的 `np-version`，0 次工具调用。
   `AGENTS.md` §3.2 禁止预建无调用方的框架——interceptor 现在没有
   `projectContext` 做不到的事。
2. **消融操作面正好匹配。** S5 的验收要求"全关 vs 全开"。
   `projectContext` 下这是一次配置改动（去掉那一行）或一次文件改动，
   两者都留在 git diff 里可审计。interceptor 要另造一个开关，
   而那个开关自己又不在版本控制的语义里。
3. **interceptor 会引入一个正确性风险而当前换不来收益。**
   `SKILL.md` §6 明确 `input` interceptor 也会收到 agent 与 runtime 注入的消息，
   必须检查 `event.source`。漏检就会把条目重复注入进每一条中间消息，
   或者把 agent 自己的输出当成 RQ。为一个当前没有额外能力的路径承担这个风险不划算。

关于 $SI_k = \mathrm{Compose}(RQ, NP_k^{agent})$ 的形式：
`projectContext` 把 $NP_k$ 放进系统提示词，$RQ$ 作为用户消息到达，
模型的实际输入是两者的函数——Compose 在语义上成立，
不要求两者被拼接成同一个字符串。

**什么时候必须改成 interceptor**（记下来，免得将来重新论证）：
出现"每个 episode 生效的条目集合不同"的需求时。具体是两种情况——
Reviewer 在 episode 中途改写条目集合（S8），
或者按 $\theta^S_k$ 过滤条目。这两种都需要在请求时点动态组装，
静态注入做不到。到那时再切换，并且在 progress 里注明是这条决策被触发了。

### D-06 — S2 允许改 `src/search-service/`，而且必须改

路线图 S2 的落点只写了 extension（`index.ts` + `core/` + tests），隐含假设
Service 已经提供三个工具需要的一切。实际不成立：

| 工具 | Service 侧现状 |
| --- | --- |
| `search_metadata` | `POST /search/metadata` 有，但 `subqueries` 参数不存在 |
| `provider_query` | `POST /provider/{name}/query` 有，够用 |
| `get_paper` | **没有任何单篇端点** |

所以 S2 的落点扩展到 `src/search-service/`。这不违反 §1.1——§1.1 限制的是
`packages/widi/`（WIDI runtime），而 Search Service 按 §1.2 的映射表本来就是
"已有的 Python HTTP 服务"，是这条架构里的一个正式部件。

考虑过但否决的替代方案：

- **用 `/search` 模拟 `get_paper`**：`/search` 是关键词检索，不是 ID 精确查找。
  拿 DOI 当关键词去搜，命中不保证是同一篇。这是把"能跑"当成"对"。
- **在 extension 里用 passthrough 拼 `get_paper`**：那要求 extension 知道
  "openalex 的单篇路径是 `works/{id}`、arXiv 的是 `id_list=`"，
  即把 provider 语法搬进 extension——正好违反本 stage 契约 1。
- **不做 `subqueries`，让签名里留个空参数**：签名里有、行为上没有，
  等于骗调用方。要么实现，要么像 `judge_level` 那样显式报告不支持。
  `subqueries` 是整条设计里最核心的策略旋钮（查询分解），
  而 aggregator 里做扇出只是把"每 provider 一次调用"改成"每 (provider, query) 一次"，
  代价小、价值大，所以实现；`judge_level` 需要一整个判别器，所以显式报告不支持。

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

**推送状态（2026-08-21 更新，本条原记为"尚未推送"）**：已推送并合并。
`1ab7905` 经 widi 的 PR #29（`fix/windows-extension-id`）合入上游 `main`，
submodule 的 `origin/main` 现在是 `c2aea3d`。

父仓库这边则出现过一次回退：`76fb88d` 把 gitlink 写回了 `a48e68b`，
于是 gitlink 又指向了不含该补丁的版本。已在本次维护中改指 `c2aea3d`，
`AGENTS.md` §2 要求的"推送到 ArcadiaLin/widi 再由父仓库更新 gitlink"
至此两截都完成。

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

### U-03 — WIDI 无法固定采样参数，可复现运行因此不可得（已知，未修，需用户授权）

**症状**：无法让同一个 prompt 在 WIDI 里可复现地生成。没有任何配置面能设置
temperature / top_p / seed。

**逐处确认**（S5 验收时做的）：

| 位置 | 结论 |
| --- | --- |
| `settings.json` / `setting-manager.ts` | 无 temperature/seed 键 |
| `models.json` 的 `ModelDefinitionSchema`、`ModelOverrideSchema`、`ProviderConfigSchema` | 无采样字段 |
| `compat` 三个 schema（openai-completions / openai-responses / anthropic-messages） | 无 `extraBody` 之类透传口 |
| extension 拦截器 `before_provider_request` | 它的 `AgentHarnessStreamOptionsPatch` 只有 transport / timeoutMs / maxRetries / maxRetryDelayMs / headers / metadata / cacheRetention |
| extension 拦截器 `before_provider_payload` | **不在** `ExtensionInterceptorName` 的六个可用拦截器里 |
| `agent-orchestrator.ts:1182` | 只传 `request.settings.providerRetry`，即上面那个不含 temperature 的结构 |

`SimpleStreamOptions`（pi-ai）本身**有** `temperature`——
`packages/agent/src/proxy.ts` 就在转发它。缺的只是从 WIDI 配置到
`AgentHarnessStreamOptions` 这一段。

**为什么没修**：正经接通要往
`packages/widi/packages/agent/src/harness/types.ts` 的 `AgentHarnessStreamOptions`
加字段并在 harness 里转发。那是 vendored 的 Pi fork，
submodule 的 `AGENTS.md` 明确写 "Treat `packages/agent` as vendored upstream code...
Do not modify it unless the user explicitly asks"。**用户没有明确要求改它**，
所以停在这里。这与 U-01 不同：U-01 改的是 `apps/widi/`（WIDI 自己的代码），
U-03 要改的是 vendored 上游。

**对 WIDI 的通用价值是明确的**：WIDI 有 RPC 评测模式（S9 要用），
而无法固定采样的评测harness 是没法做可复现评测的。
这符合 §1.1 第一种情况（extension API 无法表达，且对 WIDI 本身有通用价值），
只是被 submodule 的 vendored 边界挡住了。

**当前绕法**（S5 用的）：scratchpad 里一个反向代理，转发 vllm 请求时强制写入
采样参数，再把 `models.json` 的 `baseUrl` 临时指过去。
够做一次实验，但**不进仓库**，所以 S5 那张对照表现在无法在仓库内一键复现。

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

## Search Service 缺陷

`src/search-service/` 自己的缺陷。与 WIDI 无关，修在本仓库内即可。

### SV-01 — provider 的共享 HTTP client 在并发下互相关闭（S2 已修）

**这条是 S2 的 subquery 扇出暴露出来的**，不是我写的新代码里的 bug，
但是我的改动让它变成必然发生。

发现方式不是测试，是一次真实检索。模型自己在回答里说
"2 subqueries failed on OpenAlex due to client closure"，轨迹里坐实了：

```
failures (2):
  - openalex [unknown] query 'self-attention mechanism': Cannot send a request, as the client has been closed.
  - openalex [unknown] query 'sequence transduction with attention': Cannot send a request, as the client has been closed.
```

成因：每个 plugin 持有一个 `httpx.AsyncClient`，而每个包装方法都是

```python
try:
    return await self._client.search(...)
finally:
    await self._client.close()     # 关掉的是共享 client
```

扇出之前，aggregator 对每个 provider 只发一次调用，永远撞不上。
扇出之后同一个 provider 上有 (1 主查询 + N 子查询) 个并发调用，
最先完成的那个把 client 关掉，其余全部失败。

**这个 `finally: close()` 不能直接删掉**——它是有原因的：
`SourcePlugin.search_sync` 用 `asyncio.run` 每次开一个新事件循环，
而绑在已结束循环上的 httpx client 不能复用。删掉它会让连续两次
`search_sync` 挂掉。

修法：给三个 client（openalex / arxiv / serper）加一个计数的
`session()` async context manager——进入时计数 +1，离开时 -1，
**归零时才关**。两个性质同时保住：并发安全，且空闲时仍然关闭。
所有包装方法从 `try/finally: close()` 改成 `async with self._client.session():`。

serper 当前是 `enabled: false`，但同样改了：扇出会同等地并发调用它，
留着就是埋一个"启用即坏"的雷。

回归测试 `tests/test_client_session.py`（6 条）把两侧都钉住：
三个并发 search 全部成功、混合操作并发、归零后 client 确实关闭、
连续两次 `search_sync` 仍然可用、失败路径不泄漏计数。

验证：修前那次真实检索 `failures (2)`；修后同样的提问
`queries issued: 6 | candidates recalled: 149 | returned: 20`，
`failures: 0`，轨迹里 `client has been closed` 出现 0 次。

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

### E-06 — `ruff format --check .` 本来就红（未修，非本路线引入）

`npm run check:python` 里的 `ruff format --check .` 在改动前就有 17 个文件不合格：
这个仓库的 Python 代码普遍用 `description="...")` 把右括号接在末行的写法，
而 ruff 要它单独一行。受影响的包括 `README.md` 里的示例代码、
`aggregator.py:47` 的 `_select_sources`、`capabilities.py`、`requests.py` 等等。

**未修**：全仓库重排会产生一个跟本路线无关的巨大 diff。
本路线只保证**不新增**这笔债：

| | 不合格文件数 |
| --- | --- |
| 基线（S2 改动前） | 17 |
| S2 改动后 | 16 |

新增的 4 个文件（`api/paper.py`、`tests/test_paper_lookup.py`、
`tests/test_subquery_fanout.py`、`tests/test_client_session.py`）都跑过
`ruff format` 因此干净；被我改过的既有文件，报错位置逐个核对过都是改动前就有的老位置。
`ruff check .`（lint，不是格式）是 `All checks passed!`。

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
