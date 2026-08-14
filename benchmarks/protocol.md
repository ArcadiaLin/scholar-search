# 学术搜索 Benchmark 评测协议

Benchmark 数据获取的唯一入口是 [`sources.yaml`](sources.yaml)，统一下载入口是 [`download.py`](download.py)。本文件只定义评测用途、原生指标和公平比较约束，不重复维护下载命令、Hugging Face revision 或本地路径。

赛题的唯一事实来源仍是 [`problem.md`](../problem.md)。外部 Benchmark 只提供开发和回归代理指标，不能替代赛事公开集与隐藏集。

## 1. 优先级

| 优先级 | Benchmark | 主要能力 | 用途 |
| --- | --- | --- | --- |
| P0 | 赛事公开集、隐藏集 | 赛事最终端到端契约 | 唯一权威的最终评分依据 |
| P1 | RealScholarQuery | 真实复杂查询、开放式论文集合检索 | 主要开发集 |
| P1 | AutoScholarQuery | AI 领域合成查询、开放式检索 | 大规模回归与策略实验 |
| P1 | PaperFindingBench | 语义、导航、元数据查询及证据返回 | 主要外部 Agent Benchmark |
| P1 | SPARBench | 计算机与生物医学复杂查询 | 小型跨域补充集 |
| P2 | LitSearch | 固定语料库检索与排序 | 确定性 Retriever/Reranker 回归 |
| P2 | LitQA2-FullText-Search | 为科学问题找到支撑论文 | 检索召回补充评测 |
| P3 | LitQA2 | 检索论文正文后回答科学问题 | 验证检索后作答，不作为论文列表主指标 |
| P3 | AstaBench 全套 | 科学 Agent 检索、问答、代码、分析和发现 | 按需运行相关子任务 |

`problem.md` 中的 **AutoScholar** 是 SPAR 论文对 PaSa **AutoScholarQuery** 的简称，不是另一份独立数据集。

建议依次接入：

```text
赛事公开集契约
→ RealScholarQuery
→ AutoScholarQuery test
→ PaperFindingBench validation
→ SPARBench
→ LitSearch
→ LitQA2-FullText-Search
```

## 2. 赛事评测

赛事最终评分权重固定为：

- F1：70%；
- 运行效率：20%，包括 API 调用、Token 和端到端延迟；
- 结构化回复：10%。

公开集必须保留官方输入文件、输出 Schema、发布日期、SHA-256 和 scorer 版本。隐藏集只允许由官方评测服务使用，不得根据隐藏结果反向调优 Prompt、阈值或排序权重。

## 3. PaSa：AutoScholarQuery 与 RealScholarQuery

### 数据与边界

- AutoScholarQuery 固定 test 为 1,000 条，训练集约 33.5k 条；
- RealScholarQuery 固定 test 为 50 条真实 AI 研究查询；
- AutoScholarQuery 查询包含时间边界；RealScholarQuery 统一查询日期为 2024-10-01；
- PaSa 正文对训练集数量同时写过 33,511 和 33,551，应以清单固定 revision 中的实际文件为准。

### 评测契约

1. 只检索查询日期之前的论文；
2. 对候选结果执行稳定论文 ID 归一化、标题归一化和去重；
3. 输出有序论文列表，并明确最大结果数；
4. 使用 PaSa `metrics.py` 的标题归一化逻辑核对官方指标；
5. 另外报告本赛题要求的 Precision、Recall、F1、延迟、API 调用数、Token 和费用。

PaSa 原始评测还报告 Crawler Recall、Selector Precision/Recall 和 Recall@20/50/100。WIDI Scholar 结果若不采用 PaSa 搜索树格式，转换器必须先用固定 fixture 证明与官方 scorer 等价。

### 风险

AutoScholarQuery 的 gold papers 来源于引用关系，不是完备相关论文集合；真实相关但未被引用的论文可能被算作假阳性。RealScholarQuery 更接近真实检索，但样本少且领域集中于 AI。二者都不能单独承担最终比赛结论。

## 4. AstaBench 与 PaperFindingBench

### 固定版本

复现 `problem.md` 所依据的一代结果时，固定：

- AstaBench runtime tag：`v0.3.1`；
- runtime commit：`5c844b7451e3a98cd0df71ea626bb217803d2bed`；
- dataset revision：以 [`sources.yaml`](sources.yaml) 为准。

若升级到新版本，必须重新运行全部相关 baseline；不得沿用 `v0.3.1` 的分数、任务说明或费用结论。

### Literature tasks

与本赛题直接相关的任务是：

- PaperFindingBench；
- ScholarQABench2；
- LitQA2-FullText；
- LitQA2-FullText-Search；
- ArxivDIGESTables-Clean。

PaperFindingBench 共 333 条查询：48 条 navigational、43 条 metadata、242 条 semantic。每篇返回论文必须包含 Semantic Scholar CorpusID、相关性顺序和摘自原文的最小证据片段。

导航与元数据查询具有完整 gold set，按结果集 F1 评分。语义查询使用部分标注、LLM relevance judgement、estimated recall 和 nDCG；`v0.3.1` suite 主指标为 `score_paper_finder/adjusted_f1_micro_avg`。

AstaBench 运行还需要 `ASTA_TOOL_KEY` 以及 solver/scorer 对应的模型 API key。数据访问 Token 与运行工具密钥是两个独立权限，不得混用。

## 5. SPARBench

SPARBench 包含 50 条查询，其中 35 条计算机科学、15 条生物医学，人工确认的 gold papers 共 556 篇。评测按每条查询的文档级 Precision、Recall 和 F1 汇总。

Hugging Face 发布版与 SPAR GitHub `benchmark/` 文件覆盖同一组查询和 gold papers，但字段 Schema 不同。运行记录必须注明采用的发布源、revision、字段映射和 scorer；不得把两种 Schema 静默拼接。

SPAR 论文中的 Google、Google Scholar、ChatGPT Search、OpenAlex、Semantic Scholar、PubMed、PaSa 和 PaperFinder baseline 使用不同实时检索源。重新比较时必须统一查询、时间边界、结果上限和调用预算，不能直接把论文分数当作当前系统回归阈值。

## 6. LitSearch

LitSearch 是固定语料库检索：

- query：597 条查询及 gold CorpusIDs；
- corpus_clean：64,183 篇论文；
- corpus_s2orc：同一语料的可选 S2ORC Schema 表示。

Retriever/Reranker 回归默认使用 `query + corpus_clean`。官方论文对 broad query 报告 Recall@20，对 specific query 报告 Recall@5 和 Recall@20。WIDI Scholar 必须限制检索到固定 corpus，或将外部结果可靠映射到 CorpusID；开放 Web 结果不能直接与闭集 baseline 横比。

BM25、GTR、Instructor、E5、GritLM、LLM reranking 和引用扩展属于不同成本层级。正式对比应分别报告冷启动索引构建时间、查询延迟、模型调用和缓存命中状态。

## 7. LitQA2 与 LitQA2-FullText-Search

- LitQA2 共 248 道需要检索论文正文才能回答的科学多选题；公开 split 199 条，held-out split 49 条；
- LitQA2-FullText-Search 将问题改造成找论文任务，`v0.3.1` 主指标为 `score_paper_finder/recall_at_30`；
- LitQA2 原生报告 accuracy、coverage 和 precision，AstaBench suite 主指标使用 accuracy。

held-out split 不得用于训练、Prompt 调优、阈值选择或失败案例驱动开发。公开 199 条若已用于调优，后续结果必须明确标为 development，不得称为无污染测试结果。

## 8. 统一比较约束

任何跨系统对比必须同时固定并记录：

1. query 列表、数据 split 和数据 revision；
2. scorer 实现与 revision；
3. 检索时间边界和允许访问的语料；
4. 最大结果数、API 调用数、Token、费用和停止条件；
5. 论文 ID 与标题归一化、去重和排序规则；
6. Precision、Recall、F1，以及 Benchmark 原生 Recall@K / nDCG 等指标；
7. 冷启动和缓存命中状态；
8. 失败、超时和空结果，且这些样本必须进入统计分母；
9. WIDI revision、RPC protocol version、Profile、模型和 extension 版本。

同一对比必须使用相同查询、候选时间边界、最大调用预算和停止条件。公开网页索引持续变化，实时搜索结果不得与论文历史时间点的分数直接横比。

## 9. WIDI 执行边界

正式自动评测通过版本化 RPC client 驱动 WIDI Scholar，不抓取 TUI 文本或读取内部 session 文件。每个样本必须具有稳定 request ID、独立终止状态、机器可读结果以及 usage/cost 事件。原始 RPC JSONL 与聚合指标一并保存，使成功、失败、延迟和费用均可复核。
