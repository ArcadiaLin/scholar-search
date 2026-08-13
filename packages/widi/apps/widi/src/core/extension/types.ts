import type {
	AgentHarnessEventResultMap,
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	CompactResult,
	ContextEvent,
	ExecutionError,
	NavigateTreeResult,
	Result,
	SessionTreeEntry,
	ShellExecOptions,
	ThinkingLevel,
	ToolCallEvent,
	ToolResultEvent,
} from "@arcadialin/agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { freezeJsonValue, type JsonValue, normalizeJsonValue } from "../../utils/json.ts";
import { utf8ByteLength } from "../../utils/text.ts";
import type { AgentProfile, AgentProfileOverride, AgentProfileReference } from "../agent-profile.js";
import type { ExtensionDiagnosticDraft } from "../diagnostics.ts";
import type {
	AgentBrief,
	AgentProfileBrief,
	AgentRequestedDisposeOptions,
	AgentRequestedDisposeOutcome,
	AgentTreeListing,
} from "../host.ts";
import type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
import type { MessageSink, MessageSource } from "../message.ts";
import type { ProviderConfigInput } from "../model-registry.ts";
import type { ToolDefinition, ToolDefinitionPatch } from "../tools/types.ts";
import type {
	AgentContextUsage,
	AgentId,
	AgentToolsSnapshot,
	CandidateItem,
	OrchestratorEvent,
	RuntimeModel,
} from "../types.ts";
import type { ExtensionEventEnvelope } from "./events.ts";

// The tool contract lives in the core tools layer (ME slice 0 dependency
// inversion); the extension layer consumes and re-exports it for its own
// consumers.
export type {
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecuteMiddleware,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "../tools/types.ts";

/**
 * A named, addressable partition inside one extension. An extension that
 * declares divisions is what the docs call an integration: one installable
 * unit whose parts can be switched on and off individually, instead of a
 * scattering of single-purpose extensions.
 *
 * Ids are dot-separated paths (`servers.github`); a division is only reachable
 * when every ancestor is enabled too.
 */
export interface ExtensionDivisionDeclaration {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Default: true. */
	readonly enabledByDefault?: boolean;
}

/**
 * User-side division rules for a single extension. Each id applies to that
 * division and its whole subtree; the most specific matching rule wins, and
 * `disable` wins over `enable`.
 */
export interface ExtensionDivisionSelection {
	readonly enable?: readonly string[];
	readonly disable?: readonly string[];
}

/**
 * Division rules keyed by extension id. Wrapped in a named layer rather than
 * passed bare so a resolved state can say where its rule came from.
 */
export interface ExtensionDivisionSelections {
	readonly settings?: Readonly<Record<string, ExtensionDivisionSelection>>;
}

export type ExtensionDivisionSource = "default" | "settings" | "ancestor";

/** Resolved per-agent division state, for inspect facts. */
export interface ExtensionDivisionSnapshot {
	readonly extensionId: string;
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled: boolean;
	/** False for a division id used at activation but never declared. */
	readonly declared: boolean;
	readonly source: ExtensionDivisionSource;
}

export type ExtensionObservedEventName = ExtensionObservedEvent["type"];

export type ExtensionObservedEvent = Extract<
	OrchestratorEvent,
	{
		type:
			| "agent_context_usage_changed"
			| "agent_disposed"
			| "agent_harness_event"
			| "agent_idle"
			| "agent_persistence_ref_changed"
			| "agent_resumed"
			| "agent_session_forked"
			| "agent_session_info_changed"
			| "agent_spawned"
			| "agent_status_changed"
			| "diagnostic"
			| "human_request_cancelled"
			| "human_request_pending"
			| "human_request_resolved"
			| "human_request_timeout"
			| "input_blocked"
			| "input_transformed"
			| "runtime_shutdown_requested";
	}
>;

export type ExtensionObservedEventFor<TName extends ExtensionObservedEventName> = Extract<
	ExtensionObservedEvent,
	{ type: TName }
>;

/**
 * Runtime membership test for the observed set, keyed so it cannot drift from
 * the type above: adding a name to `ExtensionObservedEvent` without adding it
 * here is a type error, and vice versa. A hand-written switch let an event be
 * declared observable while the dispatcher silently dropped it.
 */
export const EXTENSION_OBSERVED_EVENT_NAMES: Readonly<Record<ExtensionObservedEventName, true>> = {
	agent_context_usage_changed: true,
	agent_disposed: true,
	agent_harness_event: true,
	agent_idle: true,
	agent_persistence_ref_changed: true,
	agent_resumed: true,
	agent_session_forked: true,
	agent_session_info_changed: true,
	agent_spawned: true,
	agent_status_changed: true,
	diagnostic: true,
	human_request_cancelled: true,
	human_request_pending: true,
	human_request_resolved: true,
	human_request_timeout: true,
	input_blocked: true,
	input_transformed: true,
	runtime_shutdown_requested: true,
};

/**
 * Observed events every extension in the subject's agent tree receives, rather
 * than the subject's own extensions alone.
 *
 * These are the facts an extension holding another agent's id cannot do without
 * - that it exists, that it stopped, that it is gone - and they arrive at most
 * a few times per turn. Everything outside this set stays scoped to the agent
 * it is about, which matters most for `agent_harness_event`: it is the raw
 * per-turn stream, and its subscribers mean "my turn" by it.
 */
export const EXTENSION_TREE_BROADCAST_EVENT_NAMES: Readonly<Partial<Record<ExtensionObservedEventName, true>>> = {
	agent_disposed: true,
	agent_idle: true,
	agent_resumed: true,
	agent_spawned: true,
	agent_status_changed: true,
};

/**
 * WIDI intentionally exposes only interceptors with settled semantics.
 *
 * Full AgentHarness hook candidates include:
 * - before_agent_start, context, tool_call, tool_result,
 *   before_provider_request (all exposed below)
 * - before_provider_payload (mutates the raw wire payload; deferred to
 *   backlog until a consumer justifies its failure semantics)
 * - session_before_compact, session_before_tree
 * - observer-like own events with no return value: after_provider_response,
 *   session_compact, session_tree, model_update, thinking_level_update,
 *   tools_update, queue_update, save_point, abort, settled
 *   (all reachable through the raw `agent_harness_event` observer)
 *
 * Session hooks are deferred until permission, diagnostics, and
 * stale-context semantics are explicit.
 */
export type ExtensionInterceptorName =
	| "before_agent_start"
	| "before_provider_request"
	| "context"
	| "input"
	| "tool_call"
	| "tool_result";

/**
 * WIDI-native input interceptor event (ME slice 6). Fired by `sendMessage` for
 * every message ingress, not only human text: an agent-to-agent message and a
 * system notice run the same pipeline, so no input path bypasses an input
 * policy. Not a Pi harness hook.
 *
 * `source` tells the cases apart. A handler that only means to rewrite human
 * input must check it, or it will also rewrite what the runtime wrote. `targetAgentId` is the agent that will read the message, which
 * is not the handler's own agent for cross-agent delivery.
 */
export interface ExtensionInputEvent {
	readonly type: "input";
	readonly source: MessageSource;
	readonly targetAgentId: AgentId;
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

/**
 * `undefined` passes the input through unchanged. A transform result rewrites
 * the text (and optionally the images; omitted images keep the current ones)
 * and feeds the next handler. A block result rejects the whole input and
 * short-circuits the pipeline; there is no pi-style "handled" escape hatch.
 *
 * A block is only enforced for sources whose caller can be told: a runtime
 * notice is delivered anyway, because nobody is left to learn it was dropped.
 */
export type ExtensionInputResult =
	| { text: string; images?: readonly ImageContent[] }
	| { block: true; reason?: string }
	| undefined;

// Pi harness hooks share the Pi result contract; input is WIDI-owned.
export interface ExtensionInterceptorEventMap {
	before_agent_start: BeforeAgentStartEvent;
	before_provider_request: BeforeProviderRequestEvent;
	context: ContextEvent;
	input: ExtensionInputEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
}

export interface ExtensionInterceptorResultMap {
	before_agent_start: AgentHarnessEventResultMap["before_agent_start"];
	before_provider_request: AgentHarnessEventResultMap["before_provider_request"];
	context: AgentHarnessEventResultMap["context"];
	input: ExtensionInputResult;
	tool_call: AgentHarnessEventResultMap["tool_call"];
	tool_result: AgentHarnessEventResultMap["tool_result"];
}

export type ExtensionInterceptorEventFor<TName extends ExtensionInterceptorName> = ExtensionInterceptorEventMap[TName];

export type ExtensionInterceptorResultFor<TName extends ExtensionInterceptorName> =
	ExtensionInterceptorResultMap[TName];

export type ExtensionExecResult = Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>;

/**
 * Result of an extension-initiated compaction. The compaction entry is
 * already persisted when this value resolves - it is an observation, not a
 * mutation channel (mutation is the deferred `session_before_compact` hook).
 * The shape follows pi-agent-core so retained-tail checkpoints and summary
 * usage remain observable to extensions.
 */
export type ExtensionCompactionResult = CompactResult;

/**
 * Where a tree navigation lands and what it wrote getting there. `editorText`
 * is the target user message handed back for editing, which only a client that
 * owns an editor has any use for.
 */
export type ExtensionNavigateTreeResult = NavigateTreeResult;

export interface ExtensionNavigateTreeOptions {
	/** Summarize what the move leaves behind onto the branch it lands on. */
	readonly summarize?: boolean;
	readonly customInstructions?: string;
	/** Use `customInstructions` alone rather than appending them to the default. */
	readonly replaceInstructions?: boolean;
	/** Label for the branch summary entry. */
	readonly label?: string;
}

/**
 * Durable presentation content an extension publishes into an agent, as core
 * knows it: a `kind` naming the shape, and opaque JSON beside it.
 *
 * `kind` is required because it is what a renderer dispatches on and the only
 * field core stamps a meaning on. Everything else is the renderer's contract
 * with the extension; core neither reads nor bounds it field by field.
 *
 * Core carrying the shapes themselves cost a per-shape validator, a per-shape
 * byte cap, and an API export for every kind anyone wanted - while the client
 * re-validated on hydration anyway, because a branch outlives the build that
 * wrote it and no renderer can trust a write-time check it did not run.
 */
export interface ExtensionMessage {
	readonly kind: string;
	readonly [field: string]: JsonValue;
}

/** Current state an extension keyed into a client's status area. Opaque to core. */
export type ExtensionStatus = JsonValue;

export interface ExtensionStatusSnapshot {
	readonly agentId: string;
	readonly extensionId: string;
	readonly key: string;
	readonly status: ExtensionStatus;
	readonly updatedAt: string;
}

export const MAX_EXTENSION_OUTPUT_BYTES = 65_536;
export const MAX_EXTENSION_NOTIFICATION_BYTES = 4_096;
export const MAX_EXTENSION_STATUS_KEY_BYTES = 128;
export const MAX_EXTENSION_STATUS_BYTES = 8_192;
export const MAX_EXTENSION_MESSAGE_KIND_BYTES = 128;
export const MAX_EXTENSION_MESSAGE_BYTES = 65_536;

const EXTENSION_MESSAGE_KIND_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/**
 * Validate a published message and return a detached, frozen copy core owns
 * alone. The round trip is the same one persistence and transport use, so a
 * message that survives this is a message that survives being written.
 */
export function validateExtensionMessage(message: ExtensionMessage): ExtensionMessage {
	if (typeof message !== "object" || message === null || Array.isArray(message)) {
		throw new TypeError("Extension message must be an object.");
	}
	if (typeof message.kind !== "string" || !EXTENSION_MESSAGE_KIND_PATTERN.test(message.kind)) {
		throw new TypeError("Extension message kind must contain only letters, numbers, '.', '_', ':', and '-'.");
	}
	if (utf8ByteLength(message.kind) > MAX_EXTENSION_MESSAGE_KIND_BYTES) {
		throw new RangeError(`Extension message kind exceeds ${MAX_EXTENSION_MESSAGE_KIND_BYTES} UTF-8 bytes.`);
	}
	const normalized = normalizeJsonValue(message, "Extension message", MAX_EXTENSION_MESSAGE_BYTES);
	return freezeJsonValue(normalized) as ExtensionMessage;
}

export function validateExtensionStatus(status: ExtensionStatus): ExtensionStatus {
	return freezeJsonValue(normalizeJsonValue(status, "Extension status", MAX_EXTENSION_STATUS_BYTES));
}

export function assertExtensionOutputText(text: string): void {
	if (typeof text !== "string" || text.length === 0) {
		throw new TypeError("Extension output text must be a non-empty string.");
	}
	if (utf8ByteLength(text) > MAX_EXTENSION_OUTPUT_BYTES) {
		throw new RangeError(`Extension output text exceeds ${MAX_EXTENSION_OUTPUT_BYTES} UTF-8 bytes.`);
	}
}

export function assertExtensionNotificationText(text: string): void {
	assertBoundedNonBlankText(text, "Extension notification text", MAX_EXTENSION_NOTIFICATION_BYTES);
}

export function assertExtensionStatusKey(key: string): void {
	assertBoundedNonBlankText(key, "Extension status key", MAX_EXTENSION_STATUS_KEY_BYTES);
}

function assertBoundedNonBlankText(value: string, label: string, maxBytes: number): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-blank string.`);
	}
	if (utf8ByteLength(value) > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
}

export interface ExtensionSendOptions {
	images?: ImageContent[];
	/**
	 * Another agent to deliver to; defaults to the extension's own. An id, not a
	 * scope: unlike `listAgents` and `disposeAgent`, addressing is runtime-wide,
	 * the same soft bridge between trees the agent host's `sendMessage` is.
	 */
	target?: string;
	/**
	 * Overrides the message's source label (default `extension:<id>`). A label,
	 * not a capability: the delivery policy stays the binding's, so renaming the
	 * source cannot forge a human interrupt or dodge an input policy.
	 */
	source?: MessageSource;
	/**
	 * Produces the text the model reads, replacing the default
	 * `[Input from extension <id>]` prefix. Runs once, at enqueue.
	 */
	render?: (body: string) => string;
}

/**
 * Where an extension-spawned agent's context comes from.
 *
 * Wider than the agent host's own origin: `profileOverride` assembles a role
 * out of fields rather than choosing one from the profile directory. An agent
 * picks a profile; an extension is installed code and may build the role.
 */
export type ExtensionSpawnOrigin =
	/** Fresh context; the runtime default profile when none is named. */
	| { readonly kind: "new"; readonly profileId?: string; readonly profileOverride?: AgentProfileOverride }
	/** Reopen a session left behind by an agent that is no longer running. */
	| { readonly kind: "resume"; readonly reference: string }
	/** Copy a live agent's branch, optionally truncated at an entry. */
	| { readonly kind: "fork"; readonly sourceAgentId: string; readonly entryId?: string };

export interface ExtensionSpawnRequest {
	readonly origin: ExtensionSpawnOrigin;
	/** Model reference (`provider/id`); refused when the runtime does not have it. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Action surface handed to extension authors, bound to the extension's own
 * agent. That agent's id is injected by the runner and never appears in a
 * signature.
 *
 * The cross-agent actions are bound the same way, and their scope follows from
 * it with nothing left to choose: `listAgents` reports that agent's tree,
 * `spawnAgent` parents under it, `disposeAgent` refuses another tree. What does
 * not follow from the binding is attribution, and that stays the extension's:
 * a message says an extension sent it unless the caller overrides `source`, and
 * a dispose records the extension as the one that asked.
 *
 * Deliberately absent: `watch`. Over observing `agent_idle` it adds only
 * exclusivity and delivery into an agent's context, neither of which an
 * extension can use - and a watch held on an agent's behalf would silence that
 * agent's own idle notice, so its owner would never learn it stopped.
 */
export interface ExtensionActions {
	/** Profiles this runtime has enabled, the same listing agents choose from. */
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	/** The extension's own agent tree: who is running, and what sessions were left behind. */
	listAgents(): Promise<AgentTreeListing>;
	/** One live agent anywhere in the runtime, or undefined when there is no such agent. */
	describeAgent(agentId: string): AgentBrief | undefined;
	/** Create an agent parented under the extension's own, and get its id back. */
	spawnAgent(request: ExtensionSpawnRequest): Promise<string>;
	/**
	 * Destroy a same-tree agent. A selection containing the extension's own agent
	 * is refused: the runtime tearing it down is the one that would receive this
	 * call's result.
	 */
	disposeAgent(agentId: string, options: AgentRequestedDisposeOptions): Promise<AgentRequestedDisposeOutcome>;
	getTools(): AgentToolsSnapshot;
	setTools(toolNames: string[], activeToolNames?: string[]): Promise<void>;
	setActiveTools(toolNames: string[]): Promise<void>;
	// The request source is injected by the runner as
	// { kind: "extension", extensionId } and cannot be forged.
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
	// Push append-only plain text for direct client display. Unlike
	// prompt/steer, it does not reach the model or the session. Repeated calls
	// create separate output items; sequentially awaiting calls preserves order.
	emitOutput(text: string): Promise<void>;
	// Fire a transient info-only notice. The consumer owns display lifetime;
	// notices have no severity, code, dedupe, clear, or attention semantics.
	notify(text: string): Promise<void>;
	// Keyed runtime current state for client status areas. Reusing a key
	// replaces the previous value; clearing a missing key is a no-op. The value
	// is opaque to core, which bounds and detaches it and nothing more; what a
	// client draws from it is that client's contract with the extension.
	setStatus(key: string, status: ExtensionStatus): Promise<void>;
	clearStatus(key: string): Promise<void>;
	// Durable presentation content: persisted as a core:extension_message
	// session custom entry, never model context. `kind` names the shape a
	// renderer dispatches on; the rest is opaque JSON core detaches and bounds
	// without reading. Use `precede` instead when the model should see it.
	//
	// `entryId` is absent when the write was buffered behind a running turn: the
	// harness owns the branch for the duration of an operation, and an entry it
	// has not written yet has no id. The canonical event is published from the
	// write itself, so a consumer deduping hydration against live events always
	// sees the real id there; this return value is the fast path, not the
	// contract.
	publishMessage(message: ExtensionMessage): Promise<{ entryId?: string }>;
	// Reported facts join the core diagnostic pipeline: the draft is
	// { severity: "warning" | "error", code, message }; core injects agentId
	// and extensionId and namespaces the local code to
	// extension.<extensionId>.<code>. Reported diagnostics never feed back
	// into extension observers.
	reportDiagnostic(draft: ExtensionDiagnosticDraft): Promise<void>;
	// The four message-injection paths. All four go through the one core
	// message pipeline, so the text meets the same interception as any other
	// producer's and lands with the same record of who wrote it. `prompt`
	// refuses a busy agent instead of queueing; steer and followUp always queue.
	prompt(text: string, options?: ExtensionSendOptions): Promise<void>;
	steer(text: string, options?: ExtensionSendOptions): Promise<void>;
	followUp(text: string, options?: ExtensionSendOptions): Promise<void>;
	// Model-readable text that does not wake anything. Alone among the four it
	// passes no phase gate and can therefore never be refused or deferred: the
	// harness buffers the write behind whatever is running and lands it at that
	// operation's save point, where the next turn reads it along with the rest
	// of the branch. Use it to put context in front of work that has not
	// started yet; use followUp when the agent should act on the text.
	precede(text: string, options?: ExtensionSendOptions): Promise<void>;
	// Context occupancy of the agent's current branch, or undefined before the
	// branch carries an assistant usage to measure. Recomputed when the agent
	// settles and after compaction; observe `agent_context_usage_changed` to be
	// told rather than to poll.
	getContextUsage(): AgentContextUsage | undefined;
	// Whether project-local trust is active. Actions that need it - `exec`, and
	// the cross-session reads on `session` - fail with a structured diagnostic
	// when it is not, so check this to degrade deliberately instead.
	isProjectTrusted(): boolean;
	// The effective baseline system prompt, including every appended section.
	// A `before_agent_start` interceptor may still replace it for one turn.
	getSystemPrompt(): Promise<string>;
	// Whether any message is waiting in either the core delivery queue or the
	// harness's own steer/follow-up/next-turn queues.
	hasPendingMessages(): boolean;
	// Resolve once this agent is idle and both of those queues are empty - the
	// same judgement `hasPendingMessages` reports, so there is only one notion
	// of idle. Rejects when the agent is disposed or already gone while waiting.
	//
	// Awaiting this from a `tool_call` or `context` interceptor deadlocks by
	// construction: the agent is running at that moment precisely because the
	// handler has not returned.
	waitForIdle(options?: { signal?: AbortSignal }): Promise<void>;
	// Broadcast to every live extension runtime, this agent's included. Names
	// are free-form (`owner:event` by convention) and core never interprets the
	// payload; it only bounds it and hands each subscriber the same detached
	// copy. Subscribe with `onExtensionEvent` at activation time.
	emitExtensionEvent(name: string, payload?: JsonValue): Promise<void>;
	// Ask the host to shut the runtime down. Core publishes the request and
	// stops there - the process and the terminal belong to the host, which owns
	// the ordered teardown - so nothing happens when no host is listening.
	requestShutdown(reason?: string): Promise<void>;
	// Dispose every agent directly, without a host: the escape hatch for
	// embedders that have no shutdown path of their own. Prefer
	// `requestShutdown` whenever a client is attached, or the client is left
	// running with no agents behind it.
	//
	// This disposes the caller's own extension runtime too: the extension's
	// onDispose handlers run before the returned promise settles, and the
	// context is stale afterwards. Treat it as the last statement.
	disposeRuntime(reason?: string): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getSessionName(): Promise<string | undefined>;
	// Requires an idle harness; rejects with the harness busy error otherwise.
	compact(customInstructions?: string): Promise<ExtensionCompactionResult>;
	// Move the agent to another entry of its session tree, which becomes the leaf
	// every later turn extends. The counterpart to the `session` readers: those
	// show every branch, this is what picks one. Same idle requirement as
	// `compact`, and navigating to the current leaf is a no-op that reports
	// itself as one rather than failing.
	navigateTree(targetEntryId: string, options?: ExtensionNavigateTreeOptions): Promise<ExtensionNavigateTreeResult>;
	setModel(reference: string): Promise<RuntimeModel>;
	getModel(): RuntimeModel;
	// Candidate values are model references accepted by setModel.
	listModelCandidates(): Promise<readonly CandidateItem[]>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	// Aborts the agent's current run; queued steer/followUp input is cleared.
	abort(): Promise<void>;
	// Denied with a structured diagnostic when the project is not trusted.
	exec(command: string, options?: ShellExecOptions): Promise<ExtensionExecResult>;
}

/**
 * Binding contract between the orchestrator and the runner. Agent ids stay
 * explicit here; the runner narrows this surface into the scoped
 * ExtensionActions above. Not part of the extension-author API.
 */
export interface ExtensionCoreActions {
	listProfileBriefs(): Promise<readonly AgentProfileBrief[]>;
	listAgentTree(agentId: string): Promise<AgentTreeListing>;
	describeAgentFor(callerAgentId: string, targetAgentId: string): AgentBrief | undefined;
	spawnAgentFor(callerAgentId: string, request: ExtensionSpawnRequest): Promise<string>;
	disposeAgentFor(
		callerAgentId: string,
		targetAgentId: string,
		options: AgentRequestedDisposeOptions,
	): Promise<AgentRequestedDisposeOutcome>;
	getAgentTools(agentId: string): AgentToolsSnapshot;
	setAgentTools(agentId: string, toolNames: string[], activeToolNames?: string[]): Promise<void>;
	setAgentActiveTools(agentId: string, toolNames: string[]): Promise<void>;
	requestHuman(agentId: string, extensionId: string, request: HumanRequestDraft): Promise<HumanResponse>;
	emitOutput(agentId: string, extensionId: string, text: string): Promise<void>;
	notify(agentId: string, extensionId: string, text: string): Promise<void>;
	setStatus(agentId: string, extensionId: string, key: string, status: ExtensionStatus): Promise<void>;
	clearStatus(agentId: string, extensionId: string, key: string): Promise<void>;
	publishMessage(agentId: string, extensionId: string, message: ExtensionMessage): Promise<{ entryId?: string }>;
	reportDiagnostic(agentId: string, extensionId: string, draft: ExtensionDiagnosticDraft): Promise<void>;
	/**
	 * The message entry point, bound to one extension's identity and delivery
	 * policy. The same shape the background runtime holds: what differs between
	 * producers is the binding, not the path. The target agent rides on the
	 * request rather than on this call, so one sink serves every target.
	 */
	messageSinkFor(extensionId: string): MessageSink;
	getAgentContextUsage(agentId: string): AgentContextUsage | undefined;
	isProjectTrusted(): boolean;
	getAgentSystemPrompt(agentId: string): Promise<string>;
	agentHasPendingMessages(agentId: string): boolean;
	waitForAgentIdle(agentId: string, options?: { signal?: AbortSignal }): Promise<void>;
	emitExtensionEvent(agentId: string, extensionId: string, name: string, payload?: JsonValue): Promise<void>;
	requestRuntimeShutdown(agentId: string, extensionId: string, reason?: string): Promise<void>;
	disposeRuntime(agentId: string, extensionId: string, reason?: string): Promise<void>;
	setAgentSessionName(agentId: string, name: string): Promise<void>;
	getAgentSessionName(agentId: string): Promise<string | undefined>;
	compactAgent(agentId: string, customInstructions?: string): Promise<ExtensionCompactionResult>;
	navigateAgentTree(
		agentId: string,
		targetEntryId: string,
		options?: ExtensionNavigateTreeOptions,
	): Promise<ExtensionNavigateTreeResult>;
	setAgentModelByReference(agentId: string, reference: string): Promise<RuntimeModel>;
	getAgentModel(agentId: string): RuntimeModel;
	listModelCandidates(): Promise<readonly CandidateItem[]>;
	getAgentThinkingLevel(agentId: string): ThinkingLevel;
	setAgentThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void>;
	abortAgent(agentId: string): Promise<void>;
	exec(agentId: string, extensionId: string, command: string, options?: ShellExecOptions): Promise<ExtensionExecResult>;
}

export interface ExtensionContextActions {
	getSignal?(): AbortSignal | undefined;
	isIdle?(): boolean;
	session?: ExtensionSessionActions;
	reportActionFailure?(failure: ExtensionActionFailure): Promise<void>;
}

export interface ExtensionCustomEntry<T = unknown> {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	data?: T;
}

/**
 * A session as an extension sees it: addressed by an opaque `ref`, never by
 * path.
 *
 * Storage layout is core's business - sessions live behind a repo whose
 * backend can change - and a path would also invite an extension to parse the
 * JSONL itself, which is the habit this API exists to replace. Refs are minted
 * when sessions are listed and are only valid within the running process, so
 * one cannot be constructed to reach a session the extension was never shown.
 */
export interface ExtensionSessionCandidate {
	readonly ref: string;
	/** Not unique across runtimes; use `ref` to address a session. */
	readonly id: string;
	readonly createdAt: string;
	readonly profile?: AgentProfileReference;
	/** Latest session_info name, when the user named the session. */
	readonly name?: string;
	/** First non-empty line of the first user message. */
	readonly firstUserMessage?: string;
	/**
	 * Ref of the session this one's history was forked from, when it was.
	 *
	 * Only a fork has one. The session that *spawned* a session is a different
	 * relation and is not reported here: listed sessions are top-level ones, and
	 * a spawned session is reached through the session that owns it.
	 */
	readonly forkedFromRef?: string;
}

export interface ExtensionSessionSnapshot {
	/** Absent for an ephemeral session, which owns no persisted file. */
	readonly ref?: string;
	readonly id: string;
	readonly name?: string;
	readonly leafId: string | null;
	/** Entries from the root to the current leaf, in order. */
	readonly pathToRoot: readonly SessionTreeEntry[];
}

export interface ExtensionSessionTree extends ExtensionSessionSnapshot {
	/** Every entry in the session, including branches off the current path. */
	readonly entries: readonly SessionTreeEntry[];
}

/**
 * Session reads available to an extension.
 *
 * Two channels with deliberately different scopes. `appendEntry`/`findEntries`
 * are the extension's own namespaced state: another extension's entries are
 * invisible, and always have been. The readers below are the session as a
 * whole - every message on the branch, including other extensions' entries and
 * the human's own words.
 *
 * The cross-session readers reach every session of the current project, not
 * just this agent's. That is a real information surface, so they require
 * project trust, the same bar as `exec` and as loading extensions from a `cwd`
 * root. `listSessions` is scoped by cwd; there is no channel to another
 * project's sessions.
 *
 * Sessions are addressed by the opaque `ref` returned by these readers. An
 * unknown ref fails loudly.
 */
export interface ExtensionSessionContext {
	/**
	 * Append one namespaced entry to this agent's session branch.
	 *
	 * Resolves to the entry id, or to undefined when the write was buffered
	 * behind a running turn - the harness owns the branch while it works, and an
	 * entry it has not written yet has no id. `findEntries` reads them back
	 * either way.
	 */
	appendEntry<T = unknown>(type: string, data?: T): Promise<string | undefined>;
	findEntries<T = unknown>(type?: string): Promise<ExtensionCustomEntry<T>[]>;
	/** This agent's session: identity, name, leaf, and the path back to the root. */
	getSnapshot(): Promise<ExtensionSessionSnapshot>;
	/** As `getSnapshot`, plus every entry in the session's tree. */
	getTree(): Promise<ExtensionSessionTree>;
	getLeafId(): Promise<string | null>;
	/**
	 * Top-level sessions of the current project, newest first.
	 *
	 * Sessions an agent spawned are not listed: they belong to the tree of the
	 * session that spawned them and are reached through it.
	 */
	listSessions(): Promise<ExtensionSessionCandidate[]>;
	readSession(ref: string): Promise<ExtensionSessionTree>;
}

export interface ExtensionSessionActions {
	appendEntry<T = unknown>(extensionId: string, type: string, data?: T): Promise<string | undefined>;
	findEntries<T = unknown>(extensionId: string, type?: string): Promise<ExtensionCustomEntry<T>[]>;
	getSnapshot(): Promise<ExtensionSessionSnapshot>;
	getTree(): Promise<ExtensionSessionTree>;
	getLeafId(): Promise<string | null>;
	listSessions(extensionId: string): Promise<ExtensionSessionCandidate[]>;
	readSession(extensionId: string, ref: string): Promise<ExtensionSessionTree>;
}

export interface ExtensionActionFailure {
	extensionId: string;
	action:
		| "abort"
		| "appendEntry"
		| "clearStatus"
		| "compact"
		| "describeAgent"
		| "disposeAgent"
		| "disposeRuntime"
		| "emitExtensionEvent"
		| "emitOutput"
		| "exec"
		| "findEntries"
		| "followUp"
		| "getLeafId"
		| "getSessionName"
		| "getSnapshot"
		| "getSystemPrompt"
		| "getTree"
		| "listAgents"
		| "listModelCandidates"
		| "listProfiles"
		| "listSessions"
		| "navigateTree"
		| "notify"
		| "precede"
		| "prompt"
		| "publishMessage"
		| "readSession"
		| "reportDiagnostic"
		| "requestHuman"
		| "requestShutdown"
		| "setActiveTools"
		| "setModel"
		| "setSessionName"
		| "setStatus"
		| "setThinkingLevel"
		| "setTools"
		| "spawnAgent"
		| "steer"
		| "waitForIdle";
	code: string;
	error: unknown;
}

export interface ExtensionContext {
	extensionId: string;
	agentId: string;
	profileId: string;
	actions: ExtensionActions;
	session: ExtensionSessionContext;
	readonly signal: AbortSignal | undefined;
	isIdle(): boolean;
}

/**
 * Activation-time provider registration config (ME slice 9). The provider
 * name must be new - built-in, models.json, and other extensions' names are
 * not overridable (first-registration-wins, no proxy/override channel) - and
 * the config must define complete models. Credential ownership does not move:
 * `apiKey` is a config value reference resolved by the core at request time,
 * and OAuth credentials persist in core AuthStorage. Registration is global
 * (the model table is a process-wide fact) but its lifecycle is bound to the
 * declaring runner: reload re-registers, dispose withdraws.
 */
export type ExtensionProviderConfig = ProviderConfigInput;

export type ExtensionObserver<TEvent extends ExtensionObservedEvent = ExtensionObservedEvent> = (
	event: TEvent,
	context: ExtensionContext,
) => Promise<void> | void;

/**
 * Subscriber to the runtime-level extension event bus. The context is the
 * receiving runtime's own - agent-scoped, as everywhere else - while the
 * envelope names who sent the event and from which agent.
 */
export type ExtensionEventHandler = (event: ExtensionEventEnvelope, context: ExtensionContext) => Promise<void> | void;

export type ExtensionObserverFor<TName extends ExtensionObservedEventName> = ExtensionObserver<
	ExtensionObservedEventFor<TName>
>;

/**
 * Teardown callback registered at activation time. Runs when the owning
 * extension runtime is disposed (agent disposed or extension reload replaces
 * the runner); use it to release resources the activation acquired, such as
 * open server connections.
 */
export type ExtensionDisposeHandler = () => Promise<void> | void;

export type ExtensionInterceptorFor<TName extends ExtensionInterceptorName> = (
	event: ExtensionInterceptorEventFor<TName>,
	context: ExtensionContext,
) => Promise<ExtensionInterceptorResultFor<TName>> | ExtensionInterceptorResultFor<TName>;

export interface ExtensionActivationApi {
	readonly extensionId: string;
	readonly agentId: string;
	readonly profileId: string;
	/**
	 * Register contributions that belong to one division. `register` is not
	 * called at all when the division is disabled, so a disabled part performs
	 * no side effects either - it never opens its connections or watchers.
	 *
	 * Ids nest: inside a `division("servers")` scope, `division("github")`
	 * declares `servers.github`. Await the call; the loader also awaits any
	 * pending registration before it settles the scope, so a forgotten `await`
	 * still lands its contributions.
	 */
	division(id: string, register: (api: ExtensionActivationApi) => void | Promise<void>): Promise<void>;
	/** Relative to the current division scope, like `division`. */
	isDivisionEnabled(id: string): boolean;
	registerTool<TParamsSchema extends TSchema, TDetails>(tool: ToolDefinition<TParamsSchema, TDetails>): void;
	patchTool<TParamsSchema extends TSchema, TDetails>(
		targetToolName: string,
		patch: ToolDefinitionPatch<TParamsSchema, TDetails>,
	): void;
	registerProvider(providerName: string, config: ExtensionProviderConfig): void;
	/**
	 * Ship a role agents can be spawned on, for as long as this extension is
	 * loaded. It needs no entry in the enabled-profiles setting: enabling the
	 * extension is the decision, and asking for the same consent twice would only
	 * make an extension look broken on install.
	 *
	 * A profile of the user's own with the same id shadows it, so an extension
	 * cannot quietly change what a role the user wrote means. Registration is
	 * leased per agent like a provider's: every runtime that activates the
	 * extension renews it, and it is withdrawn when the last one is gone.
	 */
	registerProfile(profile: AgentProfile): void;
	/**
	 * Append a section to the agent's system prompt, after the role's own text
	 * and the tool guidance. Sections keep registration order, and one from a
	 * disabled division is never registered at all.
	 *
	 * This is the additive channel: rewriting the whole prompt is what the
	 * `before_agent_start` interceptor is for.
	 */
	appendSystemPrompt(text: string): void;
	observe<TName extends ExtensionObservedEventName>(eventName: TName, handler: ExtensionObserverFor<TName>): void;
	intercept<TName extends ExtensionInterceptorName>(eventName: TName, handler: ExtensionInterceptorFor<TName>): void;
	/**
	 * Subscribe to the runtime-level extension event bus (`emitExtensionEvent`).
	 * This is how two extensions agree on a protocol - `herdr:blocked` and the
	 * like - without either one knowing whether the other is installed.
	 *
	 * The subscription lives as long as this extension runtime does: an
	 * extension reload replaces it, and disposal drops it.
	 */
	onExtensionEvent(name: string, handler: ExtensionEventHandler): void;
	onDispose(handler: ExtensionDisposeHandler): void;
}

export type ExtensionFactory = (api: ExtensionActivationApi) => Promise<void> | void;

/**
 * Versioned extension declaration (ME slice 10). `apiVersion` names the
 * extension API version the extension targets; the loader refuses to activate
 * an extension declaring an unsupported version and reports
 * `extension.version_incompatible` instead. A bare factory omits the
 * declaration and is treated as targeting the current version.
 *
 * `divisions` names the switchable parts of an integration. It lives on the
 * default export rather than in a package manifest because the loader imports
 * the module before it activates anything, so the declared list is listable
 * (and togglable) without running any extension code - and because a
 * single-file extension has no manifest to put it in.
 */
export interface ExtensionDefinition {
	readonly apiVersion: number;
	readonly divisions?: readonly ExtensionDivisionDeclaration[];
	readonly activate: ExtensionFactory;
}

/**
 * What an extension module default-exports, and what `registerExtension`
 * accepts: a bare factory or a versioned definition. One declaration shape
 * covers all three extension sources (factory, file, package).
 */
export type ExtensionModule = ExtensionFactory | ExtensionDefinition;
