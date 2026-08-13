# Persistence 设计

代码位置：`apps/widi/src/core/persistence/`。

本文说明持久化层的设计：pi 的对话树模型如何成为一切可恢复状态的权威，以及 custom storage 契约如何让 core 模块和 extension 各自接入一套随对话树管理的可恢复存储。

## 1. 设计目标

持久化层回答一个问题：**会话被回退、被分叉、被删除时，它附带的状态该怎么办。**

答案只有一条原则：**会话树是权威。** 一份状态由分支上的一条 ref entry 命名，回退到那条 entry 之前它自动失效，分叉一条分支就自动带走它能看见的全部状态。没有任何一种状态可以为回退或分叉定义自己的规则。

这条原则要覆盖的不只是 pi 的对话历史本身。core 模块与 extension 都有"希望随会话一起恢复、回退、分叉"的状态。因此这一层在会话存储之上提供 custom storage 契约：任何模块注册一个 namespace，就能获得一个受会话树管理的可恢复存储，而不需要仓库认识它。

## 2. 磁盘布局

```
<root>/                                  # 例如 .widi/runs
  --root-projs-widi--/                   # 按项目 cwd 分组，encodeCwd()
    20260801T120345Z_root/               # 一个顶层会话目录
      session.jsonl                      # 对话历史，唯一的权威
      persistence/
        core__notes/objects.jsonl         # 一个 namespace 的对象日志
        core__notes/output/               # namespace 自己的附属文件
      agents/                            # 这个会话 spawn 出的子会话
        20260801T120400Z_coder-1/
          session.jsonl
          persistence/...
          agents/...
```

布局规则由 `utils/layout.ts` 独占：

- **目录即所有权。** 会话目录拥有自己的历史、custom storage 和子会话目录。删除根会话递归删除整棵子树，fork 根会话复制整棵子树，子会话只能经父到达。
- **子会话在 `agents/` 下**，不与 `session.jsonl` 平级，嵌套路径段严格交替 `<dir>/agents/<dir>`。列举会话目录时因此永远不需要判断某个子目录是不是保留目录。保留名：`agents`、`persistence`。
- **嵌套深度上限 `MAX_SESSION_DEPTH = 8`**（每级两层目录段，Windows 260 字符限制）。超深的 spawn 降级为顶层会话并报 `persistence.nesting_limit`，spawn 本身不失败。
- 目录名为 `<compactTimestamp>_<sessionId>`。时间戳供人按时间阅读，唯一性靠 id 中的随机字符与 repo 的空位检查（冲突时追加 `-2`、`-3` 后缀）。
- **`SessionKey` 是会话的逻辑地址**（`readonly string[]`，根目录名加每代一个目录名），`SessionAddress = { cwd, key }` 是完整定位。持久化记录指向另一个会话时永远存 `SessionKey`，绝不存文件系统路径——磁盘布局可以演进而不必迁移任何记录。

custom storage 在自己 `persistence/` 目录下的内部形状不受会话层规则约束；namespace 可以通过 `locate` 把目录挪到会话子树之外，代价是失去"删源 fork 仍可解析"等由目录所有权提供的性质（见 §5）。

## 3. 会话存储：JsonlSession

`session.jsonl` 是 pi 的 v3 JSONL 格式，`jsonl-session.ts` 是 pi `JsonlSessionStorage` 的移植，与 v3 header/entry 格式**逐字节兼容**（`SESSION_FORMAT_VERSION = 3`），由差分测试保证：同一份字节用两个实现打开，双向比对元数据、条目、leaf、统计、标签、游标。

文件第一行是 header（格式版本、会话 id、创建时间、cwd、父会话路径、metadata），其后每行一条 `SessionTreeEntry`。entry 有 `id` 和 `parentId`，所以文件是一棵树而不是一条线：`setLeafId` 回退到某个祖先后继续追加，就长出一条新分支，旧分支仍在文件里。

移植之外，这一层拥有两个 pi 没有的方法，存在理由相同：

- `getFullBranch()`：完整的 root→leaf 路径。pi 的公开路径 `getPathToRootOrCompaction()` 在 compaction 检查点停下，因为那是给模型上下文用的；持久化必须走全分支，因为比检查点更早的 ref 仍然生效——模型忘记一件事，不代表这件事不成立。**任何时候在持久化路径上使用 compaction 截断的路径都是 bug。**
- `getEntriesToFork()`：fork 复制的条目集，同样不得截断于 compaction，否则检查点之前的 ref 会被静默丢弃，新会话恢复出来缺失状态。`position: "before" | "at"` 控制复制到目标 entry 之前还是包含目标。

## 4. 仓储：JsonlPersistenceRepo

`jsonl-persistence.ts` 是目录级入口，一个实例管理一个持久化根（构造参数 `{ fs, root, registry }`）。职责分四组：

**会话 CRUD 与树操作**：`create` / `open` / `list`（仅顶层会话）/ `listChildren` / `delete`（递归子树）；`fork(source, options)` 复制一棵会话子树；只读底层访问 `getEntries` / `getFullBranch` / `sessionFilePath`。

**恢复**：`resolveState(address)` 返回 `{ projection, states, diagnostics }`——先对完整分支做投影（§6），再逐 namespace 解析状态根。解析逐 namespace 降级：未注册报 `unknown_namespace`、对象缺失报 `dangling_ref`、版本低且无 `migrate` 报 `unsupported_version`。**会话本身永远可读**，任何 namespace 的失败都不阻塞会话打开。

**状态写入**：`stageState({ address, namespace, data, dependencies?, anchorEntryId? })` 把对象写入对象日志并返回 `PersistenceRefData`；`clearState(namespace)` 返回 `stateRoot: null` 的清除 ref。

这里有一条贯穿全文件的不对称：仓库**读**会话树、**写** custom storage，但**永不写活跃会话分支**——活分支的写入专属 `AgentHarness`（turn 内串行化且缓冲，不返回 entry id）。因此提交状态是构造上的两步：

1. `stageState` 先写对象（内容寻址），返回 ref 数据；
2. 调用方经 harness 把 ref 追加为分支上的 custom entry。

对象先行是安全次序：两步之间崩溃只留下可回收的孤儿对象，而不是指向无物的 ref。反向设计（先 ref 后补对象）在 harness 的缓冲写入模型下根本无法实现。

**namespace 存储打开**：`openStorage(address, namespace)`（未注册返回 `undefined`，绝不因空注册表删除磁盘数据）、`openDefaultStorage(...)`（直接打开默认对象日志实现）。

**fork 的内部顺序固定**：复制会话条目 → 对**源**的完整分支做投影 → `planForkClosure` 计算复制计划 → 复制对象、应用各 namespace 的 fork 策略、递归 fork 全部子会话 → 为每个存活的 namespace 在新分支追加一条带 `origin` 的 ref。此后新会话不再从源目录读任何字节——fork 出的会话在源目录被删除后必须仍然完整可恢复，这是"持久化不是缓存"的判定标准。单个子会话复制失败报 `child_not_copied` 后继续；子会话整棵按各自当前 leaf 复制，因为分支上没有信息决定哪些子会话属于它。

## 5. Custom Storage 契约

`custom-storage.ts` 是扩展点本体。框架给 namespace 三样承诺：会话内一个专属目录、一种被会话分支命名的方式、fork 时的一次递归复制。namespace 回答四个问题：状态根是什么、依赖什么、fork 时怎么办、旧版本怎么读。唯一硬性要求是**状态根不可变**——分支命名它，不再当前的分支也必须仍能解析到它命名的内容。

### CustomStorage（一个 namespace 在一个会话目录上打开的存储句柄）

- `resolveState(stateRoot)`：读取状态根对应的状态；`undefined` 表示对象不存在（dangling ref，报告而非抛出）。
- `listDependencies(stateRoot)`：该根在同 namespace 同会话内依赖的其他状态根。
- `copyReachable(target, roots)`：把 roots 闭包复制到同 namespace 的另一个 storage；仓库已解析完闭包，实现不再遍历，复制已存在的对象必须是 no-op。
- `putObject({ data, dependencies? })`：写入对象并返回其状态根，按内容幂等。
- `storedFormatVersion?`：磁盘数据的格式版本，低于 definition 的 `version` 时触发 `migrate`。
- `close?()`：契约上永不抛错。每次 `openStorage` 都是新句柄，无缓存无引用计数。

### PersistenceNamespaceDefinition（注册时提交的声明）

- `namespace`：稳定且全局唯一，形如 `core:notes`，注册时按 `NAMESPACE_PATTERN` 校验。
- `version`：namespace 自己的数据格式版本，写入对象日志 header。
- `owner?`：有权使用该目录的身份（如 extension id），写入 header 并在打开时校验；必须稳定、不含版本号。
- `forkPolicy`：`"copy"`（纯数据状态，原样复制）、`"omit"`（状态是外部句柄——pid、socket、凭据——复制会造成假象，不带入 fork）、`"degrade"`（两者皆是：历史值得带走，活进程不值得）。
- `locate?(request)`：自定义目录位置，默认 `<session>/persistence/<namespace>`。必须是跨构建稳定的纯函数；走出会话子树后，磁盘回收、并发隔离、fork 自包含都归 definition 自己负责。
- `openStorage(context)`：打开句柄。
- `fork?(request)`：自定义 fork 行为，返回 `{ stateRoot: string | null, origin? }`（`null` 表示新分支不带此 namespace 的 ref）。省略时默认复制闭包并保留根。fork 永不写源。
- `migrate?({ fromVersion, stateRoot, storage })`：读旧版本对象并返回当前版本的等价根；新对象进同一日志，分支永不改写。缺失时旧版本不可读，报告并降级。

### 注册与激活边界

`PersistenceRegistry`：`register(definition)`（重名或非法名抛错）、`get(namespace)`。空注册表下会话仍可打开、列举、读取，仅状态不解析——旧 build 必须能读新 build 写的会话。

恢复一个会话有三件事，这一层只做前两件，刻意不做第三件：

- **投影**——分支点上哪个状态根生效——归框架统一计算，不允许 per-namespace 覆写，否则"回退"的含义随会话持久化了什么而变。
- **解析**——状态根的字节是什么——归 namespace。
- **激活**——拿到结果之后做什么：重启 agent、重连进程、还是警告——归调用方，没有钩子。激活取决于这一层看不见的事实：进程是否还活着、配置是否还允许这个扩展、用户是在恢复还是在开新分叉。这一层欠调用方的是它独有的 facts，即解析结果携带的 `StateProvenance`。

core 模块在信任边界内直接注册；extension 的写入能力是注册 namespace 的后果（经 orchestrator 的通道，见 `orchestrator.md` §4），namespace 不出现在它的调用签名里。这个不对称是有意的。

## 6. Ref 与分支投影

`utils/persistence-ref.ts`：ref 是分指会支上一条 customType 为 `widi:persistence-ref` 的普通 custom entry，载荷 `PersistenceRefData = { version, namespace, stateRoot: string | null, anchorEntryId?, origin? }`，上限 2048 字节——ref 是指针而不是存储，这个上限是为了抓住把 ref 当存储用的调用方。依赖关系记录在被命名的对象里，不在 ref 里：两处都记就注定漂移，而 fork 遍历反正要打开存储。

ref 是普通 entry 这一点就是全部机制：它有 id、parentId、timestamp，可见性跟着会话树走——回退经过一条 ref，它命名的状态停止生效；分叉一条分支，带走分支看得见的全部 ref。`stateRoot: null` 是清除语义。`origin` 记录这条 ref 的来历（`"fork"` / `"fork_degraded"`），写方封闭读方开放，未知取值可以无损往返。

`utils/state-projection.ts` 的投影规则刻意小：沿完整分支走，**每个 namespace 最后一条 ref 胜出**，就是该 namespace 在这个分支点上的状态。投影为每个 namespace 产出 `NamespaceProjection = { namespace, stateRoot, refs, provenance }`，其中 `StateProvenance` 取 `"current"`（分支自己写的）、`"forked"`、`"degraded"` 之一（`"migrated"` 仅在 resolve 时计算，从不出现在分支上）。框架产出 provenance 即止：一份 `forked` 状态该被重放、丢弃还是灰显，取决于这一层看不见的东西。

## 7. 默认实现：JsonlObjectStore

`object-store.ts` 是默认 custom storage：追加式、内容寻址、不可变对象日志，路径 `<session>/persistence/<namespace>/objects.jsonl`，懒创建。大多数 namespace 要的都是同一件事——"记住这个值，让分支以后能命名它，fork 时带走它"——所以 namespace 只在确实需要别的形状时才自己写存储。

- header 行：`{ type: "persistence-objects", version, namespace, formatVersion, owner? }`；对象行：`{ id, deps, data }`，`id = contentHash({ deps, data })`，内容相同写两次只产生一行。
- 内容寻址（`utils/content-hash.ts`，sha256 + canonical JSON）使同一状态被多个 ref 命名时共享一个对象、fork 每个对象至多复制一次、重复写是 no-op。哈希必须跨进程、跨键序稳定，所以 canonical JSON 对不可表示的值抛错而不是静默丢弃。
- **owner 封印**：namespace 名唯一但不保留——扩展卸载后同名可能被别的代码认领。header 里的 owner 使这变成拒绝读取而不是静默误读。封印后读降级为空，写必须大声失败，因为被告知"已存"的调用方会接着把 ref 写上分支。
- **损坏容忍**：只容忍最后一行撕裂（进程被 kill 的预期形态），中间行损坏报 `persistence.corrupt_log`；header 版本更高或 owner 不匹配即封印。

## 8. Fork 闭包

`utils/fork-closure.ts` 的 `planForkClosure` 在复制任何东西之前先算出完整计划：逐 namespace 做 DFS，依赖闭包去重（多条 ref 命名同一根只复制一次），区分环与菱形（环报 `dependency_cycle`），对象缺失报 `dangling_ref` 但继续。**不因缺失、未知、成环而抛错**——带走大部分状态的 fork 优于拒绝 fork。

遍历只在这里实现：namespace 声明依赖但自己不递归，所以去重和成环检测只有一个实现，而不是每种状态各一份。

## 9. 诊断模型

`utils/diagnostics.ts`：非编程错误一律降级不抛，以 `PersistenceDiagnostic = { severity, code, message, sessionKey?, namespace?, stateRoot?, entryId? }` 报告。诊断码全表：`dangling_ref`、`invalid_ref`、`unknown_namespace`、`unsupported_version`、`owner_mismatch`、`corrupt_log`、`dependency_cycle`、`fork_degraded`、`fork_omitted`、`child_not_copied`、`nesting_limit`、`object_write_failed`。恢复必须永远产出一个可读的会话，代价是调用方必须被精确告知它没拿到什么。

## 10. 模块地图

- `jsonl-session.ts` — `session.jsonl` 读写，pi v3 逐字节兼容的移植，外加完整分支遍历与 fork 条目集。
- `jsonl-persistence.ts` — 仓储入口：会话 CRUD、fork、恢复、状态写入、namespace 存储打开。
- `custom-storage.ts` — namespace 契约与 `PersistenceRegistry`。
- `object-store.ts` — 默认 custom storage：追加式内容寻址对象日志。
- `utils/` — 纯函数部分：`layout`（布局算术与 `SessionKey`）、`content-hash`（哈希与 canonical JSON）、`persistence-ref`（ref 模式与解析）、`state-projection`（分支投影）、`fork-closure`（fork 计划）、`session-origin`（`spawnedBy`/`forkedFrom` 谱系记录）、`diagnostics`（诊断词汇）。都不碰文件系统，每条回退、覆写、成环、拒绝路径都可以无 IO 测试。

## 延伸阅读

实现期设计与排期文档在 `notes/develop/`（scratch，未入 git 追踪）：`ZH/persistence.md`（使用指南）、`ZH/persistence-ref-writer.md`、`ZH/agent-tree-persistence.md`、`session-tree-persistence-plan.md`。
