# Scholar Search Development Rules

## 1. Repository Mission

本仓库用于完成 `problem.md` 描述的“科研场景下复杂学术查询的智能论文搜索与推荐”赛题，并沉淀可复现的研究、评测和工程实现。

- `problem.md` 是赛题要求的唯一事实来源。除排版外，不得改写其中的表述、指标或约束。
- 优先级固定为：正确性与 F1、可复现性、运行效率、结构化输出、工程便利性。
- 研究结论必须最终落到可运行代码、固定配置和可复核结果；只有笔记或提示词不算实现。

## 2. Repository Boundaries

| 路径 | 职责 | 版本控制策略 |
| --- | --- | --- |
| `packages/widi/` | 唯一固定提交的 WIDI 上游 Git submodule 及其独立 npm workspace | 父仓库只锁定一个 gitlink；源码、测试、文档和 lockfile 在上游仓库维护 |
| `packages/widi/packages/agent/` | 从 Pi 派生的单 Agent 内核 | 尽量保持上游形态，只接受明确的 fork 修复 |
| `widis/.widi-<namespace>/` | 按 namespace 管理的 WIDI Scholar 配置、profiles、skills、prompts、themes 和 extensions | 配置和源码纳入 Git；认证、会话和运行状态忽略 |
| `src/`、`tests/` | 独立于 WIDI 的 Python 领域逻辑和测试 | 纳入 Git |
| `experiments/` | 实验代码、固定配置、分析脚本 | 纳入 Git；运行输出放在被忽略的子目录 |
| `references/` | 外部论文、仓库和数据集的来源记录 | 只提交清单；完整副本保持忽略 |
| `papers/`、`data/`、`runs/`、`artifacts/` | 本地材料、数据、运行记录和大文件 | 默认忽略，不作为源码依赖 |

不要把 `packages/widi/` 当作普通第三方黑盒，也不要把它和赛题代码混在一起。WIDI 提供唯一运行时和扩展 API；不同 WIDI namespace 默认通过 `widis/.widi-<namespace>/` 的 profile、setting、model、prompt 和 extension 表达。

`packages/widi/` 必须保持为可复现的固定提交。修改 WIDI 时，在 submodule 内创建提交并推送到 `ArcadiaLin/widi`，再由父仓库更新唯一 gitlink；不得在父仓库留下未提交的 submodule 改动。正式实验期间禁止隐式跟随远端 HEAD，升级必须单独执行并重新验证。

## 3. Architecture Policy

### 3.1 Extension First

学术查询解析、检索编排、候选筛选、排序、归纳和评测接入，默认实现为对应 `widis/.widi-<namespace>/extensions/` 下的 WIDI extension。

修改 `packages/widi/apps/widi/` 只允许两种情况：

1. extension API 无法表达所需能力，并且新增能力对 WIDI 本身具有通用价值；
2. 已用最小复现确认是 WIDI 原生缺陷，无法在 extension 中正确修复。

修改 `packages/widi/packages/agent/` 前还必须确认问题属于单 Agent 内核。不得为了赛题便利把领域逻辑下沉到 WIDI 或 Pi fork。

WIDI extension 只能依赖 `apps/widi/src/core/extension/api.ts` 及其明确导出的公共类型；不得依赖 orchestrator、loader、runner 等内部实现。Core 与 TUI 两半不得互相 import，跨半通信使用 extension event bus。

### 3.2 Domain Core

与运行时无关且需要独立评测的算法应保持纯净边界：

- 输入输出使用显式 schema，不传递 TUI 或 Agent 内部对象；
- 检索 provider、LLM provider、缓存和时钟通过接口注入；
- 排序、去重、指标计算等确定性逻辑不得隐藏网络调用；
- extension 负责适配和编排，不重复实现领域算法。

只有出现真实复用点时才抽象公共模块。禁止预建无调用方的框架、兼容层或占位接口。

### 3.3 RPC and Benchmark Boundary

WIDI RPC 是自动化评测、批量实验和无头集成的标准运行边界。Benchmark runner 必须通过 namespace 对应的 RPC 启动入口驱动 WIDI Scholar，不得抓取 TUI 文本、解析终端控制序列或直接读取内部 session 文件。

RPC 只承载通用运行时能力；查询 schema、论文结果、关系图和赛题指标仍属于 `widis/.widi-<namespace>/` 或领域模块。不得把 Scholar 专用命令、数据集规则或评分逻辑写入 WIDI RPC。

当固定 Benchmark 最小复现表明现有公开 RPC 无法可靠表达以下通用能力时，允许直接修改 `packages/widi/apps/widi/src/rpc/` 及必要的相邻 Core API，不要求先用 extension 绕过：

- 请求关联、结构化结果和错误分类；
- agent 创建、隔离、重置、等待、取消、超时和干净退出；
- 多 Agent 事件顺序、并发与背压；
- Token、费用、模型调用、工具/API 调用、缓存和延迟等可观测数据；
- Profile、模型、extension 和预算等生效配置的机器可读快照；
- 协议版本、能力发现、输入校验和客户端兼容性。

修改前必须先固定 RPC client 契约和失败复现。协议破坏性变更必须提升 `RPC_PROTOCOL_VERSION` 并同步迁移全部调用方；不得保留未迁移的旧路径。修改至少覆盖类型、运行时分派、公开协议文档，以及真实子进程级集成测试；测试必须包含 stdout JSONL 纯净性、stderr 诊断、启动期 human request、成功与失败 prompt、超时/abort、shutdown、结构化 extension event 和 usage/cost 传播。

## 4. Dependency and Runtime Rules

### Python

- 使用根目录 `pyproject.toml` 和 `uv.lock`；只用 `uv add`、`uv remove`、`uv sync` 管理依赖。
- 命令通过 `uv run ...` 执行。禁止提交手工维护的 `requirements.txt`，除非比赛交付格式明确要求导出。
- Python 最低版本由 `pyproject.toml` 定义；代码不得依赖未声明的全局包。

### TypeScript / WIDI

- 克隆父仓库后先运行 `git submodule update --init --recursive`；不得把 WIDI submodule 内容复制回父仓库追踪。
- WIDI runtime 只维护在 `packages/widi/`，使用其 `package-lock.json` 和 npm；可复现安装使用 `npm ci`。
- Node.js 必须满足 WIDI 的 `>=22.19.0` 要求。
- 不得引入 pnpm、Yarn 或第二份 WIDI runtime/lockfile；namespace 配置不得复制 WIDI 源码或依赖。
- `packages/widi/packages/agent/` 的版本跟随其 Pi 上游基线；不要顺手升级依赖或格式化整棵目录。

### Secrets and External Services

- API key、cookie、代理凭据和用户认证只能来自环境变量或被忽略的本地状态文件。
- 提交 `.env.example` 时只能写变量名和说明，不得放可用凭据。
- 新增学术 API 或模型 provider 时，必须记录服务名、模型或 API 版本、速率限制、重试策略和成本口径。

### Canonical Commands

| 命令 | 用途 |
| --- | --- |
| `npm run bootstrap` | 初始化固定版本的 WIDI submodule，按其 lockfile 安装 npm 依赖，并用 uv 同步 Python 开发环境 |
| `npm run build` | 构建唯一 WIDI runtime 的 agent core 和终端应用 |
| `npm run widi:dev` | 从 TypeScript 源码启动 Scholar namespace，使用 `widis/.widi-scholar/` 和当前仓库作为工作区 |
| `npm run widi` | 从已构建的 `dist` 启动 Scholar namespace |
| `npm run widi:rpc` | 以 Scholar namespace 的 JSONL RPC 模式启动，供自动化集成 |
| `npm run widi:pasa:dev` | 从 TypeScript 源码启动 PASA namespace，使用 `widis/.widi-pasa/` |
| `npm run widi:pasa` | 从已构建的 `dist` 启动 PASA namespace |
| `npm run widi:pasa:rpc` | 以 PASA namespace 的 JSONL RPC 模式启动 |
| `npm run check` | 运行 WIDI lint/typecheck 与 Python Ruff 检查，不修改文件 |
| `npm test` | 运行 WIDI 两个 workspace 的测试 |

## 5. Research and Experiment Protocol

### 5.1 Research

研究任务开始前先写清：

1. 假设或要回答的问题；
2. 对比基线；
3. 数据集及版本、切分和时间边界；
4. 指标与通过条件；
5. API、Token、延迟和费用预算。

论文和参考仓库用于形成可检验设计，不作为权威实现直接复制。采用外部方法时记录来源、固定版本、许可证以及本项目的具体改动。

### 5.2 Experiments

- 实验代码和配置放入 `experiments/<topic>/`，一次性探查放入 `scratch/`。
- 配置必须显式包含模型/provider 版本、prompt 或策略版本、数据版本、随机种子、检索时间边界和预算。
- 每次正式运行必须可追溯到代码版本与完整配置，并记录查询数、API 调用数、输入/输出 Token、墙钟时间、失败数和估算费用。
- 原始响应、缓存、checkpoint 和逐样本大输出写入被忽略目录；可审阅的小型汇总可以纳入 Git。
- 只有在固定评测上稳定优于基线、成本可接受且失败模式明确后，实验实现才能进入对应的 `widis/.widi-<namespace>/extensions/` 或 `src/`。

### 5.3 Evaluation

- 官方权重固定为 F1 70%、运行效率 20%、结构化回复 10%；不得只报告 Recall。
- 同一对比必须使用相同查询、候选时间边界、最大调用预算和停止条件。
- 公开集用于开发，隐藏集不得用于 prompt、阈值或排序权重调优。
- 评测至少报告 Precision、Recall、F1、端到端延迟、API 调用数和 Token；关系图等结构化输出另做契约检查。
- 缓存命中与冷启动结果分开报告。失败请求不得静默排除，必须进入分母或单独说明口径。
- 正式自动评测使用版本化 RPC client 通过对应 namespace 的静默 RPC 启动命令（Scholar 使用 `npm run --silent widi:rpc`，PASA 使用 `npm run --silent widi:pasa:rpc`）；每次运行记录 namespace、RPC protocol version、WIDI revision、Profile、模型、extension 版本和生效预算。
- 每个样本必须有稳定关联 ID、独立终止状态和机器可读结果；保存原始 RPC 事件与聚合指标，使输出、失败和成本都可复核。

## 6. Development Workflow

1. 先读 `problem.md`、相关实现和测试，确认变更落在哪个边界。
2. Bug 修复先构造最小复现；性能优化先记录基线；研究改动先固定实验配置。
3. 优先修改对应的 `widis/.widi-<namespace>/`；触及 WIDI fork 时保持补丁最小，并补覆盖该差异的测试。
4. 运行最窄且能证明行为的检查，再运行受影响 workspace 的类型检查和测试。
5. 将有效实验提升为正式实现时，迁移所有调用方并删除旧路径、临时开关和重复配置。
6. 提交前确认没有凭据、大文件、运行缓存或未固定版本的外部副本。

不得用忽略异常、放宽断言、硬编码单个评测样本或增加无界重试来掩盖问题。网络调用必须有超时、有界重试和可观测失败。

## 7. Code and Test Quality

- 代码应便于人读；名称表达领域含义，注释只解释外部约束、非显然原因和易破坏的不变量。
- 延续所在模块的既有模式，不得为同一问题引入第二套配置、错误或持久化约定。
- 测试关注可观察契约：查询约束、去重、排序稳定性、预算停止、错误传播、缓存语义和结构化输出。
- 网络测试使用记录好的确定性 fixture 或明确的集成测试标记；默认测试不得依赖实时 API。
- 对外部 API 的解析必须覆盖缺失字段、分页、限流、超时和重复论文标识。
- 不为实现细节、源码文本或无行为价值的默认值写测试。

## 8. External Assets and Provenance

- 论文放入 `papers/`，参考仓库放入 `references/repos/`，数据集放入 `references/datasets/`；这些目录不提交完整内容。
- `references/sources.yaml` 记录论文 URL/arXiv ID、仓库 URL/commit、数据版本、许可证、用途和本地路径。
- 运行时不得依赖被忽略目录中“碰巧存在”的文件。必要资源必须能由清单和脚本重新获取，或转为正式依赖。
- 不直接编辑参考仓库；需要采用的代码应按许可证迁移到正式模块，并保留来源说明。

## 9. Communication and Overrides

- 默认使用中文，回答简短、直接、技术化；先给结论，再给路径、证据和风险。
- 不使用 emoji。失败必须报告实际命令与错误，不得伪装成通过。
- 对用户反馈先明确同意或不同意，再说明依据和改动。
- 普通工程判断自行完成；只有选择会显著改变产品行为、成本或数据口径时才询问用户。
- 用户要求与本规范冲突时，明确指出冲突及风险，并在执行前取得确认。