# 检索能力支持计划：需要补全的检索 API

## 结论

综合 `papers/` 10 篇参考论文与 `packages/metasci-universe/` 的代码证据，
我们需要补全的检索 API 分两层：

- **在线检索源**：现有 serper / arxiv / ar5iv 三个（PaSa 路线闭环）；
  缺 **Semantic Scholar**（最高优先）、**OpenAlex**（有本地参考实现，成本低）、
  PubMed / Crossref（暂缓）。
- **本地检索**：全部缺失。先补 **BM25**（零成本 baseline），
  再视实验结论补**稠密 embedding 重排**（E5 起步，自研，不抄 metasci-universe）。

依据：论文逐篇分析（提取文本在 `scratch/pdftext/`）与
metasci-universe 代码走读（结论见 §4、§5）。本文件是规划，不代表已实现。

## 1. 现状

已有（`widis/.widi-pasa/extensions/pasa-tools/core/`，带 fixture 测试）：

| 模块 | 能力 | 类型 |
| --- | --- | --- |
| `serper.ts` | Serper Google Search API（付费，需 API key，按次计费） | 在线检索 |
| `arxiv.ts` | arXiv API：按 ID 取元数据、按标题搜索 | 在线检索 |
| `ar5iv.ts` | ar5iv 全文 + 引用列表抓取解析（HTML 解析，脆） | 在线全文/引用 |
| `http.ts` | 超时、有界重试 | 基础设施 |

这套仅覆盖 PaSa 的 arXiv 单源闭环：`[Search]` 走 Serper 限定
`site:arxiv.org` + 日期边界，`[Expand]` 走 ar5iv 引用扩展。

## 2. 需要补全的在线检索 API

统一要求（每个新源都必须满足，细则见 §6）：
超时 + 有界重试 + 速率限制 + 显式 `end_date` 日期边界 + 稳定 ID 归一 +
fixture 测试 + 预算记账。凭据只走环境变量（`AGENTS.md` §4、§6、§7）。

### 2.1 Semantic Scholar API —— 优先级最高

论文证据：PaperQA2 用它做初始检索 + 引文双向遍历（约 4 次调用/篇）；
SPAR 五源之一；LitSearch 建库也用它的 Academic Graph API。

需要的能力：

- 关键词/标题检索（bulk search + title match）；
- 引文图：`references` 与 `citations` 两个方向，直接返回结构化条目和外部 ID
  （arxiv_id / DOI / CorpusID），**作为 ar5iv 引用扩展的结构化替代与兜底**；
- 批量论文详情（`POST /paper/batch`）；
- 外部 ID 映射（`arxiv:`/`DOI:` 前缀查询），支撑跨源去重。

免费，有速率限制，可选 API key 提速。凭据：`S2_API_KEY`（可选）。

### 2.2 OpenAlex API —— 有本地参考实现，成本低

论文证据：SPAR 五源之一（LLM 提取关键词后调 OpenAlex API）。
参考实现就在仓库里：`packages/metasci-universe/src/DataExtractorTool/works_extractor.py`
（pyalex 封装，游标分页 `per_page=100/200`、分批按 ID 取每批 50、
重试 3 次递增退避、RateLimiter 有邮箱 90 req/min 无则 9）。

需要的能力：

- 关键词/过滤检索（标题+摘要、年份范围、作者/机构/期刊、引用数）；
- 引文图（前向 `filter(cites=...)`、后向 `referenced_works`）；
- 实体解析（topic/author/institution/source 名称→ID）。

免费，配 `email` 进 polite pool，无需 key。

**可直接借鉴 metasci-universe 的设计**（见 §5），但不要直接依赖它：
它强绑一个未分发的 PostgreSQL 快照，且 SQL 为 f-string 拼接（注入风险）。

### 2.3 暂缓：PubMed、Crossref

- PubMed（SPAR 五源之一）：赛题查询以 CS/AI 为主，待赛题数据确认后再做；
- Crossref（PaperQA2 的 past references）：Semantic Scholar 引文图覆盖后大概率不需要。

### 2.4 明确不做

- Google Scholar：无官方 API，论文里只作人工基线；
- Elicit / Perplexity / FutureHouse / You.com：对照系统，不是检索源；
- Asta Scientific Corpus：Ai2 托管服务，不自建；
- Semantic Scholar / OpenAlex 的本地镜像。

## 3. 需要补全的本地检索 API

论文证据：LitSearch 在 64,183 篇本地语料上离线跑 BM25/GTR/Instructor/E5/GritLM；
BM25 需本地倒排索引；稠密检索器离线编码 + 向量索引。

### 3.1 BM25 —— 第一优先

对在线召回的候选集临时建倒排索引做词项过滤/重排，零 API 成本，
是 LitSearch 与全部稠密模型论文的统一 baseline。
纯 Python 实现（或 `rank_bm25`），输入输出走显式 schema，确定性、无网络。

### 3.2 稠密 embedding 重排 —— 第二优先，需自研

- 选型 E5 起步（LitSearch 基线之一，本地 checkpoint，离线推理），
  后续可与 GTR / INSTRUCTOR 对比；
- 候选集 < 1000 时暴力余弦即可，规模到了再上 FAISS；
- **不能复用 metasci-universe**：其 `EmbeddingTool/` 是空目录（只有
  `__init__.py` + 一行 `__all__ = []`），计划定位是「论文嵌入和相似度分析」
  （`src/__init__.py:15`），唯一的 embedding 实现在 TopicTool 里用
  SciBERT 做 BERTopic 主题聚类——是科学计量分析，不是检索，选型也过时。

注意边界：本地检索器**不产生召回**，只排在线源给的候选。
语料不在本地，embedding 模型替代不了 Serper/S2。

### 3.3 论文缓存数据库 —— 随 Semantic Scholar 一起做

PaSa 的设计：先查库、未命中才抓 ar5iv。缓存层不是检索入口，
但对成本与可复现性必需：原始响应落被忽略目录，
缓存命中与冷启动分开报告（`AGENTS.md` §5.3）。

## 4. 跨源 ID 归一与去重

多源之后必须有一个归一层，规则：

- 统一短 ID：arxiv_id、DOI（剥 `https://doi.org/`）、S2 CorpusID、OpenAlex ID
  （剥 `https://openalex.org/` 前缀，metasci-universe 的约定可直接沿用）；
- 以 arxiv_id 为主键，DOI 为辅；跨源合并时经 S2 外部 ID 映射对齐；
- 解析覆盖缺失字段、分页、限流、重复论文标识（`AGENTS.md` §7）；
- metasci-universe 只做 OpenAlex 内部归一，无跨源映射，这层要自建。

## 5. metasci-universe 参考清单

可参考（`packages/metasci-universe/src/`）：

- 过滤参数形态：`fetch_works` 的 ID/名称双轨参数、范围/不等式字符串
  （`"2020-2023"`、`">2020"`）、`sort_by="field:asc|desc"`、字段投影、
  返回信封 `{works, total, source, filters, execution_time}`；
- `RateLimiter`（滑动窗口 + 最小间隔，约 60 行）与游标分页/重试封装；
- 统一 work schema 与 OpenAlex URL→短 ID 归一约定。

不可参考：EmbeddingTool / NetworkAnalysisTool 为空壳；
本地 DB 依赖未分发的 OpenAlex PostgreSQL 快照；
SQL 字符串拼接有注入风险；`psycopg2`/`scipy` 用了但未声明依赖。

## 6. 横切要求

- **日期边界**：每个检索入口显式接受 `end_date`，丢失会静默召回查询日期
  之后的论文（评测契约，见 `plan/01` §7）。
- **预算与记账**：记录源、查询、耗时、结果数、费用（Serper 按次计费）；
  超限即拒绝而非跑到一半（`plan/01` §2）。
- **测试**：网络层用录制 fixture（沿用 `pasa-tools/tests/fixtures/` 模式），
  默认测试不依赖实时 API；真实 API 打集成标记。

## 7. 实施顺序

1. **BM25 本地重排**：无外部依赖，立即提升候选过滤质量。
2. **Semantic Scholar API**：检索 + 引文图 + 外部 ID 映射，
   打通 SPAR 路线核心源，给 ar5iv 引用扩展兜底。
3. **论文缓存数据库**：原始响应落盘、命中统计、冷/热分开记账。
4. **OpenAlex API**：参照 metasci-universe 设计实现，供多源对比实验。
5. **稠密 embedding 重排**（E5 起步）：BM25 基线固定后对比，先确认推理环境。
6. PubMed / Crossref / FAISS / S2ORC 快照：赛题数据或实验结论明确要求时才做。

每步交付 = 可调用的 API + fixture 测试 + 预算/记账接入，
不做无调用方的框架（`AGENTS.md` §3.2）。

## 8. 不做的事

- 不自建任何在线源的本地镜像；不抓 Google Scholar。
- 不为「将来可能用」提前实现 PubMed / Crossref / FAISS。
- 不复制 metasci-universe 代码进正式模块；需要采用的按许可证迁移并注明来源
  （`AGENTS.md` §8）。
- 不把检索缓存、原始响应、API key 提交 Git。

## Git 提交流程

本文件是规划，不代表已实现，也不自动提交 Git。
用户审核后再按明确要求实现代码。
