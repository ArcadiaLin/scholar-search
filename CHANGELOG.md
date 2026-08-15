# Changelog

本文件按时间倒序记录仓库的关键工作步骤，只记结论与落点，
详细设计与验收见 `tutorial/` 和对应目录文档。

## 2026-08-15 widi-pasa 落地

将 PaSa 论文的 Crawler / Selector 双 Agent 架构用 WIDI 原语重建，
作为 `pasa` namespace 与 `scholar` 并列运行在同一份 `packages/widi`
runtime 上。详细架构见 `tutorial/widi-pasa.md`。

- 新增 `widis/.widi-pasa/` 配置 namespace：独立的 `settings.json`、
  profiles、extensions，与 `.widi-scholar` 的 auth/session/lock/runs
  互不读取；未新增 WIDI submodule。
- 新增 `extensions/pasa-tools`：`pasa_search`（Serper）、
  `pasa_fetch_paper`（arXiv API）、`pasa_resolve_title`（标题解析）、
  `pasa_expand_refs`（ar5iv 章节与引用）；`end_date` 在 schema、
  前置检查和归一化三处强制；显式 timeout 与有界重试。
- 新增 `profiles/main.md` / `crawler.md` / `selector.md`：
  main 只做编排不持有检索工具，selector 无状态批处理。
- `scripts/run-widi.mjs` 支持 `--namespace pasa`，`package.json`
  新增 `widi:pasa` / `widi:pasa:dev` / `widi:pasa:rpc`。
- `scripts/widis-quality.mjs` / `scripts/widis-test.mjs`：对 `widis/`
  下每个 namespace 做 lint/typecheck 与 45 条离线测试（录制 fixture +
  本地 HTTP server）。
- Selector 打分由单 token logprob 退化为离散判定，官方
  Recall@20/50/100 不可比，不报告（不做模型训练）。
- 未接本地论文库（2.4 GB）；确定性编排器 `pasa-orchestrator`、
  预算拦截器和评分器延后，正式 benchmark 数字待编排器落地。
- 已知偏差登记在 `tutorial/widi-pasa.md` §5，任何运行记录必须附带。
