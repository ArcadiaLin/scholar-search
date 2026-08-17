# LitSearch 快速检索评测

本目录用于在 LitSearch 固定语料库上快速对比 **BM25**、**远程 Embedding** 和 **Hybrid** 三种检索策略的效果。

与 `experiments/litsearch-bm25/eval_bm25.py` 不同，本脚本：

- **只建一次 BM25 倒排索引**，所有查询复用该索引；
- **只编码一次语料的 embedding**，所有查询复用内存向量；
- 同时报告 **Precision@k / Recall@k / F1@k**，便于和赛题指标对齐。

## 数据准备

数据记录在 `benchmarks/sources.yaml`：

- repo: `princeton-nlp/LitSearch`
- 本地路径: `references/datasets/litsearch`
- 查询：597 条（`query/full-00000-of-00001.parquet`）
- 语料：64,183 篇（`corpus_clean/*.parquet`，共 6 个文件）

下载方式：

```bash
export HF_TOKEN=hf_...                 # 公开 read token 即可
uv run python benchmarks/download.py download litsearch --profile benchmark
```

## 运行评测

### BM25

```bash
uv run python experiments/litsearch-retrieval/eval.py --strategy bm25
```

### Embedding（需要远程 E5 服务）

确保 `.env` 已配置：

```bash
EMBEDDING_BASE_URL=http://192.168.163.112:8001/v1
EMBEDDING_MODEL=intfloat/e5-base-v2
EMBEDDING_API_KEY=
```

然后：

```bash
uv run python experiments/litsearch-retrieval/eval.py --strategy embedding
```

### Hybrid

```bash
uv run python experiments/litsearch-retrieval/eval.py --strategy hybrid
```

### 快速冒烟

只跑前 10 条查询：

```bash
uv run python experiments/litsearch-retrieval/eval.py --strategy bm25 --max-queries 10
```

### 自定义 k 值

```bash
uv run python experiments/litsearch-retrieval/eval.py --strategy bm25 --ks 5 20 50
```

## 输出

结果写入 `runs/litsearch-<strategy>-results.json`，摘要包含：

- `mean_precision@k`
- `mean_recall@k`
- `mean_f1@k`
- 按 `broad` / `specific` 拆分的子集指标
- 总耗时、平均查询延迟

## 设计说明

1. **索引一次性构建**：`CorpusBM25Index` 在初始化时对 64,183 篇文档分词并创建 `BM25Okapi`；`CorpusEmbeddingIndex` 一次性批量编码全部文档向量。查询阶段只做打分/相似度计算。
2. **Hybrid 策略**：BM25 分数和 embedding cosine 分数各自 min-max 归一化到 `[0, 1]`，按 `0.5 * bm25 + 0.5 * embedding` 组合后排序。
3. **缓存**：本脚本使用内存缓存；语料向量全部驻留内存，64k 篇 E5-base 向量约占用 `64183 * 768 * 4 ≈ 197 MB`。
4. **失败处理**：embedding 调用失败会直接抛出异常并中断；超时、限流等已在 `RemoteEmbeddingProvider` 中处理。
