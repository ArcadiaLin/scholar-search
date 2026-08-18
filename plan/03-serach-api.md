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

### deepxiv

**简介**

面向 AI agent 的学术文献数据接口（[DeepXiv-SDK](https://arxiv.org/abs/2603.00084)）。
将非结构化论文数据转换为标准化 JSON，覆盖完整 arXiv 全文语料（3.1M+ 论文），每日 T+0 同步；DeepXiv SDK 是一个以 Agent 为核心的学术论文检索与渐进式阅读工具包。它封装了一个由 Elasticsearch 混合检索（BM25 + 向量）支持的 REST API，并提供三个层级的访问方式：Python SDK（Reader 类）、功能完备的 CLI（deepxiv），以及可选的集成层（包括内置的 ReAct Agent 和 MCP 服务器）。该 SDK 目标环境为 Python ≥ 3.8，采用 MIT 许可证，并在首次使用时自动注册免费的匿名 API 令牌，使开发者能够在零手动配置的情况下运行首次查询。

核心能力：

- **分层/渐进式访问**：`head`（元数据）、`brief`（摘要+TLDR）、`preview`（前 10k 字符）、
  `raw`（完整 Markdown）、`section`（指定章节）、`json`（完整结构化）。
- **混合检索**：`GET /arxiv/?type=retrieve` 基于 Qdrant 的 dense + sparse（BM25）混合检索，
  支持作者、机构、日期、引用数、类别、venue、fine rerank 等过滤。
- **Agentic Search**：`POST /arxiv/agent/search` 自动选工具、读取论文段落并返回答案+真实引用
  （`[arXiv:2512.15176]` 格式），支持 `default` / `high` / `xhigh` 三档努力级别与流式 NDJSON。
- **分发形态**：REST API、开源 Python SDK、CLI、MCP server。

认证：注册后每日 10,000 次通用请求；Agentic Search 独立配额，免费档 30 次/天。
两篇论文 `2409.05591` 和 `2504.21776` 可无 token 测试。

**用途**

- arXiv 全文获取与结构化解析（比 ar5iv HTML 解析更稳定）；
- 候选召回：混合检索可作为本地 BM25/embedding 之外的在线源；
- 深度阅读：按章节或完整全文提取证据；
- Agentic 问答：复杂查询直接获得带引用的综合答案，但需占用独立 Agentic 配额。

**参考**

- [DeepXiv SDK 项目概述](../references/deepxiv.md)
- [DeepXiv API Docs](https://data.rag.ac.cn/api/docs)
- [GitHub - qhjqhj00/deepxiv_sdk](https://github.com/qhjqhj00/deepxiv_sdk)
- [DeepXiv-SDK arXiv 论文](https://arxiv.org/abs/2603.00084)

**进度**

[x] API 支持（deepxiv-sdk==1.0.0 已加入 pyproject.toml，CLI 已验证）
[ ] 接入 widi:scholar extension

### anysearch

**简介**

面向 AI agent 的实时搜索基础设施（2026-05 发布），定位为 agent-native 搜索 API，
非人类搜索引擎的简单封装。统一 API 覆盖 17+ 垂直领域（`academic`、`finance`、
`code`、`legal`、`health`、`tech`、`business` 等），支持按领域路由。

核心能力：

- **单次调用返回检索+提取**：`POST /v1/search` 同时返回 `snippet` 和完整 `content`
  （clean markdown），无需单独的 extract 调用，减少 token 浪费。
- **垂直领域搜索**：支持 `domain` 参数指定领域，以及 `zone: cn` + `language: zh-CN`
  优化中文查询。
- **MCP 支持**：`https://api.anysearch.com/mcp` 以 Streamable HTTP 暴露 `search`、
  `extract`、`batch_search`、`get_sub_domains` 等工具。
- **隐私与免费档**：无跟踪/无日志，免费 1,000 requests/day，无需信用卡。

认证：`ANYSEARCH_API_KEY`（格式通常为 `as_sk_...`）。
注意：没有独立 REST extract 端点，提取能力通过 MCP `tools/call` 或自行抓取实现。

**用途**

- 通用网络/学术检索候选源之一，与 exa / tavily / serper 并列；
- 中文或结构化数据场景（财经、法律、技术文档）可作为首选；
- 需要“搜索+正文”一站式结果时，减少额外抓取与解析成本。

**参考**

- 使用文档：https://www.anysearch.com/docs
- [pi-all-search extension](https://pi.dev/packages/pi-all-search)
- [Add AnySearch as a built-in web search provider - pi-web-access#130](https://github.com/nicobailon/pi-web-access/issues/130)
- [AnySearch MCP Server](https://mcp.so/servers/anysearch-mcp)

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
