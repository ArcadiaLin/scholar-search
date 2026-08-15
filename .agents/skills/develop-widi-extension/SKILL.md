---
name: develop-widi-extension
description: 在本仓库的 Scholar/PASA namespace 下开发、修改或调试 WIDI extension；覆盖 Core/TUI 双入口、工具、provider、profile、拦截器、观察器、命令、快捷键、组件和 extension event bus。说明本仓库的目录、API 边界、验证命令与常见陷阱。
---

# 在 scholar-search 中开发 WIDI extension

本仓库使用一份固定的 WIDI runtime：`packages/widi/` 是 Git submodule，`widis/.widi-scholar/` 和 `widis/.widi-pasa/` 是按 namespace 隔离的配置、profiles、models、prompts、skills 和 extensions。

WIDI extension 使用 WIDI 自己的运行时协议，**不是** Pi coding-agent 的 `ExtensionAPI`。在这里写 `pi.registerTool()`、`pi.on()` 或照抄 Pi extension 示例都是错误的；必须遵守当前固定 WIDI revision 的 Core/TUI 契约。

学术查询解析、检索编排、候选筛选、排序、归纳和评测接入默认放在目标 namespace 的 `widis/.widi-<namespace>/extensions/` 中。WIDI runtime 只提供通用运行时能力，不要为了赛题逻辑修改 `packages/widi/`。

## 0. 写代码前必须读取

按此顺序读取，不要凭记忆写 API：

1. `packages/widi/apps/widi/docs/extensions.md`：当前固定 WIDI revision 的 extension 合约。
2. `packages/widi/apps/widi/src/core/extension/api.ts`：extension 作者可依赖的 Core 导出面。
3. `packages/widi/apps/widi/src/core/extension/types.ts`：`ExtensionActivationApi`、`ExtensionContext`、`ExtensionActions`、拦截器和观察事件的完整签名。
4. `packages/widi/apps/widi/src/tui/extension-host/types.ts`：`WidiTuiExtensionApi` 和 TUI 相关类型。
5. `packages/widi/.widi/extensions/drill/`：WIDI 上游提供的双入口行为基准；它是参考实现，不是本仓库 Scholar/PASA extension 的落点。
6. 根目录 `AGENTS.md`：本仓库的 Extension First、namespace、submodule 和验证规则。

Extension 只能依赖 `packages/widi/apps/widi/src/core/extension/api.ts` 及其中明确重导出的公共类型，以及 TUI host 的公开类型。禁止导入 `orchestrator`、`loader`、`runner` 或其他 WIDI 内部实现，也不要保存内部 runtime 对象。

`packages/widi/` 是固定 submodule。除非已经用最小复现证明公开 extension API 无法表达通用能力，否则不要修改其中源码；若确需修改，必须遵守根目录规则，在 submodule 内单独提交并更新父仓库 gitlink。

## 1. 先确定入口形态

| 需求 | 入口 |
| --- | --- |
| 工具、模型 provider、profile、system prompt、拦截器、观察器、session state、agent 事件 | Core half：default export；每个 agent runtime 激活一次 |
| slash command、快捷键、widget/layout、tool/message renderer、theme、editor 文本 | TUI half：具名 `tui` export；整个应用激活一次 |
| 两者都需要 | 双入口；通过 extension event bus 通信 |

只需要一半时只实现一半，不要为了对称增加空的另一半。与 WIDI 无关且需要独立评测的确定性算法保持纯净边界：使用显式输入输出和注入的 provider/cache/clock；extension 负责适配和编排，不要把领域算法下沉到 WIDI core。

## 2. 本仓库的落点与 scaffold

选择目标 namespace。默认目录结构如下：

```text
widis/
├── .widi-scholar/
│   ├── settings.json
│   └── extensions/
│       └── <id>/
└── .widi-pasa/
    ├── settings.json
    └── extensions/
        └── <id>/
```

`npm run widi:dev` 会从仓库根目录启动 Scholar，并传入 `--cwd <repo-root>` 与 `--agent-dir widis/.widi-scholar`；`npm run widi:pasa:dev` 使用 `widis/.widi-pasa`。因此本仓库 namespace extension 的实际发现目录是对应 agent dir 下的 `extensions/`。

不要把项目 extension 放到根目录 `.widi/extensions/`，也不要把它写进 `packages/widi/.widi/extensions/`。后者是 WIDI submodule 内的 `drill` 示例，只作为上游参考。不要在两个 namespace 之间复制 WIDI runtime；扩展是否同时供两个 namespace 使用，应通过各自配置和明确的共享路径设计解决。

扩展 id 是目录名。最小结构：

```text
widis/.widi-<namespace>/extensions/<id>/
├── index.ts        # default Core export；需要 TUI 时再导出 named tui
├── protocol.ts     # 双入口才需要：事件名和 JSON payload 类型
├── core/           # Core half
├── tui/            # TUI half
└── tsconfig.json
```

入口按 `package.json` 的 `widi.extensions`（兼容 `pi.extensions`）第一项解析，否则按 `index.ts`、`index.js`、`index.mjs`、`index.cjs` 解析。入口由 jiti 动态加载，TypeScript 不需要预编译；但动态加载 extension 不会被应用自身的 workspace check 自动覆盖。

对于 `widis/.widi-<namespace>/extensions/<id>/index.ts`，导入当前仓库固定 WIDI 作者 API 的相对路径通常是：

```ts
import {
	EXTENSION_API_VERSION,
	type ExtensionDefinition,
} from "../../../../packages/widi/apps/widi/src/core/extension/api.ts";
import type { TuiExtensionModule } from "../../../../packages/widi/apps/widi/src/tui/extension-host/index.ts";
```

如果改变目录深度，必须重新计算相对路径；不要改成导入 WIDI 内部模块。当前 extension API version 是 v1，使用 `EXTENSION_API_VERSION`，不要自行写一个版本常量。

从 `packages/widi/.widi/extensions/drill/tsconfig.json` 复制配置时，必须把路径改成 namespace extension 的深度，例如：

```json
{
	"extends": "../../../../packages/widi/tsconfig.base.json",
	"compilerOptions": {
		"noEmit": true,
		"paths": {
			"@arcadialin/agent-core": ["../../../../packages/widi/packages/agent/src/index.ts"],
			"@arcadialin/agent-core/node": ["../../../../packages/widi/packages/agent/src/node.ts"],
			"@arcadialin/agent-core/*": ["../../../../packages/widi/packages/agent/src/*.ts"]
		}
	},
	"include": ["**/*.ts"]
}
```

在目标 namespace 的 `settings.json` 中启用：

```json
{
	"enabledExtensions": ["<id>"]
}
```

本仓库当前 Scholar 和 PASA 的 `enabledExtensions` 都是空数组，含义是“不加载任何 extension”。`enabledExtensions` 存的是 extension id，不是路径；不设置该键才表示加载全部已发现 extension。`extensions` 键若出现，表示额外的显式入口路径，不能与 `enabledExtensions` 混淆。

## 3. Core half

`activate(api)` 是声明贡献的阶段，不是当前 agent 的操作上下文。注册工作放在这里，运行时动作放在 handler 中。可用能力包括：`registerTool`、`patchTool`、`registerProvider`、`registerProfile`、`appendSystemPrompt`、`observe`、`intercept`、`onExtensionEvent`、`onDispose` 和 `division`。

### 工具示例

下面示例适用于 namespace extension；路径导入使用本仓库布局：

```ts
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import {
	EXTENSION_API_VERSION,
	type ExtensionDefinition,
} from "../../../../packages/widi/apps/widi/src/core/extension/api.ts";

const MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_LINES = 40;

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => {
		api.registerTool({
			name: "file_head",
			label: "File Head",
			description: "Read the first lines of a text file in the workspace.",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the workspace root." }),
				lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			}),
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const target = isAbsolute(params.path)
					? params.path
					: resolve(context.workspace.cwd, params.path);
				const raw = await readFile(target, "utf8");
				const selected = raw.split("\n").slice(0, params.lines ?? DEFAULT_LINES);
				const joined = selected.join("\n");
				const truncated = joined.length > MAX_OUTPUT_CHARS;
				const text = truncated ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : joined;
				return {
					content: [{ type: "text", text }],
					details: { path: target, linesReturned: selected.length, truncated },
				};
			},
		});
	},
};

export default extension;
```

这个示例体现的硬约束：

- 失败必须 `throw`，不能用成功返回值伪造错误。
- 工具自身限制输出大小，禁止无界内容进入模型上下文。
- 在执行工作前检查 abort signal。
- 路径基于执行该 agent 的 `context.workspace.cwd`，不能捕获或使用 `process.cwd()` 代替它。
- `details` 用结构化数据服务日志和 TUI presenter，不必复制模型可见文本。
- 工具可能并行执行；读改写同一文件时必须处理并发竞争。

修改既有工具使用 `patchTool(name, { description, parameters, strict, execute, aroundExecute })`。`aroundExecute` 适合审计、确认和 sandboxing；不要为同一个工具另注册一个隐式替代品。

### 运行时操作

observer、interceptor 和 bus handler 收到 `ExtensionContext`。运行时操作只能走 `context.actions` 和 `context.session`，不要保存上下文供 dispose/reload 后继续使用。

`context.actions` 覆盖 agent tree、工具、模型、`requestHuman`、`abort`、`waitForIdle`、`compact`、`exec`、`emitOutput`、`notify`、`setStatus`、`publishMessage` 等受控操作。`exec` 和跨 session 读取受 project trust 约束。

向 agent 发送文本的语义不同，不能混用：

- `prompt`：目标必须 idle；忙时拒绝，不排队。
- `steer`：插入当前运行。
- `followUp`：当前任务结束后再运行。
- `precede`：写入 branch，下一轮模型可见，但不唤醒 agent，也不经过 phase 队列。

四者都会再次经过 `input` interceptor。`context.session.appendEntry()` 写入持久 branch，会在 resume 时重放、在 fork 时复制且不可删除；只有确实需要恢复、分叉或审计的状态才写入，普通缓存留在内存。

## 4. TUI half

TUI command 使用 `CommandDefinition`，必须声明 `kind`、`agentPolicy`、`name`、`description`，以及 action 的 `execute` 或 prompt 的 `expand`：

```ts
api.registerCommand({
	kind: "action",
	agentPolicy: "active",
	name: "my-extension-status",
	description: "Show extension status.",
	execute: async () => "ready",
});
```

`registerShortcut` 接收 binding id，不接收直接硬编码的按键判断；真实 action id 是 `ext.<extensionId>.<bindingId>`，用户在 `keybindings.json` 中覆盖按键。

TUI half 不绑定某一个 agent。要驱动当前可见 agent，应使用 capability，或发出 event bus 事件让 Core runtime 执行。`stage(text)` 只是把文本放进 editor 暂存区，用户可以修改或丢弃；它不保证写入 session，也不保证模型读取。组件和 renderer 必须容忍失败，host 会隔离错误并保留诊断。

## 5. 双入口通信

Core 与 TUI 绝不互相 import。共享内容放在纯数据模块；协议事件放在 `protocol.ts`。事件名使用 `<owner>:<event>`，payload 必须是可复制冻结的 JSON value。

总线会广播给所有 live Core runtime 和 TUI subscriber，包括发送者自身。因此 handler 通常先检查 `event.sourceAgentId` 或显式 source 字段。事件级联深度有限；不要设计两个 handler 无条件互相回应。事件 payload 不能依赖对象身份，也不能在 handler 中修改。

## 6. 常见错误

- 绝不要在 `tool_call` 或 `context` interceptor 中 `await waitForIdle()`：当前 turn 必须先等 interceptor 返回，会死锁。
- `input` interceptor 也会收到 agent、runtime 和 extension 注入的消息；只针对人类输入时必须检查 `event.source`。
- `input` 和 `tool_call` handler fail-closed：抛错会阻断；其他 hook 记录诊断并继续。
- observed event 没有顺序保证；可能先收到 `agent_status_changed`，后收到 `agent_spawned`。
- `appendEntry()` 和 `publishMessage()` 在 agent 运行时可能被 harness 缓冲，返回的 entry id 可能是 `undefined`，不能把同步 id 当作协议保证。
- `registerProvider` 是 first-registration-wins，不能覆盖内建 provider；`registerProfile` 会被同 id 的用户 profile 遮蔽。
- division 必须同时出现在 `divisions` 声明和实际注册逻辑中；禁用祖先会硬禁用所有子 division。配置写在目标 namespace 的 `extensionDivisions`，也可用 `/division <id>/<division>` 切换。
- `onDispose` 必须释放 extension 创建的 timer、watcher、连接等长生命周期资源。dispose 或 `/reload` 后，之前捕获的 `context`、`actions`、`session` 都已失效。
- 不要把 API key、cookie、代理凭据写入 extension；从环境变量或被忽略的本地状态读取，并为网络调用设置 timeout、有界重试和可观测错误。

## 7. 本仓库的验证闭环

第一次准备环境：

```bash
npm run bootstrap
```

对 namespace extension 单独做类型和格式检查。以 Scholar 为例：

```bash
npm --prefix packages/widi exec -- tsgo --noEmit -p widis/.widi-scholar/extensions/<id>/tsconfig.json
npm --prefix packages/widi exec -- biome check --config-path packages/widi/biome.json widis/.widi-scholar/extensions/<id>
```

PASA 将路径中的 `.widi-scholar` 换成 `.widi-pasa`。根目录 `npm run check` 不会自动覆盖动态加载的 extension，因此不能代替上面两条命令。

运行实际 namespace，而不是运行错误的裸 `npm run tui`：

```bash
npm run widi:dev          # Scholar，TypeScript 源码
npm run widi:pasa:dev     # PASA，TypeScript 源码
```

Core half 修改后，在对应 TUI 输入 `/reload`；TUI half 修改后重启对应应用。需要验证构建产物时先执行 `npm run build`，再运行 `npm run widi` 或 `npm run widi:pasa`。自动化路径使用对应静默 RPC：`npm run --silent widi:rpc` 或 `npm run --silent widi:pasa:rpc`，不要抓取 TUI 文本或直接读取 session 文件。

排查顺序：

1. 确认 extension 位于目标 namespace 的 `extensions/`，id 已列入该 namespace 的 `enabledExtensions`；
2. 查看启动诊断或 `/reload` 诊断，重点看 `extension.load_failed`、`extension.version_incompatible`、`extension.activation_failed`；
3. 检查目标 division 是否被 `extensionDivisions` 或 `/division` 关闭；
4. TUI half 问题直接重启应用；
5. 与 `packages/widi/.widi/extensions/drill/` 和 `packages/widi/apps/widi/docs/extensions.md` 对照，而不是与 Pi extension 示例对照。

## 8. 交付前检查

- [ ] extension 位于正确的 `widis/.widi-<namespace>/extensions/`，目标 namespace 已启用它。
- [ ] 仅依赖 `packages/widi/apps/widi/src/core/extension/api.ts` 及明确公开的 TUI 类型。
- [ ] `core/` 与 `tui/` 没有互相 import；共享内容是纯数据。
- [ ] `apiVersion` 使用 `EXTENSION_API_VERSION`，每个声明的 division 都实际注册贡献。
- [ ] 所有长生命周期资源都在 `onDispose` 释放。
- [ ] 工具失败时抛错，工具自行限制输出，并检查 abort signal。
- [ ] 没有无理由的 session branch 写入；若写入，说明恢复、fork 或审计为何需要它。
- [ ] Scholar/PASA 的领域逻辑没有下沉到 WIDI submodule；网络、缓存和时钟边界可注入且错误可观察。
- [ ] namespace extension 的 `tsgo`、Biome 检查通过，并在对应的 `npm run widi:dev`（Scholar）或 `npm run widi:pasa:dev`（PASA）下实际运行过一次。
