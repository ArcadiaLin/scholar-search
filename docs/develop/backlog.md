# 待办：已知缺陷与验收缺口

> 读者：想知道"现在什么是坏的"、以及"哪些实验结论暂时不能下"的人
> 顺序与 stage 定义在 `plan.md`；本文只说问题本身
> 前置：`../search-service.md`（Service 契约）

本文收两类问题，它们的**性质不同**，所以分两节：

| | 是什么 | 编号 | 位置 |
| --- | --- | --- | --- |
| **检索缺陷** | 已落地的部分**本身有缺陷** | `F-1`..`F-13` | 前半篇 |
| **验收缺口** | stage 验收通过，但**设计要求尚未满足** | `G-1`..`G-10` | 后半篇 |

编号避开已被占用的 `D-`（决策，见 `decisions.md`）、`U-`（上游缺陷）、
`SV-`（Service 缺陷）、`E-`（环境）——后三类在 `history.md`。

每条的格式统一：现象 → 证据 → 根因 → 后果 → 补上它需要什么。

**证据来源**：`widis/.widi-scholar/runs/--root-projs-scholar-search--/`
下的三次真实会话（2026-08-21，`npm run widi:scholar`），
其中 F-1..F-7 出自首次会话 `20260821T072357Z_search-d9w6`。
`runs/` 在 `.gitignore` 里，那些记录不会进版本库，所以**本文把关键证据原样内嵌**，
不依赖那些文件还在。

---

## 0. 为什么这次会话值得单独立档

它凑巧是一次**有对照答案的评测**。用户在 TUI 里问的那句话，逐字就是
`references/datasets/pasa/AutoScholarQuery/train.jsonl` 第 2 行：

```json
{
  "qid": "AutoScholarQuery_train_1",
  "question": "Could you provide me some works employs image patches and superpixels in region-based methods for semantic segmentation?",
  "answer_arxiv_id": ["1810.09726", "2002.06583", "2010.01884", "1911.11789"],
  "source_meta": { "published_time": "20230917" }
}
```

**四篇标准答案全部在 arXiv 上、全部有 arXiv ID。** 这一点把归因问题彻底关死了：
凡是没找到的，都不可能用"覆盖不到"解释。

实际结果是 **1/4**——只命中 CEREALS（`1810.09726`），而且是靠"CEREALS"这个
罕见词撞上的，不是靠主题检索。

下面 §1 会说明，这 1/4 的主因既不是 OpenAlex 限流，也不是 agent 的理解偏差，
而是一处查询拼接错误；改掉之后同一条查询能到 **4/4**。

---

## 1. 基线测量：0/4 → 4/4

先把结论放在最前面，因为它决定了后面所有条目的优先级排序。

**当前实现**（`all:{query}`，见 F-1），一条主题查询，取前 20：

```
search_query=all:region-based active learning semantic segmentation superpixel image patches
→ 命中 0/4
   前 5 名：Generating Superpixels for High-resolution Images / AINet+ /
            Robust Image Segmentation in Low Depth Of Field Images（2013）/
            Medical Image Segmentation based on Deep Active Contour / Adaptive Superpixel for AL
```

**只把词间连接改成 AND**，同一条查询，同样取前 20：

```
search_query=all:region AND all:active AND all:learning AND all:semantic AND all:segmentation
→ 命中 3/4   （CEREALS #7、MetaBox+ #8、Reinforced AL #14）
```

**再加一条从原问题直接分解出来的子查询**（用户问句里就有 "superpixels"）：

```
search_query=all:"active learning" AND all:"semantic segmentation" AND all:superpixel
→ 4 条结果，ViewAL 在 #2   （补齐第 4 篇 1911.11789）
```

**两条 AND 查询，合计 4/4。** 没有用 OpenAlex，没有重排，没有 LLM 判别器，
没有引文扩展。

这个数字应该被反复引用：**在补上 F-1 之前，任何关于排序栈（B 轴）、
判别器分层（J 轴）、在线拓扑（M 轴）的对比实验都是在噪声上做的**——
L0 召回层本身在漏掉正确答案，上面几层再怎么调都是在给一个错误的候选集排序。

---

## 2. 检索缺陷一览

条目按发现顺序编号，不按严重程度。下表用于翻找；每条的正文在后面。

| # | 一句话 | 状态 | 阻塞什么 |
| --- | --- | --- | --- |
| **F-1** | arXiv 查询退化成 OR，召回层从根上失效 | **已修** | **一切**。S10 的前置 |
| **F-2** | 全部 provider 失败时，失败原因被丢弃 | **已修** | S10 的前置；R5 检测器 |
| F-3 | OpenAlex 改信用计费，`rate_limit_rps` 对它无效 | 部分修（见 F-8） | 预算维度 |
| F-4 | `call_ledger` 只数次数，不算成本、不对配额 | 未修 | "预算接近上限" checkpoint；R7 检测器 |
| F-5 | `end_date` 从未被使用，而评测协议依赖它 | 未修 | 评测的时间窗正确性 |
| F-6 | 单源单查询时整个排序栈是恒等变换 | 未修 | 是 G-3 / G-5 的量化后果 |
| F-7 | 四条较小但确凿的问题（a–d） | 未修 | — |
| F-8 | `.env` 按进程 cwd 解析，凭据从未被读到 | **已修** | — |
| F-9 | LLM provider 的凭据走 `os.environ`，同样读不到 `.env` | 未修（潜伏） | 换 provider 时会咬人 |
| **F-10** | `expand_citations` 不接受其他工具产出的 id | **已修** | **S11 的 R4 检测器**；E 轴 |
| F-11 | OpenAlex 的 ML 预印本引文图稀疏，backward 扩展不可用 | **不可修**（数据现实） | E 轴的默认方向 |
| **F-12** | 查询里的 `?` 让 OpenAlex 直接 400 | 未修 | 任何绕过 agent 的批量评测 |
| **F-13** | AND 连接对整句自然语言查询过严（实测 0 条） | 未修 | 同上；J 轴消融已改用夹具查询 |

F-1 / F-2 / F-10 是 S10 的前置修复，已修，见 `plan.md` §2 与 `worklog.md` §4。
F-12 / F-13 是 S12 期间实测到的两条新缺陷：它们只在**绕过 agent** 的路径上发作
（agent 送的是词项式查询），但那条路径正是批量评测走的，所以它们阻塞的是评测而不是产品。

---

## F-1 — arXiv 查询退化成 OR，召回层从根上失效（已修）

**修复**（2026-08-21）：`plugins/arxiv.py` 的 `build_search_query()` 按 AND 连接词项，
短语保留、字段前缀与裸布尔算子透出；`SearchState.issued_queries[].native_query`
记录实际发出的串；回归断言在 `tests/test_arxiv_query.py`，其中对 arXiv 回显
`<title>` 不含 ` OR ` 的那条标 `network`（默认不跑，`pytest -m network` 跑）。
0/4 → 4/4 的复跑记录在 `worklog.md` §4。原文保留在下。

**现象**：会话中每一次 arXiv 检索返回的都是"含有若干常见词"的杂烩。
最刺眼的一次是精确标题检索：

```
query: "Reinforced Active Learning for Image Segmentation arxiv"
→ #1  Robust Image Segmentation in Low Depth Of Field Images（2013）
→ #2  Medical Image Segmentation based on Deep Active Contour
→ 目标论文（arXiv:2002.06583）不在前 10
```

**证据**：arXiv 的 Atom 响应会把**解析后**的查询回显在 `<title>` 里，
所以这件事不需要猜：

```
请求  search_query=all:reinforced active learning image segmentation
回显  all:reinforced OR all:active OR all:learning OR all:image OR all:segmentation
```

**根因**：`src/search-service/src/search_service/plugins/arxiv.py:205`

```python
params = { "search_query": f"all:{query}", ... }
```

多词查询被原样塞进 `all:` 后面，arXiv 的查询解析器按 **OR** 展开。
于是每一次检索实际上都是"任意一个词命中即可"的词袋查询。词越常见，
结果越差；`semantic`、`segmentation`、`image`、`learning` 恰好全是高频词。

MetaBox+ 和 ViewAL 在会话末尾能被标题查询命中，是因为标题里有 `MetaBox` /
`ViewAL` / `Viewpoint` / `Entropy` 这些低频词把它们顶上来了——**这是运气，
不是检索**。

**后果**：

- L0 召回层对任何"全部由常见词构成"的主题查询都失效，见 §1 的 0/4；
- 由于失效是静默的（返回 20 条看起来正常的论文），agent 无法察觉，
  它的诊断-迭代循环拿到的是有毒的反馈信号；
- 排序栈的所有消融（B 轴）建立在一个系统性缺失正确答案的候选集上。

**补上它需要**：

1. 把词间连接改成 AND；短语（引号内）作为可选项而非默认——
   实测纯短语查询 `all:"reinforced active learning image segmentation"` 返回 0 条，
   太严，不能作为默认路径；
2. 把**实际发出的 arXiv 查询串**写进 `SearchState.issued_queries`。
   现在记的是调用方传入的原始 query，正是这一点让这个 bug 藏了这么久——
   $\bar{\tau}_t$ 里看到的查询和真正发出去的查询不是同一个东西，
   这本身也违反了 trace 的可信性要求；
3. 加一个针对该解析行为的回归测试。arXiv 的回显机制让断言很容易写：
   直接断言响应 `<title>` 里不出现 ` OR `。

---

## F-2 — 全部 provider 失败时，失败原因被丢弃（已修）

**修复**（2026-08-21）：`AggregationError` 带上 `failures` 与 `alternative_sources`
（服务端算出来的"还没试过且具备该能力的源"），`POST /search` 的 502 体原样透出这两项；
extension 侧 `describeUpstreamFailure()` 取代那句无条件文案，全部失败都是限流时
另加一句"重试同一个调用不可能成功"。第 2 点（`Retry-After` 上传）属于 F-3，未做。
原文保留在下。

**现象**：同一类失败，agent 看到的信息量完全不同。

部分成功时（arXiv 活着、OpenAlex 挂了）：

```
failures (5):
  - openalex [rate_limit] query 'region-based semantic segmentation ...': OpenAlex rate limit exceeded
  - openalex [rate_limit] query 'superpixel-based semantic segmentation': OpenAlex rate limit exceeded
  ...
```

全部失败时（`sources: ["openalex"]`）：

```
The provider failed behind the service: All providers failed. Another source may still be able to answer.
```

**根因**：`src/search-service/src/search_service/aggregator.py:234`

```python
if not items_by_list:
    raise AggregationError("All providers failed.")
```

此时局部变量 `failures` **已经装满了带错误分类的 `Failure` 对象**，
紧接着连同整个函数栈一起被丢弃。只有走到下面构造 `SearchState` 的路径，
`failures` 才会被带给调用方——而那条路径要求至少一个 provider 成功。

**方向正好反了**：全部失败恰恰是调用方最需要知道原因的时刻。

附带问题：`widis/.widi-scholar/extensions/scholar-search/index.ts:178` 拼上的
"Another source may still be able to answer." 是**无条件模板文案**。
会话发生时并没有第二个可用源（Serper 停用、arXiv 不支持引文），
这句话把 agent 推向了错误的下一步。

**后果**：agent 在 07:37–07:40 之间盲目重试了十几次，无法区分
"限流（等一天才有用）"、"查询没结果（该换词）"、"源坏了（该换源）"这三种情况。
$\bar{\tau}_t$ 中记录的失败也因此丢失了分类信息，Reviewer 即使开着也看不到
"来源失衡"——而这是 `../design.md` §5.2 第三个 checkpoint 的触发条件之一。

**补上它需要**：

1. 让 `AggregationError` 携带 `failures` 列表，工具层原样透出错误分类；
2. 把 `Retry-After` 与"这不是重试能解决的"这一判断一并上传（见 F-3）；
3. 那句兜底文案改成有条件的：只有确实存在**另一个已启用且具备该能力**的
   provider 时才说。

---

## F-3 — OpenAlex 已改为信用计费，`rate_limit_rps` 对它完全无效

**现象**：会话里 OpenAlex 的**第一次**调用就返回 rate_limit，而 `/budget` 报告
"Spent so far: nothing recorded"。5 条子查询 5 条全挂，耗时 13797ms。

**证据**（2026-08-21 直连实测的响应头与响应体）：

```
HTTP/2 429
retry-after: 57539                      ← 约 16 小时
x-ratelimit-limit: 1000                 ← 每天 1000 信用
x-ratelimit-limit-usd: 0.1              ← 折合 $0.10/天
x-ratelimit-remaining: 0
x-ratelimit-credits-required: 10        ← 一次 list 查询要 10 信用
x-ratelimit-prepaid-remaining-usd: 0
```

```json
{ "error": "Rate limit exceeded",
  "message": "Insufficient budget. This request costs $0.001 but you only have $0 remaining. Resets at midnight UTC. Need more? Add funds at https://openalex.org/pricing",
  "retryAfter": 57505, "costUsd": 0.001, "creditsRequired": 10, "creditsRemaining": 0 }
```

**根因**：OpenAlex 2026 起改成信用 / USD 预算制，限的**不是速率**：

| 调用类型 | 信用 | 匿名（按 IP）每天可用次数 |
| --- | --- | --- |
| list 查询 `/works?search=` 或 `?filter=` | 10 | **100** |
| singleton `/works/W123` | 1 | ~1000 |
| PDF 内容 | 100 | — |
| 向量检索 / aboutness | 1000 | — |

匿名池每天 1000 信用（$0.10），UTC 午夜重置。一次带 5 条 subqueries 的
`search_metadata` = 5 次 list 查询 = 50 信用，**单次调用吃掉全天配额的 5%**。

一个反向证据可以确认这个模型：会话中 `get_paper` 全程正常。因为 singleton
查询在预算归零时**仍然返回 200**（实测 `x-ratelimit-cost-usd: 0`），
而 list 查询同一时刻返回 429。

`config.yaml` 里的 `rate_limit_rps: 10.0` 和 `plugins/openalex.py` 的
`_rate_limit()` 令牌桶对这个 429 **一点作用都没有**——调慢速率不会让配额变多。

**顺带的两个次生缺陷**：

- `plugins/openalex.py:211` 处理 429 时用 `wait = min(2**attempt, 60)` 退避，
  **完全忽略 `Retry-After`**。对一个"16 小时后才恢复"的 429 重试 3 次，
  纯浪费约 7 秒（这就是首次调用 13797ms 的来源）；
- `mailto` 目前是空的（`OPENALEX_MAILTO` 未设）。**但要说清楚：`mailto` 不增加预算**，
  它只决定是否进 polite pool、影响响应稳定性。别指望它解限流。

**关于代理**：实测三种路径

```
直连 + 匿名     → 429（0.35s，秒拒）
代理 + 匿名     → 200（6.0s）
代理 + mailto   → 200（4.3s）
```

代理能通只是因为出口 IP 的配额还没用完——**这是在蹭别人的额度，不是解决方案**，
而且慢得不能用：`per_page=100` 走代理单次 >25s（httpx 超时是 30s），
8 并发时超过 2 分钟无响应。配好 key 之后 **OpenAlex 应当走直连**。

**补上它需要**：

1. ~~注册免费账号拿 API key~~ —— **key 早就有了，是配置路径断了，见 F-8（已修）。**
   修好之后实测：`x-ratelimit-limit: 10000` / `limit-usd: 1`，
   即 **每天 1000 次 list 查询**，且直连可用，无需代理。这一步已经完成；
2. 设 `OPENALEX_MAILTO` 进 polite pool（目前仍为空），并确保 OpenAlex 的出站
   不走代理——F-8 修复后直连已经能通，代理只会拖慢它；
3. 预算不够时再在 pricing 页按 **$1 增量**买预付额度（免费额度用完后才扣，
   购买后 3 个月过期）。以 $1/天 ≈ 1000 次 list 查询估算，
   跑几百条 AutoScholarQuery 的全量评测才可能需要；
4. 代码侧（**未做**）：429 时读 `Retry-After`，超过阈值就**不重试**并把
   "今天不可用"这个事实上报给调用方（配合 F-2、F-4）。

年度 Member+（$100/天预算）对本项目的规模是浪费。

---

## F-8 — `.env` 按进程 cwd 解析，凭据从未被读到（已修）

**现象**：`.env` 里 `OPENALEX_API_KEY` 一直有值，但每一次 OpenAlex 调用都是匿名的。
F-3 中"第一次调用就 429"的直接原因就是这个——撞的是 $0.10/天 的匿名 IP 池，
而不是 key 自己的 $1/天。

**证据**：

```
从 src/search-service 启动（run-scholar.mjs 的实际 cwd）→ openalex_api_key 长度=0  空
从仓库根启动（.env 所在处）                              → openalex_api_key 长度=22 有值
```

**根因**：`config.py` 的 `env_file=".env"` 是**相对路径**，pydantic-settings
按进程工作目录解析。而 `scripts/run-scholar.mjs:63` 起 uvicorn 时用
`cwd: src/search-service`——**这是对的且不能改**，因为
`config_file: "./config.yaml"` 正靠它解析。仓库的 `.env` 在根目录，
两者永远对不上。`SERPER_API_KEY` 同理（Serper 当前停用，所以没暴露出来）。

注入链路本身没问题：`config.py:116-117` 确实把 `api_key` / `mailto`
塞进了 plugin config。断的只有这一处路径。

**为什么藏了这么久**：失败是完全静默的。`api_key` 取不到就退化成 `None`，
匿名调用在配额未耗尽时**照常返回 200**，只有配额耗尽后才以 429 的形式浮现——
而 429 又长得像"速率太快"，把排查引向了 `rate_limit_rps`。
这是 F-2（错误信息被吞）在配置层的同构问题。

**已修**：`config.py` 增加 `_env_files()`，同时读仓库根的 `.env` 与
service 本地的 `.env`（后者优先，因为"放在 `config.yaml` 旁边"是更具体的声明）。
修复后实测：

```
env 文件解析为: ['/root/projs/scholar-search/.env', '.env']
openalex_api_key 长度=22 -> 有值
注入 plugin 的 api_key: 有值
```

直连带 key 调用 → `HTTP/2 200`，`x-ratelimit-limit: 10000`、`remaining: 9990`。
`pytest -q` 在 `src/search-service` 下 111 passed。

**遗留**：`OPENALEX_MAILTO` 仍未设。另外这类"凭据没读到"应当**在启动时就报**，
而不是等到第一次调用失败——建议 Service 启动时对每个 `enabled` 且
声明需要凭据的 plugin 检查一次，缺失就写进启动日志与 `/health`。这条未做。

---

## F-4 — `call_ledger` 只数次数，不算成本、不对配额、不持久化

**现象**：`get_budget` 在 OpenAlex 配额已经耗尽的情况下，报告

```
Spent so far: nothing recorded.
```

**根因**：`src/search-service/src/search_service/call_ledger.py` 只维护
`dict[str, int]` 的调用计数。而 `config.yaml` 的 `cost_model` **单价其实写对了**：

```yaml
works_search:  { usd_per_call: 0.001, daily_quota: 1000, rate_limit_rps: 10.0 }
single_work:   { usd_per_call: 0.0,   daily_quota: null }
```

也就是说：写配置的人读过 OpenAlex 的价目表，把正确的数字放进了仓库，
**但没有任何代码去读它**。计数器与单价表之间缺一次乘法。

而且计数是进程内的，服务一重启就归零，而 OpenAlex 的预算是
**按 IP、按 UTC 日**结算的——两者的作用域根本对不上。

**后果**：

- $\theta^S_k$ 的预算维度形同虚设。`../design.md` §5.2 第三个 checkpoint
  "预算接近上限"**没有任何数据可以触发**；
- agent 只能撞墙之后才知道没配额了，而不是开搜之前就知道
  "今天还剩 37 次 OpenAlex 检索，省着用"；
- P 轴（偏好来源）里凡是涉及预算意识的偏好条目都无法被测量——
  `np-agent.md` 写了"预算意识"，但 agent 拿不到预算数字。

**补上它需要**：

1. `CallLedger.record()` 接上 `cost_model`，输出 `{calls, credits, usd}`；
2. 解析 OpenAlex 响应头的 `x-ratelimit-remaining` / `-remaining-usd` / `-reset`
   写进 `/budget`——**这是权威数字**，比本地累加准确，因为它包含了同 IP 其他进程的消耗；
3. `/budget` 的响应里区分"本进程记账"与"上游报告的剩余量"，
   现在的 `scope: process` 说明文字保留，但要说清楚哪个字段是哪种。

---

## F-5 — `end_date` 从未被使用，而评测协议依赖它

**现象**：会话中 37 次工具调用，**没有一次**设过 `end_date`。返回结果里
包含 `2509.12791`（2025）、`2508.05065`（2025）、`2605.02764`（2026）等
明显晚于问题时间窗的论文。

**根因分成两半，性质不同**：

- **TUI 侧不算 agent 的错**：用户没给日期边界，问句里也没有。
  工具描述（`index.ts:710`）已经写了"`end_date` 必须携带研究问题的时间边界
  whenever it ..."，agent 无从凭空构造。
- **但评测侧是真缺口**：AutoScholarQuery 每条都带
  `source_meta.published_time`（本条是 `20230917`），意思是这条问题取自一篇
  2023-09-17 发表论文的相关工作章节，**晚于该日期的论文不可能是标准答案**。
  `experiments/eval-runner/run.mjs:108` 支持 `endDate` 并把它拼进 prompt，
  但需要构造输入的人手工填。

另外 `np-agent.md` 里**没有任何关于时间窗的条目**。$NP_k^{agent}$
既然是"策略偏好"的载体，"有时间边界就必须传 `end_date`"正是该写在那里的东西。

**后果**：不设时间窗时，候选集里混入了大量按协议就不可能算对的论文，
这些论文挤占 top_k 名额，直接压低召回。在 §1 的对照里，
0/4 那次前 20 名中有 3 篇是 2025 年及以后的。

**补上它需要**：

1. AutoScholarQuery → eval runner 的转换脚本，把 `published_time` 映射成 `endDate`；
2. `np-agent.md` 增补时间窗条目（注意：只写策略，不写阈值，遵守 $NP_k$ 的无参数约束）；
3. 会话里 agent 报告的"检索时间 2025-06-24"是编造的（实际 2026-08-21），
   见 B-2——它没有获取当前日期的手段，这也需要一并解决，否则时间窗推理没有锚点。

---

## F-6 — 单源单查询时，整个排序栈是恒等变换

**现象**：会话后期几乎所有调用都是 `sources: ["arxiv"]` + 单条 query，
返回的顺序就是 arXiv 自己的顺序。

**根因**：`aggregator.py` 的 RRF（`_DEFAULT_RRF_K = 60`）作用在
`items_by_list` 的多个列表之间。当只有一个列表时，RRF 是保序的恒等变换。
L1（特征）/L2（意图）/L3（判别器）在当前 build 里都不存在。

**证据**（工具自陈，`index.ts:800`）：

```
intent='find superpixel-based semantic segmentation papers on arxiv' was recorded
on the call but does not affect ranking in this build.
```

这句话是诚实的，但它的含义是：**agent 表达意图的唯一通道是死的**。

**后果**：这条与 G-3、G-5 是同一件事的不同侧面，记在这里是因为
本次会话给了它一个具体的量化后果——`search_metadata` 在单源场景下
退化成"arXiv 前 20 条"的薄封装，$\theta^S_k$ 中所有排序相关的分量
（`api/probe.py` 里硬编码的 `_relevance` 权重 2.0/1.0/0.1、`_tier` 阈值 0.6/0.2）
既不可配置、也不在这条路径上生效。

**补上它需要**：见 G-5。本文只补一条前置条件：**先修 F-1**。
在召回层漏掉正确答案的前提下比较排序器，测到的是噪声。

---

## F-7 — 其余较小但确凿的问题

| 编号 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| F-7a | `expand_citations` 唯一的引文能力来自 OpenAlex | `backward expansion from 2 seed(s): 0 paper(s) reached over 0 edge(s)`，失败原因是 `openalex [rate_limit]` | OpenAlex 一挂，引文扩展整条腿断掉，且工具没有告诉 agent"换个源"在结构上不可能 |
| F-7b | arXiv 结果全部 `citations unknown` | 每条 `get_paper` 输出 | 质量信号缺失，无法按影响力排序；E 轴（扩展）与 B 轴都受影响 |
| F-7c | `default_timeout_ms: 15000` 偏紧 | 07:45:55 一次 `search_metadata` 超时 | 5 条 subquery 并发 + 代理慢链路时必然超时。修 F-3（走直连）后应重新测定 |
| F-7d | 九个工具只用了三个半 | `facet_probe`、`rank_candidates`、`search_fulltext` 零调用，`provider_query` 一次 | 见 B-4 |

---

## F-9 — LLM provider 的凭据走 `os.environ`，同样读不到 `.env`（未修）

**现象**：暂无——这是 F-8 的**同族潜伏缺陷**，目前不咬人，但会。

**根因**：`llm/providers/openai_compatible.py:49` 这样取密钥：

```python
return os.environ.get(env_name) or os.environ.get("LLM_API_KEY") or None
```

而 pydantic-settings 读 `.env` 是**读进 model，不写回 `os.environ`**。实测：

```
pydantic Settings 从 .env 读到 openalex key : 有值
同一个变量在 os.environ 里                  : 空
```

所以只要有人把 `OPENAI_API_KEY` 写进 `.env`，LLM provider 就会静默地拿不到——
和 F-8 一模一样的失败模式，一模一样的静默方式。

现在不发作只因为两件事恰好成立：默认 provider 是局域网 vllm，
`config.yaml` 里写的是字面量 `api_key: "EMPTY"`；而 `.env` 里也确实没有 OpenAI 的 key。
两个条件任一改变就会复现。

**补上它需要**：跟 OpenAlex 与 Serper 走同一条路——在 `Settings` 上加字段，
在 `ServiceConfig` 里用 `cfg.get("api_key") or self.settings.xxx` 的写法解析
（`config.py:136-139` 是现成的样板），不要在 provider 内部读 `os.environ`。

**附带的一条命名意见**（不是缺陷）：端点叫 `/judge`，但 `api/judge.py`
实际是通用 LLM 转发，它自己的 docstring 也说了不含 prompt 模板与结果解析。
Service 侧要用 LLM 的地方不止判别器——还有 L3a 的 cross-encoder 打分
（`cf.score.relevance`）和查询扩展的语义部分。当前名字把**传输**和**角色**绑死，
加第二个消费者时会别扭。`/llm/chat` 作为传输、judge 作为其上一层更贴合分工。
趁只有一个消费者时改，成本最低。

---

## F-10 — `expand_citations` 不接受其他工具产出的 id（已修）

**修复**（2026-08-21）：新增 `search_service/identifiers.py` 作为唯一的 id 解析处，
`api/paper.py` 的三条本地正则改成调它，OpenAlex 的 `works/` 寻址一律经
`openalex_address()`（DOI → `doi:<doi>`，arXiv id → `doi:10.48550/arXiv.<id>`，
两种形式都实测是 $0 的单篇查找）；`filter=cites:` 前先把种子解析成 `W` id。
无法解析的种子记成 `bad_id` 并说明接受哪些形式，全部种子都坏时返回 400 而不是空图。
契约测试在 `tests/test_identifier_contract.py`，包括"把 `/search` 给出的 id
直接喂给 `/expand/citations`"这一条。原文保留在下。

**现象**：2026-08-21 的 `search-k9u1` 会话里，两次 `expand_citations` 都因为
种子 id 格式失败，agent 随后**放弃了引文扩展这条路**。

**证据**：

```
forward expansion from 1 seed(s): 0 paper(s) reached over 0 edge(s), 1 provider call(s).
failures (1):
  - openalex [http] seed 'https://doi.org/10.1007/978-3-642-15555-0_26':
    OpenAlex client error 400: {"error":"Invalid query parameters error.",
    "message":"'https://doi.org/10.1007/978-3-642-15555-0_26' is not a valid OpenAlex ID."}
```

第二次调用部分成功（`W1542723449` 可用，29 篇 / 30 条边），但 depth-2 展开时
再次撞上同样的墙，7 个种子里 7 个是 DOI URL，全挂。

**根因**：**id 空间在工具之间不一致。**
`search_metadata` 经 OpenAlex 返回的论文，`paper_id` 就是 `https://doi.org/...`；
`get_paper` 也**确实能**解析这种 id（会话里成功了十几次）。
于是 agent 完全合理地假设这种 id 到处都能用——而 `expand_citations`
把它原样透给 OpenAlex 的 id 端点，400。

**后果**：这不是一次孤立的失败，它**改变了 agent 的策略**。
第一次失败后 agent 写下"引文扩展因为ID格式问题失败了"，
之后整段 diffusion 检索（约 35 次调用）**再没用过 `expand_citations`**，
全靠关键词穷举。而它自己对 1/5 召回的归因恰恰是
"我过度依赖关键词检索，而没有通过引文扩展从已知论文回溯"——
**工具坏掉的方式，正好塞住了它自己诊断出来的那条出路。**

E 轴（引文扩展）在当前实现下没有测量对象。

**补上它需要**：

1. Service 侧统一 id 归一：DOI URL / 裸 DOI / `W\d+` / arXiv id 都应先经
   同一个解析器变成规范 id，再进各端点。`get_paper` 已经有这个能力，
   `expand_citations` 应该复用它而不是各写一份；
2. 无法解析的种子要以 `[bad_id]` 这个分类返回并**说明接受哪些形式**，
   而不是伪装成"这个方向没有边"——现在的兜底文案
   "Either the seeds have no edges in this direction, or no source could serve them"
   把一个可修的输入错误说成了数据缺失；
3. 回归测试：拿 `search_metadata` 的输出直接喂给 `expand_citations`，
   断言不出现 `[http] ... is not a valid OpenAlex ID`。
   **工具 A 的输出必须是工具 B 的合法输入**，这条该成为工具集的通用契约。

## F-12 — 查询里的 `?` 让 OpenAlex 直接 400（未修）

**现象**：把 AutoScholarQuery 的问句原样作为 `query` 发给 `/search/metadata`，
OpenAlex 侧整条失败。

**证据**（2026-08-21，S12 的 J 轴消融第一次跑，`runs/judge-ablation/accept`）：

```
openalex [http] query 'Could you provide me some works employs image patches and
superpixels in region-based methods for semantic segmentation?':
OpenAlex client error 400: {"error":"Invalid query parameters error.",
 "message":"Wildcards (* or ?) require exact (no-stem) search. ... Use the
 search.exact= parameter instead ..."}
```

**根因**：OpenAlex 把 `?` 当通配符。问句末尾的问号于是让整个 `search=` 参数
变成一个非法的通配查询。`plugins/openalex.py` 的 `build_base_params` 把
调用方的 query 原样放进 `search`，不做任何字符归一。

**后果**：任何以自然问句结尾的查询在 OpenAlex 上是 100% 失败，而不是"结果差"。
这在 agent 路径上被掩盖了——agent 送的是词项式查询，不带问号；
只有直接把数据集问句喂给 Service 时才暴露。**这也意味着任何绕过 agent 的
批量评测（包括 J 轴消融）都会先撞上它。**

**补上它需要**：`search` 参数里的 `?` 与 `*` 做转义或剔除（OpenAlex 无转义语法，
实际只能剔除，并把剔除动作记进 `native_query` 让它可见）。
剔除会改变查询语义，所以这是一条需要决策的改动，不是纯 bugfix。

## F-13 — AND 连接对整句自然语言查询过严，实测确认（未修）

**现象**：`worklog.md` §3 预告过这条风险，S12 的消融把它变成了实测。
同一条 17 词问句，`sources: ["arxiv"]`，返回 **0 条**。

**证据**：`runs/judge-ablation/accept` 第一次运行，两条查询的 `returned` 都是 0，
其中 arXiv 侧无 failure（不是错误，是真的没有结果），OpenAlex 侧是 F-12。

**根因**：F-1 的修法把词间连接改成 AND，一句 17 词的提问因此变成 17 个必须全部
命中的词项。这不是 F-1 的回归——F-1 修对了它要修的东西（`backlog.md` §1 的
0/4 → 4/4 用的是词项式查询），但它把"送整句"这条路从"结果很差"变成了"零结果"。

**后果**：
- agent 路径不受影响：工具描述已经把它引向词项式查询（D-16），实测它送的都是
  词项组合；
- **绕过 agent 的路径受影响**：任何把数据集问句直接当 `query` 用的批量评测
  都会拿到 0 条。J 轴消融因此改用固定的词项式 `searchQuery` 作为夹具
  （`experiments/judge-ablation/queries.accept.json`），并在记录里同时留下
  原问句与实际发出的查询。

**补上它需要**：一条对长查询的降级策略。可选项各有代价，需要决策而不是修 bug：
按词项数阈值自动降级成 OR（引回 F-1 的问题面）、去停用词后再 AND
（引入一份需要维护的词表，且对非英语查询失效）、或在 Service 侧不做而要求
调用方送词项（现状，把责任放在工具描述上）。

## F-11 — OpenAlex 的 ML 预印本引文图很稀疏，backward 扩展基本不可用（未修，是数据现实）

**现象**：即使修好 F-10，`direction=backward` 在本项目的语料上依然大面积无效。

**证据**（2026-08-21 实测，带 key 直连，抽样 8 篇 gold）：

| arXiv id | `referenced_works` | `cited_by_count` | 标题 |
| --- | --- | --- | --- |
| 2010.02502 | 40 | 102 | Denoising Diffusion Implicit Models |
| 2303.01469 | **0** | 26 | Consistency Models |
| 2112.07068 | **0** | 7 | Score-Based … Critically-Damped Langevin |
| 2112.07804 | **0** | 145 | Denoising Diffusion GANs |
| 1810.09726 | 55 | 25 | CEREALS |
| 1911.11789 | **无记录** | — | ViewAL |
| 2010.01884 | **0** | 1 | MetaBox+ |
| 2002.06583 | 51 | 24 | Reinforced active learning |

八篇里 **四篇 `referenced_works` 为空、一篇根本没有记录**。
`cited_by_count` 同样严重偏低——DDIM 的真实被引在数千量级，OpenAlex 只记了 102。

**后果**：

- **backward 扩展**从新近预印本出发时大概率返回空，而"从找到的论文回溯参考文献"
  正是 `../prototype.md` E 轴与 `../skill-decomposition.md` CF-B 整个 Phase 2 的基础；
- **forward 扩展相对可用**（`cited_by` 至少存在），所以这个语料上正确的策略是
  **从老的奠基工作向前扩展**，而不是从新论文向后回溯——这与 CF-B 的默认假设相反；
- 任何以 `citation_count` 为排序特征的做法（`../prototype.md` §3 的 L1 特征、
  CF-B-05 的 "cc >5000 判 C" 判据）在这个数据上**阈值全部失准**。
  CF-B-05 那条准则如果照搬，会把所有论文都判成非通用工具类。

**补上它需要**：这不是一个能"修"的缺陷，是数据源的能力边界。可选的应对：

1. 把它写进 provider 能力表（`CAP`）——`graph_references` 当前在
   `config.yaml` 里被声明为 `true`，而实测它对预印本大面积失效。
   `../skill-decomposition.md` §2 对 `CAP` 的判据是"关于数据源的**可证伪断言**，
   应被实测推翻"——这就是一次推翻，能力表该改；
2. E 轴实验默认用 forward 而非 backward，并把这个选择的理由记进 `../experiments.md`；
3. 若要真正做引文扩展，需要引入有 ML 预印本引文图的源
   （Semantic Scholar / OpenCitations），这是新 provider，不在当前范围。

---

## 会话中的 Agent 行为观察

这一节记的不是代码缺陷，而是**这次会话暴露出的 agent 行为特征**。
它们对实验设计有直接影响，所以一并记下。

**B-1（做对了）自我反思的定位准确。** 被追问后，agent 准确指出自己把问题理解成了
"superpixel-based segmentation"而非"region-based **active learning** for segmentation"，
并引用了 `np-agent.md` 的 `decompose-by-research-elements` 条目说自己没照做。
它也没有编造检索不到的论文，被直接询问时如实回答 1/4。这两点是可靠的行为基线。

**B-2 归因错误——最危险的一条。** 它把没找到的三篇解释为
"可能发表在期刊或会议（非 arXiv）"。**三篇全在 arXiv 上**
（2002.06583 / 2010.01884 / 1911.11789）。一个听起来完全合理的反思，
把责任推给了外部覆盖面，掩盖了 F-1 这个真 bug。
**含义**：Reviewer 如果只读 agent 的自述而不读 $\bar{\tau}_t$ 里的
`issued_queries`，会被这类归因带偏——这反过来支持了
"$\bar{\tau}_t$ 必须记录实际发出的查询串"（见 F-1 第 2 点）。

**B-3 两处凭空编造。** 把服务地址说成 `172.20.80.165:8000`（工具返回的是
`127.0.0.1:8000`）；报告里写"检索时间 2025-06-24"（实际 2026-08-21）。
都是无中生有的具体细节，且都出现在**面向用户的总结**里而非工具调用里——
即 $\bar{\tau}_t$ 看不到它们，Reviewer 也审不到。

**B-4 策略在挫折下萎缩而非调整。** 第一次调用带 5 条 subqueries，
之后 15 次调用**全部退回单查询**。九个工具只用了三个半，`end_date` 一次没设。
而它在 07:24 自己描述的工作流写着"诊断先行 / 覆盖优先 / 预算意识 / 透明报告"，
实际执行时一步没走。**声称的策略与实际行为完全脱节**——
这对 P 轴（偏好来源）是个直接警告：$NP_k^{agent}$ 里写了条目
不等于 agent 会执行，实验必须有独立于自述的行为测量。

**B-5 它自己指出了 Reviewer 的缺席。** 被问到有没有 LLM judge / worker 时，
它回答"没有，全是确定性工具"，并补充"如果有 LLM-as-judge，
可能会在检索结果偏离预期时触发重新审视检索策略的机制"。
这正是 Sidecar Reviewer 的设计意图，而 Reviewer 当前默认关闭
（`SCHOLAR_REVIEWER` 未设，且见 G-1：即使打开也只在 episode 之后介入）。
**这次会话是 G-1 的一个活案例**：中途的四个 checkpoint 里至少有两个
（"检测到覆盖不足"、"一轮候选合并完成"）本该在 07:38 前后触发。

---

## 验收缺口 G-1..G-10

这一节记的是"**stage 验收通过、但设计要求尚未满足**"的部分。

单独成节而不是塞进 `history.md` 的状态表备注里，是因为这两件事的性质不同：
备注写的是这个 stage 做了什么，而这里写的是**下一步必须补什么，
以及在补上之前哪些实验结论不能下**。把它们混在一起，缺口就会随着状态表变绿
而消失在视线外。

### G-1 — Reviewer 的介入时机偏在 episode 之后（S8）

**设计要求**：`../design.md` §5.2 列了四个 checkpoint，**前三个都在 episode 中途**
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
而那才是 §5.2 存在的理由。判据弱于设计，这是判据的问题，不是执行的问题。

**补上它需要**：**这就是 S11**，见 `plan.md` §4 与 `../reviewer-design.md`。
三项分别对应到：checkpoint 判定移到 `tool_execution_end`（§5.3）、
投递改成每条放行即发（§5.2d）、`MAX_REVIEWS_PER_AGENT` 取消（D-14）。

### G-2 — Evidence Store 未落地，gate 的证据校验落在替代物上（S4 决策 / S7 / S8）

**设计要求**：`../design.md` §4.1、`../search-service.md` §5.3、`mapping.md` §3.2——
Evidence Store 是 episode 作用域的运行时状态，由 Service 持有，
与 `RunSnapshot` 同生共死。

**实际实现**：未落地。Service 至今没有 episode 概念，`get_budget` 的 `scope`
如实标 `process` 而不是 episode。S8 需要"可引用的 id"才谈得上 gate 的证据校验，
于是在 extension 侧做了 `TraceEvidence`（`core/trajectory.ts`）。

`TraceEvidence` 本身**不违规**：它是轨迹的证据视图（只有 id、标题、来源、
由哪次调用发现），不是 Store，也没有把候选集搬进 Agent 上下文。

**后果**：Reviewer 只能引用**已经进过 Main 上下文**的论文 id。它看得到
`recalled: 589 / returned: 110` 这样的差额，却无法对被丢弃的那 479 篇里的缺口
提出任何可被 gate 接受的具体建议——因为那些 id 不在轨迹里。而"召回了但没进最终
名单的那批里有没有系统性缺口"恰恰是 sidecar 最有价值的观察面。

**补上它需要**：一个 episode 标识穿过工具入参到 Service，Service 侧按该标识维护
Store 并在 `SearchState` 上挂出它的账目。**不属于任何已排定的 stage**，
见 `plan.md` §7。注意 S10 的答案池**不抵消这一条**，两者是不同的对象。

### G-3 — S5 的验收判据是看到数据之后选定的（S5）

**实际过程**：原判据"关掉全部条目与打开全部条目，轨迹形状明显不同"以调用总数衡量
时不成立（全关 7–37，全开 22–40，区间大面积重叠）；固定采样后改用**调用构成**
（`provider_query` 全开 0/0/0 vs 全关 3/2/3）才判定通过，n=3/组。

**问题不在于结论错**，而在于观察量是在看过数据之后选的。这样得到的分离度不能
当作效应量的估计——它至少一部分来自选择本身。当前记录足以支持
"策略先验有作用面"这一定性判断，**不足以支持任何定量结论**。

**补上它需要**：把观察量与重复次数写进 `../experiments.md` 做**预注册**——
先定判据再跑。另外记一条已经发现的依赖问题：30 条条目里有 11 条讲引文扩展，
而 `expand_citations` 到 S7 才注册，所以 S5 的锐利判据本来就应当排在 S7 之后。

**D-12 追加了一个解释**：如果当时 30 条里多数是**不可绑定**的
（关掉它轨迹本来就不会变），"关掉全部条目轨迹不变"就是预期结果，
而不是实现出了问题。S11 的 $NP_0$ 重写会把这一点分清楚。

### G-4 — S9 的产出不可复现：采样固定依赖仓库外的器材（S9 / U-03）

**设计要求**：`../experiments.md` 的等算力比较要求同一配置可重跑。

**实际实现**：S9 的 runner 把 provenance 记全了（namespace、RPC protocol version、
WIDI revision、profile、模型、extension 版本、生效预算、启动诊断、父仓库 revision
与 dirty 标志），但**没有确定性**——同一条查询重跑时采样是自由的。
固定采样目前只能靠 scratchpad 里一个强制写入采样参数的反向代理，**它不进仓库**。

**后果**：S5 那张对照表无法在仓库内一键复现；将来任何用 S9 跑出来的数字同样如此。

**补上它需要**：见 `history.md` 的 **U-03**。三条路径互斥，需要用户拍板选一条。

### G-9 — S12 判据 2 的"出现在 $\bar{\tau}_t$ 里"没有经过真实 agent episode（S12）

**判据原文**：`judge_level=l3b` 时 `judgeSupported: true`，实际判别篇数写进
`SearchState` **并出现在 $\bar{\tau}_t$**。

**已验的**：`SearchState.judge` 在真实运行里带着完整账目
（`level` / `judged: 30` / `considered: 30` / `rubric_version: r3` /
`criteria_version` / `model_version`），见 `worklog.md` §8 的 J 轴消融记录。
extension 侧的解析与 `PublicSearchTrace` 的 `judge` 字段各有单测。

**没验的**：**一次真实 agent episode 里 $\bar{\tau}_t$ 带着判别账目落盘。**
原因是算力而不是通路：agent 一个 episode 发 19 次 `search_metadata`，
每次判 30 篇、每篇一次 LLM 往返（实测约 15–18 秒），
一个 episode 的判别开销就是 **2.5 小时以上**。

**后果**：链路的最后一跳（`SearchState.judge` → 工具 `details` →
`tool_execution_end` → `PublicSearchTrace`）只有单测作证。三段各自被测过，
拼起来没被跑过一次。

**补上它需要**：一次开着 `judge.forced_level: l3b`、把
`judge.max_papers_l3b` 临时降到 3–5 的 episode。降低篇数会让判别质量无意义，
但这条判据验的是账目是否流到轨迹里，不是判得准不准——所以这是一次
**便宜且有效**的验证，只是要在记录里写明篇数被降过。

### G-10 — L3a / L3c 未实现，J 轴只有 J0 与 J2 两组（S12）

**设计要求**：`../prototype.md` §4.1 定义三档
（L3a cross-encoder $N_{sem}=100$ / L3b LLM judge on abstract $N_{judge}=30$ /
L3c fulltext $N_{full}=8$，P0 默认关闭），§6.5 的 J 轴是 J0–J3 加上 J2'。

**实际实现**：只有 L3b。请求 `l3a` 或 `l3c` 会被如实报告为
"not implemented in this build"，**不会被静默降级成 l3b**——这一处是对的，
是 D-09 那个教训的直接应用。

**后果**：
- **J1（只有 L3a）与 J3（三档全开）没有实现面**，J 轴目前只有 J0 与 J2；
- `prototype.md` §6 要求的 judge-free 消融**成立**（J0 对 J2 就是它），
  所以 §5.6 那条硬要求没有被绕过；
- 但 "L3a 便宜且够用吗" 这个问题无法回答，而它决定默认策略
  （§4.1 写的是"预算充裕走 L3a + L3b，紧张时只走 L3a"）——
  这个默认策略当前没有实现依据。
- **J2'（judge 蒸馏后的 L2 打分器）更远**：它需要 L2 存在，而 L2 属于 G-5。

**补上它需要**：L3a 是一个 cross-encoder 打分器，不是 LLM 调用，
所以它不在 `judge/` 这一层，而是 G-5 里 "L2 与参数外提" 的邻居。
L3c 需要全文，`search_fulltext` 已有，但 §4.1 明说 P0 默认关闭。
**两者都不阻塞 J0/J2 的对照。**

### G-7 — S11 判据 3 的"被 novelty key 挡下"在真实运行里没走到（S11）

**判据原文**：gate 的拒绝记录里能看到检测器重复触发被 **novelty key** 挡下的条目
（说明检测器接在 gate 之内，没有绕过）。

**实际实现**：括号里那条性质**成立且有充分证据**——一次真实 episode 的拒绝记录是
`duplicate_action_target` ×1、`unknown_evidence` ×3、`repeated_no_action` ×1。
其中三条 `unknown_evidence` 尤其有力：Reviewer 引了三个不在轨迹里的 id，全被挡下。

**没走到的是那条具体路径**：Reviewer 重复的那条 `organize_answer` 换了 novelty key
但动作与 target 相同，于是先撞上 `duplicate_action_target`
（gate 的检查顺序是 episode 上限 → novelty key → action|target）。
`duplicate_novelty_key` 有单测（`review.test.ts:98`），但没有真实运行的样本。

**为什么记成缺口而不是"实质等价"**：这两条规则挡的是不同的东西。
novelty key 挡的是"同一个意思换个说法"，action|target 挡的是"同一个动作对同一个对象"。
一个换了 novelty key 就能重发的 Reviewer，在 target 不同时能绕过 action|target 那条——
而这次运行没有覆盖到那种情形。**它是否真的挡得住，目前只有单测作证。**

**补上它需要**：一次 Reviewer 用同一个 novelty key 重发、或 target 不同而语义重复的
真实运行。可以在下一次 M 轴运行里顺带观察，不需要单独的工作项。

### G-8 — S11 判据 8 的 TUI 交互半边未验（S11）

**判据原文**：TUI 里用户能切到 Reviewer 并直接与它对话，且切过去看到的上下文里
**没有** Main 的私有推理（沿用 S8 的逐片段查证方法，leaks = 0）。

**已验的一半**：隔离。Reviewer 的输入完全由 `renderTraceForReviewer(trace)` 构造，
`PublicSearchTrace` 是白名单过滤的产物，且有一条测试往 trace 上塞额外字段并断言
渲染不出来。运行侧最有力的证据是三条 `unknown_evidence` 拒绝。

**未验的一半**：**切过去对话这个动作本身**。本次推进全程走 RPC，
无法驱动全屏 TUI，因此 S8 那套"切过去、逐片段 grep、leaks = 0"的过程没有执行。
D-10 把"用户能直接与 Reviewer 对话"列为常驻化的第二条理由
（人工 review 是 $NP_0$ 的种子来源），所以这不只是一个演示步骤，
它是那条决策的作用面。

**补上它需要**：一次交互式 `npm run widi:scholar`，`SCHOLAR_REVIEWER=1`，
在 agent strip 里切到 reviewer、问它一个问题、并按 S8 的方法抽片段查证。
**需要人在 TUI 前**，无法自动化。

### G-6 — S10 判据 4 的后半只由单测证明，没有活的 Reviewer 读过池子（S10）

**设计要求**：`plan.md` §3.5 第三条——答案池的价值之一是让 Reviewer
**在 episode 中途**读出覆盖缺口（"池中八篇全是 superpixel segmentation、
一篇 active learning 都没有"）。判据 4 的后半写的是
"Reviewer 的上下文能读到池子当前内容"。

**实际实现**：`renderTraceForReviewer` 会渲染 pool 段（committed / withdrawn /
note / 每条的 `why`），空池渲染成 `Answer pool: EMPTY`；两条单测覆盖
（`review.test.ts`）。`PublicSearchTrace.answerPool` 在真实运行里确实带着 14 条
落进了 `search-to8d.json`。

**没有验的**：**一个真的 Reviewer 读了它**。Reviewer 仍挂在 `agent_idle` 上、
`SCHOLAR_REVIEWER` 默认关闭，而且即使打开也只在 episode 结束后介入（G-1）。
所以"池子对 Reviewer 有作用面"这件事，目前只有渲染函数层面的证据。

**为什么不在 S10 里补**：补它就是把 Reviewer 的触发时机改掉，那是 S11 的全部内容
（`plan.md` §4，`../reviewer-design.md` §5.3）。在 S10 里顺手改会把两个 stage
混进一个 commit，也会让 S11 的判据 2 失去对照。

**补上它需要**：S11 的判据 2 与判据 4 一起跑一次真实检索，确认 Reviewer 在
**池子被写入之后**收到的轨迹里含 pool 段。这是 S11 的验收，不需要新增工作项。

### G-5 — 排序栈只有 L1 真实存在，判别器完全没有（S7）

**设计要求**：`../prototype.md` 的 L0–L3 排序栈——L0 资格过滤、L1 RRF 候选控制、
L2 可训练特征融合、L3 预算内判别。

**实际实现**：

- **L1 真实存在**：`aggregator.py` 的 RRF（κ=60）。
- **L2 / L3 没有**。`POST /rank` 是词面重叠加引用数先验的占位实现
  （`api/probe.py` 的 `_relevance`），权重 `2.0 / 1.0 / 0.1` 与 tier 阈值
  `0.6 / 0.2` 硬编码在函数里。它的 docstring 诚实标注了自己是 placeholder。
- `judge_level` 参数存在但无实现，工具在传入非 `off` 时显式告知未实现——
  **这个处理是对的**，不算缺口，只是说明判别器整个还不存在。

**后果**：**B 轴（ranker）与 J 轴（judge tier）目前没有实现面**，
对应的消融实验无法开始。另外敏感性筛选建立在"那批参数可配"之上，
而现在其中一部分是代码里的常量——在参数外提之前，筛选协议跑不起来。

**补上它需要**：L3b 那一半是 **S12**，见 `plan.md` §5。
L2 与参数外提尚无 stage。

---

## 两类问题的关系

| 检索缺陷 | 与验收缺口的关系 |
| --- | --- |
| F-1 | **新**。此前未被任何 stage 验收覆盖——S2/S7 验的是"端点通、返回结构对"，没有验召回质量 |
| F-2 | **新**。S6 验的是 $\bar{\tau}_t$ 的过滤白名单，没有验失败路径的信息完整性 |
| F-3 / F-4 | 扩展 G-5（$\theta^S_k$ 未参数化）到预算维度，并给出具体数字 |
| F-8 | **新，且已修**。此前所有 stage 的验收都跑得通，因为匿名调用在配额未耗尽时正常返回——静默降级不会让任何一条判据变红 |
| F-9 | **新，未修**。潜伏缺陷，随 `aac617c` 的 LLM provider 层引入；与 F-8 同族 |
| F-10 | **新，未修**。S7 验的是九个工具各自可调用，没有验"工具 A 的输出是工具 B 的合法输入" |
| F-11 | **新，不可修**。是 provider 能力表的可证伪断言被实测推翻，E 轴的默认方向要改 |
| F-5 | 与 G-4 相关；新增的是评测协议侧的时间窗映射 |
| F-6 | 是 G-3（`intent` 无作用面）与 G-5 的量化后果，非新缺口 |
| B-5 | 为 G-1 提供了一个真实案例 |

另需记一笔：`experiments/eval-runner/run.mjs` 有完整的运行与记录能力，
但**没有任何指标**——不读标准答案，不算召回。AutoScholarQuery 的
`answer_arxiv_id` 就在 `references/datasets/pasa/` 里躺着。
在建立这条评测回路之前，F-1 这类缺陷只能靠人肉会话偶然发现。

---

## 修改顺序

**主线顺序在 `plan.md`**，不在这里：F-1 / F-2 / F-10 是 S10 的前置修复，
建立召回评测回路是 S10 本身，排序栈与判别器是 S12。

本节只补 `plan.md` 没有排进 stage 的几条，以及它们该插在哪里：

| 何时做 | 做什么 | 为什么是这个位置 |
| --- | --- | --- |
| 随时，很小 | **F-3 的剩余部分**：设 `OPENALEX_MAILTO`，确保 OpenAlex 出站不走代理 | key 的问题已由 F-8 解决，剩下的只是两个配置。**先不付费** |
| 随时，很小 | **F-9**：LLM provider 改用 `Settings` 字段而非 `os.environ` | 潜伏缺陷，现在不咬人；改动照 `config.py:136-139` 的样板抄 |
| **S10 之后** | **F-4**：`call_ledger` 接上 `cost_model` 与上游 `x-ratelimit-*` 头 | 它激活 `../design.md` §5.2 的"预算接近上限"checkpoint，也就是 S11 的 R7 检测器的数据源。放在 S10 之后是因为它要用到 S10 建立的评测回路来验证记账是否准 |
| **S12 之前** | **F-11 的应对**：把 `graph_references` 的能力声明改成实测结果，E 轴默认改 forward | 它推翻的是一条 `CAP` 断言，不改会让 E 轴实验从错误的默认值出发 |
| ~~无排期~~ **已做** | **F-5 的 `np-agent.md` 时间窗条目** | 并进 S11 的 $NP_0$ 重写：A 组的 `carry-the-date-boundary`（`[NP v2]`） |
| 无排期 | **F-6 / G-5 的参数外提** | 需要单独的 stage |

四段路线走完之后新增的条目，以及它们该插在哪里：

| 何时做 | 做什么 | 为什么是这个位置 |
| --- | --- | --- |
| **下一件** | **F-4**：`call_ledger` 接上 `cost_model` 与上游 `x-ratelimit-*` 头 | 它是 R7 检测器唯一的数据源。R7 现在拿 `budget.totalCalls` 对一个配置里的软上限比，那是调用次数不是预算——真正的"预算接近上限"checkpoint 仍然没有数据可触发 |
| **任何批量评测之前** | **F-12 / F-13**：查询归一（`?` 与 `*`）与长句降级策略 | 两者都只在绕过 agent 的路径上发作，而那正是批量评测的路径。J 轴消融已经用夹具查询绕过它们一次（D-26），但绕过不是修好 |
| **J 轴报结论之前** | **G-10**：至少让 J1 有实现面（L3a） | 现在 J 轴只有 J0 与 J2。judge-free 消融成立（§5.6 的硬要求没被绕过），但"L3a 便宜且够用吗"这个决定默认策略的问题无法回答 |
| **M 轴开跑之前** | **G-8**：一次交互式 TUI 的 Reviewer 对话查证 | D-10 把"用户能直接与 Reviewer 对话"列为常驻化的第二条理由，而人工 review 是 $NP_0$ 的种子来源。**需要人在 TUI 前**，无法自动化 |
| 便宜，随时 | **G-9**：把 `judge.max_papers_l3b` 临时降到 3–5 跑一个 episode | 验的是判别账目流到 $\bar{\tau}_t$，不是判得准不准，所以降篇数不影响这条判据 |

排序的依据是"单位改动量的信息增益"，不是严重程度——F-1 排第一不是因为它最严重，
而是因为它改动最小、收益最大，且 §1 已经给出可直接用作回归断言的期望值。

---

## 附：复现命令

```bash
# F-1：观察 arXiv 把查询解析成 OR（看返回的第一个 <title>）
curl -s -G "https://export.arxiv.org/api/query" \
  --data-urlencode "search_query=all:reinforced active learning image segmentation" \
  --data "max_results=5" | grep -o '<title>[^<]*</title>' | head -1

# F-1：AND 版本，目标论文回到第 1 位
curl -s -G "https://export.arxiv.org/api/query" \
  --data-urlencode "search_query=all:reinforced AND all:active AND all:learning AND all:image AND all:segmentation" \
  --data "max_results=5" | grep -o '<title>[^<]*</title>'

# F-3：观察 OpenAlex 的信用预算头（注意要绕开代理才看得到真实 IP 的配额）
env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY \
  curl -s -D- -o /dev/null "https://api.openalex.org/works?search=test&per_page=5" \
  | grep -iE "^HTTP|ratelimit|retry-after"

# F-3：对照——singleton 查询在预算耗尽时仍返回 200 且 cost 为 0
env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY \
  curl -s -D- -o /dev/null "https://api.openalex.org/works/W2741809807" \
  | grep -iE "^HTTP|ratelimit-cost|ratelimit-credits-used"
```

arXiv 的礼貌用法是约 3 秒一次请求，连续跑上面的命令时请自行间隔。