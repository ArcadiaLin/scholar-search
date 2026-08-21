# 决策记录

> 读者：想知道"为什么是这样定的"、或者正准备推翻某个选择的人
> 规矩：**不要推翻已记录的决策，除非它被证明是错的。** 推翻时在原条目下追加，
> 不要删除原文——被否决的替代方案本身就是资产。

每条的格式：决定了什么 → 理由 → 代价 → 被否决的替代方案。
编号 `D-nn` 全局唯一，与 `G-`（验收缺口）、`F-`（检索缺陷）、`U-`（上游缺陷）、
`SV-`（Service 缺陷）、`E-`（环境）分开。

---

## 1. 待落地的决策（S10 起）

这些是在**计划阶段**就已经确定的，落地时不需要重新论证，直接照做。

### D-08 — $T^M$ 从九个工具变成十个

**决定**：新增 `update_answer_pool`，$T^M$ 从 9 变 10。

**偏离的对象**：`prototype.md` §7.1 冻结了九个工具；
`skill-decomposition.md` §5 结论一明确说"94 条里没有一条要求新工具"。

**理由**：那九个是**检索**工具，答案池是**输出**机制，属于不同范畴。
结论一是对着 94 条检索指导得出的，它的作用域不覆盖"$SO$ 以什么形式产出"。
现在 $SO$ 是散文，而散文不可测——这是当时没有面对的问题。

**代价**：任何拿工具数量或工具集构成做对照的实验，跨 S10 这条线都不可比。
S5 的验收判据正是"调用构成"，因此 **S5 的数字不能与 S10 之后的运行直接比较**。

**被否决的替代**：从 agent 的最终散文里解析论文列表。否决理由是它会静默劣化
（agent 写"MetaBox+ 我没找到"，正则照样算命中），而且把测量的正确性押在了
agent 的输出格式上。

**变到 12 个工具就要重新论证**，不要把它当成放开的口子。

### D-13 — 身份归一提成 Service 公开函数，`add` 接受一次额外调用

**决定**：把身份归一规则提成 Service 侧的公开函数，结果作为字段随响应返回；
extension 每次 `add` 多调一次现成的 `get_paper`。

**先说一个纠正**，否则照着旧说法做会卡住。此前文档写"身份归一是 Service 已经
实现的领域算法（`merge_papers`）"，**这是不准确的**：

| 以为的 | 实际的 |
| --- | --- |
| `merge_papers` 做身份归一 | 它只做**字段合并**——把**已经判定为同一篇**的多条记录并成一条（`schemas/paper.py:160`） |
| Service 有归一入口 | 身份判定是 `aggregator.py:111` 的一行内联表达式，在私有方法 `_deduplicate` 里，不是可复用函数 |
| 调一下就行 | `api/` 下七个路由没有任何归一端点，`service-client.ts` 的九个方法也没有对应项 |

那行内联表达式是：

```python
key = paper.doi or paper.arxiv_id or paper.openalex_id or paper.paper_id
```

它还有一个隐含前提：**调用方必须已经持有完整的 `Paper`**，因为它读的是
`doi` / `arxiv_id` / `openalex_id` 三个交叉 id 字段。而 agent 往池子里加的时候
手上只有一个 id 字符串。

**落地三步**：

1. `schemas/paper.py` 新增 `canonical_key(paper: Paper) -> str`，就是上面那行；
   `aggregator._deduplicate` 改为调用它——**归一逻辑从此只有一处定义**；
2. `Paper` 增加 `canonical_id` 字段，由 `canonical_key` 计算；
3. extension 的 `update_answer_pool` 在 `add` 时调一次**现成的** `get_paper`
   （`service-client.ts:790` 已有，`GET /paper/{paper_id}` 本来就是"ID 空间的读侧"，
   `api/paper.py` 的 docstring 写明了这一点），读回 `canonical_id` 落盘。

**代价**：每次 `add` 多一次 API 调用，计入 `call_ledger`。**这是明确接受的。**
换来三件事——extension 里不出现任何领域算法（守住 `AGENTS.md` §3.2）、
**不需要新增端点**、以及池中每条自动带上标题/年份/作者等 schema 要求的字段
（本来也要取，等于顺路）。

**被否决的替代**：在 extension 里复制那行 key 表达式。省一次调用，
但把领域算法复制成两份，且两份会各自漂移。

**顺带修掉一个既有隐患**：`_deduplicate` 里的归一规则目前没有任何直接测试，
只能通过聚合结果间接观察。提成函数之后它可以单测，
而 F-10（`expand_citations` 拒绝 DOI-URL 形态的 id）暴露的正是同一个
"ID 空间不自洽"的问题域。

### D-10 — Reviewer 常驻，随 search agent 一起启动

**决定**：Reviewer 不再"每次 checkpoint spawn 一个"，而是在 `agent_spawned`
观察到 `profile.id === "search"` 时起来，episode 全程存活。

**理由**（全文见 `../reviewer-design.md` §5.2b）：常驻不是性能妥协，
而是更贴合 $C^R_t$ 这个**带 $t$ 下标**的记号——Reviewer 的上下文本来就是随 $t$
演化的，"每次新起一个无记忆的 Reviewer"反而是对形式化的削弱。
并且它解锁了用户直接与 Reviewer 对话这条通道，而人工 review 动作正是 $NP_0$
的种子来源。

**推翻的是什么**：此前记的是"先按每次新起做，复用留作优化"。那个判断的依据
（担心跨 checkpoint 记忆破坏旁路定位）是错的。

**三条机械约束**写在 `reviewer-design.md` §5.2b，实现时按那里做：
子 agent 而非并列 main、`prompt` 忙时被拒（只影响 extension → Reviewer 方向）、
生命周期 = episode 而非 session。

### D-11 — 触发源取"答案池更新"与"七个检测器"的并集

**决定**：两个触发源取并集，检测器是**地板**。

**理由**：只用答案池会让 Main **间接控制介入率**——不写池子就不被审查，
于是 $\Delta_{\mathrm{sidecar}}$ 的归因重新变成内生的。这正是 `mapping.md` §3.4
否决 `ask_reviewer` 方案时担心的那件事。不管 Main 写不写池子，R1–R7 到了条件就触发。

**一个相关的可测风险**：Main 若学到"写池子会召来 Reviewer"，可能少写或多写。
观察量是"池子首次写入时刻"与"池子写入次数"，与 `plan.md` §3.8 第二条合并观察即可。

### D-12 — $NP_0$ 重写后分两组，不追求某个条目数

**决定**：$NP_0$ 分成绑定组 A（带 `observable:` 元数据，**P 轴的消融只作用于这一组**）
与未绑定组 B（标 `observable: none`，**排除在消融之外**，各自写清为什么暂时绑不了）。

**理由**：原先的问法（"会从 30 条降到多少"）本身就问错了——答案不该是一个数字，
而该是一个划分。这样处理有四个好处：不丢失 `skill-decomposition.md` 追溯到的
CF-\* 出处；P 轴作用在一个良定义的集合上；B → A 的提升成为一条具体的、
可增量推进的工作队列；条目数这个问题自然消失。

**可绑定的判据**，一句话：

> 一条条目可绑定，当且仅当**关掉它会让轨迹不同**。
> 关掉它轨迹一模一样的条目，按构造就是不可观察的。

值得注意的是：**这与 S5 的消融判据是同一条**。它顺带解释了 S5 那次
"轨迹形状明显不同"为什么难验——如果当时 30 条里多数是不可绑定的，
"关掉全部条目轨迹不变"本就是预期结果，而不是实现出了问题。

落地时把 A / B 的划分结果同步进 `experiments.md` 的 P 轴定义。

### D-14 — 取消 `MAX_REVIEWS_PER_AGENT`，只限建议条数

**决定**：删除 `index.ts:272` 的 `MAX_REVIEWS_PER_AGENT`，不保留、也不改成别的数。

**理由**：此前写的是"从 1 提到与 gate 的 episode 上限一致（6）"，
这是把两个不同的量当成了一个：

| 量 | 计什么 | 处置 |
| --- | --- | --- |
| `MAX_REVIEWS_PER_AGENT` | review **轮次** | 取消 |
| `DEFAULT_MAX_PER_EPISODE = 6` | 放行的**建议条数** | 保留（`core/review.ts:38`） |

两者都设成 6 会得到一个坏结果：第一个 checkpoint 若一次吐满 6 条，
就把整个 episode 的建议预算耗尽，后面五次触发全部空转——
**而越靠后的 checkpoint 掌握的轨迹越多，建议本该越准。**

正确的边界只有一个：**限建议条数，不限观察次数。** 这也更贴合
"Reviewer 是旁路观察者"的定位——观察本身不该有配额，介入才该有。

轮次的天然上限来自检测器的形状：R1–R7 各自只在条件**从未触发变为触发**时
投递一次，所以轮次不会无界增长。

### D-15 — 检测器阈值进 Service 的 `config.yaml`，检测器逻辑留在 extension

**决定**：阈值进 `src/search-service/config.yaml` 的 `review:` 段，
经一个只读端点取回；检测器逻辑留在 `core/review.ts`。

**先纠正一处会让实施者卡住的说法**：此前写"检测器阈值进 `config.yaml` 作为 $HP$
落位"，但 `config.yaml` 只有一份、在 `src/search-service/`、属于 **Python 服务**，
而检测器要写在 **TypeScript extension** 里，且 extension 的配置来源**全部是环境变量**
（`SCHOLAR_TRACE_DIR` / `SCHOLAR_REVIEWER` / `SCHOLAR_REVIEWER_MODEL`），
代码里一次 yaml 都没有。原来那句话指的是一条**不存在的通路**。

**为什么阈值该去 Service**：它们是 $HP_k$，而 $HP_k$ 的唯一权威载体就是
`config.yaml`（$\theta^S_k = \mathrm{Configure}(P, HP_k, NP_k^{judge})$ 这条边的
起点在那里）。散在环境变量里会让 $HP$ 搜索无从下手。沿用 D-13 的口径：
**多一次 API 调用是明确接受的**，一个 episode 只调一次。

**为什么逻辑不该去 Service**（这条要写清楚，否则后来的人会以为"既然阈值都去了，
逻辑也该去"然后动手搬）：检测器读的是 `PublicSearchTrace`——一个由 WIDI 事件流
装配出来的 **extension 侧类型**（`core/trajectory.ts`）。搬进 Service 就必须在
Python 里镜像一份它的 schema，于是 Service 被绑死在 WIDI 的事件形状上，
正好撞上 `search-service.md` 开篇立的"不绑定任何具体数据源、算法或指标"。

**判据**：阈值是数据，跨进程传是廉价的；轨迹是结构，跨进程传要复制 schema。

### D-09 — LLM provider 层是计划外的提前投入（已发生）

**事实**：`aac617c` 在路线图没有对应 stage 的情况下加了 765 行代码。

**为什么不算问题**：它解开的是一个真实阻塞（Service 无法调 LLM），
而且守住了关键性质（`/judge` 没有被注册成 agent 工具）。

**为什么仍要记**：这段代码**没有对应的验收判据**。现在测的是"转发通不通"
（`test_judge.py` + `test_llm_registry.py`，126 passed），而 `prototype.md` §4
要求的是"按准则分级、可归因、带版本号"——两者差着一整个判别策略层。
这正是 `DONE†` 那个模式的成因：**判据缺席时，能力缺口会以"看起来完成了"的形式
沉淀下来。** 所以 S12 的验收判据不应该是"`/judge` 能返回 200"。

---

## 2. 已执行的决策（S0–S9）

这些决策已经落地在代码里，列在这里主要是为了**不被重新论证或误改**。

### D-07 — $SI_k$ 的注入点选 `projectContext` 静态注入，不选 `input` interceptor

**理由**：

1. **它已经被验证可用，且不需要写代码。** S4 的验收就是这条路径：
   模型逐字引用了注入文件里的 `np-version`，0 次工具调用。
   `AGENTS.md` §3.2 禁止预建无调用方的框架——interceptor 现在没有
   `projectContext` 做不到的事。
2. **消融操作面正好匹配。** "全关 vs 全开"在 `projectContext` 下是一次配置改动
   或一次文件改动，两者都留在 git diff 里可审计。interceptor 要另造一个开关，
   而那个开关自己又不在版本控制的语义里。
3. **interceptor 会引入一个正确性风险而当前换不来收益。**
   `input` interceptor 也会收到 agent 与 runtime 注入的消息，必须检查 `event.source`。
   漏检就会把条目重复注入进每一条中间消息，或者把 agent 自己的输出当成 $RQ$。

关于 $SI_k = \mathrm{Compose}(RQ, NP_k^{agent})$ 的形式：`projectContext`
把 $NP_k$ 放进系统提示词，$RQ$ 作为用户消息到达，模型的实际输入是两者的函数——
Compose 在语义上成立，不要求两者被拼接成同一个字符串。

**什么时候必须改成 interceptor**（记下来免得将来重新论证）：出现"每个 episode
生效的条目集合不同"的需求时。具体是两种情况——Reviewer 在 episode 中途改写条目
集合，或者按 $\theta^S_k$ 过滤条目。这两种都需要在请求时点动态组装，
静态注入做不到。**S11 的 D-12 分组暂时不触发这条**：A/B 分组是文件内的静态标注，
不是每 episode 变化的集合。

### D-06 — 改 `src/search-service/` 不违反 Extension First

**这条是一条持续有效的规则，不只是一次性决定。**

`AGENTS.md` §3.1 限制的是 `packages/widi/`（WIDI runtime）。
Search Service 按映射表本来就是"已有的 Python HTTP 服务"，
是这条架构里的一个正式部件，改它不触发 §3.1 的两个例外条件。

起因是 S2：路线图的落点只写了 extension，隐含假设 Service 已经提供三个工具
需要的一切，实际不成立（`get_paper` 根本没有单篇端点，`search_metadata`
没有 `subqueries` 参数）。

**被否决的替代**：

- **用 `/search` 模拟 `get_paper`**：`/search` 是关键词检索，不是 ID 精确查找。
  拿 DOI 当关键词去搜，命中不保证是同一篇。这是把"能跑"当成"对"。
- **在 extension 里用 passthrough 拼 `get_paper`**：那要求 extension 知道
  "openalex 的单篇路径是 `works/{id}`、arXiv 的是 `id_list=`"，
  即把 provider 语法搬进 extension。
- **不做 `subqueries`，让签名里留个空参数**：签名里有、行为上没有，等于骗调用方。
  要么实现，要么像 `judge_level` 那样显式报告不支持。

### D-05 — fixture 用真实录制的服务响应，不手写

`tests/fixtures/providers.json` 是从真实 `GET /providers` 录下来的
（录制命令与日期写在 `tests/fixtures/README.md`），不是照 pydantic 模型手写的。

手写 fixture 会跟着写的人对 schema 的理解走，测的就变成"我以为服务返回什么"；
录制的会在服务真的改了 schema 时让解析测试红掉，那才是想要的信号。

保留 `serper`（配置了但 `enabled: false`）是刻意的：
"配置了但停用"和"不存在"必须能被 `list_providers` 区分开。

### D-01 / D-02 / D-03 / D-04 — S0–S1 执行期的四条一次性选择

已经完成且不再影响后续工作，压缩成一句话各一条：

- **D-01** — S0 的验收改用 RPC 无头驱动而非交互式 TUI，因为执行路线的 agent
  无法驱动 TUI；验证的是同一套 `models.json` / `settings.json` 解析与同一个
  provider 客户端，覆盖面不弱且可复现。**边界**：这不是 S9，驱动脚本停在
  scratchpad 不进 Git。
- **D-02** — 修 `scripts/run-widi.mjs` 不违反 Extension First：它是**父仓库自己的**
  启动脚本，不是 WIDI 上游代码，也不是 extension 能表达的东西。
- **D-03** — commit hash 由紧随其后的 docs-only commit 补录（进度文件本身要记
  它所描述的那个 commit 的 hash，存在先有鸡还是先有蛋的问题）。
- **D-04** — S1 的真实链路验收用一次性 profile 脚手架（`profiles/zz-s1-smoke.md`），
  跑完即删并还原 `settings.json`，以免侵占 S3 的落点。
