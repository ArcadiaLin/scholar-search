# eval-runner：widi-scholar 的无头评测入口

通过 `npm run --silent widi:rpc` 驱动 widi-scholar 跑一组查询，
每条查询一个机器可读记录，外加一条 run 级 provenance 记录。

这是**唯一**支持的自动化边界（`AGENTS.md` §3.3）：本 runner 不抓取 TUI 文本、
不解析终端控制序列、不读取 session 文件。所有数字都来自 RPC 帧，
所以 session 的存储布局怎么变，它都照常工作。唯一的例外是仓库 revision——
那是关于 checkout 的事实而不是关于运行的，用 `git` 读。

## 用法

```bash
# 单条查询
node experiments/eval-runner/run.mjs \
  --query "Find the literature on retrieval-augmented generation for code completion." \
  --end-date 2024-06-30 \
  --model vllm/qwen3.6-35b-a3b \
  --out runs/eval/smoke

# 一组查询（JSON 数组，元素形如 { id, query, endDate? }）
node experiments/eval-runner/run.mjs \
  --queries experiments/eval-runner/queries.example.json \
  --model vllm/qwen3.6-35b-a3b \
  --out runs/eval/<name>
```

前置条件：`npm run build`（`widi:rpc` 跑的是 dist），Search Service 在运行
（地址经 `SCHOLAR_SEARCH_SERVICE_URL` 传给 extension）。

其余旗标：`--profile`（默认 `search`）、`--namespace`（默认 `scholar`）、
`--script`（默认 `widi:rpc`）、`--deadline-ms`（每条查询的 prompt 截止，默认 600000）。

输出写到 `--out` 目录的 `run.json`。`runs/` 在 `.gitignore` 里——
运行产物按 `AGENTS.md` §5.2 不入 Git。

## 打分（S10）

三个脚本串成一条回路：`autoscholarquery.mjs` 造输入 → `run.mjs` 跑 →
`score.mjs` 出数字。

```bash
# 1. AutoScholarQuery -> queries 文件（带 gold 与时间边界）
node experiments/eval-runner/autoscholarquery.mjs \
  --split train --limit 20 --out runs/eval/train-20/queries.json

# 2. 跑（答案池与轨迹落到 --out 下的 trajectories/）
node experiments/eval-runner/run.mjs \
  --queries runs/eval/train-20/queries.json \
  --model vllm/qwen3.6-35b-a3b --out runs/eval/train-20

# 3. 打分
node experiments/eval-runner/score.mjs --run runs/eval/train-20/run.json --k 20
```

**打分只读答案池**（`<agentId>.answer.json`），不读 agent 的散文。
从散文里正则抠 arXiv ID 是一个会静默劣化的仪器——agent 写"MetaBox+ 我没找到"，
正则照样算命中（`docs/develop/plan.md` §3.5）。同一个理由让池子成为硬要求：
池子为空的 episode 得 0 分并**留在分母里**。

`--k` 按 agent 写入池子的顺序截断，那是它自己给出的排序；换任何别的顺序，
打的就是一个没人产出过的排名。

报告 Recall@k / Precision@k / F1 / 中位延迟，以及两张分类表：
`byPoolStatus`（`ok` / `empty` / `never-written` / `unreadable`——同样是 0 分，
但"没调过这个工具"和"调了没提交"是两种不同的诊断）与 `byTermination`。
不只报 Recall：官方权重是 F1 70% / 效率 20% / 结构化 10%（`AGENTS.md` §5.3）。

**数据集不在仓库里。** `references/datasets/` 在 `.gitignore` 里，且上游
`CarlanLark/pasa-dataset` 是 gated HF 仓库，要凭据才能取。
`autoscholarquery.mjs` 也接受 `--input <任意 jsonl>`，格式相同即可。

`--trace-dir` 覆盖池子与轨迹的落点（经 `SCHOLAR_TRACE_DIR` 传给 extension）。
默认是 `<out>/trajectories`，这样两次 run 的答案不会互相顶掉。

**这是端到端那条路**：agent 自己写查询、自己决定判别档位、自己维护答案池。
它测的是"agent 带着这些部件做得如何"。判别器**本身**做了什么，
在 `../judge-ablation/`——那条路直接打 Service、候选集受控，
两者不能互相替代，也不能混着报（决策 D-26）。

## 记录了什么

**Provenance**（`AGENTS.md` §5.3 要求的每一项，全部来自 RPC）：
namespace、RPC protocol version、WIDI revision（submodule 的 HEAD）、
profile（id/label/来源）、model（provider/id/baseUrl）、thinking level、
加载的 extension 及其 stale 状态、scholar-search 的 `EXTENSION_VERSION`、
生效预算（经 `get_budget` 工具取得，因为边界在 Search Service 的配置里，
runtime 看不到）、启动诊断、父仓库 revision 与 dirty 标志。

**每条查询**：稳定关联 `id`、`agentId`（打分器靠它找到这条查询的答案池）、
`gold`（原样带过来，免得打分要同时对齐两个文件）、独立的 `terminationStatus`（`completed` / `timeout` /
错误码——与 `ok` 分开，因为超时和被拒都是"没有答案"，折叠在一起就没有失败分类了）、
`elapsedMs`、答案文本（只取 text part，推理内容不混入）、token usage。
**失败的查询留在记录里进分母**，不静默剔除。

**Run 级**：`run_summary`（轮次、provider 响应与错误、每工具调用数、耗时分相）。

## 隔离

每条查询 spawn 一个新 agent，跑完 dispose。共享上下文会让第 N 条查询
看见第 N-1 条的结果，单条数字就没有意义了。

## 版本

`RUNNER_VERSION`（`rpc-client.mjs`）标记本 runner 自己的记录格式；
它与 WIDI 的 RPC protocol version 是两回事，后者记录在每条 run 的 provenance 里。
