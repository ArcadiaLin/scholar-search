# Orchestrator 设计

代码位置：`apps/widi/src/core/agent-orchestrator.ts`、`core/message.ts`、`core/extension/` 及 `core/` 下的协作者模块。

本文说明 orchestrator 的设计：组织判据、多 agent 生命周期管理、消息中枢、extension 支持、客户端与诊断。

## 1. 组织判据

**关于单个 agent 的事实，从那个 agent 的 `AgentHarness` 读；orchestrator 只决定需要多于一个 agent 才能回答的事。** 这些事是：AgentId 的分配、spawn 树的所有权、跨 agent 的消息路由、谁在等谁进入空闲、以及这些事实的持久化。

harness 是单 agent 的执行内核——模型轮次、会话树、资源、工具、流式生命周期。orchestrator 不重新实现其中任何一件，也不在 harness 之外为单 agent 事实维护第二份拷贝。

这条判据同时决定了一个协作者什么时候配拥有自己的类：**只有当它持有的状态，其不变量可以在不查 `_live`（活跃 agent 表）的情况下维护时**。符合的有三个：`OrchestratorEventBus`（事件广播）、`AgentContextMonitor`（上下文用量）、`AuthRuntimeController`（认证）。其余凡核心判断需要跨 `_live`、harness 相位、spawn 树做 join 的，都留在 orchestrator——再拆出去只是把 join 换成回调，不会变简单。

## 2. 多 Agent 生命周期

### LiveAgent

运行时实体 `LiveAgent`（`agent-types.ts`）聚合：`agentId`、`generation`（单调递增，用于句柄失效判定）、`profile` 与 `resolvedProfile`、`sessionRef`（持久化会话地址，ephemeral agent 无）、`harness: WidiAgentHarness`、`extensionRunner` 与 `extensionBindings`、`toolPolicy`、`settings`，以及释放钩子 `releaseHarnessBindings`。对外投影为 `AgentSnapshot`（附加 model、thinkingLevel、tools、activity、extensions、diagnostics、contextUsage）；已消亡的 agent 没有 snapshot。`AgentId` 的查找结果是四态 `AgentLookup`：`live | gone | creating | unknown`——`creating` 与 `gone` 分开，是为了让"等它建完"和"它没了"走不同的路。

### 生命周期操作

- **spawn**：`spawnAgent(options)` 是唯一创建入口，`SpawnAgentOrigin` 三种——`new`（分配 id，在父会话目录下建子会话目录；目录嵌套是 agent 树的唯一持久记录）、`resume`（从持久化会话恢复，复用 session header 中绑定的 AgentId）、`fork`（复制源会话目录后按 resume 处理，要求源 profile 允许持久化）。同一会话的并发 resume 通过创建预约复用。resume 完成后把"旧 spawn 树已关闭"作为 runtime notice 写入恢复上下文。
- **dispose**：`disposeAgent(agentId, { intent, scope })`。同步摘除（进入 tombstone 表）后异步清理：取消 human request、取消该 agent 的投递队列、detach 后台任务（以 `cause: "dispose"` reconcile 分支）、释放 harness 与 extension 绑定、`harness.shutdown()` 有 10 秒上限。`intent` 区分 `"removed"`（写持久化标记）与 `"runtime_shutdown"`（不写）；`scope` 区分单 agent 与整棵子树。
- **navigate**：`navigateAgentTree(agentId, targetId, ...)` 包装 `harness.navigateTree`（会话树回退/切换分支）；leaf 变化后触发后台任务分支 reconcile 与上下文监控失效。`compactAgent` 与 navigate 都经维护操作通道：相位门 + 活动边事件 + idle 结算。
- **运行控制**：`abortAgent`、`steerQueuedFollowUps`（把排队的 follow-up 提升为 steer）。
- **查询**：`inspectAgent` / `listAgents` / `getAgentActivity` / `getAgentSessionTree` 等快照读；`isAgentIdle` / `waitForAgentIdle` / `agentHasPendingMessages`。

### Idle 判定

`isAgentIdle` 是四源 join：harness 相位为 idle、harness 的两个内部队列均为空、消息投递队列无 pending、没有在飞的 prompt run。`waitForAgentIdle` 在满足时结算并发出 `agent_idle` 事件（原因分 `ready | settled | aborted | maintenance`）；agent 在等待期间消失时 reject 而非永远挂起。

## 3. 消息中枢

`message.ts` 是依赖图的叶子，任何模块都可以依赖它。核心规则：**所有会进入某个 agent 模型上下文的文本，都经过 orchestrator 的同一个投递方法。** 运行时没有私有投递通道。

### 两条正交的轴

- **source（身份轴）**：`MessageSource = { kind: string; label?; details? }`，"这段话是谁写的"。只决定渲染与追溯，不参与任何行为判断，持有者可以随意填写。core 内建 `human` / `agent` / `runtime`。这样安排的理由：消息内容由持有者的 `render` 闭包产出，持有者本来就能渲染出与用户输入逐字相同的文本；既然类型拦不住这件事，就不该为它付约束的代价。
- **投递策略（行为轴）**：`MessageDeliveryPolicy = { humanInterrupt, blockPolicy: "enforce" | "ignore", retryOnFailure, mergeKey? }`。这是真正改变运行时行为的东西，在 orchestrator 发放 sink 时绑定，请求不可覆盖。

模型看到的始终是纯 user 文本；类型标记是给存储和 UI 的，不是给模型的。

### API 形状

- `MessageRequest = { targetAgentId, body, source?, render?, images?, mode, editedByHuman? }`，`mode: "next_turn" | "interrupt" | "precede"`（next_turn 不打断在飞 turn；interrupt 打断；precede 不唤醒目标，落在分支上等下次输入一起读）。`editedByHuman` 只记录不参与判断：文本在送出前被人改写过，而 `source` 说的仍是原生产者，不记就等于把人写的话记在别人名下。合并批次时批内任一条带它，合并后的条目就带它——合并后的 body 说不清哪句是谁写的。
- `MessageSinkBinding = { source, policy, render?, plainEntry? }`——sink 代持者固定的一切。`plainEntry` 仅 shell 输入为真（落盘为无类型的普通 user 条目，保证既有会话可读回不变）。
- `messageSinkFor(binding): MessageSink` 是 orchestrator 暴露的唯一工厂，返回 `{ send, prompt }`。`send` 不要求目标空闲；`prompt` 要求空闲（忙目标拒绝而非排队）并等待 assistant message 返回。
- `messageBindingFor(producer)` 为内置生产者给出预置 binding：human（可打断、enforce、plainEntry）、agent（enforce，渲染加 `[Message from <id>]` 前缀）、runtime notice（ignore 阻塞、失败重试、按 mergeKey 合并）、extension（enforce，加前缀）。

### 投递决策与队列

`decideMessageDelivery({ phase, mode, requiresIdle })` 产出 `deliver | defer | reject`，投递方法为 `prompt | follow_up | steer | append`；compaction 与 branch_summary 相位一律 defer。`MessageDeliveryQueue` 对每目标维持 FIFO 并以接受序串行化；`wake(agentId)` 是相位变化后恢复 defer 的唯一通道；`mergeKey` 相同的相邻消息合并（agent notice 靠它把多条回报并成一条）；`cancel(agentId, reason)` 取消全部待发。可重试错误（harness 的 `busy | invalid_state`）与终态错误（`shutdown`）分开判定。

### 拦截管线

extension 的 `input` 拦截器作用于语义 body（`transformMessage` 返回 pass / transform / block），`render` 在拦截**之后**才取一次（优先级 `draft.render ?? binding.render ?? 恒等`）——extension 永远看不到渲染后的文本，阻塞策略为 `ignore` 时 block 降级为放行原文。

## 4. Extension 支持

### 激活模型

`ExtensionDefinition = { apiVersion, divisions?, activate }`，`activate(api: ExtensionActivationApi)` 时扩展拿到自己的能力面（`extensionId`、`agentId`、`profileId` 由 core 注入）：

- `registerTool(definition)` / `patchTool(targetToolName, patch)`：工具贡献，经 `ExtensionRunner.contributeToolsTo(registry)` 安装进工具注册表；patch 可改 `description | parameters | strict | execute | aroundExecute`。
- `registerProvider(providerName, config)`：注册模型 provider，first-registration-wins，不可覆盖内建与他人 provider，随 runner 生命周期注册与撤销。
- `appendSystemPrompt(text)`：增量追加系统提示（整体改写用 `before_agent_start` 拦截器）。
- `observe(eventName, handler)` / `intercept(eventName, handler)` / `onExtensionEvent(name, handler)` / `onDispose(handler)`。
- `division(id, register)` / `isDivisionEnabled(id)`：division 机制按声明分区，被禁用分区的 register 根本不被调用；最近规则胜出、disable 胜 enable、祖先禁用是硬门、未声明 id fail-open。

### 拦截器与观察事件

拦截器名单（`ExtensionInterceptorName`）：`before_agent_start | before_provider_request | context | input | tool_call | tool_result`。除 `input` 外复用 pi harness 的事件与结果类型；`input` 是 WIDI 自有，结果为放行 / 替换 / 阻断三态，阻断短路整条管线。

观察事件名单（`ExtensionObservedEvent`）：`agent_spawned | agent_resumed | agent_disposed | agent_status_changed | agent_idle | agent_session_forked | agent_session_info_changed | agent_persistence_ref_changed | agent_harness_event | agent_context_usage_changed | human_request_pending | human_request_resolved | human_request_timeout | human_request_cancelled | input_blocked | input_transformed | diagnostic | runtime_shutdown_requested`。诊断与 extension 自产事件不回流 observer（orchestrator 用 AsyncLocalStorage 标记 extension 引起的写入，防止扩展收到自己触发的事件而互答死循环；runtime 级 `emitExtensionEvent` 另有派发深度上限 8）。

### 事件的作用域

事件按主体 agent 派发（`_dispatchExtensionObservedEvent`），分两档：

- **树内广播**（`EXTENSION_TREE_BROADCAST_EVENT_NAMES`）：`agent_spawned | agent_resumed | agent_disposed | agent_idle | agent_status_changed`。同一棵 agent 树里每个扩展都收到。这几条是「持有别的 agent 的 id」这件事的前提——不知道它何时到达、何时停止、何时消失，跨 agent 能力就无从用起。低频，每轮至多几条。
- **只给主体 agent**：其余全部。最要紧的是 `agent_harness_event`——它是逐轮的原始事件流，订阅它的人说的是「我这一轮」；跨 agent 广播既会放大 N×M，也会改变它的含义。

代价可接受：`emitObserved` 对没注册该事件的 runner 是一次 map 查找就返回；`_agentsShareTree` 是两次父指针走到根。

三条必须知道的事实：

1. **`agent_disposed` 在剪边之前发出。** `_pruneSpawnEdges` 会删掉已销毁叶子的父边，先剪再发就会把它解析成一棵只剩它自己的树，广播找不到任何人。所以顺序是先发后剪。被销毁的 agent 自己收不到这条——它的 runner 已经不在 `_live` 里了，这条通知是给它所属的那棵树的。
2. **到达顺序不保证。** `_publishAgentActivityEdge` 发出到达边沿、`_settleAgentIdle` 发出 `ready` idle，两者都排在 `agent_spawned` 之前。所以观察者可能先看到某个陌生 id 的 `agent_status_changed` 或 `agent_idle`，再看到它的 `agent_spawned`。扩展必须容忍陌生 id。
3. **`agent_spawned` 带 `origin: "new" | "fork"`。** resume 单独走 `agent_resumed`。fork 值得单独分辨：它继承了一棵不属于自己的 spawn tree，树里每个 agent 都会拒绝它的消息与 dispose。

### Presentation 能力

extension 面向客户端的呈现全部经 `presentation.ts` 的校验层（core 不渲染，只约束形状与上限）：

- `publishMessage(message)`：发布结构化消息（kind：`text | markdown | code | table | fields | diff | banner`），持久化为会话条目，校验后深拷贝深冻结。
- `setStatus(key, status)` / `clearStatus(key)`：状态区（region：`panel | footer | agent-strip`），带 progress、icon（单字素）、tone（`neutral | info | success | warning | danger`，语义强调而非颜色——core 没有调色板）。
- `notify(text)` / `emitOutput(text)`：瞬时通知与纯文本输出，不进模型上下文。
- `reportDiagnostic(draft)`：诊断，code 被命名空间化为 `extension.<extensionId>.<code>`。

### 会话写入通道

extension 可以把状态交给会话历史管理：`ExtensionSessionContext.appendEntry(type, data)` 经 harness 写入分支，customType 被命名空间化为 `extension:<extensionId>:<type>`——一个扩展读不到另一个扩展的条目；`findEntries(type?)` 读回，resume 后仍在。条目随会话树获得回退、分叉、可追溯三条性质。另有只读会话面：本 agent 的 `getSnapshot / getTree / getLeafId`，跨会话的 `listSessions / readSession`（要求 project trust）。

### 加载与重载

`ExtensionLoader` 负责发现（`ExtensionRoot`：`agent_dir | cwd | settings`）、注册（`registerExtension(extensionId, module)`）、加载与重载。`reloadExtensions({ agentIds? })` 按 agent 报告 `reloaded | skipped | failed`（跳过原因：`creating | running | gone`）；重载时整代注销旧 harness 拦截器再装新。

### 跨 agent 能力

extension 拿到与 agent host 同名的五个方法，作用域与结构由「扩展绑在哪个 agent 上」唯一确定：`listProfiles`、`listAgents`（本树）、`describeAgent`（runtime 全域寻址）、`spawnAgent`（挂在本 agent 下）、`disposeAgent`（同树，拒绝含自身的选择）。消息不另开方法，`ExtensionSendOptions.target` 让四条注入路径都能打到别的 agent。

底下的实现只有一份：`_listProfileBriefs` / `_listAgentTree` / `_describeAgentForCaller` / `_spawnForCaller` / `_disposeForCaller` 是 orchestrator 的私有方法，agent host 和 `ExtensionCoreActions` 各自薄薄地包一层。两个面的差别不在逻辑，在**归属**——host 说话算 agent，extension 说话算 extension，而归属由构造请求的那一方决定，不由这几个方法决定。

两条刻意的差异：

- **`spawnAgent` 的 origin 更宽。** `ExtensionSpawnOrigin` 带 `profileOverride`，可以拿字段拼出一个 profile 目录里没有的角色；agent host 的 origin 没有这个字段，agent 只能从目录里挑。扩展是运维装进来的代码，拼角色是安装时就已经做过的决定。
- **不给 `watch`。** 它相对于观测 `agent_idle` 只多出「独占」（一次停止只有一个读者）和「投递进某个 agent 的上下文」，扩展两样都用不上——它没有 turn 循环，叫不醒。更要紧的是 `_agentHoldsWatches`：持有 watch 的 agent 不再发自己的 idle 通知，所以扩展代表宿主 agent 去 watch 别人，等于悄悄废掉宿主的上报，它的 owner 再也不知道它停了。

### `precede`

`MessageDeliveryMode` 三态现在扩展都够得到：`prompt`/`followUp` 走 `next_turn`，`steer` 走 `interrupt`，`precede` 走 `precede`。

`precede` 与另外三个的差别是实质的：`decideMessageDelivery` 里它单独短路成 `append`，是**唯一一个不过 phase 闸门的方法**——不会被拒绝、不会被 defer、不进任何队列，也不唤醒目标。而 `next_turn` 打到一个 idle 的 agent 会被判成 `prompt`，直接起一轮。

落点要分清：接受不等于可见。harness 把写入缓冲在正在跑的操作之后，落在那次操作的 save point，下一轮读分支时才随其余条目一起进入上下文。它不会在 turn 中途插进模型上下文。

这是扩展第一次拿到「模型可读 + 不唤醒 + 落分支」这条通道。`appendEntry` / `publishMessage` 确实落盘，但明确不进模型上下文。

**recap 机制随之可自建。** recap 实质是三件事：读分支、比对还欠什么、不唤醒地写进模型上下文。extension 现在三件都有——`session.getTree()` 返回的就是 `collect` 的入参类型，`findEntries` 的私有命名空间做幂等，写入就是 `precede`。core 自己不再有 recap：唯一的实例随后台任务一起删掉了。

### 有意的越权面

`ExtensionSendOptions.source` 被原样透传（含 `details`），消息落盘时成为条目的 `details.source`。core 保留的 `kind` 不做校验，扩展可以借此冒充任何一种内建生产者。

**这是允许的，不是待修的缺陷。** 代价是 source 命名空间从此是共享的：排查一条消息的来路，第一步查扩展，不是查 core。

### 剩余缺口

**可路由之前的钩子（未定）**

`_buildLiveAgent` 里 `bindCore` 是最后一步，所以 `activate()` 阶段 actions 未绑，什么都做不了。最早的可操作点是 `agent_spawned` / `agent_resumed` observer，那时 `ready` idle 已经发过。observer 是被 `await` 的（`event-bus.ts`），所以扩展的写入仍在 `spawnAgent()` 返回前落地，不会和第一次人类输入抢跑——但它只能追加在 core 之后，无法先于或替换 core 的行为。

生命周期级**拦截器**（`before_agent_spawn` 之类）是明确不做的，不是漏做：一旦存在就要回答「否决一次 spawn 之后，发起方看到什么」，而发起方多半是一次 tool call，那就变成 tool 结果语义的问题，比事件面大得多。想控制 spawn 的扩展可以用 `setActiveTools` 关掉 core 的 spawn 工具、自己接管，这比否决权更直接，也不引入新的失败语义。

**runtime 级 extension（未做，方向记录）**

现在的模型是「模块级单例 + 每 agent 一次激活」：`loadAvailableExtensions` 只 import 一次、存下 factory，`loadForAgent` 对每个 agent 调一次 `factory(...)`，observers / interceptors / tools / providers / systemPrompt 追加全部落进那个 agent 的 scope。

per-agent 这层是对的——profile 决定装哪些扩展、division 按 agent 选、五个拦截器天然只在某个 agent 的 turn 循环里有意义、工具和 prompt 追加本来就属于某个 agent 的注册表。缺的是它**上面**那层，证据有三条：

1. `emitExtensionEvent` 的注释自己写着「同一扩展在不同 agent 的两个实例之间协调是一等场景」——一条 runtime 级总线被加进来，专门缝合 per-agent 切开的东西。
2. 20 个 agent 就跑 20 次 `factory()`，任何昂贵的初始化重复 20 遍。
3. 想持有 runtime 级资源（一个连接、一个索引）只能塞进模块作用域——能跑，但 core 完全看不见：没有生命周期、没有诊断、没有 dispose。

方向是加第二层而不是推翻第一层，形状与 TUI 的双入口一致：一个模块两个 host，`default` 导出 per-agent 半（原封不动），另一个具名导出 per-orchestrator 半，拿全量事件与 runtime 生命周期，不拿拦截器、工具与 presentation。

## 5. 客户端、事件与诊断

**OrchestratorClient**（`client.ts`）是 TUI 实现的被动接收端，经 `registerClient` 注册：

```ts
interface OrchestratorClient<TEvent = unknown> {
	id: string;
	receive?: (event: TEvent) => void | Promise<void>;
	requestHuman?: (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;
}
```

client 收全部 `OrchestratorEvent`；human request 路由给第一个带 `requestHuman` 的 client（事件流：`human_request_pending | resolved | timeout | cancelled`；无 handler 时抛 `orchestrator.human_request_unhandled`）。主动操作面就是 orchestrator 的公开方法本身。

**OrchestratorEventBus** 只管 listeners 与 clients，不知道 extension observer——那是 orchestrator 在发布外层的组合。listener/client 失败降级为诊断（`orchestrator.listener_failed` / `orchestrator.client_failed`，交叉投递避免二次失败循环）。

**诊断**模型刻意小：`CoreDiagnostic = { severity: "warning" | "error", code, message, agentId?, extensionId? }`。severity 与策略决定执行是继续、降级、标记 agent 不可用、还是失败。凡能降级的不抛异常，凡降级必留诊断。per-agent 诊断历史随 `AgentSnapshot.diagnostics` 读出。

## 6. 公开方法总表

按用途分组（准确签名以源码为准）：

- **生命周期**：`spawnAgent`、`disposeAgent`、`disposeAll`、`navigateAgentTree`、`compactAgent`、`abortAgent`、`steerQueuedFollowUps`。
- **消息**：`messageSinkFor`、`sendMessage`、`promptAgent`、`isAgentIdle`、`waitForAgentIdle`、`agentHasPendingMessages`。
- **查询**：`inspectAgent`、`listAgents`、`getAgentActivity`、`getAgentSession`、`getAgentSessionTree`、`listAgentSessions`、`getAgentSessionName`、`setAgentSessionName`（唯一会话名写路径）。
- **工具/模型/资源**：`getAgentTools`、`setAgentTools`、`setAgentActiveTools`、`getAgentSystemPrompt`、`getAgentModel`、`setAgentModel`、`setAgentModelByReference`、`listAvailableModelCandidates`、`listAgentThinkingLevelCandidates`、`get/setAgentThinkingLevel`、`listAgentPromptTemplateCandidates`、`listAgentSkillCandidates`。
- **认证**：`listAuthProviderCandidates`、`listAuthCredentialCandidates`、`loginAuthProvider`、`logoutAuthProvider`。
- **Extension**：`registerExtension`、`listExtensionStatuses`、`reloadExtensions`。
- **Human request**：`requestHuman`、`cancelHumanRequest`。
- **客户端/事件**：`registerClient`、`subscribe`、`subscribeAgent`、`emitStartupDiagnostics`、`requestShutdown`。
- **默认值**：`get/setDefaultModel`、`get/setDefaultThinkingLevel`、`get/setDefaultProfileId`、`get/setEnabledProfileIds`。

## 延伸阅读

领域词汇表在仓库根的 `CONTEXT.md`（Core / Agent / Orchestrator / Diagnostic 等术语的定义与反义词）。实现期设计与排期文档在 `notes/develop/`（scratch）：`agent-harness-ownership-plan.md`（orchestrator 与 harness 的所有权划分及例外清单）、`ZH/orchestrator-message.md`（消息管线全文）、`ZH/orchestrator-refactor.md`、`ZH/orchestrator-wiring-plan.md`。
