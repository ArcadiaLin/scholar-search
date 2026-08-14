# Scholar Search

本项目面向 `problem.md` 描述的“科研场景下复杂学术查询的智能论文搜索与推荐”赛题，目标是构建一个端到端的学术论文智能搜索系统，完成：

- 解析并分解包含主题、方法、数据、时间和发表范围等约束的复杂查询；
- 通过多策略检索、引文网络探索和动态查询演化提高候选覆盖率；
- 对候选论文进行相关性过滤、去重和综合排序；
- 以论文列表、关系图等机器可读形式归纳搜索结果；
- 在提高 Precision、Recall 和 F1 的同时，控制 API 调用、Token、费用和端到端延迟。

赛题原始要求及评分口径以 [`problem.md`](problem.md) 为准，其中 F1、运行效率和结构化回复的权重分别为 70%、20% 和 10%。

## 开发基座

- [`packages/widi`](packages/widi) 是固定提交的 WIDI Git submodule，提供多 Agent 运行时、终端应用、extension API 和 Benchmark RPC。
- [`.widi-scholar`](.widi-scholar) 是本项目的 WIDI Scholar 发布配置，承载 Profile、模型配置和后续 Scholar extensions。
- [`references/sources.yaml`](references/sources.yaml) 记录论文、参考仓库、固定版本、许可证和本地路径。
- `experiments/` 用于保存可复现实验代码和固定配置；大规模运行输出、论文、数据和参考仓库副本保持忽略。

初始化并运行开发环境：

```bash
git clone --recurse-submodules <repository-url>
cd scholar-search
npm run bootstrap
npm run build
npm run widi:dev
```

自动化评测和无头集成使用：

```bash
npm run widi:rpc
```

## 研究与开发追溯

本项目的完整研究与开发过程通过 Git commit 追溯。提交历史用于记录：

- 研究假设、采用的论文或外部方法及其来源；
- 实验数据版本、配置、模型、预算、指标和可审阅结果；
- 从实验实现提升到正式代码的依据和迁移过程；
- WIDI submodule 的固定 revision 及 RPC、extension 等基座变更；
- 失败修复、评测口径调整和架构决策。

被忽略的大型产物不作为唯一证据；能够复现实验所需的代码、配置、来源清单和小型结果摘要应随对应 commit 纳入版本控制。可使用以下命令查看演进记录：

```bash
git log --oneline --decorate
git show <commit>
git submodule status
```

具体开发、研究、评测和版本控制纪律见 [`AGENTS.md`](AGENTS.md)。
