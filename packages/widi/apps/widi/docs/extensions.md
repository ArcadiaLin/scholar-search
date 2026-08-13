# Extension 开发

代码位置：`apps/widi/src/core/extension/`、`apps/widi/src/tui/extension-host/`；完整示例：`.widi/extensions/drill/`。

WIDI extension 是自己的运行时协议，**不是** Pi coding-agent 的 `ExtensionAPI`。不要在 WIDI extension 中使用 Pi 文档里的 `pi.registerTool()`、`pi.on()` 等 API；应使用本项目的 Core/TUI 契约。

当前 extension API 为 v1，但尚未作为独立稳定包发布。开发 extension 时应锁定 WIDI 版本；第三方 extension 只应依赖 `core/extension/api.ts` 导出的作者 API 和该文件明确重导出的类型，不能依赖 orchestrator、loader、runner 等内部实现。

## 1. 安装、发现与启用

一个 extension 是一个 TypeScript/JavaScript 文件或目录。目录入口按以下顺序解析：

1. `package.json` 的 `widi.extensions`（兼容读取 `pi.extensions`）的第一个入口；
2. `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`。

入口由 jiti 加载，因此 TypeScript 不需要预编译。extension id 是入口文件名或目录名。例如：

```text
.widi/
├── settings.json
└── extensions/
    └── my-extension/
        └── index.ts       # extension id: my-extension
```

运行时按以下顺序发现扩展，先发现的同名 id 获胜：

1. `settings.json` 的 `extensions` 指向的显式路径；
2. 已信任项目的 `<cwd>/.widi/extensions/`；
3. agent dir 的 `extensions/`，通常是 `~/.widi/extensions/`。

项目目录下的 extension 只有在项目被信任后才加载。显式路径和 agent-dir extension 是安装者的信任边界：extension 有执行 Node.js 代码的能力，只安装可信来源。

在 `settings.json` 启用：

```json
{
  "enabledExtensions": ["my-extension"]
}
```

- 不设置 `enabledExtensions`：加载全部已发现 extension。
- 设置为空数组：不加载任何 extension。
- `/reload` 重载当前 agent 的 Core half；修改 TUI half 后需要重启应用。

仓库内开发可仿照 `drill`：扩展放在 `.widi/extensions/`，从入口通过相对路径导入作者 API。安装脚本将 `drill` 链接到源码 checkout；它不是可直接复制的发布包模板。

## 2. 双入口模型

一个 extension 可有两半：

- **Core half**：模块的 default export。每个加载它的 agent 各激活一次；负责工具、模型、消息、会话、拦截器和 agent 事件。
- **TUI half**：模块的具名 `tui` export。整个 TUI 应用只激活一次；负责命令、快捷键、组件和终端展示。

两个 host 独立加载，Core 与 TUI 不应互相 import。若两半需要协作，在 `protocol.ts` 定义 JSON 事件载荷，经 extension event bus 通信。`.widi/extensions/drill/` 的 `index.ts`、`core/`、`tui/` 和 `protocol.ts` 是推荐结构。

```ts
import {
  EXTENSION_API_VERSION,
  type ExtensionDefinition,
} from "../../../apps/widi/src/core/extension/api.ts";
import type { TuiExtensionModule } from "../../../apps/widi/src/tui/extension-host/index.ts";

const core: ExtensionDefinition = {
  apiVersion: EXTENSION_API_VERSION,
  activate(api) {
    api.appendSystemPrompt("Use the project deployment policy.");
  },
};

export const tui: TuiExtensionModule = {
  apiVersion: 1,
  activate(api) {
    api.registerCommand({
      kind: "action",
      agentPolicy: "active",
      name: "my-extension-status",
      description: "Show extension status.",
      execute: async () => "ready",
    });
  },
};

export default core;
```

上例的相对导入只适用于仓库 `.widi/extensions/my-extension/` 布局；独立分发前应先确定与目标 WIDI 构建匹配的 API 导入路径和版本。

## 3. Core 激活 API

`activate(api)` 是声明贡献的阶段，不是当前 agent 的操作上下文。它可做的事：

- `registerTool(tool)`：注册新工具。
- `patchTool(name, patch)`：修改已有工具的 `description`、`parameters`、`strict`、`execute` 或 `aroundExecute`。
- `registerProvider(name, config)`：注册新的模型 provider。不能覆盖内建或其他 extension 已注册的 provider，先注册者生效。
- `registerProfile(profile)`：注册 extension 自带 profile；用户同 id profile 会遮蔽它。
- `appendSystemPrompt(text)`：按注册顺序追加系统提示。若要逐轮整体改写，使用 `before_agent_start` interceptor。
- `observe(name, handler)`：订阅观察事件。
- `intercept(name, handler)`：注册拦截器。
- `onExtensionEvent(name, handler)`：订阅 extension bus。
- `onDispose(handler)`：释放 extension 自己建立的连接、timer 或 watcher。
- `division(id, register)`：将一组贡献放入可独立开关的分区。

最小工具：

```ts
import { Type } from "typebox";

api.registerTool({
  name: "my_echo",
  label: "My Echo",
  description: "Return text unchanged.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: params.text }],
      details: undefined,
    };
  },
});
```

工具执行失败应 `throw`，不要以返回值模拟错误。工具输出必须自行限制大小，避免无界内容进入模型上下文。工具可能并行执行；自行实现读改写文件的工具应处理同一文件的并发竞争。

## 4. 事件与拦截器

### 拦截器

可拦截的事件如下：

| 名称 | 能力 |
| --- | --- |
| `input` | 放行、改写或阻断所有进入 agent 的消息 |
| `before_agent_start` | 追加消息或替换该轮 system prompt |
| `context` | 改写即将发送给模型的上下文 |
| `before_provider_request` | 修改模型流请求参数、headers、metadata |
| `tool_call` | 审核或阻断工具调用 |
| `tool_result` | 改写工具结果 |

拦截器按 extension 加载顺序运行。`input` 的 transform 和 `context` 的结果会链式传给后一个 handler；`tool_call` 的第一个 block 会终止调用。输入策略的 handler 异常会 fail-closed（阻断），工具调用 handler 异常也会阻断；其他 hook 异常会记录诊断并继续。

`input` 不只处理人类输入，也处理 agent、runtime 与 extension 注入的消息。若策略只针对人类消息，必须检查 `event.source`。

### 观察事件

`observe()` 可订阅：

- 生命周期：`agent_spawned`、`agent_resumed`、`agent_disposed`、`agent_status_changed`、`agent_idle`；
- session：`agent_session_forked`、`agent_session_info_changed`、`agent_persistence_ref_changed`；
- 执行内核：`agent_harness_event`；
- 其他：`agent_context_usage_changed`、human request 状态、`input_blocked`、`input_transformed`、`diagnostic`、`runtime_shutdown_requested`。

其中 spawn/resume/dispose/status/idle 会向同一 agent tree 广播，其余通常只交给事件主体 agent 的 extensions。事件到达顺序不保证；尤其处理其他 agent 时，必须容忍先收到状态事件、后收到 `agent_spawned`。

## 5. Handler context 与受控操作

observer、interceptor 和 bus handler 都收到 `ExtensionContext`：

```ts
context.extensionId;
context.agentId;
context.profileId;
context.actions;
context.session;
context.signal;
context.isIdle();
```

`context.actions` 是 extension 唯一的运行时操作面，不要取得或保存 `AgentOrchestrator` 等内部对象。

| 类别 | 主要方法 |
| --- | --- |
| Agent tree | `listProfiles`、`listAgents`、`describeAgent`、`spawnAgent`、`disposeAgent` |
| 工具 | `getTools`、`setTools`、`setActiveTools` |
| 模型 | `getModel`、`setModel`、`listModelCandidates`、读写 thinking level |
| 人工交互 | `requestHuman` |
| 运行控制 | `abort`、`hasPendingMessages`、`waitForIdle`、`compact`、`navigateTree` |
| 运行时 | `requestShutdown`；无 host 的 embedding 才使用 `disposeRuntime` |
| 本地执行 | `exec(command, options)`，要求 project trust |
| 瞬时展示 | `emitOutput`、`notify`、`setStatus`、`clearStatus`、`reportDiagnostic` |

`waitForIdle()` 不能从 `tool_call` 或 `context` interceptor 内 await：当前 turn 必须先等该 handler 返回，等待会构成死锁。

### 向模型发送文本

四个方法共用同一消息管线，也都会经过 `input` interceptor：

- `prompt(text)`：目标必须空闲，立即运行；忙时拒绝而不排队。
- `steer(text)`：插入当前运行。
- `followUp(text)`：当前任务结束后再运行。
- `precede(text)`：写入 branch，下一轮模型可见，但不唤醒 agent、不经过 phase 队列。

四者都可传 `{ target, images, source, render }`。`target` 可寻址 runtime 中另一 agent；但 `spawnAgent` 只会创建当前 agent 的子 agent，`disposeAgent` 只能处置同一 tree。

## 6. 会话与展示

`context.session` 是 extension 私有的会话状态面：

```ts
await context.session.appendEntry("state", { revision: 3 });
const entries = await context.session.findEntries<{ revision: number }>("state");
```

写入类型会命名空间化，其他 extension 不可通过 `findEntries()` 读取。它随 session branch 回退和 fork，适合确实需要恢复、分叉与追溯的状态；不要把普通临时缓存写进 branch。

其他 session 方法：

- 当前 session：`getSnapshot()`、`getTree()`、`getLeafId()`；
- 当前项目的其他顶层 session：`listSessions()`、`readSession(ref)`，要求 project trust。

展示通道的语义不同：

- `emitOutput()` / `notify()`：瞬时，不进 session，也不进模型上下文。
- `setStatus()`：按 key 保存运行时状态；TUI 可显示在 panel、footer 或 agent strip。
- `publishMessage(message)`：持久化展示消息，不进模型上下文。内建 kind 为 `text`、`markdown`、`code`、`table`、`fields`、`diff`、`banner`；也可配合 TUI renderer 使用自定义 kind。
- `precede()`：模型可读的持久文本，适合“下一轮需要知道、但现在不应启动”的上下文。

`appendEntry()`、`publishMessage()` 在 agent 运行时可能先被 harness 缓冲，返回的 entry id 因而可能为 `undefined`。不要把同步取得 id 当成协议保证。

## 7. Division

division 用来让一个 integration 的可选部分真正不注册、不初始化：

```ts
const extension: ExtensionDefinition = {
  apiVersion: EXTENSION_API_VERSION,
  divisions: [
    { id: "github", label: "GitHub integration" },
    { id: "github.review", label: "Pull request review" },
  ],
  async activate(api) {
    await api.division("github", async (github) => {
      github.registerTool(/* ... */);
      await github.division("review", (review) => {
        review.registerTool(/* ... */);
      });
    });
  },
};
```

分区 id 以 `.` 分隔，只能含字母、数字、`_`、`-`。禁用祖先会硬性禁用所有子项。配置写在 `extensionDivisions`：

```json
{
  "extensionDivisions": {
    "my-extension": {
      "disable": ["github.review"],
      "enable": ["github"]
    }
  }
}
```

用户也可用 `/division my-extension/github.review` 切换当前状态；命令会重载当前 agent。声明的 id 是面向用户的开关清单，因此不要以未声明 id 作为正式功能分区。

## 8. TUI half

TUI half 得到 `WidiTuiExtensionApi`，可扩展：

- 命令：`registerCommand()`；命令使用 TUI 的 `CommandDefinition`，并声明 `agentPolicy`。
- 快捷键：`registerShortcut(bindingId, { defaultKeys, handler })`。实际 action id 是 `ext.<extensionId>.<bindingId>`，用户可在 `keybindings.json` 覆盖；不要在 extension 中硬编码按键判断。
- 工具与消息展示：`registerToolPresenter()`、`registerMessageRenderer()`、`registerEntryRenderer()`。
- 布局：`setWidget()`、`setHeader()`、`setFooter()`、`showOverlay()`。
- 编辑器：`getEditorText()`、`setEditorText()`、`pasteToEditor()`。
- 主题：`theme`、`setTheme()`、`getAllThemes()`。
- 应用 capability：`capability(key)`；只有已声明的 capability 才有稳定形状。
- 生命周期：`onDispose()`。

TUI half 不绑定一个 agent。需要针对当前可见 agent 的动作时，通过 capability 或向 event bus 发事件，让对应 Core runtime 执行。`stage(text)` 仅将文本暂存到 editor，用户下次提交前仍可修改或丢弃；它不保证写 session，更不保证模型会读取。

TUI 组件和 renderer 必须容忍调用失败。host 会隔离 extension 的加载、激活和渲染错误，保留诊断并让其余 UI 继续运行。

## 9. Core/TUI 通信与清理

事件名称建议采用 `owner:event`，载荷必须是 JSON 值：

```ts
// Core: 订阅
api.onExtensionEvent("my-extension:open", async (event, context) => {
  if (event.sourceAgentId !== context.agentId) return;
  await context.actions.notify("Opened.");
});

// TUI: 发出
await api.emitExtensionEvent("my-extension:open", { source: "toolbar" });
```

总线广播给每个 live Core runtime，以及 TUI 订阅者，也包括发送者自身。载荷会被复制冻结；不要依赖对象身份或试图修改它。级联派发深度有限，handler 间不能设计无条件互相回应的协议。

Core 的 `onDispose()` 和 TUI 的 `onDispose()` 都必须释放 extension 自己启动的长生命周期资源。Core runner 会在 agent dispose 或 Core reload 时失效；此后捕获的 `context`、`actions`、`session` 都不可再用。

## 10. 开发与检查

以仓库内 extension 为例：

```bash
npm run tui
# 修改 Core half 后，在 TUI 输入：/reload

npx tsgo --noEmit -p .widi/extensions/my-extension/tsconfig.json
npx biome check .widi/extensions/my-extension
```

可将 `drill/tsconfig.json` 复制为起点，并按 extension 所在目录调整 `extends`、`paths` 的相对路径。应用自身的 `npm run check` 不会覆盖运行时动态加载的 extension。

排查问题时：

1. 确认 extension id 已列入 `enabledExtensions`，且项目已被信任；
2. 查看启动诊断或 `/reload` 结果，特别是 `extension.load_failed`、`extension.version_incompatible`、`extension.activation_failed`；
3. 用 `/division` 检查目标 division 是否已被关闭；
4. 对 TUI half 的问题重启应用；
5. 以 `.widi/extensions/drill/` 为行为基准，而不是 Pi 的 extension 示例。

## 延伸阅读

- `apps/widi/src/core/extension/api.ts`：第三方作者可依赖的 Core API 出口。
- `apps/widi/src/core/extension/types.ts`：完整类型、事件和 action 签名。
- `apps/widi/src/tui/extension-host/types.ts`：TUI API。
- `apps/widi/docs/orchestrator.md` §4：extension 与多 agent、消息和会话的运行时语义。
- `.widi/extensions/drill/README.md`：双入口示例的设计约束。
