# S10 起的 stage 定义与设计判断

> 状态：计划，尚未执行
> 读者：要决定下一步做什么、以及为什么是这个顺序的人
> 前置：`06-widi-scholar-roadmap.md` §3（S0–S9 的定义与"关于验收"那一节）、
> `06-progress.md`（状态与验收缺口 G-1..G-5）、`08-retrieval-defects.md`（F-1..F-11）
>
> **S11（Reviewer v0 与 $NP_0$ 重写）的定义不在本文**，在 `10-reviewer-v0.md`。
> 完整顺序：F-1/F-2/F-10 → S10 → S11 → S12。

**路径约定**：正文出现的裸文件名按下表还原，不再重复前缀。

| 写法 | 实际路径 |
| --- | --- |
| `index.ts` / `core/*.ts` | `widis/.widi-scholar/extensions/scholar-search/` 下 |
| `preference/*.md` | `widis/.widi-scholar/preference/` 下 |
| `config.yaml` | `src/search-service/config.yaml`（**只有这一份**，属于 Python 服务） |
| `run.mjs` | `experiments/eval-runner/run.mjs` |
| `aggregator.py` / `schemas/paper.py` / `api/*.py` | `src/search-service/src/search_service/` 下 |

---

`06-widi-scholar-roadmap.md` 的 S0–S9 已经全部执行完，它记的是**已经走过的路**。
本文另起一篇而不是往那份文件后面追加，理由有二：

1. S0–S9 是一个完成了的单元，把尚未执行的 stage 混进去会让"哪些真的跑过"变模糊；
2. 下面两个 stage 的**理由比定义本身长**。roadmap 的 stage 条目是刻意精简的，
   而 S10 / S12 各自涉及一个需要论证的架构选择，塞进那个格式会把论证挤掉。

stage 的格式沿用 roadmap §3：**目标 / 落点 / 做什么 / 验收 / 独立价值**。
roadmap §3 开头那段"关于验收"的告诫对本文同样有效，而且更要紧——
下面两个 stage 的判据是**先于实现**写的，正好可以避免 S5 和 S8 那种事后选判据的问题。

---

## 1. 为什么是这个顺序

### 1.1 S10 之前必须先修 F-1

`08-retrieval-defects.md` §1 给了实测：同一条主题查询，当前实现在
`AutoScholarQuery_train_1` 上召回 **0/4**，只把 arXiv 查询的词间连接从
隐含 OR 改成 AND 就变成 **3/4**，再加一条子查询到 **4/4**。

在 L0 召回层系统性漏掉正确答案的前提下：

- 答案池会忠实地记录一个残缺的答案，第一个 Recall@k 数字会难看得没有信息量；
- 判别器会在一个缺失正确答案的候选集上排序，J 轴测到的是噪声。

**所以 F-1（以及顺带的 F-2）不是 stage，是 S10 的前置条件。**
它改动很小——arXiv 查询拼接加 AND、把实际发出的查询串写进 `issued_queries`、
让 `AggregationError` 带上 `failures`——但不做它，后面两个 stage 的产出都不可信。

### 1.2 S10 排在 S12 之前

**答案池是测量仪器，判别器是被测对象。** 没有前者，后者的效果没法量化。

具体地：现在要拿 AutoScholarQuery 算 Recall@k，唯一的办法是从 agent 的散文里
正则抠 arXiv ID。这是个会静默劣化的仪器——agent 写"MetaBox+ 我没找到"，
正则照样把它算成命中。`experiments/eval-runner/run.mjs` 有完整的运行与记录能力，
但**没有任何指标**，原因就在这里：指标无处安放。

先把 $SO$ 变成数据，再谈改进 $SO$ 的质量。

### 1.3 S11 排在 S12 之前

这一条是 2026-08-21 三次会话之后加的，理由是一个负结果：
一次手工的 P 轴消融显示，**陈述式偏好条目在当前模型上的执行率接近于零**
（四条提示，三条完全没有被执行；召回从 1/4 变成 0/4）。
详见 `10-reviewer-v0.md` §2.2。

这意味着：把力气花在改进 Service 侧的判别质量（S12）之前，
先要解决"agent 根本不照着策略走"这个更前面的问题。
判别器再准，也纠正不了一个从头到尾只在一个错误方向上穷举关键词的检索。

同样的证据还显示，三次会话加起来 `facet_probe` / `rank_candidates` /
`search_fulltext` **一次都没被调用过**——九个工具里的三个诊断型工具全部闲置。
S11 的检测器直接针对这一点。

---

## 2. S10 — 结构化答案池与召回评测回路

**目标**：$SO$ 从散文变成数据，Recall@k 成为良定义的量。

**落点**：

- Service 侧：`src/search-service/src/search_service/schemas/paper.py` 提出
  `canonical_key()` 并给 `Paper` 加 `canonical_id` 字段；
  `aggregator.py` 的 `_deduplicate` 改调它（见 §2.3b）
- extension 侧：`widis/.widi-scholar/extensions/scholar-search/index.ts` 新增工具
  `update_answer_pool`，落盘 `${agentId}.answer.json`
  （与现有的 `${agentId}.json` / `${agentId}.review.json` 同目录、同命名族）
- `experiments/eval-runner/` 新增 AutoScholarQuery → queries 文件的转换脚本
  与按 `answer_arxiv_id` 计算 Recall@k 的评分脚本。
  数据在 `references/datasets/pasa/AutoScholarQuery/{train,dev,test}.jsonl`，
  每行的字段是 `question` / `answer` / `answer_arxiv_id` / `source_meta.published_time` / `qid`；
  `published_time` 就是 F-5 要求传给 `end_date` 的那个边界

**做什么**：见 §2.1–§2.5。

**验收**：

1. 跑 `AutoScholarQuery_train_1`，`${agentId}.answer.json` 存在且非空，
   其 id 集合与 `answer_arxiv_id` 的交集可直接计算，Recall@4 有确定取值；
2. 同一篇论文分别用 arXiv id 与 OpenAlex id 各加一次，池中只有一条
   （身份归一真的生效，见 §2.3）；
3. eval runner 在**一个 session** 里跑两条查询，产出两个 `.answer.json`，
   内容不交叉（agentId 作用域正确，见 §2.3）；
4. 池子的每一次变动出现在 $\bar{\tau}_t$ 里，Reviewer 的上下文能读到池子当前内容；
5. 一次带 `reason` 的移除落盘可读。

**这些判据不检验什么**（照 roadmap §3 的要求预先声明）：
判据只验"池子是可靠的记录器"，**不验 agent 是否恰当地使用它**——
放进去的是不是对的、什么时候放、漏没漏，那是 P 轴的测量对象，不是本 stage 的验收。
如果发现两者被混为一谈，按 roadmap §3 的规矩把差额写进"验收缺口"，不要放宽判据。

**独立价值**：第一个真实的 Recall@k 数字。到这里，
`08-retrieval-defects.md` §1 那个 0/4 → 4/4 的对照可以在完整系统上重跑一遍，
后续任何改动都有基线可比。

### 2.1 为什么值得做：三个理由，最强的是第二个

**一、结构化输出与产品形态**（提出时的初衷）。池子里每条带足够的字段，
UI 可以直接渲染可跳转的引用控件，不必二次抓取。这条成立，但它**只应影响一个决定**
——schema 一次写够（§2.4），其余别让它带节奏。

**二、benchmark 的测量仪器**（最强的理由）。见 §1.2。
这条把"要不要做"从偏好问题变成了必要性问题：不做它，J 轴、B 轴、E 轴
都没有可信的因变量。

**三、Reviewer 的作用面**（提出时未预见，但可能价值最高）。
G-1 记的问题是 review 挂在 `agent_idle` 上、$A_t$ 里的 $t$ 恒等于 $T+1$。
但比时机更根本的问题是：**episode 中途 Reviewer 没有东西可看**。
$\bar{\tau}_t$ 里是一串工具调用，"覆盖不足"要靠推断得出。

答案池改变了这一点。池中八篇全是 superpixel segmentation、
一篇 active learning 都没有——这正是 `design.md` §5.2 第三个 checkpoint
（检测到覆盖不足）**可以直接读出来**的形态。
而且因为池子的操作是工具调用，它天然流进 `tool_execution_start/end`，
$\bar{\tau}_t$ 不用改一行就能看见每次变动。

**四、$NP^{judge}$ 的标注数据**（同样是副产品）。agent 把一篇加进池子、
后来又拿掉并写下理由——这是一条**带出处的负例**。`design.md` §6 要求
"示例必须携带来源：取自真实轨迹的哪个 episode、哪次调用"，
而这个机制自动满足。判别准则的正反例不用手工攒，它从真实轨迹里长出来。

**所以移除必须带 `reason`，不是可选字段。**

### 2.2 它不是 Evidence Store，两者都还得做

`07-widi-mapping.md` §3.2 论证过 Evidence Store 必须在 Service 侧。
答案池是**另一个对象**，不要混：

| | Evidence Store（G-2） | 答案池（S10） |
| --- | --- | --- |
| 内容 | 见过的**所有**候选 | agent **承诺**的子集 |
| 用途 | 排序、去重、扩展的工作内存 | 输出契约 |
| 生命周期 | 与 `RunSnapshot` 同生共死 | 落盘，episode 结束后仍可读 |
| 位置 | 必须 Service 侧 | 可以 extension 侧 |
| 阻塞在什么上 | 需要 episode 标识穿过工具入参 | 无，现在就能做 |

§3.2 的三条理由套到答案池上：

1. **"放 extension 侧会把候选集搬进 Agent 的进程边界"** —— 基本不适用。
   池中只有 agent **已经看过并选定**的条目，不是候选集在往返搬运。
   但有一个衍生要求：读取操作必须返回**紧凑摘要**（计数 + id + 标题），
   不返回完整记录，否则等于把内容重新灌回上下文。
2. **"排序、去重、指标计算是领域算法，不该在 extension 里"** —— **这条咬人**。
   身份归一（同一篇论文经 arXiv id / OpenAlex id / DOI 进来）是 Service 已经
   实现的领域算法（`merge_papers`）。见 §2.3。
3. **"必须能进 $\bar{\tau}_t$"** —— 自动满足，见 §2.1 第三条。

**做答案池不抵消 G-2。**

### 2.3 落地上的四个决定

**一个工具，不是三个。** `update_answer_pool(add?, remove?, note?)`，增量调用。
$T^M$ 从 9 变 10 可以接受，变 12 就要重新论证——见 §4 的偏离记录 D-08。

**按 agentId 作用域，不是 session。** 这是个真陷阱：eval runner 在一个 session 里
per-query spawn 新 agent（`run.mjs` 的注释写明了理由：共享上下文会让查询 N
看到查询 N-1 的结果）。按 session 存会把所有查询的答案塌进一个池子，
每条查询的数字随之失去意义。现有代码已经做对了（`index.ts:298` 写
`${trace.agentId}.json`），照抄即可。

**身份归一经 Service，不在 extension 里自己做。** 这是 §2.2 第 2 条的直接后果，
也是唯一一处不能图省事的地方。具体通路见 §2.3b——**它比原先设想的要多一步，
因为现成的那个函数并不是身份归一算法。**

**池子不取代散文。** $SO$ = 散文答案 + 池子。池子是**可引用的底料**，散文才是回答。
2026-08-21 那次会话的方向分组（Superpixel Transformer / Region-based AL / …）
是有信息量的，全塌成平铺列表就丢了。每条的 `why` 字段承载这部分结构。

### 2.3b 身份归一的实际通路（2026-08-22 定，决策 D-13）

**先说一个纠正**：本文早先把 `merge_papers` 说成"Service 已经实现的身份归一算法"，
这是不准确的，照着做会卡住。核过源码之后的实际情况：

| 以为的 | 实际的 |
| --- | --- |
| `merge_papers` 做身份归一 | 它只做**字段合并**——把**已经判定为同一篇**的多条记录并成一条（`schemas/paper.py:160`） |
| Service 有归一入口 | 身份判定是 `aggregator.py:111` 的一行内联表达式，在私有方法 `_deduplicate` 里，不是可复用函数 |
| 调一下就行 | `api/` 下七个路由没有任何归一端点，`service-client.ts` 的九个方法也没有对应项 |

那行内联表达式是：

```python
key = paper.doi or paper.arxiv_id or paper.openalex_id or paper.paper_id
```

它还有一个隐含前提：**调用方必须已经持有完整的 `Paper`**，
因为它读的是 `doi` / `arxiv_id` / `openalex_id` 三个交叉 id 字段。
而 agent 往池子里加的时候手上只有一个 id 字符串。

**决定**：把这个表达式提成 Service 侧的公开函数，并让它的结果**作为字段出现在响应里**。

1. `schemas/paper.py` 新增 `canonical_key(paper: Paper) -> str`，就是上面那行；
   `aggregator._deduplicate` 改为调用它——**归一逻辑从此只有一处定义**。
2. `Paper` 增加 `canonical_id` 字段，由 `canonical_key` 计算。
3. extension 的 `update_answer_pool` 在 `add` 时调一次 **现成的** `get_paper`
   （`service-client.ts:790` 已有，`GET /paper/{paper_id}` 本来就是
   "ID 空间的读侧"，`api/paper.py` 的 docstring 写明了这一点），
   读回 `canonical_id` 落盘。

**代价：每次 `add` 多一次 API 调用。这是明确接受的。** 换来的是三件事——
extension 里不出现任何领域算法（守住 §2.2 第 2 条与 `AGENTS.md` §3.2）、
**不需要新增端点**、以及池中每条自动带上标题/年份/作者等 §2.4 要求的字段
（本来也要取，等于顺路）。

被否决的替代：在 extension 里复制那行 key 表达式。省一次调用，
但把领域算法复制成两份，且两份会各自漂移——这正是 §2.2 第 2 条要防的事。

**这条同时修掉一个既有隐患**：`_deduplicate` 里的归一规则目前没有任何
直接测试，只能通过聚合结果间接观察。提成函数之后它可以单测，
而 F-10（`expand_citations` 拒绝 DOI-URL 形态的 id）暴露的正是同一个
"ID 空间不自洽"的问题域。

### 2.4 schema 一次写够

每条至少：

```json
{"canonical_id": "...", "arxiv_id": "1810.09726", "doi": null,
 "title": "...", "authors": ["..."], "year": 2018, "venue": null,
 "url": "...", "why": "region-based AL 的开山工作，直接命中提问的方法范式",
 "added_at": "...", "added_by_tool_call": "call_..."}
```

`added_by_tool_call` 是把池子的每一条接回 $\bar{\tau}_t$ 的钩子——
没有它就无法回答"这篇是哪次检索找到的"，而发现溯源正是
`05-skill-decomposition.md` CF-S-10 给 PaperStore 列的职责之一。

现在多写六个字段几乎零成本，将来回填要重跑整个 episode。

### 2.5 "强制必须"怎么真的强制

写进 profile 正文是**弱约束**。2026-08-21 的会话已经证明了这一点
（`08-retrieval-defects.md` 的 B-4）：agent 在开场洋洋洒洒描述了
"诊断先行 / 覆盖优先 / 预算意识"的工作流，之后 37 次调用一步没走。
**声称不等于执行。**

真正的强制只有一条路：**让 benchmark 只读池子**。池子为空 = 该 episode
终止失败，进分母（S9 已经确立了"失败样本进分母"的做法）。
这样"强制"是结构性的，不是劝导性的。

补充一条软的：Reviewer 的固定动作集里加 `organize_answer`，
池子长期为空时可以触发。注意这要改 `core/review.ts` 的 `ADVICE_ACTIONS`，
属于对已冻结动作集的扩展，同样要记成决策。

### 2.6 两个代价，先说在前面

**一、它改变了环境，S9 之前的运行记录不再可比。** 加了这个工具之后，
agent 的 step 预算里多了一项开销，检索行为会变。这对 B/E/J/M 各轴**内部**
没问题（各组一致），但跟本 stage 之前跑过的任何数字都不能直接对照。
落地时把这一点记进 `06-progress.md`，免得将来有人跨这条线做对比。

**二、它会诱导 agent 过早承诺。** 池子存在会让 agent 倾向"先放进去再说"，
而 `np-agent.md` 的 `direction-coverage` 要求先覆盖方向再深入。
这是个**可测的**副作用，正好做成 P 轴的一条观察量：
池子的首次写入时机（第几个 tool call）与最终召回的相关性。
预先声明它，比事后发现它污染了结论要好。

---

## 3. S12 — $NP_k^{judge}$ 载体与 L3b 判别层

**目标**：判别准则成为可版本化、可消融的对象，L3b 真正接进排序栈。

### 3.1 当前做到哪一步

2026-08-21 merge 的 `aac617c` 加了 LLM provider 支持：
`llm/base.py` + `llm/providers/openai_compatible.py` + `llm/registry.py`，
经 `POST /judge` 转发，默认 provider 指向局域网 vllm。

**它是传输层，不是判别器。** `api/judge.py` 的 docstring 说得很坦白：

> This module **intentionally does not contain prompt templates or result parsing**;
> those belong in a separate judge-strategy layer.

这一步是必须的——在此之前 Search Service 根本没有调 LLM 的能力，
$NP^{judge}$ 的消费者无处安放。但它**只解开了阻塞，没有落地 NPj**。

一个必须守住的性质：**`/judge` 没有被注册成任何 agent 工具**，现在如此，
以后也应如此。理由见 §3.3。

### 3.2 还差四样

| 缺什么 | 现状 |
| --- | --- |
| **$NP^{judge}$ 的载体** | `preference/` 下只有 `np-agent.md`。而 `design.md` §6 要求判别准则的正反例与准则文本同属一个版本化对象 |
| **Configure 通路** | `config.yaml` 里没有放判别准则的地方，$NP_k^{judge} \to \theta^S_k$ 这条边不存在 |
| **L3b 接进排序栈** | `index.ts:827` 的 `judgeSupported: false` 仍然写死 |
| **判别结果进 provenance** | 判了哪些、判成什么档、花了多少 token，都得进 $\bar{\tau}_t$，否则 J 轴没有观测量 |

### 3.3 规格是齐的，排期是空的

`prototype.md` 对 L3b 的设计细到可以直接实现：

- **§4.1 三档**：L3a cross-encoder（$N_{sem}=100$）/ L3b LLM judge on abstract
  （$N_{judge}=30$，temperature 0，结构化输出）/ L3c fulltext（$N_{full}=8$，P0 默认关闭）
- **§4.2 加权准则制**：不给总分，对每条查询派生的带权准则逐条判
  $r_c(p) \in \{0,1,2,3\}$，合成 $s_{judge}$ 后按 $0.25/0.67/0.99$ 离散回四档；
  输出带 `rubric_version` / `criteria_version` / `model_version`
- **J 轴**：J0–J3 加上 J2'（judge 蒸馏后的 L2 打分器，线上不调 judge）
- 连"judge 失败不惩罚被评方：单篇失败就跳过该篇，且先判全部再取 top-k"都写了

**但 `06-widi-scholar-roadmap.md` 的 stage 定义停在 S9，没有对应 stage。**
设计上是核心组件，工程上一个 stage 都没排——这正是 G-5 与
`08-retrieval-defects.md` F-6 说的同一件事的成因。

**判别器不会成为第十一个工具。** `prototype.md` §7.1 的工具表下面写明：

> `judge_level` 取 `off` / `auto` / `l3a` / `l3b` / `l3c`。
> **决定花多少预算做判别是 Agent 的策略，执行判别是 Service 的实现**——
> 这是 `judge_level` 出现在签名里、而模型与 prompt 不出现的原因。

`05-skill-decomposition.md` 给 `cf.papers.judge_relevance` 的归属是 `SVC`
而非 `TOOL`，备注写死"由 `judge_level` 控制，**Agent 不直接调**"；
§5 结论一也说"94 条里没有一条要求新工具"。
§4 结尾那条警告是同一个判断：一旦判别器变成 agent 能直接调的工具，
决策就搬进了工具内部的固定 prompt，既不进 $\bar{\tau}_t$ 也不受 $NP_k^{agent}$ 影响，
"轨迹上看还是 ReAct，实际决策发生在工具内部"。

### 3.4 stage 定义

**目标**：见 §3 开头。

**落点**：

- `widis/.widi-scholar/preference/np-judge.md`（新，与 `np-agent.md` 同构，带版本注释）
- Service 侧判别策略层：prompt 模板 + §4.2 的结构化输出解析，建在 `llm/` 之上
- `config.yaml` 增加判别准则的注入位（$NP_k^{judge}$ 经 `Configure` 进 $\theta^S_k$）
- `judge_level` 从自陈无能改为真实生效

**做什么**：照 `prototype.md` §4.1/§4.2 实现，不要自创打分方案。
采样参数、prompt 模板版本、准则版本从第一天就进 `config.yaml` 并进 provenance
（见 `07-widi-mapping.md` §3.5 结尾那条约定）。

**验收**：

1. 给定一条查询准则与一篇论文，判别层返回 `prototype.md` §4.2 那个 JSON 结构，
   且 `rubric_version` / `criteria_version` / `model_version` 三个字段可追溯；
2. `judge_level=l3b` 时 `judgeSupported: true`，实际判别篇数写进 `SearchState`
   并出现在 $\bar{\tau}_t$；
3. **改一条 `np-judge.md` 的条目能改变判别输出**——这条验的是载体真的有作用面，
   而不只是文件存在；
4. J0 与 J2 在同一批查询上的 Recall@k 都被记录下来（见 §3.5，这是硬要求）。

**这些判据不检验什么**：判别质量本身。判得准不准是 J 轴实验的结论，
不是本 stage 的验收；混淆两者会重演 S8 的模式。

**独立价值**：J 轴实验的 J2 组具备；$NP^{judge}$ 侧的偏好学习有了作用面。

### 3.5 一条与我们的 benchmark 直接冲突的硬要求

`prototype.md` §6（评价协议实例化）里有一条必须现在就钉进判据：

> **judge 的两个特殊要求**：必须报告 judge-free 消融（J0/J1 对 J2/J3），
> 因为**若 benchmark 的 gold 由 LLM 生成或校验，用 LLM judge 排序会系统性虚高**。

AutoScholarQuery 的 gold 正是这种构造方式（问题由 LLM 从论文相关工作章节生成）。
所以这条对本项目**不是理论风险，是直接适用**：一旦接上 L3b，
J2/J3 相对 J0/J1 的提升里会混进一部分同源偏差，不做 judge-free 对照
就没法把它剥掉。

**值得在写代码之前就钉进判据里，而不是等跑出好看的数字之后再回头质疑。**
这是本文所有判据里最容易被"反正数字变好了"冲掉的一条。

---

## 4. 偏离记录

roadmap §4 要求"stage 执行中做出的、路线图没有规定的选择"记进
`06-progress.md` 的决策记录。下面两条是**在计划阶段**就已经确定的偏离，
先记在这里，落地时同步一条 `D-nn`。

### D-08（待落地）— $T^M$ 从九个工具变成十个

**偏离的对象**：`prototype.md` §7.1 冻结了九个工具；
`05-skill-decomposition.md` §5 结论一明确说"94 条里没有一条要求新工具"。

**理由**：那九个是**检索**工具，答案池是**输出**机制，属于不同范畴。
05 的结论一是对着 94 条检索指导得出的，它的作用域不覆盖"$SO$ 以什么形式产出"。
现在 $SO$ 是散文，而散文不可测——这是 05 当时没有面对的问题。

**代价**：任何拿工具数量或工具集构成做对照的实验，跨 S10 这条线都不可比。
`06-progress.md` 里 S5 的验收判据正是"调用构成"，因此**S5 的数字不能与
S10 之后的运行直接比较**。

**被否决的替代方案**：从 agent 的最终散文里解析论文列表。
否决理由见 §1.2——这是个会静默劣化的仪器，而且它把测量的正确性
押在了 agent 的输出格式上。

### D-13（待落地）— 身份归一提成 Service 公开函数，`add` 接受一次额外调用

全文见 §2.3b。一句话：`merge_papers` 不是身份归一算法，
真正的规则是 `aggregator.py:111` 的一行内联表达式；把它提成
`canonical_key()` 并作为 `canonical_id` 字段随 `get_paper` 返回，
extension 每次 `add` 多调一次 API 换取"领域算法只有一处定义"。

**代价**：每次 `add` 一次网络往返，计入 `call_ledger`。
**被否决的替代**：在 extension 里复制 key 表达式。

### D-09（已发生）— LLM provider 层是计划外的提前投入

**事实**：`aac617c` 在 roadmap 没有对应 stage 的情况下加了 765 行代码。

**为什么不算问题**：它解开的是一个真实阻塞（Service 无法调 LLM），
而且守住了关键性质（`/judge` 没有被注册成 agent 工具）。

**为什么仍要记**：这段代码**没有对应的验收判据**。
现在测的是"转发通不通"（`test_judge.py` + `test_llm_registry.py`，126 passed），
而 `prototype.md` §4 要求的是"按准则分级、可归因、带版本号"——
两者差着一整个判别策略层。这正是 `06-progress.md` 里 `DONE†` 那个模式的成因：
**判据缺席时，能力缺口会以"看起来完成了"的形式沉淀下来。**

所以 S12 的验收判据（§3.4）不应该是"`/judge` 能返回 200"。

---

## 5. 本文范围之外

这几件事被讨论过但**不进 S10/S12**，记下来免得后面重新捡起：

- **U-03 / 采样参数固定**：卡的是调用点 A（Main 的推理），
  见 `07-widi-mapping.md` §3.5。它不能靠"封装进 Search Service"绕过，
  需要用户授权改 vendored 的 `packages/agent`。与本文两个 stage 正交。
- **G-2 Evidence Store**：答案池不抵消它，见 §2.2。它需要 episode 标识
  穿过工具入参，是独立的一件事。
- **G-1 Reviewer 时机**：S10 给它造出了作用面（§2.1 第三条），
  但**没有修它**——review 仍然挂在 `agent_idle` 上。
  把 checkpoint 判定移到工具执行边界是 **S11**，见 `10-reviewer-v0.md` §5.3。
- **产品化 UI**：只影响 §2.4 的 schema 决定，其余不进计划。
