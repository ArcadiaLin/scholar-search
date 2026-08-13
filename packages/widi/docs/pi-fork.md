# Forking Pi's agent package

## Why the fork exists

WIDI's runtime is built on `AgentHarness`. Upstream plans to replace it: `packages/agent/docs/harness-v2.md` specifies a full rewrite of `packages/agent/src/harness` and a greenfield SQLite schema, under a compatibility policy that keeps exactly one guarantee - old coding-agent v3 JSONL sessions must open and restore idle. Everything else in the harness and storage surface may break.

WIDI cannot ride that rewrite while it lands. The orchestrator consumes the harness deeply: eighteen harness methods, five hooks, and the whole event vocabulary. So the harness is frozen at a known-good upstream release and owned locally, while the two packages that keep improving without breaking us stay on the registry.

This is a freeze, not a divorce. Re-sync is expected; the conditions are at the end of this document.

## The split, and why it falls here

| Package | How we consume it | Why |
| --- | --- | --- |
| `packages/agent` (`@arcadialin/agent-core`) | vendored into this repo | The only package harness-v2 rewrites, and the one we extend. |
| `@earendil-works/pi-ai` | published tarball, exact version | Fast-moving, additive for us. harness-v2 only adds `fetchDeferred`/`cancelDeferred`. |
| `@earendil-works/pi-tui` | published tarball, exact version | Independent: its only dependencies are `get-east-asian-width` and `marked`. Untouched by harness-v2. |
| `reference/pi` | untracked local clone, read only | Source of upstream history for cherry-picks, and the reference implementation we calibrate behavior against. |

The dependency graph makes this clean: `pi-tui` depends on neither of the others, and `pi-agent-core` depends only on `pi-ai` (sixteen import sites, all through the package root, no deep paths). There is no diamond - `pi-ai` does not depend on the agent package.

Upstream `packages/storage/sqlite-node` is deliberately not vendored: WIDI persists sessions as JSONL through `SessionDirectoryRepo`, and harness-v2 replaces that schema wholesale anyway.

## Baseline and complete divergence

Vendored from upstream commit `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`v0.83.0`). The `version` field in `packages/agent/package.json` tracks that release and is bumped only on re-sync.

The rest of `packages/agent/package.json` carries publish metadata upstream does not have: the `@arcadialin/agent-core` name, `files`, `publishConfig`, `repository`, and `prepublishOnly`. These exist so the fork can be published to npm as `apps/widi`'s registry dependency; on a re-sync, keep all of them and take only upstream's dependency and script changes.

Two sets of post-release commits are cherry-picked on top of that baseline, both landed on upstream `main` after v0.83.0 and not yet published.

The second set is the session store split, `9b50b046d` (PR #7163). Its subject is a SQLite search index we do not vendor; what we took is the storage restructuring underneath it. `packages/agent/src/harness/session/*` and `src/index.ts` are byte-identical to that commit, so the whole of it is carried except the sqlite backend and its two tests. See "The session store split" below.

The first set is the harness shutdown lifecycle, `82c485983`, `bc031ae45`, `871a99047` and `9cde1725d`. They are taken early because the orchestrator refactor removes the maintenance registry that today is the only orchestrator-side handle on a running compaction, leaving `AgentHarness` as the only place that can abort and await one. See "The shutdown lifecycle" below. The four commits also touch `skill()`, `promptFromTemplate()` and the resource generics, none of which exist here; only the task-tracking half was applied.

`packages/agent/src` diverges from upstream in six places, four additions, one widening and one removal:

- **Added** to `src/harness/agent-harness.ts`: `AgentHarness.promoteFollowUpsToSteer()`. A follow-up is only read where the agent would otherwise stop, so a user who queued one and then cannot wait has no way to promote it; re-sending the text as a steer would deliver it twice, and only the harness can take the message back out. Used by `agent-orchestrator.ts` via `steerQueuedFollowUps`.
- **Added** to `src/harness/agent-harness.ts` and `src/harness/types.ts`: `AgentHarness.getPhase()`, `AgentHarness.getQueuedMessageCounts()`, and the `AgentHarnessQueuedMessageCounts` type. Two facts the harness already owns but exposed only as events, forcing every consumer to mirror them. See "The observation getters" below.
- **Added** to `src/harness/agent-harness.ts` and `src/harness/types.ts`: the `phase_change` event, its `PhaseChangeEvent` type, and the private `setPhase()` every transition now goes through. See "The observation getters" below.
- **Added** to `src/harness/agent-harness.ts` and `src/harness/types.ts`: the session write surface. `appendCustomEntry()`, `appendCustomMessageEntry()`, `appendLabel()`, `setSessionName()`, entry ids returned from `appendMessage()` and the four new methods, and the `session_write` event with its `SessionWriteEvent` type. See "The session write surface" below.
- **Added** to `src/harness/types.ts`: the `"shutdown"` member of `AgentHarnessErrorCode`. Upstream rejects a shut-down harness with `invalid_state`, the same code as "cannot steer while idle", so a caller cannot tell a phase it can wait out from a state that will never change. `isRetryableDeliveryError` in `core/message.ts` retries on `busy` and `invalid_state`; without a distinct code its only termination condition is that the orchestrator re-resolves the target on every attempt and eventually finds it gone. See "The shutdown lifecycle" below.
- **Changed** in `src/harness/agent-harness.ts`: `abort()` on a shut-down harness awaits the shutdown and returns an empty `AbortResult` instead of throwing, `shutdown()` publishes its promise before aborting the active operation so that a listener reentering through `abort()` has something to await, and it releases the subscriber table once everything has settled. Teardown calls `abort()` then `shutdown()`, and duplicate teardown is normal; upstream's asymmetry - `shutdown()` idempotent, `abort()` fatal afterwards - would push that guard into every caller. See "The shutdown lifecycle" below.
- **Widened** in `src/harness/agent-harness.ts`: `prompt()`, `steer()`, `followUp()` and `nextTurn()` take `string | AgentMessage`, the `steerQueue` and `followUpQueue` fields are `AgentMessage[]`, and `promoteFollowUpsToSteer()` returns `AgentMessage[]`. See "The typed input widening" below.
- **Removed** from `src/harness/agent-harness.ts` and `src/harness/types.ts`: the harness's entire resource surface. `skill()`, `promptFromTemplate()`, `getResources()`, `setResources()`, the `resources` option, the `resources_update` event, `BeforeAgentStartEvent.resources`, the `resources` field of the system-prompt callback context, the `AgentHarnessResources` type, and the `TSkill`/`TPromptTemplate` type parameters. `AgentHarness` is now `AgentHarness<TContext, TTool>`. See "The resource removal" below.

`packages/agent/test` diverges in six places:

- `test/harness/agent-harness.test.ts`: two tests for the promotion path, two for the observation getters, one for the `phase_change` edges, five for the session write surface, one for the subscriber tail delivered during shutdown, plus `textFromUserMessages` widened to `content?: unknown` so an `AgentMessage[]` - a union whose bash-execution member carries no `content` - can be passed directly. Without the widening the promotion test does not type-check against v0.83.0. The resource-getter test is deleted and the save-point refresh test drives its system-prompt change through a closure instead of `setResources()`.
- `test/harness/agent-harness.test.ts`, upstream's own "awaits concurrent idle session mutations before shutdown resolves": its `BlockingSessionStorage(3)` waits for three writes to reach storage at once, which serialization makes impossible. It expects one now. The guarantee under test - shutdown does not resolve until every idle mutation has landed - is unchanged.
- `test/harness/agent-harness.test.ts`, the three upstream shutdown tests that assert a rejection code: `invalid_state` becomes `shutdown`. Same rejections, renamed.
- `test/scratch/simple.ts`: composes the skills listing and expands the prompt template itself, then passes the harness a plain string.
- `test/harness/session-test-utils.ts`: the package self-reference now names `@arcadialin/agent-core`.
- `test/harness/sqlite-migrations.test.ts` and `test/harness/sqlite-node.test.ts`: removed. They import `packages/storage/sqlite-node`, which is not vendored.

Nothing in `packages/agent/src` references SQLite, so removing those tests costs no source coverage.

Upstream's own `docs/` is kept inside the package because it documents the code the package now owns, and is left at upstream's version even where the removal made it wrong: `docs/agent-harness.md` still describes `skill()`, `getResources()`, and `AgentHarness<TContext, TSkill, TPromptTemplate, TTool>`. That file carries upstream's roadmap and changelog and changes on every release, so editing it would trade a real conflict for a self-consistent vendored document. `LICENSE` is upstream's MIT notice and stays with the code.

### The resource removal

The harness held skills and prompt templates only to hand them back to the application that loaded them: `skill()` formatted a resource the app had already resolved, and the system-prompt callback returned the same set the app passed in. WIDI had stopped calling all of it - `/skill` and `/prompt` expand through `built-ins.ts` before the text ever reaches the harness - so the surface was dead weight carrying two type parameters.

The skills now live on `AgentRecord.systemPrompt.skills`, read per turn by the system-prompt callback in `agent-orchestrator.ts`. The harness holds a system prompt source and nothing else.

**What did not move.** `src/harness/skills.ts`, `src/harness/prompt-templates.ts`, and `src/harness/system-prompt.ts` are untouched and still exported: the loaders are filesystem mechanism upstream keeps improving, and `formatSkillInvocation`, `formatPromptTemplateInvocation`, and `formatSkillsForSystemPrompt` are pure functions whose output WIDI matches byte for byte. WIDI's divergence is where they are called, not what they emit. The invariant that replaces the deleted code: **`AgentHarness` imports none of those three modules; only the application calls them.**

On re-sync, harness-v2 rewrites `src/harness` wholesale. Those three files should be **moved out of `harness/`, not deleted with it**, and none of the removed API should come back.

### The observation getters

Both facts already exist inside the harness; upstream only publishes them as events. `phase` is private, and the three message queues are reported solely by `queue_update`. A consumer that needs either answer at an arbitrary moment - not at the moment an event happened to fire - has no choice but to keep a mirror and hope every event was observed in order.

WIDI's orchestrator kept both mirrors, and they were the two least defensible pieces of state in it. `_maintenanceOperations` re-implemented `phase` in a parallel map, down to reserving synchronously before the first await because the harness does the same at `compact()`'s second line, and it needed an object-identity check on release so a resumed agent reusing an id could not have its reservation cleared by its predecessor. `AgentRecord.harnessQueuedMessageCount` cached the queue lengths so that `agentHasPendingMessages` and the idle judgement could answer without an event.

The getters are pure reads. They add no state, emit nothing, and cannot fail:

- `getPhase(): AgentHarnessPhase`. Every phase transition in the harness is synchronous, ahead of the operation's first await (`prompt` sets `turn` on its second line, `compact` sets `compaction`, `navigateTree` sets `branch_summary`, each clearing back to `idle` in a `finally`). So a caller that reads the phase and then calls a method races only against other callers, never against the operation it just observed. It is still not a total guard - `AgentHarnessError` with code `busy` remains the authority - but it makes the common path honest and the errors rare.
- `getQueuedMessageCounts(): AgentHarnessQueuedMessageCounts`. Per-lane lengths of `steerQueue`, `followUpQueue`, and `nextTurnQueue`.

`phase_change` closes the other half of the same gap. `getPhase()` answers "what now"; nothing answered "it changed". Upstream emits no event at any of the seven phase assignments, so entering and leaving `compaction` or `branch_summary` was observable only to whoever called `compact()` or `navigateTree()` - and WIDI's orchestrator paid for that with `_runMaintenanceOperation`, a wrapper that bracketed both calls with manual activity-edge publication, ordered its own publication after the operation start to avoid a window where the event said maintenance and the phase still said idle, and kept a `started` flag to tell an operation it began from one the harness refused. All of it is gone: `compactAgent` and `navigateAgentTree` call the harness directly, and `_observeHarnessActivity` publishes the edge the same way it publishes every other one.

The event carries `phase` and `previousPhase` and nothing else. Every transition goes through `setPhase()`, which assigns synchronously and then emits, so `getPhase()` already reports the new phase when an observer runs; a no-op transition emits nothing, because a failure path back to `idle` can run after the operation's tail already cleared it. There is no `cause` field: `previousPhase` names the operation that released the harness, and how a turn ended - settled or aborted - is carried by `turn_end` and `abort`, which know things the phase does not. The one behavioral consequence is ordering: `prompt()`, `compact()` and `navigateTree()` now call `startOperation()` before announcing the phase, so an observer that reacts by aborting finds a controller to abort. The guard-to-assignment window stays await-free.

One upstream wart survives: `AgentHarnessPhase` includes `"retry"`, which nothing in v0.83.0 ever assigns. Consumers must still handle it, because the type says it can happen, and `phase_change` will never report it.

On re-sync, check first whether harness-v2 already exposes the equivalent of both. Its step model makes the current operation explicit and its lane queues are durable records, so the natural expectation is that the mirrors are unnecessary there for structural reasons rather than because this patch ported.

### The session write surface

The harness is the session's writer while an operation runs: it buffers its own writes in `pendingSessionWrites` so a turn's messages stay contiguous, and flushes them at the next save point. But upstream exposes only `appendMessage()`, so an application that needs its own entries has no way in - even though `PendingSessionWrite` is derived from the entry union and `flushPendingSessionWrites` already implements all nine variants. Five of them, `custom`, `custom_message`, `label`, `session_info` and `leaf`, were unreachable: nothing could push them.

WIDI needs four of those five. Command expansions, input transforms and extension messages are session entries, and today `SessionManager` writes them straight to the session behind the harness's back. That makes two writers on one branch: the entry lands wherever the leaf happens to be, mid-turn if the target is running, and undoing it on a failed delivery means rewinding the leaf with `moveTo` while the harness may be moving it too.

- `appendCustomEntry()`, `appendCustomMessageEntry()`, `appendLabel()`, `setSessionName()`. Each mirrors `appendMessage()` exactly: shutdown guard, tracked as a `mutation`, written immediately when idle and buffered otherwise.
- `appendMessage()` and the four new methods resolve to the entry id, or to `undefined` when the write was buffered - the id does not exist until the flush.
- `session_write` reports every entry the harness persists that an embedder addresses by id: the loop's messages and everything written through this API, whether written immediately or flushed later. It is what makes a buffered write's id knowable, and it removes the reverse scan WIDI used to recover a message's entry id by object identity. Model, thinking level and active tool changes are excluded because each already has a dedicated update event, and compaction and branch summaries because `session_compact` and `session_tree` carry the entry itself.

Four rules hold the surface together, three of them fixing races the upstream code has too:

- **Writes are serialized.** Appending reads the leaf and then writes a child of it, so two writes that interleave across that await both parent themselves to the same entry and one falls off the branch. Every write - the four new methods, `appendMessage`, and the model, thinking level and active tool changes - goes through one promise tail. A failed write does not poison it.
- **Operations take the session from concurrent writers.** `prompt()`, `compact()` and `navigateTree()` set the phase synchronously, which makes later writes buffer, and then wait for the writes already in flight before reading the session. This is the consumer of `waitForTasks("mutation")`, which upstream added without one.
- **Reported ids survive failure.** An entry id exists only inside the harness until it is emitted, so an entry that lands and then fails to be announced - because a later write in the same flush threw, or because an observer did - would take its id with it. Notifications go to a queue that outlives the call, drained oldest first and retried by the next write or flush. Announcement still happens only after the whole buffer is durable, so a failing observer cannot leave the rest unflushed.
- **`session_write` precedes `message_end`** for a message the loop produced, so a subscriber can correlate the entry before the message itself is announced. A write that fails stays at the head of the buffer, unchanged from upstream.

`compact()` and `navigateTree()` flush what was buffered during them, before reopening the phase. Upstream only resets the phase, so an entry written inside a compaction hook stayed buffered until some later turn, was overtaken by any idle write in between, and was discarded outright by `shutdown()`.

On re-sync, harness-v2's record model has to answer the same requirement - an application writing its own records into the branch the harness owns, and getting their identity back - so this is a case of adopting its equivalent rather than porting these methods.

**Downstream rule.** These five methods are the only supported way into a live session, and using one is a design decision, not a convenience. Reach for them only when the entry genuinely belongs on the branch the harness owns; anything the runtime can keep beside the session should live beside it. Any new call site is reported to the developer when it is added, with what it writes and why the branch is the right place for it. The cost of an unnecessary entry is permanent: it is replayed into context on every resume and forked into every child session.

### The typed input widening

Every message WIDI puts into an agent's context goes through one path, and each one records who wrote it - a peer agent, an extension, the runtime itself. That record has to reach the branch, because a session read back later has to render the same way the live client did, and a bare `role:"user"` entry carries nothing to render from.

`CustomMessage` is already the answer. It is an `AgentMessage` union member, it carries `customType`, `display` and `details`, and `convertToLlm` maps it to `role:"user"` with the content verbatim - so the model reads exactly what it read before. The agent loop already persists whatever messages it is handed, and `nextTurnQueue` was already `AgentMessage[]`.

What blocked it was two narrowed fields and four `string` parameters. `steerQueue` and `followUpQueue` were `UserMessage[]`, and the four input entry points built the message themselves from text. The change is a pure widening:

- `toInputMessage(input, images)` returns `createUserMessage(input, images)` for a string and the message itself otherwise. A caller passing text gets the message it always got.
- `toInputText(input)` extracts the text for `before_agent_start`, whose `prompt` field is a string. For a string input it is the identity.

No existing call site changes behavior, and nothing new is stored: `AgentMessage[]` is what the loop consumed all along (`src/types.ts:239/252`), and `AbortResult` and the `queue_update` payload were already declared with it.

**Downstream rule.** A typed input is not a way to smuggle structure past the model. `content` is the whole of what the model reads; `customType` and `details` reach storage and the UI only. In WIDI exactly one producer builds these - `toHarnessInput` in `agent-orchestrator.ts`, from a `MessageEntryPayload` the message pipeline assembled - and shell input deliberately stays a bare user message so existing sessions read back unchanged. See `notes/develop/ZH/orchestrator-message.md` §6.

On re-sync, check whether harness-v2's lane records already carry an application-defined type. Its queues are durable records rather than in-memory arrays, so the natural expectation is that they do, and this widening disappears rather than porting.

### The session store split

Cherry-picked from `9b50b046d`, so all of it is upstream's. Five changes matter here:

- `SessionRepo` stopped being an interface that hands back `Session` objects. `SessionStore` replaces it: metadata-addressed, returning `TMetadata` and `SessionSnapshot`, with `getEntries`/`createEntryId`/`appendEntry`/`setLeafId` as primitives. `SessionRepo` is now a concrete class in `repo-utils.ts` composed of a store plus an optional search backend.
- **`Session.getStorage()` is gone.** `Session` holds a five-method `SessionDependencies` port instead of a `SessionStorage`.
- Every derived read - `getPathToRootOrCompaction`, `getLabel`, `getSessionName`, `getSessionStats` - moved out of the storage implementations into pure functions over a loaded snapshot. A storage implementation now only has to store and return entries.
- `setLeafId` returns the `LeafEntry` it wrote instead of `void`, making a leaf move addressable.
- Search split into `SessionSearchIndex` (write-side maintenance) and `SessionSearch` (query only), composed at the store boundary, with `ScanningSessionSearch` as the index-free fallback.

The reason to take it early is the second point. The session write surface above rests on a claim - nothing writes to a live branch except the harness - that until now was a convention, because any holder of a `Session` could call `getStorage().appendEntry()` and land outside `pendingSessionWrites`. Removing the accessor makes the claim checkable. The rest is cheap to carry now and expensive later: these files are byte-identical to upstream, so the next cherry-pick still diffs against a known point.

`agent-harness.ts` changed by one line as a consequence: `session.getStorage().setLeafId(...)` became `session.moveTo(...)`.

**What WIDI does not use.** `SessionRepo`, `createJsonlSessionRepo`, `createInMemorySessionRepo`, and `toStoreSession` are all present and all unused. The store contract is metadata-addressed, so each operation reopens the session - for JSONL, a full reparse - and the `Session` that `toStoreSession` builds reloads the whole session on every read, including the `getLeafId` that every append performs. WIDI holds one long-lived handle per open session and appends through it continuously, so `SessionDirectoryRepo` and `SessionManager`'s in-memory sessions keep binding `Session` to a stateful storage through `toSession()`. Upstream's own coding-agent does not exercise the store path either - it still runs the pre-harness `SessionManager` - so this is not a path to converge onto until it has a consumer that proves the cost.

`SessionSearch` has no consumer here at all. `ScanningSessionSearch` reads every session in the root per query.

### The shutdown lifecycle

Cherry-picked, so the three guarantees below are upstream's - but two of the seams around them are ours, and they are listed in the divergence table above. It arrived after the release we vendored:

- **`shutdown()` is a terminal state.** Every mutating entry point, plus `subscribe()`/`on()`, throws `shutdown` afterwards. Disposal keeps its own ordering: `abort()` first, so the interrupted turn flushes its pending session writes through `executeTurn`'s `finally`, then `shutdown()` to seal. `shutdown()` **discards** `pendingSessionWrites`, so it can never replace `abort()`.
- **Operations own an abort signal.** `compact()` and `navigateTree()` previously passed a controller that nothing ever aborted, so `abort()` could not cancel them and `waitForIdle()` returned immediately while they ran. Both are now tracked operations wired to the same signal, which is what makes "dispose an agent that is compacting" expressible at all.
- **Idle session mutations are tracked.** `appendMessage`, `setModel`, `setThinkingLevel`, `setTools` and `setActiveTools` write to the session when the harness is idle; they are tracked as `mutation` tasks so `shutdown()` awaits them. `waitForIdle()` deliberately waits only on `operation` tasks - a concurrent `appendMessage` must not make an idle harness look busy.

Two seams are ours. The `shutdown` error code exists so a delivery arbiter can tell terminal from transient without matching on a message string, and `abort()` after shutdown is a no-op that awaits the shutdown rather than a failure, so a teardown path may call both and may run twice. Releasing the subscriber table is deferred until `waitForTasks()` returns, never done at the first line of `shutdown()`: the aborted operation keeps emitting its tail - the failure message, `agent_end`, the final `queue_update` - and an observer cut off before it would be left believing the agent is still running.

`isShutdown` itself stays private on purpose. In WIDI the question "can this agent still be addressed" is answered by the orchestrator's live registry, which answers it *earlier*: the registry cutover is synchronous while `shutdown()` completes several steps later, so a public getter would disagree with the registry for the whole teardown window. The error code is the supported way to observe the terminal state, and only at the moment you try to use the harness.

On re-sync, the code is a one-line addition to whatever error taxonomy harness-v2 ships and the two behaviors are small; what matters is that the requirement behind them - an embedder must be able to distinguish a retryable phase from a dead harness, and tear down idempotently - is worth an issue against harness-v2's design rather than a pull request against code it deletes.

## Carrying upstream work across

`reference/pi` is the upstream mirror: an ordinary clone, untracked and gitignored, that nothing builds from. Clone it when it is missing:

```bash
git clone https://github.com/earendil-works/pi.git reference/pi
```

Cherry-picks are file-level, not git-level, because the paths differ (`packages/agent/...` in a different repository):

```bash
git -C reference/pi fetch origin
git -C reference/pi log --oneline 845d6ff1..origin/main -- packages/agent/src packages/agent/test
git -C reference/pi diff 845d6ff1..<commit> -- packages/agent/src/harness/foo.ts
```

Apply the hunks by hand into `packages/agent`, keep upstream's formatting (see invariants), then run `npm run check` and `npm run test`. Record anything that changes the divergence list above.

To audit the divergence list at any time, diff the two trees directly:

```bash
diff -r reference/pi/packages/agent/src packages/agent/src
diff -rq reference/pi/packages/agent/test packages/agent/test
```

That only reads as our divergence while `reference/pi` sits at the baseline commit. After pulling it forward, compare against `845d6ff1` instead: `git -C reference/pi worktree add ../pi-baseline 845d6ff1`.

Keeping the vendored files byte-identical to upstream is what makes this cheap. Every gratuitous reformat turns a clean hunk into a conflict.

### Upstreaming our own work

The rule that fell out of the fork: **a patch to code harness-v2 deletes is not worth a pull request; a requirement harness-v2 has not settled is worth an issue.**

`promoteFollowUpsToSteer` is the first case. It sits on the `promote-followups-to-steer` branch of `reference/pi` (based on `v0.83.0`, pushable to the `fork` remote `ArcadiaLin/pi`), and it is deliberately not filed upstream: it edits `agent-harness.ts`, which harness-v2 lists as "the harness being replaced". Upstream has no reason to review code it is deleting, and we would not consume the merge - the shipping copy is `packages/agent`. The branch is kept only as a historical marker.

What is worth sending upstream is the requirement behind it. harness-v2's lane queues are `steer`/`followUp`/`nextRun` with no promotion path, and its open questions are still collecting input, so the queue semantics are not frozen. An issue against the design costs nothing and targets live code.

The same test separates this from the JSONL header metadata work on the `jsonl-header-metadata` branch: harness-v2 defines a new v4 header and is actively designing it, so that conversation still has a live target.

The observation getters fail the test in both directions and are filed nowhere. They patch `agent-harness.ts`, so no pull request; and the requirement behind them - "an embedder must be able to read the harness's current operation and queue depths synchronously, without mirroring events" - is only interesting if harness-v2 fails to meet it, which its step model suggests it does not. Re-evaluate when harness-v2's observation surface is settled, not before.

## What we gave up

We can no longer patch `pi-ai` or `pi-tui` in place. This has come up before: `packages/ai/src/providers/opencode-go.ts` needed the `openai-responses` API registered because live models.dev data began serving `grok-4.5` through it. That patch is upstream as of v0.83.0.

If it recurs, in order of preference:

1. Do it in WIDI. Provider registration already lives in `model-registry.ts`, which is usually the better home anyway.
2. Send an upstream pull request. That is how the `opencode-go` case actually resolved.
3. Last resort: an npm `overrides` entry pointing at a fork tarball.

## Invariants

Breaking any of these is how this arrangement fails.

**Keep `typebox` at exactly the version published `pi-ai` pins (1.3.7 today).** `TSchema` crosses the package boundary - `ResolvedAgentHarnessTool extends AgentHarnessTool<ToolAdapterContext, TSchema, unknown>` in `tool-registry.ts`. Two copies of typebox are two structurally distinct `TSchema` types. Before the fork this was masked: every tsconfig mapped `typebox` to a single copy, so the mismatch between the app's 1.1.38 and pi's 1.3.7 never surfaced. Published `.d.ts` files resolve their own dependencies, so the mapping no longer hides it.

**Pin `pi-ai` and `pi-tui` to exact versions, never a caret range.** They iterate fast and have broken us: v0.83.0 added a five-minute proactive OAuth refresh window in `src/auth/resolve.ts`, which sent a WIDI test at the real GitHub API. Bump deliberately, with the test suite as the gate. A caret range on a fast-moving dependency is also what produced the shadowing bug below.

**A version range that the workspace cannot satisfy is silently fatal.** When `apps/widi` still asked for `^0.81.1` while the workspace held 0.83.0, npm installed published 0.81.1 into `apps/widi/node_modules/@earendil-works/` and shadowed the workspace packages. The root type check stayed green because it resolves through path mappings; only `tsconfig.build.json`, which resolves from `node_modules`, failed. Renaming the vendored package to `@arcadialin/agent-core` removes the collision for the agent package - do not rename it back.

**Do not reformat `packages/agent`.** Root `biome.json` applies upstream's formatter settings (tab, width 3, line width 120) and upstream's lint relaxations to `packages/agent/**`, while `apps/**` keeps WIDI's defaults (tab, width 2, line width 80). The partition exists so `npm run check --write` cannot rewrite ten thousand vendored lines.

**Type-check from the repository root.** `npm run check` uses the root `tsconfig.json`, which covers `packages/agent/{src,test}` and `apps/widi/{src,tests}`. The app's own `check` script only sees the app.

## What the fork bought us

Beyond the freeze itself, dropping `pi-ai` and `pi-tui` to published tarballs removed two long-standing chores:

- **No model-data generation.** `pi-ai` used to import generated, gitignored catalogs from `src/providers/data/*.json`, so every submodule update meant re-running a generator that fetches live models.dev data over the network. The published tarball ships `dist/providers/data/*.json`; `npm run build` no longer touches the network.
- **No pi dist rebuilds.** The app used to resolve three pi packages through dists we had to rebuild ourselves, and a stale dist silently omitted new modules - this once broke `kimi-coding` OAuth login because `dist/auth/oauth/kimi-coding.js` was never emitted. Only `packages/agent` is built locally now.

Source reading survives: both tarballs ship declaration maps with `sourcesContent` embedded, so editor navigation still lands in real TypeScript.

## Re-sync conditions

Revisit this arrangement when all of the following hold:

1. harness-v2 has landed upstream and its API has stopped moving across at least two releases.
2. The two gaps WIDI needs are answered, or we have accepted owning them:
   - **Follow-up promotion.** harness-v2's lane queues are `steer`/`followUp`/`nextRun` with no promotion. Our patch does not port as written: its rollback works by splicing in-memory arrays, and harness-v2's queues are append-only durable records, so promotion has to become a record-level operation.
   - **Human-in-the-loop suspension.** `SuspendedOperation.reason` is `crash | deferred`. WIDI's `ask_human` awaits a person inside a tool call, which harness-v2 recovery treats as an interrupted tool and closes with a synthetic result. A third reason is needed.
3. The migration is priced. The method surface maps almost one to one, including all five hooks (`before_agent_start` to `before_run`, `before_provider_request` to `before_request`/`before_payload`, `context` to `transform_context`, `tool_call` to `before_tool`, `tool_result` to `after_tool`). The real work is the storage adapter, the session snapshot and tree queries behind `SessionHydrator`, and the loss of the harness's type parameters - `WidiAgentHarness` instantiates two and harness-v2 keeps only the tool context, so `ResolvedAgentHarnessTool`'s extra fields need a new home. The resource removal above already paid the other half of that bill: the two resource parameters harness-v2 also drops are gone.

Until then, harness-v2 is a design to mine rather than a dependency to track. Part II of that document - the record model, provisioned ids, and recovery - is backend-neutral and does not require lanes, which is the part worth adopting into our own layer first. Lanes themselves model shared history across parallel positions; WIDI isolates agents by spawn tree and passes messages, so lanes are the one piece to leave alone.
