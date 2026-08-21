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

## 记录了什么

**Provenance**（`AGENTS.md` §5.3 要求的每一项，全部来自 RPC）：
namespace、RPC protocol version、WIDI revision（submodule 的 HEAD）、
profile（id/label/来源）、model（provider/id/baseUrl）、thinking level、
加载的 extension 及其 stale 状态、scholar-search 的 `EXTENSION_VERSION`、
生效预算（经 `get_budget` 工具取得，因为边界在 Search Service 的配置里，
runtime 看不到）、启动诊断、父仓库 revision 与 dirty 标志。

**每条查询**：稳定关联 `id`、独立的 `terminationStatus`（`completed` / `timeout` /
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
