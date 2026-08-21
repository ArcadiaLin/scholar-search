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
| S10 答案池与召回评测回路 | TODO | |
| S11 Reviewer v0 与 $NP_0$ 重写 | TODO | |
| S12 $NP^{judge}$ 载体与 L3b 判别层 | TODO | |

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
| 2026-08-21 | `experiments/eval-runner/run.mjs` | 每条结果记 `agentId` 与 `gold`；`SCHOLAR_TRACE_DIR` 默认指到 `<out>/trajectories` | 打分器只有靠 `agentId` 才能找到 `<agentId>.answer.json`；默认分目录则两次 run 的答案不会互相顶掉 | **实验对照**（`run.json` 的记录格式变了，`RUNNER_VERSION` 未升——见下方缺口一节） |
| 2026-08-21 | `experiments/eval-runner/score.mjs` | `--k` 按 agent 写入池子的**顺序**截断 | 池子是 agent 自己建的列表，换任何别的顺序打的都是一个没人产出过的排名 | **实验对照**（k 的语义） |
| 2026-08-21 | `experiments/eval-runner/score.mjs` | `poolStatus` 区分 `empty` 与 `never-written` | 同样是 0 分，但"没调过这个工具"和"调了没提交"是两种不同的诊断，B-4 说的正是前者 | 只影响打分输出 |
| 2026-08-21 | `package.json` | 新增 `test:experiments` 并挂进 `npm test` | eval-runner 的转换与打分是有行为契约的代码，之前完全没有测试入口 | 只影响测试入口 |
| 2026-08-21 | `index.ts` `EXTENSION_VERSION` | 1 → 2 | 注册工具集与 `search_metadata` 的 `query` 契约都变了，跨这条线的运行不可比 | **实验对照** |

## 3. 撞见但没修的问题

按纪律记在这里，**修不修由 `plan.md` 的顺序决定**。

| 日期 | 是什么 | 证据 | 为什么现在不修 |
| --- | --- | --- | --- |
| 2026-08-21 | **AND 连接对整句自然语言查询过严。** `build_search_query` 会把一句 15 词的提问变成 15 个 AND 词项，命中率大概率为零 | `AutoScholarQuery_train_1` 的原问句共 17 词 | `plan.md` §2 与 `backlog.md` F-1 指定的修法就是 AND；缓解手段（停用词表、词项数上限、自动降级成 OR）都是新的检索设计，不在计划里。已经用工具描述把 agent 引向词项式查询，实测 4/4 成立。**若 S10 的 Recall@k 暴露出这条，它是一个新的 F 条目，不是 F-1 的一部分** |
| 2026-08-21 | **本仓库的 Python 在当前 ruff 下不是 format-clean。** `uv run ruff format --check .` 报 18 个文件要重排，其中 `plugins/serper.py` / `plugin_loader.py` / `tests/test_serper_plugin.py` 等**本次未改动** | 基线即红；差异全是 `hug_parens_with_braces_and_square_brackets` 这一条（`f({...})` vs `f(\n{...}\n)`） | `ruff>=0.12,<1` 是浮动区间，仓库是用另一个 ruff 版本排的。全仓重排会盖住修复本身的 diff；新写的代码沿用了仓库现有风格。`uv run ruff check .`（lint）全绿 |
| 2026-08-21 | **`npm run check:widis` 的 biome 半在本检出上必红。** 本地 `core.autocrlf=true`，工作区文件是 CRLF，biome 的 formatter 期望 LF，于是**每个文件**都报 format 差异（含 `themes/*.json` 这类未改动文件） | `git config core.autocrlf` → `true`；`xxd widis/.widi-scholar/themes/prism.json` 里是 `0d0a` | 这是检出配置，不是仓库内容；改仓库去迁就它是错的方向。已用 `biome lint --error-on-warnings`（对行尾不敏感）+ `tsgo --noEmit` 覆盖，两者全绿 |
| 2026-08-21 | **`pytest` 在设了 `all_proxy=socks5://...` 的 shell 里 39 个用例失败。** httpx 读环境代理，缺 `socksio` 就抛 ImportError | `ImportError: Using SOCKS proxy, but the 'socksio' package is not installed` | 是本机 shell 环境，不是仓库缺陷。跑法：`all_proxy= uv run pytest -q` |
| 2026-08-21 | **端口 8000 上有一个前一天（08-20 11:16）留下的 Search Service 进程。** 它只有 S2 时期的路由（`/`、`/health`、`/providers`、`/search`、`/search/metadata`、`/provider/{name}/query`），`GET /budget` 返回 404 | 第一次 S10 验收跑出来 `get_budget` 两次失败："Not Found Call list_providers ..."；新起的 uvicorn 因端口占用退出（日志里 `Errno 10048`） | 已 kill 并重起（否则任何测量都建立在旧代码上）。**值得单独记一笔的不是这个进程，是失败的样子**：一个陈旧服务不会说自己陈旧，它会以 404 的形式表现，而 404 的兜底文案把 agent 引向 `list_providers`。`run-scholar.mjs` 复用已在跑的 Service（先探 `/health`）这条设计放大了它——`/health` 在旧服务上照样 200。**建议 `/health` 报出 service 版本与路由集，让复用前能对齐**，记成一条未修问题 |
| 2026-08-21 | **`tests/fixtures/README.md` 里 `search-metadata.json` 的录制命令与实际 fixture 不一致**（缺 abstract/authors/venue/published/urls），照它重录会得到一个更薄的 fixture | 按原命令重录后 45 行内容消失，而三个测试依赖那些字段 | 已顺手修正（重录 fixture 时必须先修它，否则 D-05"fixture 只录不手写"这条守不住），记在这里是因为它说明**录制命令本身也需要被验证** |

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
