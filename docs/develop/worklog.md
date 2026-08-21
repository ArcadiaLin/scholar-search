# 实施日志

> 读者：正在推进 `plan.md` 那四段的人，以及事后想知道"这个选择是谁在什么时候做的"的人
> 规矩：`plan.md` 写明了的照做**不记**；计划没写而实施中定下来的，一行一条。
> 影响面标成 **实验对照** 的，最后要升成 `decisions.md` 的 `D-nn`。

## 1. 进度表

| 项 | 状态 | commit |
| --- | --- | --- |
| F-1 arXiv 查询退化成 OR | DONE | `f8c0f5b` |
| F-2 全部 provider 失败时丢弃原因 | DONE | `f8c0f5b` |
| F-10 `expand_citations` 不接受其他工具的 id | DONE | `f8c0f5b` |
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

## 3. 撞见但没修的问题

按纪律记在这里，**修不修由 `plan.md` 的顺序决定**。

| 日期 | 是什么 | 证据 | 为什么现在不修 |
| --- | --- | --- | --- |
| 2026-08-21 | **AND 连接对整句自然语言查询过严。** `build_search_query` 会把一句 15 词的提问变成 15 个 AND 词项，命中率大概率为零 | `AutoScholarQuery_train_1` 的原问句共 17 词 | `plan.md` §2 与 `backlog.md` F-1 指定的修法就是 AND；缓解手段（停用词表、词项数上限、自动降级成 OR）都是新的检索设计，不在计划里。已经用工具描述把 agent 引向词项式查询，实测 4/4 成立。**若 S10 的 Recall@k 暴露出这条，它是一个新的 F 条目，不是 F-1 的一部分** |
| 2026-08-21 | **本仓库的 Python 在当前 ruff 下不是 format-clean。** `uv run ruff format --check .` 报 18 个文件要重排，其中 `plugins/serper.py` / `plugin_loader.py` / `tests/test_serper_plugin.py` 等**本次未改动** | 基线即红；差异全是 `hug_parens_with_braces_and_square_brackets` 这一条（`f({...})` vs `f(\n{...}\n)`） | `ruff>=0.12,<1` 是浮动区间，仓库是用另一个 ruff 版本排的。全仓重排会盖住修复本身的 diff；新写的代码沿用了仓库现有风格。`uv run ruff check .`（lint）全绿 |
| 2026-08-21 | **`npm run check:widis` 的 biome 半在本检出上必红。** 本地 `core.autocrlf=true`，工作区文件是 CRLF，biome 的 formatter 期望 LF，于是**每个文件**都报 format 差异（含 `themes/*.json` 这类未改动文件） | `git config core.autocrlf` → `true`；`xxd widis/.widi-scholar/themes/prism.json` 里是 `0d0a` | 这是检出配置，不是仓库内容；改仓库去迁就它是错的方向。已用 `biome lint --error-on-warnings`（对行尾不敏感）+ `tsgo --noEmit` 覆盖，两者全绿 |
| 2026-08-21 | **`pytest` 在设了 `all_proxy=socks5://...` 的 shell 里 39 个用例失败。** httpx 读环境代理，缺 `socksio` 就抛 ImportError | `ImportError: Using SOCKS proxy, but the 'socksio' package is not installed` | 是本机 shell 环境，不是仓库缺陷。跑法：`all_proxy= uv run pytest -q` |
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
