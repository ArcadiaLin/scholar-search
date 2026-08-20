# widi-scholar 原型开发进度

> 这条路线的状态来源。stage 定义在 `docs/06-widi-scholar-roadmap.md`（只读）。

分支：`feature/widi-scholar-prototype`

## 状态表

| Stage | 内容 | 状态 | commit | 备注 |
| --- | --- | --- | --- | --- |
| S0 | 分支、进度骨架、vllm 接入 | TODO | | |
| S1 | extension 骨架与最短链路 | TODO | | |
| S2 | 核心检索工具 | TODO | | |
| S3 | search profile：工具集收紧 | TODO | | |
| S4 | 概念到实现映射 + Preference 载体 | TODO | | |
| S5 | $NP_0^{agent}$ 条目化 | TODO | | |
| S6 | 公开轨迹 $\bar{\tau}_t$ | TODO | | |
| S7 | 其余检索工具 | TODO | | |
| S8 | Reviewer 通道 | TODO | | |
| S9 | RPC 评测入口 | TODO | | |

状态取值：`TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`。
`IN_PROGRESS` 必须在备注里写清做到哪一步；`BLOCKED` 必须写清卡在哪、试过什么、需要什么。

## 日志

每完成一段追加一条，保持简短：做了什么、验收结果、commit。

<!-- 格式示例，实际记录时删除
### 2026-08-21 — S0
- 做了：新增 vllm provider，enabledModels 加 vllm/*
- 验收：npm run widi:dev 启动正常，/model 切到 vllm/qwen3.6-35b-a3b 有回复
- commit: abc1234
-->

## 决策记录

stage 执行中做出的、路线图没有规定的选择，记在这里（含理由）。
不要推翻已记录的决策，除非它被证明是错的。

## 上游缺陷记录

只有确认是 WIDI 原生缺陷、且 extension 内无法修复时才动 `packages/widi/`。
每一次都要在这里记录最小复现、submodule commit、父仓库 gitlink 更新。

（暂无）
