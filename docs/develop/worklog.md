# 实施日志

> 读者：正在推进 `plan.md` 那四段的人，以及事后想知道"这个选择是谁在什么时候做的"的人
> 规矩：`plan.md` 写明了的照做**不记**；计划没写而实施中定下来的，一行一条。
> 影响面标成 **实验对照** 的，最后要升成 `decisions.md` 的 `D-nn`。

## 1. 进度表

| 项 | 状态 | commit |
| --- | --- | --- |
| F-1 arXiv 查询退化成 OR | DONE | `8bc69de` |
| F-2 全部 provider 失败时丢弃原因 | DONE | `8bc69de` |
| F-10 `expand_citations` 不接受其他工具的 id | DONE | `8bc69de` |
| S10 答案池与召回评测回路 | DONE† | `599f351`（判据 4 后半缺口 → G-6） |
| S11 Reviewer v0 与 $NP_0$ 重写 | DONE† | `cd5d0d5` + `382d69b`（判据 3、8 缺口 → G-7、G-8） |
| S12 $NP^{judge}$ 载体与 L3b 判别层 | DONE† | `24bdcc0`（判据 2 后半缺口 → G-9；L3a/L3c → G-10） |

## 2. 决策

| 日期 | 在哪 | 选了什么 | 理由 | 影响面 |
| --- | --- | --- | --- | --- |
| 2026-08-21 | `plugins/arxiv.py` `build_search_query` | 词项 AND 连接之外，另做两件事：引号内保持短语、无引号词项去掉首尾句读（`?!.,;:()[]{}'"`` `） | 一个被告知"说出你要什么"的 agent 会写句子，而 `segmentation?` 与 `segmentation` 对词索引不是同一个词 | 只影响 arXiv 查询构造 |
| 2026-08-21 | `plugins/arxiv.py` `build_search_query` | 已带 arXiv 字段前缀（`ti:`/`cat:`/…）或裸布尔算子（`AND`/`OR`/`ANDNOT`）的词项原样透出，不再包一层 `all:` | 调用方写的是 arXiv 自己的语法，二次改写会把一条正确的查询改坏 | 只影响 arXiv 查询构造 |
| 2026-08-21 | `index.ts` `search_metadata` 的 `query` 描述 | 从"自然语言陈述"改成"词项按 AND 组合，送概念不要送句子，短语用引号" | 改成 AND 之后旧描述会直接把 agent 引向零召回，两者不能并存 | **实验对照**（改了 $T^M$ 的工具描述，agent 行为随之变化，跨这条线的检索行为数字不可比） |
| 2026-08-21 | `schemas/state.py` `IssuedQuery` | 新增 `native_query` 字段承载"实际发出的查询串"，而不是覆盖 `query` | 两者都要留：`query` 是 agent 的措辞、`native_query` 是 provider 收到的，F-1 藏了这么久正因为只有前者 | **实验对照**（`SearchState` 的数据格式变了，旧的 `.json` 轨迹没有这个字段） |
| 2026-08-21 | `providers/base.py` | 加 `native_query_for()` 纯函数钩子，而不是改 `search()` 的返回类型 | 归一后的查询串必须来自发请求的那段代码，但不值得为它动三个 plugin 的返回签名 | 只影响 provider 基类 |
| 2026-08-21 | `identifiers.py`（新） | id 解析集中一处，`api/paper.py` 的三条本地正则一并改成调它 | F-10 的根因是三个端点各有一套 id 观念；只修 expand 会留下同样的坑 | **实验对照**（`/expand/citations` 与 `/paper` 接受的 id 集合变了） |
| 2026-08-21 | `identifiers.py` `openalex_address` | DOI 一律走 `doi:<doi>`，arXiv id 走其注册 DOI `doi:10.48550/arXiv.<id>` | 2026-08-21 实测：`works/doi:...` 与 `works/W...` 是 $0 的单篇查找，`works/https://doi.org/...` 与 `works/arxiv:...` 不是（后者正是 F-10 那个 400） | 只影响 OpenAlex 寻址 |
| 2026-08-21 | `schemas/state.py` `Failure.error_type` | 新增 `bad_id` 分类 | "输入写错了"和"这个方向没有边"必须能被调用方区分开，这是 F-10 的核心 | **实验对照**（`Failure` 的取值集合变了） |
| 2026-08-21 | `api/expand.py` | 全部种子都不可解析时返回 400（带接受形式），部分可解析时继续走并把坏种子记成 `bad_id` failure | 一个坏种子不该让好种子的扩展一起停；但全坏就是调用错误，不是空图 | 只影响 expand 端点 |
| 2026-08-21 | `pyproject.toml`（service） | 加 `network` marker 并默认 `-m 'not network'` | F-1 要求的断言（arXiv 回显里不出现 ` OR `）只有实时 API 能验，但默认测试不得依赖实时 API（`AGENTS.md` §7） | 只影响测试选择 |
| 2026-08-21 | `scripts/widis-quality.mjs` | `spawnSync` 在 win32 上加 `shell: true` | 不加则 `npm run check:widis` 在 Windows 上直接 EINVAL，检查步骤根本跑不起来 | 只影响 Windows 下的检查脚本 |
| 2026-08-21 | `schemas/paper.py` `canonical_key` | 沿用 D-13 的优先级（doi > arxiv_id > openalex_id > paper_id），但**选中的那个 id 先过 `parse_identifier`** 归一，并输出带空间前缀的键（`arxiv:X` / `doi:x` / `openalex:W`） | 不归一的话 OpenAlex 记的 `10.48550/arxiv.1810.09726` 与 arXiv 记的 `1810.09726` 是两篇；归一后跨源的 arXiv 预印本重复项才会合并（判据 §3.7.2 靠这一条） | **实验对照**（`_deduplicate` 的分组结果变了，`recalled/returned` 的比值随之变化） |
| 2026-08-21 | `schemas/paper.py` `Paper` | `canonical_id` 做成 `computed_field` 而非普通字段 | 能被入参设置的身份字段，等于让调用方把一篇拆成两篇 | 只影响 `Paper` 的序列化（多一个只读字段） |
| 2026-08-21 | `identifiers.py` | 接受 `openalex:` 前缀 | `canonical_key` 会发出这种形式，而 `/expand/citations` 把 canonical 键当下一跳种子用——不接受就会把自己产出的键判成 `bad_id` | 只影响 id 解析 |
| 2026-08-21 | `core/answer-pool.ts` | 池子上限 200 篇，超出时 `add` 抛错并提示"先带理由移除最弱的"，而不是静默丢弃 | 工具失败必须 throw（`SKILL.md` §6）；静默丢弃会让 agent 以为提交成功了 | 只影响答案池 |
| 2026-08-21 | `core/answer-pool.ts` | 重复 `add` 同一篇 → 更新 `why`，但 `addedByToolCall` 保留**首次**提交的那次调用 | 溯源要回答"这篇是哪次检索找到的"，那是第一次；而 `why` 的当前值才是当前判断 | 只影响答案池 |
| 2026-08-21 | `core/answer-pool.ts` | 移除后再加回来，`removed` 里的那条**不删** | 一次被推翻的判断本身就是 $NP^{judge}$ 要的带出处负例（`plan.md` §3.5 第四条） | 只影响答案池 |
| 2026-08-21 | `core/trajectory.ts` | `PublicSearchTrace` 加 `answerPool` 投影字段 | 不是白名单扩宽：池子是**经工具调用**写的，内容本来就在 args 里；这只是把它投影成可读形状，让"覆盖不足"从推断变成读出（`plan.md` §3.5 第三条） | **实验对照**（`.json` 轨迹多了一个字段） |
| 2026-08-21 | `experiments/eval-runner/run.mjs` | 每条结果记 `agentId` 与 `gold`；`SCHOLAR_TRACE_DIR` 默认指到 `<out>/trajectories` | 打分器只有靠 `agentId` 才能找到 `<agentId>.answer.json`；默认分目录则两次 run 的答案不会互相顶掉 | **实验对照**（`run.json` 的记录格式变了；`RUNNER_VERSION` 已随之升到 2，见 §6） |
| 2026-08-21 | `experiments/eval-runner/score.mjs` | `--k` 按 agent 写入池子的**顺序**截断 | 池子是 agent 自己建的列表，换任何别的顺序打的都是一个没人产出过的排名 | **实验对照**（k 的语义） |
| 2026-08-21 | `experiments/eval-runner/score.mjs` | `poolStatus` 区分 `empty` 与 `never-written` | 同样是 0 分，但"没调过这个工具"和"调了没提交"是两种不同的诊断，B-4 说的正是前者 | 只影响打分输出 |
| 2026-08-21 | `package.json` | 新增 `test:experiments` 并挂进 `npm test` | eval-runner 的转换与打分是有行为契约的代码，之前完全没有测试入口 | 只影响测试入口 |
| 2026-08-21 | `index.ts` `EXTENSION_VERSION` | 1 → 2 | 注册工具集与 `search_metadata` 的 `query` 契约都变了，跨这条线的运行不可比 | **实验对照** |

## 3. 撞见但没修的问题

按纪律记在这里，**修不修由 `plan.md` 的顺序决定**。

| 日期 | 是什么 | 证据 | 为什么现在不修 |
| --- | --- | --- | --- |
| 2026-08-21 | **AND 连接对整句自然语言查询过严。** `build_search_query` 会把一句 15 词的提问变成 15 个 AND 词项，命中率大概率为零 | `AutoScholarQuery_train_1` 的原问句共 17 词 | `plan.md` §2 与 `backlog.md` F-1 指定的修法就是 AND；缓解手段（停用词表、词项数上限、自动降级成 OR）都是新的检索设计，不在计划里。已经用工具描述把 agent 引向词项式查询，实测 4/4 成立。**已发生**：S12 的 J 轴消融把它变成了实测（原问句召回 0 条），按当时说的记成新条目 **F-13**，不并进 F-1 |
| 2026-08-21 | **本仓库的 Python 在当前 ruff 下不是 format-clean。** `uv run ruff format --check .` 报 18 个文件要重排，其中 `plugins/serper.py` / `plugin_loader.py` / `tests/test_serper_plugin.py` 等**本次未改动** | 基线即红；差异全是 `hug_parens_with_braces_and_square_brackets` 这一条（`f({...})` vs `f(\n{...}\n)`） | `ruff>=0.12,<1` 是浮动区间，仓库是用另一个 ruff 版本排的。全仓重排会盖住修复本身的 diff；新写的代码沿用了仓库现有风格。`uv run ruff check .`（lint）全绿 |
| 2026-08-21 | **`npm run check:widis` 的 biome 半在本检出上必红。** 本地 `core.autocrlf=true`，工作区文件是 CRLF，biome 的 formatter 期望 LF，于是**每个文件**都报 format 差异（含 `themes/*.json` 这类未改动文件） | `git config core.autocrlf` → `true`；`xxd widis/.widi-scholar/themes/prism.json` 里是 `0d0a` | 这是检出配置，不是仓库内容；改仓库去迁就它是错的方向。已用 `biome lint --error-on-warnings`（对行尾不敏感）+ `tsgo --noEmit` 覆盖，两者全绿 |
| 2026-08-21 | **`pytest` 在设了 `all_proxy=socks5://...` 的 shell 里 39 个用例失败。** httpx 读环境代理，缺 `socksio` 就抛 ImportError | `ImportError: Using SOCKS proxy, but the 'socksio' package is not installed` | 是本机 shell 环境，不是仓库缺陷。跑法：`all_proxy= uv run pytest -q` |
| 2026-08-21 | **端口 8000 上有一个前一天（08-20 11:16）留下的 Search Service 进程。** 它只有 S2 时期的路由（`/`、`/health`、`/providers`、`/search`、`/search/metadata`、`/provider/{name}/query`），`GET /budget` 返回 404 | 第一次 S10 验收跑出来 `get_budget` 两次失败："Not Found Call list_providers ..."；新起的 uvicorn 因端口占用退出（日志里 `Errno 10048`） | 已 kill 并重起（否则任何测量都建立在旧代码上）。**值得单独记一笔的不是这个进程，是失败的样子**：一个陈旧服务不会说自己陈旧，它会以 404 的形式表现，而 404 的兜底文案把 agent 引向 `list_providers`。`run-scholar.mjs` 复用已在跑的 Service（先探 `/health`）这条设计放大了它——`/health` 在旧服务上照样 200。**建议 `/health` 报出 service 版本与路由集，让复用前能对齐**，记成一条未修问题 |
| 2026-08-21 | **`tests/fixtures/README.md` 里 `search-metadata.json` 的录制命令与实际 fixture 不一致**（缺 abstract/authors/venue/published/urls），照它重录会得到一个更薄的 fixture | 按原命令重录后 45 行内容消失，而三个测试依赖那些字段 | 已顺手修正（重录 fixture 时必须先修它，否则 D-05"fixture 只录不手写"这条守不住），记在这里是因为它说明**录制命令本身也需要被验证** |
| 2026-08-22 | **`runs/*/session.jsonl` 的 `session` 头不记模型与配置指纹。** 只有 `{id, timestamp, cwd, metadata.profile}`；模型要从每条 assistant 消息的 `provider`/`model` 字段倒推 | §1.5 那张双模型对照表里的 `vllm/qwen3.6-35b-a3b` 与 `kimi-coding/k3`，是逐条读 message 才确定的；`settings.json` 在两次会话之间被改过（`defaultProvider` vllm → kimi-coding），会话记录里没有任何痕迹 | 是记录格式问题，不影响本次结论（倒推得到的信息是完整的）。但它与 G-4（S9 产出不可复现）同族：**一次会话的可比性依赖仓库外的配置状态**。补法很小——`session` 头加 `model` / `settingsHash`，等有人动 run 记录格式时顺手做 |
| 2026-08-22 | **kimi-coding 侧 429 会让会话静默停在最后一个问题上。** run2 末尾用户连问两次"你有哪些工具用了？哪些没有用"，两次的 assistant 记录都是 `stopReason: "error"`、`usage` 全 0、`errorMessage: 429 ... The engine is currently overloaded` | `20260822T090309Z_search-ez9i/session.jsonl` 最后两条 | 是上游限流，不是仓库缺陷。记一笔是因为**失败的样子**值得知道：轨迹里留下的是一条空的 assistant 消息，不是一个显式的失败标记——任何按消息数或 `stopReason` 统计 episode 的脚本都会把它算成一次正常回合 |

## 4. 前置修复的验收记录

`plan.md` §2 的判据："`backlog.md` §1 那个 0/4 → 4/4 的对照在完整系统上重跑一遍，
数字可复现。"

2026-08-21，`sources: ["arxiv"]`、`top_k: 20`、live arXiv API、gold 取
`AutoScholarQuery_train_1` 的四个 `answer_arxiv_id`：

```
修复前的那条查询（把旧的 OR 串经 provider_params 原样发出）
issued : all:region-based active learning semantic segmentation superpixel image patches
results: 20  hits: []  (0/4)
top 5  : Generating Superpixels for High-resolution Images / AINet+ /
         Robust Image Segmentation in Low Depth Of Field Images /
         Medical Image Segmentation based on Deep Active Contour /
         Adaptive Superpixel for Active Learning in Semantic Segmentation

修复后，第一条查询
issued : all:region AND all:active AND all:learning AND all:semantic AND all:segmentation
results: 20  hits: 1810.09726, 2002.06583, 2010.01884  (3/4)

修复后，第二条查询（原问句里就有 superpixels）
issued : all:"active learning" AND all:"semantic segmentation" AND all:superpixel
results: 4   hits: 1911.11789  (1/4)

UNION -> 4/4
```

三个数字（0/4、3/4、合计 4/4）与 `backlog.md` §1 逐条一致，前 5 名的标题也一致。

## 5. S10 的验收记录

命令（`runs/` 不进 git，所以数字内嵌）：

```bash
node experiments/eval-runner/autoscholarquery.mjs --input <一行 train_1 的 jsonl> \
  --out runs/eval/s10-accept/queries.json
node experiments/eval-runner/run.mjs --queries runs/eval/s10-accept/queries.json \
  --model vllm/qwen3.6-35b-a3b --out runs/eval/s10-accept --deadline-ms 480000
node experiments/eval-runner/score.mjs --run runs/eval/s10-accept/run.json --k 4
```

provenance：`runner v1 | rpc protocol v1 | widi c2aea3d40c9a | repo 8bc69de (dirty) |
scholar-search v2 | vllm/qwen3.6-35b-a3b`。

### 判据 1 — 池子存在、非空，Recall@4 有确定取值 ✅

```
AutoScholarQuery_train_1: recall 0/4 | precision 0.000 | pool ok (14 committed, 0 withdrawn) | 133966ms
      missed: 1810.09726, 2002.06583, 2010.01884, 1911.11789
macro: Recall@4 0.5000 | Precision@4 0.2500 | F1 0.3333 | median 167144ms
```

（macro 里的第二条是我为判据 3 加的一条**自造**查询，不是 AutoScholarQuery 的记录，
它的 2/2 不构成任何 benchmark 声明。**唯一可引用的数字是 train_1 上的 0/4。**）

**这个 0/4 值得单独说一句**：F-1 修好之后 L0 召回层在同一条查询上能到 4/4
（§4），而 agent 端到端只拿到 0/4。差额全部落在策略上——它 14 次
`search_metadata` 全部围绕 "superpixel / patch / region-based segmentation"
这一个解释，一次都没有转向 "region-based **active learning**"。
这与 `../reviewer-design.md` §2.2 的负结果、`backlog.md` B-1/B-2 完全同型。
**这不是 S10 的缺陷，正是 S11 的测量对象**，而在 S10 之前它根本没有数字可言。

### 判据 2 — 同一篇论文经 arXiv id 与 OpenAlex id 各加一次，池中只有一条 ✅

Service 侧（live）：

```
1810.09726                                  -> canonical_id arxiv:1810.09726 | 由 arxiv 应答
W2893040979                                 -> canonical_id arxiv:1810.09726 | 由 openalex 应答
https://doi.org/10.48550/arxiv.1810.09726   -> canonical_id arxiv:1810.09726 | 由 arxiv 应答
```

端到端（`runs/eval/s10-probe`，三次 `update_answer_pool`）：第一次加
`1810.09726`、第二次加 `W2893040979`，池子仍为 1 篇，工具回复
"was already committed; its 'why' is updated"。

### 判据 3 — 一个 session 两条查询，两个 `.answer.json`，内容不交叉 ✅

```
pool A: search-to8d 14 papers
pool B: search-78dn  5 papers
intersection: []
```

### 判据 4 — 池子的每次变动进 $\bar{\tau}_t$，Reviewer 上下文能读到池子当前内容 ⚠️ 部分

前半满足：`search-to8d.json` 里 `callsByTool.update_answer_pool = 1`，
`answerPool.committed = 14`，`answerPool.lastChangedBy = call_3fd4892d...`，
每条带 `why`。probe 那次三次变动三条调用全在轨迹里。

后半**只由单测证明**（`review.test.ts` 的两条：pool 段渲染、空池渲染成 `EMPTY`），
**没有活的 Reviewer 读过它**——Reviewer 目前仍挂在 `agent_idle` 上且默认关闭
（G-1）。这是 S11 的作业面，不是这里可以补的。已按 `plan.md` §8 记进
`backlog.md` 的验收缺口（G-6）。

### 判据 5 — 一次带 `reason` 的移除落盘可读 ✅

```json
{"canonicalId": "arxiv:1810.09726", "paperId": "1810.09726",
 "title": "CEREALS - Cost-Effective REgion-based Active Learning for Semantic Segmentation",
 "reason": "withdrawn to check that a reasoned withdrawal is recorded",
 "removedAt": "2026-08-21T18:19:53.712Z",
 "removedByToolCall": "call_8188b8aa...", "addedByToolCall": "call_532c6d08..."}
```

### 顺带观察到的两件事

- **`search_fulltext` 第一次被调用了。** 三次历史会话里它零调用
  （`../reviewer-design.md` §2.1）。第二条查询里出现了 `POST /fulltext`。
  n=1，不构成结论，但值得记：R6 那类检测器的前提（"只抓不看"）可能不是恒定的。
- **池子是一次性批量写入的**（14 篇全在同一个 `call_3fd4892d...` 里，
  时间戳跨 26 秒）。`plan.md` §3.8 第二条预告的是"过早承诺"，实测到的是相反的
  "最后一次性承诺"。观察量（首次写入时刻）已经在记录里，留给 P 轴。

## 6. S11 的决策

| 日期 | 在哪 | 选了什么 | 理由 | 影响面 |
| --- | --- | --- | --- | --- |
| 2026-08-21 | `index.ts` `ensureReviewer` | 附着有两个入口（`agent_spawned` + 该 agent 的首个 `tool_execution_end`），都先做同步声明 | 只挂 `agent_spawned` 假设了"这个事件会到达一个能对它动手的 activation"，而 extension 是按 agent activate 的 | **实验对照** → D-20 |
| 2026-08-21 | `index.ts` `scheduleReview` | 按 subject 串行化（一在飞 + 一排队），超出的记进 `review.json` 的 `journal` 而不是 gate 的 `refusals` | gate 的拒绝是关于**建议**的，这里被拒的是一次**投递**；混在一起会让两种情况看起来一样 | **实验对照** → D-21 |
| 2026-08-21 | `index.ts` journal | 每条记录带 `atCall` / `atSearch` | 判据 2 问的是"投递是否早于最后一次 `search_metadata`"，墙钟时间答不了，调用序列里的位置才能 | **实验对照** → D-21 |
| 2026-08-21 | `core/review.ts` | 七个检测器读一个结构化子集 `DetectorTraceView` 而不是整个 `PublicSearchTrace` | 检测器只需要计数与查询串；收窄入参让它们能脱离真实轨迹单测 | 只影响检测器 |
| 2026-08-21 | `core/review.ts` `FALLBACK_THRESHOLDS` | extension 侧留一份占位阈值，但 Service 的值优先 | 没有 Service 时模块要能跑（单测）；同时不能让 extension 成为阈值的作者（D-15） | 只影响检测器默认值 |
| 2026-08-21 | `api/review.py` | 端点返回**开放 map** 而不是命名字段 | 加一个检测器就要加一个阈值，闭合 schema 会把它变成跨两种语言的协同改动 | **实验对照**（`/review-config` 的响应形状） |
| 2026-08-21 | `np-agent.md` | `observable:` 元数据写在注入文件里，agent 看得到 | 本仓库没有"不被注入的元数据"这个位置；且在这里 Goodhart 就是执行 | **实验对照** → D-22 |
| 2026-08-21 | commit 划分 | S11 分两个 commit（代码 / `[NP v2]`） | `preference/README.md` 的版本约定与"一个 stage 一个 commit"直接冲突，前者的可回放性一旦破坏无法补救 | 只影响提交历史 → D-23 |
| 2026-08-21 | `rpc-client.mjs` | `RUNNER_VERSION` 1 → 2（S10 遗漏，本次补） | `run.json` 加了 `agentId` / `gold` / `traceDir`，记录格式变了却不升版本，正是 D-09 记下的那个模式 | **实验对照** → D-19 |

## 7. S11 的验收记录

```bash
SCHOLAR_REVIEWER=1 SCHOLAR_REVIEWER_MODEL=vllm/qwen3.6-35b-a3b \
  node experiments/eval-runner/run.mjs --queries runs/eval/s11-accept/queries.json \
  --model vllm/qwen3.6-35b-a3b --out runs/eval/s11-accept --deadline-ms 540000
```

一条查询（`AutoScholarQuery_train_1`），38 次工具调用，304 秒。
`callsByTool = {list_providers:1, search_metadata:19, get_paper:13, update_answer_pool:3, expand_citations:2}`。

### 判据 1 — k9u1 轨迹喂给检测器，R1 / R3 / R6 必须触发 ✅

`tests/detectors.test.ts`。**轨迹本身不在仓库里**（`runs/` 被 gitignore），
fixture 是按 `../reviewer-design.md` §2.1/§2.2 原文记录的计数重建的：
64 次调用、`get_paper` 33、`search_metadata` 28、`expand_citations` 2、
`list_providers` 1，`facet_probe`/`rank_candidates`/`search_fulltext` 为 0，
30 条查询无一条带引号。**这是重建而不是回放**，测试文件里写明了这一点。
三条全部触发，且观察文本里带原始数字（28、33）。

### 判据 2 — 至少一条建议的投递早于最后一次 `search_metadata` ✅

```
journal（触发源 @ 位置 -> 是否投递）
  attach                              reviewer-pc2i attached
  detector R4    atCall=5   atSearch=3   delivered
  detector R1    atCall=10  atSearch=5   delivered
  answer_pool R1+R4  atCall=27 atSearch=15 delivered
  answer_pool R1     atCall=33 atSearch=17 delivered
  answer_pool R1     atCall=37 atSearch=18 delivered

delivered（建议 -> 落点）
  organize_answer            atCall=4   atSearch=2
  refine_query               atCall=10  atSearch=5
  expand_citation            atCall=27  atSearch=15
```

第一条建议在第 2 次检索之后投递，而 episode 一共 19 次检索。
**$A_t$ 里的 $t$ 不再恒等于 $T+1$**，G-1 关闭。

### 判据 3 — gate 的拒绝记录里能看到检测器重复触发被挡下 ⚠️ 实质满足，字面不满足

实测拒绝：`duplicate_action_target` ×1、`unknown_evidence` ×3、`repeated_no_action` ×1。
括号里的性质（**检测器接在 gate 之内，没有绕过**）由此确立，而且
`unknown_evidence` 那三条格外有力：Reviewer 编了三个不在轨迹里的 id，
全被挡下——说明它除了轨迹之外确实什么都没有。

**字面上没满足的是"被 novelty key 挡下"**：这次 Reviewer 重复的那条
`organize_answer` 换了 novelty key 但动作与 target 相同，
于是先撞上 `duplicate_action_target`（gate 的检查顺序是 episode 上限 → novelty key
→ action|target）。`duplicate_novelty_key` 这条路径有单测覆盖
（`review.test.ts:98`），但**这次真实运行里没有走到**。
按 `plan.md` §8 记进 `backlog.md` 的验收缺口 G-7，不改判据。

### 判据 4 — 一个 episode 三次以上 review，Main 收到的建议没有一条重复 ✅

5 次投递（2 次检测器 + 3 次答案池），3 条建议放行并投递，
`3 unique of 3`——没有重复。这一条直接验证了 §5.2d 那个坑被修掉：
若还按 `gate.admitted()` 全量投递，第三次会把前两条再投一遍。

### 判据 5 — 只为 `profile.id === "search"` 配 Reviewer，一个 episode 恰好一个 ✅

`journal` 里 `attach` 恰好一条，`reviewerAgentId` 六轮不变（`reviewer-pc2i`）。
预算探测那个 agent（`search-9oig`）也是 `search` profile，它各自配了一个——
"每个 search agent 一个"是设计要求（§5.2b 第三条），不是重复。

### 判据 6 — 绑定组每条都能指出它对应 $\bar{\tau}_t$ 的哪个字段 ✅

A 组 7 条，逐条对应：`callsByTool.facet_probe`（probe-before-second-round）、
`subqueries` 含引号数（phrase-and-keyword-both）、首轮 `subqueries` 的 Jaccard
（cover-two-readings-first）、`filters.end_date`（carry-the-date-boundary）、
`callsByTool.get_paper` 对 `search_metadata` 与 `rank_candidates`（reread-before-refetch）、
`answerPool` 首次写入时刻（commit-incrementally）、`answerPool.removed[].reason`
（withdraw-with-reason）。七条全部满足 D-12 的判据：关掉它，轨迹会不同。

B 组 30 条各自标了 `observable: none` 与原因，归成三类
（工具入参里没有对应概念 / 约束的是判断而非动作 / 依赖尚不存在的观察量）。

### 判据 7 — lint 能拦下一条含 arXiv id 的条目 ✅

```
$ node scripts/preference-lint.mjs
widis\.widi-scholar\preference\np-agent.md:285: arXiv id 'arXiv:1810.09726' must not appear
    in a preference entry - NP_k is strategy reused across episodes, and a paper identifier
    in it is one question's answer.
preference-lint: 1 file(s) checked, 1 finding(s)   exit=1
```

（临时插入一条再删除；干净状态下 0 finding，exit 0。已挂进 `npm run check`。）

### 判据 8 — TUI 里能切到 Reviewer 对话，且上下文里没有 Main 的私有推理 ⚠️ 一半

**隔离那一半有机械证据**：Reviewer 的输入完全由 `renderTraceForReviewer(trace)`
构造，而 `PublicSearchTrace` 是白名单过滤的产物；`review.test.ts` 有一条测试
往 trace 上塞一个额外字段并断言它渲染不出来。运行侧最有力的证据是那三条
`unknown_evidence`——Reviewer 引了三个不在轨迹里的 id，说明它手上除了轨迹之外
没有别的东西。

**TUI 交互那一半没验**：本次推进全程走 RPC，无法驱动全屏 TUI，
也就无法执行 S8 那种"切过去、逐片段 grep、leaks = 0"的过程。
记进 `backlog.md` 的 G-8。

### 一条必须写下来的观察：sidecar 有作用面，而这次它把方向推错了

召回仍是 **0/4**（k=20，池中 11 篇）。判据本身不检验这个——
`plan.md` §4.2 写明"判据 2 只验'有机会被读到'，不验'读了之后变好了'"。
但**行为确实变了**，而且变化方向值得记：

| | S10 那次（无 Reviewer） | S11 这次（有 Reviewer） |
| --- | --- | --- |
| `update_answer_pool` | 1 次批量写 14 篇 | **3 次增量写**，共 11 篇 |
| `expand_citations` | 0 次 | **2 次** |
| 召回 | 0/4 | 0/4 |

前两行是 R4 与 `organize_answer` 的直接后果——三次会话里从未被调用过的
引文扩展，这次被建议之后调用了。

而第二条建议是：

> Drop "region proposal" and "image patches" from the subqueries. …
> Restrict searches to superpixel aggregation, boundary-aware segmentation …

**这条建议把检索推得更深地进入了那个错误的方向。** 原问句里的
"image patches" 是提问者自己的用词，而 Reviewer 判断它是噪声。
Reviewer 看不到 gold，这个判断在它掌握的信息下是合理的；
但它说明了一件对 M 轴很重要的事：**一个只看轨迹的观察者会强化候选集里已有的主题分布**，
因为"这批结果不够聚焦"和"这批结果聚焦错了"在轨迹上长得一样。
这不是本 stage 的验收对象，但它是 $\Delta_{\mathrm{sidecar}}$ 可能为负的一条具体机制，
应当进 `../experiments.md` 的 M 轴假设。**已记进 `../experiments.md` §4.2.1**，
连带一个能测它的观察量（建议前后子查询词项集合的收缩率）。

## 8. S12 的决策与验收记录

### 决策

| 日期 | 在哪 | 选了什么 | 理由 | 影响面 |
| --- | --- | --- | --- | --- |
| 2026-08-21 | `preference/np-judge.md` + `config.yaml` `judge.carrier` | $NP^{judge}$ 的载体放 `preference/`，config 里只放指针 | 把准则塞进 `config.yaml` 会抹掉 `Configure` 这条边——那时 $NP^{judge}$ 与 $HP$ 就是同一个东西 | **实验对照** → D-24 |
| 2026-08-21 | `judge/criteria.py` | `criteria_version` 由（派生 prompt 版本 + 归一化查询 + 载体全文 + 配置指纹）内容哈希派生，不手写 | 手写的版本号是会被忘记 bump 的版本号；内容寻址让"改准则等于换口径"自动成立，也让缓存不可能过期 | **实验对照** → D-24 |
| 2026-08-21 | `config.yaml` `judge.forced_level` | 配置可以覆盖调用方的 `judge_level` | 参数留在签名里（agent 的策略）与消融要按住它（受控变量）方向相反，覆盖是唯一同时满足两者的形状；`requested_level` 与 `level` 都报，所以覆盖可观测 | **实验对照** → D-25 |
| 2026-08-21 | `judge/service.py` `config_fingerprint` | `forced_level` **不进**指纹 | 钉住档位决定"这篇有没有被判"，不是"怎么判"；进指纹会让 J0 与 J2 的 `criteria_version` 不同，比较就没意义了 | **实验对照** → D-25 |
| 2026-08-21 | `api/search.py` | 判别时召回放宽到 `max(top_k, max_papers_l3b)`，判完再截断到 `top_k` | `prototype.md` §6 要求"先判全部再取 top-k"；只判 top-k 会让判别器退化成对召回顺序的重排而不是对候选集的筛选 | **实验对照**（同一 `top_k` 下实际召回的条数变了） |
| 2026-08-21 | `api/search.py` `_apply_judgements` | 判不了的论文保持判前顺序、排在已判的之后，不按 0 分处理 | §6 的"judge 失败不惩罚被评方"。按 0 分处理会让一次解析失败等价于一次"完全不相关"的判决 | 只影响判别后的排序 |
| 2026-08-21 | `judge/strategy.py` | 任一准则缺项或标签不认识 → **跳过该篇**并计入 `failures`，不补默认档 | §4.2 第二条约束。补默认档等于替模型做了一个它没做的判决，而合成分会把缺项当 0 分 | 只影响判别失败路径 |
| 2026-08-21 | `experiments/judge-ablation/` | J 轴消融直接打 Service，不跑 agent；查询可由夹具 `searchQuery` 覆盖 | 经 agent 的两次 episode 不会发出同样的查询，判别器的效应会和 agent 的方差绑在一起 | **实验对照** → D-26 |
| 2026-08-21 | 消融的默认 `--k` | 10（而召回上限跟着 `max_papers_l3b` = 30） | 若 $k \ge$ 候选集大小，两组的 top-$k$ 是同一个集合，Recall@k 必然相同——第一次跑 `--k 20`/候选 20 就撞在这上面，那个 0 差异是设计错误不是结论 | **实验对照** → D-27 |

### 判据 1 — 给定一条准则与一篇论文，返回 §4.2 的 JSON 结构，三个版本可追溯 ✅

`POST /judge/relevance`，live vllm，`carrier_version: 1`：

```
paper_id        arxiv:1810.09726
criteria        semantic_segmentation_task  Highly Relevant   "semantic image segmentation"
                superpixel_unit             Somewhat Relevant "selected via superpixels"
                region_based_strategy       Somewhat Relevant "region-based active learning approach"
                superpixel_integration      Highly Relevant   "selected via superpixels"
score / tier    0.4444 / somewhat_relevant
rubric_version  r3
criteria_version cq_24947a5647b2915f
model_version   vllm/qwen3.6-35b-a3b
```

四条准则的权重由模型给出后归一化（0.111 / 0.333 / 0.333 / 0.222），
snippet 全部逐字来自证据文本。

### 判据 2 — `judge_level=l3b` 时 `judgeSupported: true`，判别篇数进 `SearchState` ⚠️ 部分

`SearchState.judge` 在真实运行里带全套账目：

```
level l3b | requested_level l3b | supported true | considered 30 | judged 30
rubric_version r3 | criteria_version cq_9071ec2a8e87a1df | model_version vllm/qwen3.6-35b-a3b
```

extension 侧 `judgeSupported` 现在读的是这个账目而不是常量，
`index.ts:827` 那个写死的 `false` 已经不存在了。

**没验的是"出现在 $\bar{\tau}_t$ 里"这一跳经过一次真实 agent episode**：
链路的三段（`SearchState.judge` → 工具 `details` → `PublicSearchTrace.judge`）
各有单测，拼起来没跑过。原因是算力：一个 episode 19 次检索 × 30 篇 × 一次 LLM 往返
（实测 15–18 秒）≈ 2.5 小时。记成 G-9，并写明补它的便宜办法。

### 判据 3 — 改一条 `np-judge.md` 的条目能改变判别输出 ✅

同一篇论文、同一条查询，只在载体里加一条
`[exactly-two-criteria] 只派生两条准则：任务，以及方法的核心机制`：

```
                  改之前                       改之后
criteria_version  cq_24947a5647b2915f          cq_6869a0b410657c68
criteria          4 条（semantic_segmentation_  2 条（task, core_mechanism）
                  task / superpixel_unit /
                  region_based_strategy /
                  superpixel_integration）
score             0.4444                       0.4000
tier              somewhat_relevant            somewhat_relevant
```

**载体有作用面，不只是文件存在。** 版本随内容改变，所以改前改后的结果
按构造就是不可比的——不需要谁记得声明这件事。

### 判据 4 — J0 与 J2 在同一批查询上的 Recall@k 都被记录下来 ✅

`experiments/judge-ablation`，`--k 10`，`sources: ["arxiv"]`，
`end_date: 2023-09-17`，候选 30 条（`max_papers_l3b`），gold 4 篇：

```
AutoScholarQuery_train_1          J0 recall 0.75   J2 recall 0.75   judged 30
AutoScholarQuery_train_1_phrases  J0 recall 0.25   J2 recall 0.25   judged 2

J0: Recall@10 0.5000 | Precision@10 0.4000 | F1 0.3810 | median 1163ms
J2: Recall@10 0.5000 | Precision@10 0.4000 | F1 0.3810 | median 543765ms
```

§5.6 那条硬要求（必须报 judge-free 消融）**满足**：两组一起报，
而且脚本的输出末尾把"为什么必须一起报"打出来，不指望读者记得。

### 判据不检验、但这次测出来的一件事：Recall@k 看不见判别器做了什么

两组的 Recall@10 完全相同，**而判别器实际上大幅重排了**：

```
J0  2112.05975 > 2111.12940 > 2107.11769 > 2203.10730 > 1810.09726 > 2010.01884 > ...
J2  2111.12940 > 2010.01884 > 2002.06583 > 2307.07168 > 2112.05975 > 2203.10730 > 1810.09726 > ...
```

三篇 gold 被明显往上提（`2010.01884` 从 #6 到 #2，`2002.06583` 从 #9 到 #3），
top-10 的顺序和集合都变了。但三篇本来就在前 10 之内，
所以 **Recall@10 不可能反映这次重排**。

这不是判别器无效的证据，也不是有效的证据——**是指标选错了的证据**。
`../prototype.md` §6.3 已经有下界校正 nDCG，J 轴要报的应当是它或 MRR，
而不是只报 Recall@k。这条与 §5.6 那条硬要求是一对：
前者说"不能只报 J2"，这条说"不能只报 Recall"。
**记进 `../experiments.md` 之前不下任何关于 J2 的结论。**

另外两个数字值得留：J2 的中位耗时是 J0 的 **467 倍**（543765ms vs 1163ms），
判 30 篇一条查询将近 9 分钟。官方权重里运行效率占 20%，
所以 L3b 在当前形态下**不是一个可以默认开着的档位**——
这正是 §4.1 写"预算充裕走 L3a + L3b"的原因，而 L3a 还不存在（G-10）。

## 9. 2026-08-22 的双模型对照会话（不是一个 stage）

四段路线走完之后的第一次全系统实跑，**没有改任何代码**，所以不进 §1 的进度表。
两次会话同一条查询、同一 `search` profile，模型分别是
`vllm/qwen3.6-35b-a3b` 与 `kimi-coding/k3`，各带一个 sidecar Reviewer。
用户在两轮之后各贴出 13 篇标准答案逐条核对。

**产出全部记在 `backlog.md`**，这里只留索引与那个必须先看的数字：

| 产出 | 在哪 |
| --- | --- |
| 两轮的完整数字（F1 0.273 / 0.195，成本、token、工具调用） | `backlog.md` §1.5 |
| 七条新缺陷 F-14..F-20 | `backlog.md` 同名条目 |
| 五条行为观察 B-6..B-10 | `backlog.md` "会话中的 Agent 行为观察" |
| G-6 关闭、G-7 与 G-9 改写 | `backlog.md` 对应条目的 "2026-08-22 更新" |
| 修改顺序（F-14 / F-17 排最前） | `backlog.md` "修改顺序"第三张表 |

**先看的数字**：run2 的工具调用是 run1 的 2.6 倍、时长 4.5 倍、答案池 3 倍大，
**F1 从 0.273 掉到 0.195**。§1 那个 0/4 → 4/4 说明召回层修对了；
这一次说明**瓶颈已经移到策略层与证据层**，而且"搜得更多"在当前实现下
是负收益。四段路线的下一步该从这里选，不是从"再修一个召回 bug"选。

**一条纪律层面的教训**：F-14..F-20 全部**只在 agent 路径上发作**，
批量评测（绕过 agent 直接调 Service）一条都碰不到。S10–S12 三段的验收
与 J 轴消融走的都是后者，所以它们全绿而这七条一直在。
`plan.md` §8 说判据是必要条件不是充分条件——这次给出了具体的形状：
**判据验的是链路通不通，而缺陷藏在"agent 实际看到什么"里**。
