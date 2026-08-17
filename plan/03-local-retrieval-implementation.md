# 本地检索支持脚本实现计划：/src/retriever

> 本文件是本地设计文档，用于把 `plan/02-retrieval-support.md` 中“本地检索 API”的设想落实为可在 `src/retriever` 下直接实现的工程方案。当前阶段只输出文档，不修改项目代码。WIDI extension 适配层（`widis/.widi-<namespace>/extensions/retrieval`）不在本次 PR 范围内，将在后续 PR 单独实现。

## 1. 目标与范围

### 1.1 本次 PR 目标

在 `src/retriever/` 下实现一组纯 Python 的本地检索支持脚本，提供：

1. **BM25 重排**：对在线源召回的候选论文做零成本、确定性的词项重排。
2. **稠密 Embedding 重排**：基于 E5 等本地 embedding 模型对候选论文做语义重排。
3. **统一 CLI**：通过 JSON stdin/stdout 被外部（后续 WIDI extension / benchmark runner）无状态调用。
4. **可测试性**：默认测试不依赖真实模型或外部 API，使用 fixture 数据即可验证行为。

### 1.2 服务边界

- **不产生召回**：只接收候选列表并返回重排结果。
- **不耦合 WIDI / TUI**：本 PR 只负责 Python 侧领域逻辑与 CLI，不触及 `packages/widi/` 或 `widis/.widi-<namespace>/`。
- **不实现跨源去重**：去重与 ID 归一由上层调用方负责；本模块只要求每篇候选提供稳定的 `paper_id`。
- **不实现持久化论文缓存**：只保留轻量的 embedding 运行时内存缓存接口，持久化在后续 PR 随 Semantic Scholar 缓存层一起做。

### 1.3 与 `plan/02-retrieval-support.md` 的关系

| `plan/02` 章节 | 本次 PR 覆盖 | 说明 |
| --- | --- | --- |
| 3.1 BM25 | ✅ 完全覆盖 | 作为核心交付 |
| 3.2 稠密 embedding 重排 | ✅ 覆盖 E5 起步 | 暴力余弦，不上 FAISS |
| 3.3 论文缓存数据库 | ❌ 不覆盖 | 仅留接口，不实现持久化 |
| 4 跨源 ID 归一与去重 | ❌ 不覆盖 | 调用方负责 |
| 6 横切要求（日期/预算/记账） | 部分覆盖 | 本地源记录耗时、结果数、费用为 0；日期边界由上层在线源保证 |

---

## 2. 目录结构

```text
src/retriever/
├── __init__.py              # 导出公开入口：rank()、BM25Ranker、EmbeddingRanker
├── schema.py                # Pydantic schema：输入输出契约
├── tokenizer.py             # 学术文本清洗与分词
├── text.py                  # 文本拼接与字段加权工具
├── bm25.py                  # BM25 索引与打分
├── embedding.py             # Embedding 模型封装（E5 + 运行时缓存）
├── ranker.py                # 统一策略分派：bm25 / embedding / hybrid
├── cache.py                 # 轻量运行时缓存接口（内存实现）
└── cli.py                   # JSON stdin/stdout CLI

tests/
├── test_bm25.py             # BM25 fixture 测试
├── test_embedding.py        # embedding fixture 测试（预计算向量）
├── test_ranker.py           # 统一入口与异常处理测试
└── fixtures/
    └── candidates.json      # 共享候选集 fixture
```

---

## 3. 数据契约

### 3.1 输入

```python
class PaperCandidate(BaseModel):
    """一篇候选论文。paper_id 由上层调用方保证跨源唯一。"""

    paper_id: str
    title: str
    abstract: str | None = None
    full_text: str | None = None
    # 外部 ID 仅用于诊断与上层去重回查，本模块不做对齐
    arxiv_id: str | None = None
    doi: str | None = None
    s2_corpus_id: str | None = None


class RankRequest(BaseModel):
    """单次重排请求。"""

    query: str
    candidates: list[PaperCandidate]
    strategy: Literal["bm25", "embedding", "hybrid"] = "bm25"
    top_k: int | None = None  # None 表示返回全部
    max_wall_ms: int = 30_000  # 本地总耗时上限
```

### 3.2 输出

```python
class RankedPaper(BaseModel):
    """重排后的单篇结果。"""

    paper_id: str
    score: float
    rank: int  # 从 1 开始
    tier: Literal["highly_relevant", "partially_relevant", "not_relevant"]


class RankResponse(BaseModel):
    """统一返回结构。"""

    ranked: list[RankedPaper]
    elapsed_ms: int
    strategy: str
    cost_usd: float = 0.0  # 本地检索无 API 费用
    source_counts: dict[str, int] = {}  # 例如 {"bm25": 10}
```

### 3.3 分级策略

不依赖绝对阈值，而是按分数分布做相对分桶：

- `highly_relevant`：排名前 20% 且 score > 0
- `partially_relevant`：排名 20%–50% 且 score > 0
- `not_relevant`：其余

若所有 score 均为 0，则全部归为 `not_relevant`。

---

## 4. BM25 实现

### 4.1 依赖

```bash
uv add rank-bm25
```

选择 `rank-bm25` 而不是自实现，原因：

- 已验证、接口稳定。
- 允许外部传入 token list，便于控制分词。

### 4.2 分词器

`src/retriever/tokenizer.py`：

- 小写化。
- 移除 LaTeX 命令、URL、DOI 前缀、纯数字。
- 按非字母数字下划线切分。
- 去除英文停用词（保留 small 停用词表，避免引入 NLTK 等大型依赖）。
- 可选： Porter Stemmer，先关闭，后续实验再开。

### 4.3 字段加权

BM25 对每篇候选只看到一个文档字符串：

```
doc = (title + " ") * 3 + (abstract or "")
```

标题权重 3 倍作为起点，后续在实验中调优。

### 4.4 类设计

```python
class BM25Ranker:
    def __init__(self, title_weight: int = 3, tokenizer: Callable | None = None) -> None: ...

    def rank(self, request: RankRequest) -> RankResponse: ...
```

---

## 5. Embedding 实现

### 5.1 模型

默认模型：

```python
DEFAULT_EMBEDDING_MODEL = "intfloat/e5-base-v2"
```

后续可替换为 `intfloat/e5-small-v2`（更快）或 `sentence-transformers/all-MiniLM-L6-v2`（最小依赖验证用）。

### 5.2 依赖

```bash
uv add sentence-transformers
```

首次运行会从 Hugging Face Hub 下载模型，使用项目已有的 `huggingface-hub` 缓存机制。

### 5.3 推理策略

- 候选数 < 1000 时直接做暴力余弦相似度，不上 FAISS。
- batch size 默认 32，可在模型加载时配置。
- 查询文本前缀：`query: {query}`
- 论文文本前缀：`passage: {title}. {abstract}`

### 5.4 运行时缓存

`src/retriever/cache.py` 提供一个 `EmbeddingCache` 接口：

```python
class EmbeddingCache(Protocol):
    def get(self, key: str) -> list[float] | None: ...
    def set(self, key: str, vector: list[float]) -> None: ...
```

本次 PR 只提供内存实现 `InMemoryEmbeddingCache`，按 `paper_id` 缓存论文向量（查询向量不缓存）。持久化缓存后续再补。

### 5.5 类设计

```python
class EmbeddingRanker:
    def __init__(
        self,
        model_name: str = DEFAULT_EMBEDDING_MODEL,
        cache: EmbeddingCache | None = None,
        device: str = "auto",
    ) -> None: ...

    def rank(self, request: RankRequest) -> RankResponse: ...
```

---

## 6. Hybrid 策略

当 `strategy == "hybrid"` 时：

1. 分别计算 BM25 分数和 embedding 分数。
2. 各自 min-max 归一到 `[0, 1]`。
3. 组合：`score = 0.5 * bm25_norm + 0.5 * emb_norm`。
4. 按组合分排序、分级。

权重 `0.5 / 0.5` 作为起点，后续通过固定 benchmark 调优，不允许在隐藏集上调参。

---

## 7. CLI 设计

### 7.1 调用方式

```bash
uv run python -m src.retriever.cli rank < request.json > response.json
```

### 7.2 输入输出约定

- **stdin**：单个 `RankRequest` JSON。
- **stdout**：单个 `RankResponse` JSON，且只输出 JSON，保证可被 JSONL 管线安全消费。
- **stderr**：人类可读诊断与异常堆栈，不进入 stdout。

### 7.3 异常处理

| 异常 | stdout | stderr | 退出码 |
| --- | --- | --- | --- |
| 输入校验失败 | 空 | 错误信息 | 2 |
| 策略不支持 | 空 | 错误信息 | 3 |
| 模型加载失败 | 空 | 错误信息 | 4 |
| 超时 | 空 | timeout 信息 | 5 |
| 其他运行时错误 | 空 | 堆栈 | 1 |

### 7.4 CLI 模块职责

`cli.py` 只做三件事：解析 stdin、调用 `ranker.rank()`、序列化输出。不包含任何领域逻辑。

---

## 8. 测试策略

### 8.1 默认测试（无模型、无网络）

| 测试文件 | 覆盖点 |
| --- | --- |
| `test_tokenizer.py` | 停用词、LaTeX、数字、URL 清洗 |
| `test_bm25.py` | 排序方向、top_k、分级、空候选、全零分 |
| `test_embedding.py` | 用预计算向量 fixture 验证 cosine 排序与缓存命中 |
| `test_ranker.py` | 策略分派、参数校验、超时模拟 |

### 8.2 慢速集成测试

| 测试文件 | 覆盖点 | 标记 |
| --- | --- | --- |
| `test_embedding_e2e.py` | 真实加载 `intfloat/e5-small-v2` 并打分 | `@pytest.mark.slow` |
| `test_cli.py` | 子进程调用 CLI，验证 stdout 纯净性 | `@pytest.mark.slow` |

### 8.3 BM25 fixture 示例

```json
{
  "query": "transformer language model pretraining",
  "candidates": [
    {
      "paper_id": "p1",
      "title": "Attention Is All You Need",
      "abstract": "We propose the transformer, a model architecture based solely on attention."
    },
    {
      "paper_id": "p2",
      "title": "Cooking for Beginners",
      "abstract": "A guide to basic culinary techniques."
    }
  ],
  "strategy": "bm25"
}
```

期望：`p1` 排在 `p2` 前，且 `p2` 为 `not_relevant`。

---

## 9. 依赖与安装

本次 PR 计划新增的 Python 依赖（均通过 `uv add` 管理）：

```text
rank-bm25>=0.2.2
sentence-transformers>=3.0.0
```

不新增：

- `faiss-cpu`（候选 < 1000 无需向量索引）。
- `nltk`（自维护小停用词表足够）。
- `scikit-learn`（除非 BM25 改自实现，否则不需要）。

---

## 10. 验收标准

- [ ] `uv run python -m src.retriever.cli rank` 可接收 JSON 并返回结构化重排结果。
- [ ] `uv run pytest tests/test_bm25.py` 全部通过。
- [ ] `uv run pytest tests/test_embedding.py` 全部通过（不加载真实模型）。
- [ ] `uv run pytest tests/test_ranker.py` 全部通过。
- [ ] `uv run ruff check .` 与 `uv run ruff format --check .` 通过。
- [ ] 不修改 `packages/widi/`、`widis/.widi-<namespace>/`、`packages/metasci-universe/`。
- [ ] 不提交 API key、模型权重或大文件。

---

## 11. 实施步骤

1. **基础设施**
   - 新增 `src/retriever/schema.py`、`src/retriever/tokenizer.py`、`src/retriever/text.py`。
   - 新增 `src/retriever/cache.py`（内存实现）。
2. **BM25**
   - 新增 `src/retriever/bm25.py`。
   - 新增 `tests/test_bm25.py` + fixture。
   - `uv add rank-bm25`。
3. **Embedding**
   - 新增 `src/retriever/embedding.py`。
   - 新增 `tests/test_embedding.py`（预计算向量）。
   - 新增 `tests/test_embedding_e2e.py`（`@slow`，真实模型）。
   - `uv add sentence-transformers`。
4. **统一入口与 CLI**
   - 新增 `src/retriever/ranker.py`。
   - 新增 `src/retriever/cli.py`。
   - 新增 `tests/test_ranker.py`、`tests/test_cli.py`。
5. **公开 API**
   - 在 `src/retriever/__init__.py` 导出 `rank()`、`BM25Ranker`、`EmbeddingRanker`。
6. **检查与文档**
   - 运行 Ruff、pytest、类型检查（mypy 可选）。
   - 更新本文件状态为“已实施”。

---

## 12. 后续 PR 规划（不在本次）

- **WIDI extension adapter**：在 `widis/.widi-scholar/extensions/retrieval/` 注册 `local_rank` tool，调用 `src/retriever/cli`。
- **论文缓存数据库**：持久化原始响应与 embedding，支持冷热命中统计。
- **在线源接入**：Semantic Scholar / OpenAlex API（见 `plan/02-retrieval-support.md` §2）。
- **Hybrid 权重调优**：在固定 benchmark 上对比 BM25 / embedding / hybrid 的 F1。

---

## 13. 备注

- 本模块的“本地”指**运行于本机、无外部 API 调用**，但不代表不下载模型。模型下载走 Hugging Face Hub 默认缓存，运行前需保证网络可达或缓存已存在。
- 所有实现必须遵循 `AGENTS.md` §3.2：显式 schema、可注入的 provider/cache/clock、确定性逻辑不隐藏网络调用。
