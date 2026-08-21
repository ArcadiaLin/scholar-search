# 检索缺陷备忘：从一次 TUI 会话追出来的问题

> 状态：待修复清单，每条都附可复现的证据
> 读者：要决定下一步改什么的人
> 前置：`search-service.md`（Service 契约）、`06-progress.md` 的"验收缺口"一节（G-1..G-5）
> 证据来源：`widis/.widi-scholar/runs/--root-projs-scholar-search--/20260821T072357Z_search-d9w6/session.jsonl`
> （2026-08-21，`npm run widi:scholar` 的首次真实人机会话）

`runs/` 在 `.gitignore` 里，那份会话记录不会进版本库，所以**本文把关键证据原样内嵌**，
不依赖那个文件还在。

每条缺陷的格式与 `06-progress.md` 的验收缺口一致：
现象 → 证据 → 根因 → 后果 → 补上它需要什么。

编号用 `F-n`（Finding），避开已被占用的 `D-`（决策）、`G-`（验收缺口）、
`U-`（上游缺陷）、`SV-`（Service 缺陷）、`E-`（环境）。

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

## F-1 — arXiv 查询退化成 OR，召回层从根上失效

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

## F-2 — 全部 provider 失败时，失败原因被丢弃

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
"来源失衡"——而这是 `design.md` §5.2 第三个 checkpoint 的触发条件之一。

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

**补上它需要**（按成本从低到高）：

1. **注册免费账号拿 API key**，设 `OPENALEX_API_KEY`。预算从 $0.10/天 升到
   **$1/天**（约 1000 次 list 查询），不需要付款方式。一次完整检索约 20–50 次
   list 查询，**这一步大概率就够日常开发和小规模评测用**；
2. 同时设 `OPENALEX_MAILTO` 进 polite pool，并把 OpenAlex 的出站排除在代理之外；
3. 不够再在 pricing 页按 **$1 增量**买预付额度（免费额度用完后才扣，
   购买后 3 个月过期）。跑几百条 AutoScholarQuery 的全量评测时才需要；
4. 代码侧：429 时读 `Retry-After`，超过阈值就**不重试**并把"今天不可用"
   这个事实上报给调用方（配合 F-2、F-4）。

年度 Member+（$100/天预算）对本项目的规模是浪费。

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

- $\theta^S_k$ 的预算维度形同虚设。`design.md` §5.2 第三个 checkpoint
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

## 与既有缺口的关系

| 本文条目 | 与 `06-progress.md` 验收缺口的关系 |
| --- | --- |
| F-1 | **新**。此前未被任何 stage 验收覆盖——S2/S7 验的是"端点通、返回结构对"，没有验召回质量 |
| F-2 | **新**。S6 验的是 $\bar{\tau}_t$ 的过滤白名单，没有验失败路径的信息完整性 |
| F-3 / F-4 | 扩展 G-5（$\theta^S_k$ 未参数化）到预算维度，并给出具体数字 |
| F-5 | 与 G-4 相关；新增的是评测协议侧的时间窗映射 |
| F-6 | 是 G-3（`intent` 无作用面）与 G-5 的量化后果，非新缺口 |
| B-5 | 为 G-1 提供了一个真实案例 |

另需记一笔：`experiments/eval-runner/run.mjs` 有完整的运行与记录能力，
但**没有任何指标**——不读标准答案，不算召回。AutoScholarQuery 的
`answer_arxiv_id` 就在 `references/datasets/pasa/` 里躺着。
在建立这条评测回路之前，F-1 这类缺陷只能靠人肉会话偶然发现。

---

## 建议的修改顺序

按"单位改动量的信息增益"排序，不是按严重程度：

1. **F-1：arXiv 改 AND 拼接 + 记录实际查询串。**
   改动最小、收益最大，且 §1 已经给出可直接用作回归断言的期望值（0/4 → 3/4 单查询）。
2. **F-2：`AggregationError` 带上 `failures`。**
   让 agent 能区分限流 / 无结果 / 源故障。约十几行。
3. **F-3 第 1–2 步：注册 OpenAlex 免费 key，设 `OPENALEX_API_KEY` 与
   `OPENALEX_MAILTO`，OpenAlex 走直连。** 零代码，先不付费。
4. **建立召回评测回路**：AutoScholarQuery → eval runner 的转换脚本
   （含 F-5 的 `endDate` 映射）+ 按 `answer_arxiv_id` 计算 Recall@k。
   有了它，1–3 的效果可以被量化，后续的排序栈实验才有意义。
5. **F-4：`call_ledger` 接上 `cost_model` 与上游 `x-ratelimit-*` 头。**
   同时激活 §5.2 的"预算接近上限"checkpoint。
6. 之后再进入排序栈与判别器（G-5 / F-6）——**在 1 和 4 完成之前不要开始**。

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