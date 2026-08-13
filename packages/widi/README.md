# WIDI

WIDI fork 自 [Pi](https://github.com/earendil-works/pi)，以其 `AgentHarness` 作为单 Agent 执行内核。

WIDI 是一个可扩展的终端 coding agent。在单 Agent 内核之上，它提供原生多 Agent 编排、持久会话、Profile、后台任务和扩展能力，并通过终端 TUI 交互使用。

> 项目仍在快速迭代中，当前以源码工作区方式运行。

## 它能做什么

- **终端 coding agent**：在 TUI 中完成代码阅读、搜索、编辑、写入和 shell 执行。
- **原生多 Agent 协作**：Agent 可以发现可用 Profile、创建子 Agent、向其他 Agent 发送消息、等待任务结果并销毁已完成的 Agent。
- **持久会话**：支持新建与恢复历史会话、分叉会话树、树导航和上下文压缩。
- **基于 Profile 的 Agent 角色定义**：通过 Markdown Profile 定义系统提示词、可见工具、技能和项目上下文。
- **高度可扩展**：扩展可以注册或修改工具、注册命令和模型提供方、订阅事件、拦截输入，并提供受控的运行时操作。官方扩展可在同一运行时基础上提供不同发行版；MCP 是其中一种扩展方式。
- **异步后台任务**：支持后台 shell 任务的读取、等待和取消，也可用于 Agent 委派任务。
- **人工交互**：Agent 可以向人请求确认或输入。

## 安装

前置条件：Node.js `>= 22.19.0` 和 npm。

```bash
git clone <repo-url> && cd widi
./install.sh
```

`install.sh` 会安装依赖并构建，把 `widi` 命令装进 `~/.local/bin`（指向本 clone 的 `apps/widi/dist/cli.js`），并把 `preset/` 种到 `~/.widi`。重复运行会覆盖 preset 管理的文件（profiles、themes），但不会动 `settings.json`、`agent/models.json`、`auth.json`、`trust.json`、`runs/` 等状态文件。`extensions/drill` 是指向本 clone 的符号链接（它的源码按相对路径引用 app 代码，拷贝出去会断），所以 `git pull` 后它随即更新，其余部分重跑 `install.sh` 即完成升级。

默认模型是 `kimi-coding/k3`（Kimi for Coding），在 TUI 内登录即可；也可以设 `MOONSHOT_API_KEY` / `ANTHROPIC_API_KEY` 使用 `~/.widi/agent/models.json` 里预定义的 moonshot 和 anthropic 提供方。

## 开发运行

```bash
npm install
npm run build
npm run tui
```

`npm run tui` 使用仓库内的 `.widi/` 配置，并继承当前终端的工作目录。默认配置面向本仓库的本地开发环境，与 `install.sh` 安装的 `~/.widi` 互不影响。

## TUI 使用

直接输入文本即可向当前 Agent 发送任务。Agent 正在运行时，普通输入会排入下一轮；使用 `/steer <text>` 可立即介入，`/abort` 可中止当前运行。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/new`、`/clear` | 关闭当前 Agent，按相同 Profile 创建新会话 |
| `/resume`、`/session` | 恢复或列出持久会话 |
| `/fork`、`/tree` | 分叉会话或查看、导航会话树 |
| `/agent`、`/inspect` | 查看运行中的 Agent 或当前 Agent 状态 |
| `/model`、`/thinking` | 切换模型或思考等级 |
| `/compact` | 压缩当前会话上下文 |
| `/skill`、`/prompt` | 应用 Skill 或 Prompt 模板 |
| `/reload` | 重载当前 Agent 的扩展 |
| `/quit` | 退出程序 |

命令支持自动补全。运行中的 Agent 也可以通过工具创建子 Agent、委派任务并读取后台任务结果。

## 配置、Profile 与扩展

agent 目录是 WIDI 的配置根目录，常见结构如下：

```text
.widi/
├── settings.json          # 运行时默认值、启用的 Profile 与扩展
├── agent/models.json      # 模型提供方和模型定义
├── profiles/*.md          # Agent Profile
├── skills/*/SKILL.md      # Skill
├── prompts/*.md           # Prompt 模板
└── extensions/*/          # 扩展
```

Profile 是带 YAML frontmatter 的 Markdown 文件，可声明角色名称、系统提示词、持久化行为、允许使用的工具、Skill 和项目上下文。模型由 `agent/models.json` 配置；密钥可以通过环境变量引用，例如 `$MOONSHOT_API_KEY` 或 `$ANTHROPIC_API_KEY`，不应提交真实密钥。项目目录中的 `.widi/` 配置属于项目本地代码，只有在项目被信任后才会加载；这避免了打开未知项目时自动执行其扩展或读取其指令。

扩展是运行时的一等参与者：它们可以贡献工具、命令、资源和模型提供方，也可以订阅事件或在受控钩子中检查、改写、阻止输入。一个扩展可以同时有 core 与 TUI 两半（default 导出与 `tui` 具名导出），两半由各自的宿主独立加载，经运行时级的扩展事件总线对话。

## 与 Pi 的关系和未来接入

WIDI 的单 Agent 内核来自 Pi 的 `AgentHarness`：模型调用、工具循环、流式事件和会话树仍由它负责。WIDI 在其外层实现多 Agent 生命周期、运行时依赖解析、跨 Agent 消息、后台任务、客户端事件分发和扩展机制。

Pi 上游正在持续迭代 `AgentHarness` 与存储模型。WIDI 当前从 Pi `v0.83.0` fork 并维护 `packages/agent`，包名为 `@arcadialin/agent-core`；`@earendil-works/pi-ai` 与 `@earendil-works/pi-tui` 仍使用 npm 上的固定版本。随着上游新 harness 稳定，WIDI 会评估接入其新模型的时机与迁移路径。当前 fork 的维护约束、差异和重新同步条件见 [`docs/pi-fork.md`](docs/pi-fork.md)。

## 仓库结构

- [`apps/widi`](apps/widi)：WIDI 的运行时、内置工具、扩展系统和终端 TUI；构建后提供 `widi-harness` 二进制。
- [`packages/agent`](packages/agent)：从 Pi fork 的 `@arcadialin/agent-core`，作为 WIDI 的单 Agent 执行内核。
- [`docs/pi-fork.md`](docs/pi-fork.md)：Pi fork 的维护约束和设计背景。
- [`apps/widi/docs`](apps/widi/docs)：extension、orchestrator 和 persistence 的运行时契约与设计说明。

## 开发

```bash
npm run build   # 构建 agent core 和 WIDI 应用
npm run check   # Biome 格式化/lint 与 TypeScript 检查
npm run test    # 运行工作区测试
```

`packages/agent` 是刻意保持接近上游的 vendored 代码。除非修改明确属于 fork 差异，不应随意重构或重新格式化该目录。
