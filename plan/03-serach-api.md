# 检索 API 支持

本文档用于汇总所有需要支持的检索 API。
详细的取舍依据与实施顺序见 `plan/02-retrieval-support.md`；本文件只做逐项清单与进度跟踪。

## 网络检索

### OpenAlex

**简介**

免费的学术文献元数据图谱 API，覆盖论文、作者、机构、期刊与引用关系，
配 `email` 可进 polite pool，无需 API key。

**用途**

获取元数据，扩展引文

**参考**

metasci 中已经提供 openalex 的调用方式

**进度**

[x] 部署可使用的 API 支持（例如 OpenAlex）
[x] 接入 widi:scholar extension

### semantic scholar

**简介**

免费的学术图谱 API（Semantic Scholar Academic Graph），支持关键词/标题检索、
引文双向遍历与批量论文详情；可选 `S2_API_KEY` 提速。

**用途**

- 多源检索之一（PaperQA2、SPAR、LitSearch 均使用）；
- 引文图扩展，作为 ar5iv 引用抓取的结构化替代与兜底；
- 外部 ID 映射（arxiv_id / DOI / CorpusID），支撑跨源去重。

**参考**

`plan/02-retrieval-support.md` §2.1

**进度**

[ ] API 支持
[ ] 接入 widi:scholar extension

### arxiv

**简介**

arXiv 官方 API：按 ID 取元数据、按标题搜索，免费。

**用途**

arXiv 单源闭环的元数据与标题解析（PaSa 路线）

**参考**

`widis/.widi-pasa/extensions/pasa-tools/core/arxiv.ts`（已实现）

**进度**

[x] API 支持（pasa-tools，带 fixture 测试）
[ ] 接入 widi:scholar extension

### ar5iv

**简介**

arXiv 论文的 HTML 全文服务，可抓取全文与引用列表（HTML 解析，脆）。

**用途**

引文扩展（PaSa `[Expand]` 阶段）与全文获取

**参考**

`widis/.widi-pasa/extensions/pasa-tools/core/ar5iv.ts`（已实现）

**进度**

[x] API 支持（pasa-tools，带 fixture 测试）
[ ] 接入 widi:scholar extension

### deepiv

**简介**

**用途**

**参考**

**进度**

[ ] 待评估

### anysearch

**简介**

**用途**

**参考**

**进度**

[ ] 待评估

### exa

**简介**

付费的语义搜索 API（面向 LLM 场景）。

**用途**

候选检索源之一，与 serper 对比

**参考**

**进度**

[ ] 待评估

## 本地检索

**用途**

可用作 reviewer 精炼检索方案。
注意边界：本地检索器不产生召回，只排在线源给的候选。

### BM25

**简介**

词项匹配的 probabilistic 排序，对在线召回的候选集临时建倒排索引做过滤/重排，
零 API 成本，是 LitSearch 与全部稠密模型论文的统一 baseline。

**参考**

`src/retriever/bm25.py`（已实现，`tests/test_bm25.py` 覆盖）

**进度**

[x] API 支持
[ ] 接入 widi:scholar extension

### embedding

**简介**

稠密向量检索/重排（E5 起步，本地 checkpoint 离线推理）；
候选集 < 1000 时暴力余弦，规模到了再上 FAISS。

**参考**

`src/retriever/embedding.py`（已实现，`tests/test_embedding.py` 覆盖）

**进度**

[x] API 支持
[ ] 接入 widi:scholar extension

## Git 提交流程

本文件是规划与进度跟踪，不代表全部已实现，也不自动提交 Git。
