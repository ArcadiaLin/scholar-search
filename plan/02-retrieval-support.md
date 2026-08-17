# 检索能力支持计划：在线源与本地检索

## 结论

`papers/` 下 10 篇参考论文涉及的检索能力可归为三层：

1. **在线检索源**（远程 API / 搜索引擎）：拿候选论文，是召回的来源；
2. **全文与引用获取**（在线，但可缓存成本地数据库）：支撑引用扩展；
3. **本地检索**（离线索引 + 本地模型）：对候选集做过滤、重排、去重，零边际成本。

现状：`pasa-tools/core/` 已有 `serper.ts`、`arxiv.ts`、`ar5iv.ts`、`http.ts`，
覆盖 PaSa 路线的最小闭环。**Semantic Scholar、Crossref、OpenAlex、PubMed
以及全部本地检索能力均缺失。**

本文件是规划，不代表已实现。依据来自对 `papers/` 10 篇论文的逐篇分析
（提取文本在 `scratch/pdftext/`，可复核）。

## 1. 现状盘点

已有（`widis/.widi-pasa/extensions/pasa-tools/core/`，带 fixture 测试）：

| 模块 | 能力 | 在线 |
| --- | --- | --- |
| `serper.ts` | Serper Google Search API（付费，需 API key） | 是 |
| `arxiv.ts` | arXiv API：按 ID 取元数据、按标题搜索 | 是 |
| `ar5iv.ts` | ar5iv 全文 + 引用列表抓取与解析 | 是 |
| `http.ts` | 超时、有界重试 | — |

这套正好对应 PaSa 的 `[Search]`（Serper 限定 `site:arxiv.org` + 日期边界）与
`[Expand]`（ar5iv 引用扩展），但**仅限 arXiv 单源**。

## 2. 在线检索源：缺口与优先级

按论文证据排序。统一要求：超时 + 有界重试 + 速率限制 + 日期边界参数 +
稳定论文 ID 归一化（`AGENTS.md` §6、§7）；凭据只走环境变量（§4）。

| 源 | 论文证据 | 用途 | 凭据/成本 | 优先级 |
| --- | --- | --- | --- | --- |
| **Semantic Scholar API** | PaperQA2 初始检索与引文双向遍历（约 4 次调用/篇）；SPAR 五源之一；LitSearch 建库 | 标题/关键词检索、引文图（references + citations）、S2 论文 ID 归一 | 免费 API，有速率限制，可选 API key 提速 | **高**：SPAR 路线必需，也是引文扩展的免解析替代（比 ar5iv 抓 HTML 稳） |
| **arXiv API** | PaSa / SPAR 目标语料 | 已有 | 免费 | 已有 |
| **Serper (Google Search)** | PaSa 唯一检索入口；SPAR 的 Google 源 | 已有 | 付费，按调用计费，**必须计入预算** | 已有 |
| **ar5iv** | PaSa 全文/引用获取 | 已有 | 免费在线服务 | 已有 |
| **OpenAlex API** | SPAR 五源之一，LLM 提取关键词后调 API | 关键词检索、结构化元数据 | 免费，mailto 礼貌池 | 中：SPAR 路线需要 |
| **PubMed (E-utilities)** | SPAR 五源之一 | 生物医学领域检索 | 免费，可选 API key | 低：赛题查询以 CS/AI 为主，待赛题数据确认 |
| **Crossref API** | PaperQA2 引文遍历的 past references | DOI 元数据、引文 | 免费 | 低：Semantic Scholar 引文图覆盖后可不做 |

不做的事：Google Scholar（无官方 API，论文里只作基线）、
Elicit/Perplexity/FutureHouse 等商业系统（只作对照，不是检索源）、
Asta Scientific Corpus（Ai2 托管服务，不自建）。

## 3. 全文与引用获取

- **全文**：ar5iv 已覆盖 arXiv；非 arXiv 论文暂不抓全文（PaSa 也只做 arXiv）。
- **引用扩展**两条路：
  1. ar5iv 解析引用列表（已有，但 HTML 解析脆，且引用条目需再经
     arXiv 标题搜索归一到 arxiv_id，PaSa 官方就是这么做的）;
  2. Semantic Scholar 引文图 API（references/citations 直接返回结构化
     条目与外部 ID），命中时优先，ar5iv 兜底。
- **本地论文缓存数据库**：PaSa 的设计是先查库、未命中才抓 ar5iv。
  这是缓存层不是检索入口，但对成本和可复现性是必需的：
  原始响应写入被忽略目录，缓存命中与冷启动分开报告（`AGENTS.md` §5.3）。

## 4. 本地检索：全部缺失，按需补

论文侧证据：LitSearch 在 64,183 篇本地语料上跑 BM25/GTR/Instructor/E5/GritLM
全部离线；BM25 需要本地倒排索引；稠密检索器离线编码 + ANN 向量索引
（FAISS/ScaNN）。

| 能力 | 候选实现 | 用途 | 优先级 |
| --- | --- | --- | --- |
| **BM25** | 纯 Python 实现或 `rank_bm25`，对候选集临时建倒排 | 对在线召回的候选做词项过滤/重排，零 API 成本 | **高**： cheapest baseline，LitSearch 基线之一 |
| **稠密 embedding 检索** | E5 / GTR / INSTRUCTOR（HuggingFace checkpoint，本地推理） | 语义重排候选、query-论文相似度 | 中：需要 GPU/CPU 推理环境，先小规模验证 |
| **向量索引** | FAISS（Python 包） | 候选数上千时的 ANN；候选集小（<1000）时暴力余弦即可 | 低：先暴力，规模到了再上 |
| **本地语料快照** | S2ORC 子集（LitSearch 做法） | 离线评测语料 | 低：只有做 LitSearch 式本地评测时才需要 |

注意边界：本地检索器**不产生召回**，它排的是在线源给的候选。
别指望 embedding 模型替代 Serper/S2——语料不在本地，模型无处可检。

## 5. 横切要求

所有检索 API（在线与本地）必须共享的口径：

- **日期边界**：每个检索入口显式接受 `end_date`（评测契约，见
  `plan/01` §7 的 `contract: true` 论证），丢失会静默召回查询日期之后的论文。
- **预算与记账**：每次调用记录源、查询、耗时、结果数、费用（Serper 按次计费）；
  预算超限即拒绝而非跑到一半（`plan/01` §2 的动机）。
- **去重与 ID 归一**：arxiv_id / DOI / S2 CorpusID 之间的映射，
  跨源合并时以稳定 ID 去重；解析覆盖缺失字段、分页、限流、重复标识
  （`AGENTS.md` §7）。
- **测试**：网络层用录制的 fixture（沿用 `pasa-tools/tests/fixtures/` 模式），
  默认测试不依赖实时 API；真实 API 打集成标记。

## 6. 实施顺序

1. **BM25 本地重排**（无外部依赖，立即提升候选过滤质量，成本为零）。
2. **Semantic Scholar API**：检索 + 引文图，替代/兜底 ar5iv 引用扩展，
   打通 SPAR 路线的核心源。
3. **论文缓存数据库**：原始响应落盘、命中统计、冷/热分开记账。
4. **OpenAlex API**：SPAR 多源对比实验需要时再做。
5. **稠密 embedding 重排**（E5 起步）：BM25 基线固定后再对比，
   需先确认推理环境。
6. PubMed / Crossref / FAISS / S2ORC 快照：赛题数据或实验结论明确要求时才做。

每步交付 = 可调用的 API + fixture 测试 + 预算/记账接入，
不做无调用方的框架（`AGENTS.md` §3.2）。

## 7. 不做的事

- 不自建 Semantic Scholar / OpenAlex 的本地镜像。
- 不抓 Google Scholar，不接无官方 API 的来源。
- 不为「将来可能用」提前实现 PubMed/Crossref/FAISS。
- 不把检索结果缓存提交 Git；凭据只走环境变量与 `.env.example` 占位。

## Git 提交流程

本文件是规划，不代表已实现，也不自动提交 Git。
用户审核后再按明确要求实现代码。
不把 API key、论文缓存、原始响应和运行输出提交到 Git。
