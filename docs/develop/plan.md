# 推进计划

> 读者：要决定下一步做什么、并按顺序把它做完的人
> 状态来源：本文是 stage 定义与顺序的唯一出处
> 前置：`README.md`（当前位置与命令）、`backlog.md`（F-\* 缺陷与 G-\* 缺口）

S0–S9 已经全部执行完，记录在 `history.md`。本文只写**还没做的部分**。

---

## 1. 路径

```
前置修复          S10              S11              S12
F-1 / F-2 / F-10  答案池 +         Reviewer v0 +    NP_judge 载体 +
                  召回评测回路      NP_0 重写        L3b 判别层
   §2               §3               §4               §5
```

四段是线性依赖，不要并行，理由见 §6。

**路线图之外的两件事**（G-2 Evidence Store、U-03 采样固定）与这四段正交，
见 §7。

---

## 2. 前置修复：F-1 / F-2 / F-10

**这三条不是 stage，是 S10 的前提条件。** 缺陷详情、证据与复现命令在
`backlog.md`，这里只说为什么必须先做。

`backlog.md` §1 给了实测：同一条主题查询，当前实现在
`AutoScholarQuery_train_1` 上召回 **0/4**，只把 arXiv 查询的词间连接从隐含 OR
改成 AND 就变成 **3/4**，再加一条子查询到 **4/4**。

在 L0 召回层系统性漏掉正确答案的前提下：

- 答案池会忠实地记录一个残缺的答案，第一个 Recall@k 数字难看得没有信息量；
- 判别器会在一个缺失正确答案的候选集上排序，J 轴测到的是噪声。

| # | 改什么 | 改动量 | 为什么必须在 S10 之前 |
| --- | --- | --- | --- |
| **F-1** | arXiv 查询词间连接改 AND；把**实际发出**的查询串写进 `SearchState.issued_queries`；加回归断言"响应 `<title>` 里不出现 ` OR `" | 小 | 召回层从根上失效，后面每个数字都不可信 |
| **F-2** | `AggregationError` 带上 `failures`；`index.ts:178` 那句无条件的 "Another source may still be able to answer." 改成有条件 | 十几行 | agent 无法区分限流 / 无结果 / 源故障，检测器 R5 也就没有输入 |
| **F-10** | Service 侧统一 id 归一，`expand_citations` 复用 `get_paper` 已有的解析能力；无法解析的种子返回 `[bad_id]` 并说明接受哪些形式 | 中 | **S11 的 R4 检测器以它为前提**——扩展工具坏着的时候，"建议去做引文扩展"是有害建议 |

**验收**：`backlog.md` §1 那个 0/4 → 4/4 的对照在完整系统上重跑一遍，
数字可复现。

---

## 3. S10 — 结构化答案池与召回评测回路

**目标**：$SO$ 从散文变成数据，Recall@k 成为良定义的量。

### 3.1 落点

**Service 侧**

- `src/search-service/src/search_service/schemas/paper.py`：提出
  `canonical_key(paper: Paper) -> str`，并给 `Paper` 加 `canonical_id` 字段
- `src/search-service/src/search_service/aggregator.py`：`_deduplicate` 改调
  `canonical_key()`，归一逻辑从此只有一处定义

**extension 侧**

- `widis/.widi-scholar/extensions/scholar-search/index.ts`：新增工具
  `update_answer_pool`，落盘 `${agentId}.answer.json`
  （与现有的 `${agentId}.json` / `${agentId}.review.json` 同目录、同命名族）

**评测侧**

- `experiments/eval-runner/`：AutoScholarQuery → queries 文件的转换脚本，
  与按 `answer_arxiv_id` 计算 Recall@k 的评分脚本

  数据在 `references/datasets/pasa/AutoScholarQuery/{train,dev,test}.jsonl`，
  每行字段是 `question` / `answer` / `answer_arxiv_id` /
  `source_meta.published_time` / `qid`；`published_time` 就是 F-5 要求传给
  `end_date` 的那个边界。

### 3.2 落地上的四个决定

**一个工具，不是三个。** `update_answer_pool(add?, remove?, note?)`，增量调用。
$T^M$ 从 9 变 10 可以接受，变 12 就要重新论证——见 `decisions.md` D-08。

**按 agentId 作用域，不是 session。** 这是个真陷阱：eval runner 在一个 session 里
per-query spawn 新 agent（`run.mjs:208` 的注释写明了理由：共享上下文会让查询 N
看到查询 N-1 的结果）。按 session 存会把所有查询的答案塌进一个池子，
每条查询的数字随之失去意义。现有代码已经做对了（`index.ts:298` 写
`${trace.agentId}.json`），照抄即可。

**身份归一经 Service，不在 extension 里自己做。** 通路见 `decisions.md` **D-13**——
它比原先设想的多一步，因为现成的 `merge_papers` **并不是身份归一算法**。

**池子不取代散文。** $SO$ = 散文答案 + 池子。池子是**可引用的底料**，散文才是回答。
2026-08-21 那次会话的方向分组（Superpixel Transformer / Region-based AL / …）
是有信息量的，全塌成平铺列表就丢了。每条的 `why` 字段承载这部分结构。

### 3.3 schema 一次写够

```json
{"canonical_id": "...", "arxiv_id": "1810.09726", "doi": null,
 "title": "...", "authors": ["..."], "year": 2018, "venue": null,
 "url": "...", "why": "region-based AL 的开山工作，直接命中提问的方法范式",
 "added_at": "...", "added_by_tool_call": "call_..."}
```

`added_by_tool_call` 是把池子的每一条接回 $\bar{\tau}_t$ 的钩子——
没有它就无法回答"这篇是哪次检索找到的"，而发现溯源正是
`skill-decomposition.md` CF-S-10 给 PaperStore 列的职责之一。

现在多写六个字段几乎零成本，将来回填要重跑整个 episode。

**移除必须带 `reason`，不是可选字段。** 理由见 §3.5 第四条。

### 3.4 "强制必须"怎么真的强制

写进 profile 正文是**弱约束**。2026-08-21 的会话已经证明了这一点
（`backlog.md` 的 B-4）：agent 在开场洋洋洒洒描述了"诊断先行 / 覆盖优先 /
预算意识"的工作流，之后 37 次调用一步没走。**声称不等于执行。**

真正的强制只有一条路：**让 benchmark 只读池子**。池子为空 = 该 episode
终止失败，进分母（S9 已经确立了"失败样本进分母"的做法）。
这样"强制"是结构性的，不是劝导性的。

补充一条软的：Reviewer 的固定动作集里加 `organize_answer`，池子长期为空时触发。
注意这要改 `core/review.ts` 的 `ADVICE_ACTIONS`，属于对已冻结动作集的扩展，
同样要记成决策。

### 3.5 为什么值得做：四个理由，最强的是第二个

**一、结构化输出与产品形态**（提出时的初衷）。池子里每条带足够的字段，
UI 可以直接渲染可跳转的引用控件，不必二次抓取。这条成立，但它**只应影响一个决定**
——schema 一次写够（§3.3），其余别让它带节奏。

**二、benchmark 的测量仪器**（最强的理由）。现在要拿 AutoScholarQuery 算 Recall@k，
唯一的办法是从 agent 的散文里正则抠 arXiv ID。这是个会静默劣化的仪器——
agent 写"MetaBox+ 我没找到"，正则照样把它算成命中。
`experiments/eval-runner/run.mjs` 有完整的运行与记录能力，但**没有任何指标**，
原因就在这里：指标无处安放。**先把 $SO$ 变成数据，再谈改进 $SO$ 的质量。**

**三、Reviewer 的作用面**（提出时未预见，但可能价值最高）。G-1 记的问题是 review
挂在 `agent_idle` 上、$A_t$ 里的 $t$ 恒等于 $T+1$。但比时机更根本的问题是：
**episode 中途 Reviewer 没有东西可看**。$\bar{\tau}_t$ 里是一串工具调用，
"覆盖不足"要靠推断得出。

答案池改变了这一点。池中八篇全是 superpixel segmentation、一篇 active learning
都没有——这正是 `design.md` §5.2 第三个 checkpoint（检测到覆盖不足）
**可以直接读出来**的形态。而且因为池子的操作是工具调用，它天然流进
`tool_execution_start/end`，$\bar{\tau}_t$ 不用改一行就能看见每次变动。

**四、$NP^{judge}$ 的标注数据**（同样是副产品）。agent 把一篇加进池子、后来又拿掉
并写下理由——这是一条**带出处的负例**。`design.md` §6 要求"示例必须携带来源：
取自真实轨迹的哪个 episode、哪次调用"，而这个机制自动满足。
判别准则的正反例不用手工攒，它从真实轨迹里长出来。

### 3.6 它不是 Evidence Store，两者都还得做

`mapping.md` §3.2 论证过 Evidence Store 必须在 Service 侧。
答案池是**另一个对象**，不要混：

| | Evidence Store（G-2） | 答案池（S10） |
| --- | --- | --- |
| 内容 | 见过的**所有**候选 | agent **承诺**的子集 |
| 用途 | 排序、去重、扩展的工作内存 | 输出契约 |
| 生命周期 | 与 `RunSnapshot` 同生共死 | 落盘，episode 结束后仍可读 |
| 位置 | 必须 Service 侧 | 可以 extension 侧 |
| 阻塞在什么上 | 需要 episode 标识穿过工具入参 | 无，现在就能做 |

`mapping.md` §3.2 的三条理由套到答案池上：

1. **"放 extension 侧会把候选集搬进 Agent 的进程边界"** —— 基本不适用。
   池中只有 agent **已经看过并选定**的条目，不是候选集在往返搬运。
   但有一个衍生要求：读取操作必须返回**紧凑摘要**（计数 + id + 标题），
   不返回完整记录，否则等于把内容重新灌回上下文。
2. **"排序、去重、指标计算是领域算法，不该在 extension 里"** —— **这条咬人**，
   见 §3.2 第三条与 D-13。
3. **"必须能进 $\bar{\tau}_t$"** —— 自动满足，见 §3.5 第三条。

**做答案池不抵消 G-2。**

### 3.7 验收

1. 跑 `AutoScholarQuery_train_1`，`${agentId}.answer.json` 存在且非空，
   其 id 集合与 `answer_arxiv_id` 的交集可直接计算，Recall@4 有确定取值；
2. 同一篇论文分别用 arXiv id 与 OpenAlex id 各加一次，池中只有一条
   （身份归一真的生效）；
3. eval runner 在**一个 session** 里跑两条查询，产出两个 `.answer.json`，
   内容不交叉（agentId 作用域正确）；
4. 池子的每一次变动出现在 $\bar{\tau}_t$ 里，Reviewer 的上下文能读到池子当前内容；
5. 一次带 `reason` 的移除落盘可读。

**这些判据不检验什么**（照 §8 的要求预先声明）：判据只验"池子是可靠的记录器"，
**不验 agent 是否恰当地使用它**——放进去的是不是对的、什么时候放、漏没漏，
那是 P 轴的测量对象，不是本 stage 的验收。如果发现两者被混为一谈，
按 §8 的规矩把差额写进 `backlog.md` 的验收缺口，不要放宽判据。

**独立价值**：第一个真实的 Recall@k 数字。到这里，`backlog.md` §1 那个
0/4 → 4/4 的对照可以在完整系统上重跑一遍，后续任何改动都有基线可比。

### 3.8 两个代价，先说在前面

**一、它改变了环境，S9 之前的运行记录不再可比。** 加了这个工具之后，
agent 的 step 预算里多了一项开销，检索行为会变。这对 B/E/J/M 各轴**内部**没问题
（各组一致），但跟本 stage 之前跑过的任何数字都不能直接对照。
落地时记进 `history.md`，免得将来有人跨这条线做对比。

**二、它会诱导 agent 过早承诺。** 池子存在会让 agent 倾向"先放进去再说"，
而 `np-agent.md` 的 `direction-coverage` 要求先覆盖方向再深入。
这是个**可测的**副作用，正好做成 P 轴的一条观察量：池子的首次写入时机
（第几个 tool call）与最终召回的相关性。预先声明它，比事后发现它污染了结论要好。

---

## 4. S11 — Reviewer v0 与 $NP_0$ 重写

**目标**：让 $A_t$ 在 episode 中途产生，并让每条偏好条目可被检查是否执行。

> **设计全文在 `../reviewer-design.md`。** 那份文档给证据、原理、七个检测器、
> 边界判据与五条决策（D-10..D-12、D-14、D-15）。本节只给 stage 的落点与验收。
> **动手前先读它**——尤其 §5.2c（Reviewer 拿细节的唯一合法方式）
> 与 §5.2d（建议怎么投递）。

**前置**：F-1、F-2、F-10（见 §2）。F-10 是 R4 检测器的前提。

### 4.1 落点

路径按仓库根写全。extension 的三个文件都在
`widis/.widi-scholar/extensions/scholar-search/` 下。

**extension 侧**

- `core/review.ts`：新增七个检测器 R1–R7（纯函数，与 gate 同文件同风格）
- `index.ts`：
  - Reviewer 改为在 `agent_spawned` observer 里起，条件
    `event.profile.id === "search"`，episode 全程常驻（`reviewer-design.md` §5.2b）
  - review 触发从 `agent_idle` 移到 `tool_execution_end` 与 `update_answer_pool` 两处
  - **删除 `MAX_REVIEWS_PER_AGENT`**（`index.ts:272`，D-14）
  - 建议投递改为**每条放行即发一条**，不再取 `gate.admitted()` 全量
    （`reviewer-design.md` §5.2d）
- `core/trajectory.ts`：`TraceEvidence` 增加摘要/主题字段
  （§5.2c 批准的**唯一一处**白名单扩宽）
- `core/review.ts` 的 `renderTraceForReviewer`：增加 `DETECTED CONDITIONS` 段
- `core/service-client.ts`：增加读取 `review:` 配置段的方法，与 `getBudget()` 同形

**Service 侧**

- `src/search-service/config.yaml`：新增 `review:` 段，放 R1–R7 的阈值
  （含 R2 的 Jaccard，先取 0.5）作为 $HP$ 落位（D-15）
- `src/search-service/src/search_service/api/`：新增只读端点返回该段

**配置与偏好**

- `widis/.widi-scholar/profiles/reviewer.md`：`whenToUse` 现在写的是
  "extension starts it **at a review checkpoint**"，与常驻矛盾，需改写；
  `tools:` 保持 `[provide_advice, inspect_evidence, get_ranking_features]`
  **不变**——尤其不要加原生 `send_message`，理由见 `reviewer-design.md` §5.2d
- `widis/.widi-scholar/preference/np-agent.md`：按 `reviewer-design.md` §4 重写，
  并按 D-12 分成绑定组 A / 未绑定组 B
- `widis/.widi-scholar/preference/README.md`：补写作规程
  （`reviewer-design.md` §3.1 的两条纪律）
- 纪律二的 lint：**注意 `scripts/widis-quality.mjs` 是 biome 的驱动器**
  （对各 namespace 跑 lint / format / typecheck），它不检查 markdown 正文。
  这条 lint 要作为独立检查步加进去，不是往现有规则里塞一条

### 4.2 验收

1. 拿 `search-k9u1` 的轨迹作为固定输入喂给检测器，**R1、R3、R6 必须触发**——
   这三条是该次会话实测存在的缺陷，检测器认不出它们就是没写对；
2. 一次真实检索中，至少一条 `provide_advice` 的投递时刻**早于**最后一次
   `search_metadata`（即建议有机会改变它所审查的那次搜索——这是 G-1 的正面判据）；
3. gate 的拒绝记录里能看到检测器重复触发被 novelty key 挡下的条目
   （说明检测器接在 gate 之内，没有绕过）；
4. 一个 episode 内触发三次以上 review，Main 收到的建议**没有一条重复**；
5. `agent_spawned` 只为 `profile.id === "search"` 的 agent 配 Reviewer，
   **一个 episode 里 Reviewer 恰好一个**（验递归防护）；
6. `np-agent.md` 的**绑定组**每条都能指出它对应 $\bar{\tau}_t$ 的哪个字段，
   且满足 D-12 的可绑定判据（关掉它轨迹会不同）；
7. lint 能拦下一条含 arXiv id 的条目；
8. TUI 里用户能切到 Reviewer 并直接与它对话，且切过去看到的上下文里
   **没有** Main 的私有推理（沿用 S8 的逐片段查证方法，leaks = 0）。

**这些判据不检验什么**：建议的**质量**，以及 Main 是否采纳。
判据 2 只验"有机会被读到"，不验"读了之后变好了"——后者是 M 轴的结论，
需要 S10 的召回指标才能测。

**独立价值**：G-1 关闭；$NP$ 条目从"不可检查的劝告"变成"可检查的断言"。

---

## 5. S12 — $NP_k^{judge}$ 载体与 L3b 判别层

**目标**：判别准则成为可版本化、可消融的对象，L3b 真正接进排序栈。

### 5.1 当前做到哪一步

2026-08-21 merge 的 `aac617c` 加了 LLM provider 支持：`llm/base.py` +
`llm/providers/openai_compatible.py` + `llm/registry.py`，经 `POST /judge` 转发，
默认 provider 指向局域网 vllm。

**它是传输层，不是判别器。** `api/judge.py` 的 docstring 说得很坦白：

> This module **intentionally does not contain prompt templates or result parsing**;
> those belong in a separate judge-strategy layer.

这一步是必须的——在此之前 Search Service 根本没有调 LLM 的能力，
$NP^{judge}$ 的消费者无处安放。但它**只解开了阻塞，没有落地 NPj**。

一个必须守住的性质：**`/judge` 没有被注册成任何 agent 工具**，现在如此，
以后也应如此。理由见 §5.3。

### 5.2 还差四样

| 缺什么 | 现状 |
| --- | --- |
| **$NP^{judge}$ 的载体** | `preference/` 下只有 `np-agent.md`。而 `design.md` §6 要求判别准则的正反例与准则文本同属一个版本化对象 |
| **Configure 通路** | `config.yaml` 里没有放判别准则的地方，$NP_k^{judge} \to \theta^S_k$ 这条边不存在 |
| **L3b 接进排序栈** | `index.ts:827` 的 `judgeSupported: false` 仍然写死 |
| **判别结果进 provenance** | 判了哪些、判成什么档、花了多少 token，都得进 $\bar{\tau}_t$，否则 J 轴没有观测量 |

### 5.3 规格是齐的，判别器不会成为第十一个工具

`prototype.md` 对 L3b 的设计细到可以直接实现：

- **§4.1 三档**：L3a cross-encoder（$N_{sem}=100$）/ L3b LLM judge on abstract
  （$N_{judge}=30$，temperature 0，结构化输出）/ L3c fulltext（$N_{full}=8$，P0 默认关闭）
- **§4.2 加权准则制**：不给总分，对每条查询派生的带权准则逐条判
  $r_c(p) \in \{0,1,2,3\}$，合成 $s_{judge}$ 后按 $0.25/0.67/0.99$ 离散回四档；
  输出带 `rubric_version` / `criteria_version` / `model_version`
- **J 轴**：J0–J3 加上 J2'（judge 蒸馏后的 L2 打分器，线上不调 judge）
- 连"judge 失败不惩罚被评方：单篇失败就跳过该篇，且先判全部再取 top-k"都写了

**照它实现，不要自创打分方案。**

而 `prototype.md` §7.1 的工具表下面写明：

> `judge_level` 取 `off` / `auto` / `l3a` / `l3b` / `l3c`。
> **决定花多少预算做判别是 Agent 的策略，执行判别是 Service 的实现**——
> 这是 `judge_level` 出现在签名里、而模型与 prompt 不出现的原因。

`skill-decomposition.md` 给 `cf.papers.judge_relevance` 的归属是 `SVC` 而非 `TOOL`，
备注写死"由 `judge_level` 控制，**Agent 不直接调**"；§5 结论一也说
"94 条里没有一条要求新工具"。§4 结尾那条警告是同一个判断：一旦判别器变成 agent
能直接调的工具，决策就搬进了工具内部的固定 prompt，既不进 $\bar{\tau}_t$
也不受 $NP_k^{agent}$ 影响，"轨迹上看还是 ReAct，实际决策发生在工具内部"。

### 5.4 落点

- `widis/.widi-scholar/preference/np-judge.md`（新，与 `np-agent.md` 同构，带版本注释）
- Service 侧判别策略层：prompt 模板 + §4.2 的结构化输出解析，建在 `llm/` 之上
- `src/search-service/config.yaml` 增加判别准则的注入位
  （$NP_k^{judge}$ 经 `Configure` 进 $\theta^S_k$）
- `judge_level` 从自陈无能改为真实生效

采样参数、prompt 模板版本、准则版本从第一天就进 `config.yaml` 并进 provenance
（见 `mapping.md` §3.5 结尾那条约定）。

### 5.5 验收

1. 给定一条查询准则与一篇论文，判别层返回 `prototype.md` §4.2 那个 JSON 结构，
   且 `rubric_version` / `criteria_version` / `model_version` 三个字段可追溯；
2. `judge_level=l3b` 时 `judgeSupported: true`，实际判别篇数写进 `SearchState`
   并出现在 $\bar{\tau}_t$；
3. **改一条 `np-judge.md` 的条目能改变判别输出**——这条验的是载体真的有作用面，
   而不只是文件存在；
4. J0 与 J2 在同一批查询上的 Recall@k 都被记录下来（见 §5.6，这是硬要求）。

**这些判据不检验什么**：判别质量本身。判得准不准是 J 轴实验的结论，
不是本 stage 的验收。

**独立价值**：J 轴实验的 J2 组具备；$NP^{judge}$ 侧的偏好学习有了作用面。

### 5.6 一条与我们的 benchmark 直接冲突的硬要求

`prototype.md` §6（评价协议实例化）里有一条必须现在就钉进判据：

> **judge 的两个特殊要求**：必须报告 judge-free 消融（J0/J1 对 J2/J3），
> 因为**若 benchmark 的 gold 由 LLM 生成或校验，用 LLM judge 排序会系统性虚高**。

AutoScholarQuery 的 gold 正是这种构造方式（问题由 LLM 从论文相关工作章节生成）。
所以这条对本项目**不是理论风险，是直接适用**：一旦接上 L3b，
J2/J3 相对 J0/J1 的提升里会混进一部分同源偏差，不做 judge-free 对照就没法把它剥掉。

**值得在写代码之前就钉进判据里，而不是等跑出好看的数字之后再回头质疑。**
这是本文所有判据里最容易被"反正数字变好了"冲掉的一条。

---

## 6. 为什么是这个顺序

### 6.1 S10 之前必须先修 F-1

见 §2。**不做它，后面三段的产出都不可信。**

### 6.2 S10 排在 S12 之前

**答案池是测量仪器，判别器是被测对象。** 没有前者，后者的效果没法量化。
见 §3.5 第二条。

### 6.3 S11 排在 S12 之前

这一条的依据是一个负结果：一次手工的 P 轴消融显示，
**陈述式偏好条目在当前模型上的执行率接近于零**（四条提示，三条完全没有被执行；
召回从 1/4 变成 0/4）。详见 `../reviewer-design.md` §2.2。

这意味着：把力气花在改进 Service 侧的判别质量（S12）之前，
先要解决"agent 根本不照着策略走"这个更前面的问题。
**判别器再准，也纠正不了一个从头到尾只在一个错误方向上穷举关键词的检索。**

同样的证据还显示，三次会话加起来 `facet_probe` / `rank_candidates` /
`search_fulltext` **一次都没被调用过**——九个工具里的三个诊断型工具全部闲置。
S11 的检测器直接针对这一点。

### 6.4 S11 与 S10 的双向依赖，以及降级路径

S11 的**检测器**只用 $\bar{\tau}_t$ 的现有字段，不依赖 S10；
但 S11 的**触发源一（答案池更新）确实依赖 S10**。所以顺序是 S10 → S11。

万一 S10 延期，S11 的检测器部分可以先做——但那样只有触发源二，
$\Delta_{\mathrm{sidecar}}$ 的归因论证不完整（D-11 只落地了一半）。
**这是降级路径，不是可以随意调序的许可。**

---

## 7. 本文范围之外

这几件事被讨论过但**不进上面四段**，记下来免得后面重新捡起：

- **G-2 Evidence Store**：答案池不抵消它，见 §3.6。它需要 episode 标识穿过工具入参，
  是独立的一件事。详见 `backlog.md` G-2。
- **U-03 / 采样参数固定**：卡的是调用点 A（Main 的推理），见 `mapping.md` §3.5。
  它不能靠"封装进 Search Service"绕过，需要用户授权改 vendored 的 `packages/agent`。
  三条路径互斥，需要用户拍板。详见 `history.md` U-03。
- **F-3 / F-4 / F-5 / F-11 等其余缺陷**：见 `backlog.md`。它们不阻塞上面四段，
  但 F-4（预算记账）会激活 `design.md` §5.2 的"预算接近上限"checkpoint，
  做完 S10 之后值得顺手做掉。
- **产品化 UI**：只影响 §3.3 的 schema 决定，其余不进计划。

---

## 8. 关于验收判据的纪律

**这些验收判据是必要条件，不是充分条件。** 它们检验的是"这条链路真的通了、
真的在跑"，写得刻意可执行。但**通过验收不等于对应的设计要求已经被满足**。

S0–S9 已经发生过两个例子：

- **S8** 验"至少产生一条 `provide_advice`"——那验的是通道连通性，
  不是 `design.md` §5.2 要求的 checkpoint 时机；结果是通道通了，
  而介入影响不到被审的那次搜索（G-1）。
- **S5** 验"轨迹形状明显不同"——没有预先规定观察量，于是观察量只能事后选，
  得到的分离度不能当效应量（G-3）。

所以：**验收通过就提交并继续，但如果你发现判据没覆盖到设计要求的某一部分，
把差额写进 `backlog.md` 的验收缺口一节**，不要为了让它看起来完整而放宽
或重新解释判据。

一个带着已知缺口的 `DONE` 是可用的；一个把缺口解释掉的 `DONE`
会让后面所有依赖它的实验结论失效。

这条比"卡住就记 BLOCKED"更容易被漏掉：BLOCKED 是你走不下去，
而这里你走得下去，只是走到的地方比设计要求浅一层。

**S10–S12 的判据是先于实现写的**，正好可以避免 S5 和 S8 那种事后选判据的问题——
不要在实现过程中回头改它们。
