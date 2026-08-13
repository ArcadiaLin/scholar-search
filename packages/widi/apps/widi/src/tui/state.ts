import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "../core/agent-types.ts";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionMessage, ExtensionStatusSnapshot } from "../core/extension/api.ts";
import type { HumanRequestEnvelope, HumanRequestKind } from "../core/human-request.ts";
import type { MessageSource } from "../core/message.ts";
import type { AgentId, AgentMaintenanceKind, OrchestratorEvent, RuntimeModel } from "../core/types.ts";
import type { CommandError } from "./commands/types.ts";
import { DiagnosticsLog } from "./diagnostics-log.ts";
import type { AgentQuip } from "./quips.ts";
import { SegmentStore } from "./segments.ts";

export type TimelineDurability = "durable" | "ephemeral";
export type NoticeTextMode = "compact" | "full";

export interface UserMessageItem {
	readonly type: "user-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	text: string;
	modelText?: string;
}

/**
 * Input the runtime put into this agent's context on someone else's behalf: a
 * peer agent, an extension, or the runtime itself.
 *
 * Distinct from `user-message`, which is only what the person at this keyboard
 * typed. The two are indistinguishable to the model - both reach it as user
 * text - and that is exactly why they must not be here: a reader who cannot
 * tell them apart cannot tell what they were answering.
 *
 * `text` is the semantic body and `modelText` the rendered form the model
 * actually read, present only when the source's renderer changed it. The
 * attribution prefix lives in `modelText`; on screen the source line carries
 * it, so the same fact is never shown twice.
 */
export interface OrchestratorMessageItem {
	readonly type: "orchestrator-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	readonly source: MessageSource;
	text: string;
	modelText?: string;
	/** A human rewrote the body before it was sent; the source is still the producer. */
	readonly editedByHuman?: true;
}

export interface AssistantMessageItem {
	readonly type: "assistant-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	text: string;
	streaming: boolean;
	message?: AssistantMessage;
}

export interface ToolExecutionItem {
	readonly type: "tool-execution";
	readonly id: string;
	readonly toolCallId: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	/** Assistant stream that emitted this provisional tool call, when known. */
	readonly sourceAssistantId?: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	/**
	 * "preparing" covers the window between the streamed toolcall_start and
	 * tool_execution_start; a run that ends in that window leaves the item
	 * "cancelled".
	 */
	status: "preparing" | "running" | "completed" | "cancelled";
	/** When execution actually began; unset while the call is still preparing. */
	startedAt?: string;
	endedAt?: string;
	/**
	 * Per-item expand override (parity §4.3-3): set, it wins over the global
	 * toolOutputExpanded toggle; unset, the item follows the global state.
	 * The projector preserves it across item updates.
	 */
	expanded?: boolean;
}

export interface ThinkingStatusItem {
	readonly type: "thinking-status";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	status: "thinking" | "completed";
	/** Spinner line text; defaults to "Thinking…" when unset. */
	label?: string;
	/** Display-only tail of the streamed thinking text (last lines). */
	preview?: string;
}

export interface DiagnosticItem {
	readonly type: "diagnostic";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly diagnostic: OrchestratorDiagnostic;
}

export interface CommandResultItem {
	readonly type: "command-result";
	readonly id: string;
	readonly commandId: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly name: string;
	readonly argument: string;
	status: "running" | "completed" | "failed";
	result?: unknown;
	/** Human-readable summary from the command's formatResult, when defined. */
	display?: string;
	error?: CommandError;
}

export interface ExtensionOutputItem {
	readonly type: "extension-output";
	readonly id: string;
	readonly presentationId: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly extensionId: string;
	readonly text: string;
	/**
	 * Show the whole text instead of the bounded preview. The producer's own
	 * switch, not the global tool-output toggle: what an extension writes here is
	 * not tool output, and one key should not decide for both.
	 */
	expanded?: boolean;
}

export interface PersistentMessageItem {
	readonly type: "extension-message";
	readonly id: string;
	readonly entryId: string;
	readonly extensionId: string;
	readonly message: ExtensionMessage;
	readonly durability: "durable";
	readonly createdAt: string;
}

export interface HumanRequestTraceItem {
	readonly type: "human-request-trace";
	readonly id: string;
	readonly requestId: string;
	readonly requestKind: HumanRequestKind;
	readonly title: string;
	/** Original request options, kept only for the expanded trace rendering. */
	readonly options?: readonly string[];
	readonly answer:
		| { readonly kind: "confirm"; readonly confirmed: boolean }
		| { readonly kind: "selected-option"; readonly value: string }
		| { readonly kind: "selected-options"; readonly values: readonly string[] }
		| {
				readonly kind: "answered-questions";
				readonly items: readonly { readonly title: string; readonly values: readonly string[] }[];
		  }
		| { readonly kind: "answered" };
	readonly durability: "ephemeral";
	readonly createdAt: string;
}

export interface ApplicationNoticeItem {
	readonly type: "application-notice";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly text: string;
	/** Full mode wraps sanitized text without abbreviating copy-sensitive values. */
	readonly textMode?: NoticeTextMode;
}

export interface SessionMarkerItem {
	readonly type: "session-marker";
	readonly id: string;
	readonly durability: "durable";
	readonly createdAt: string;
	readonly marker: "compaction" | "branch-summary";
	readonly summary: string;
}

/** Placeholder left behind when the sliding window trims older turns. */
export interface WindowMarkerItem {
	readonly type: "window-marker";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	hiddenTurns: number;
}

export type TimelineItem =
	| UserMessageItem
	| OrchestratorMessageItem
	| AssistantMessageItem
	| ToolExecutionItem
	| ThinkingStatusItem
	| DiagnosticItem
	| CommandResultItem
	| ExtensionOutputItem
	| PersistentMessageItem
	| HumanRequestTraceItem
	| ApplicationNoticeItem
	| SessionMarkerItem
	| WindowMarkerItem;

export type AgentAttention = "none" | "completed" | "human-request" | "warning" | "error";

export interface PendingInput {
	readonly originalText: string;
	readonly submittedAt: string;
}

/**
 * What a pending agent will become once the user submits. A new session carries
 * the identity to reopen with rather than the agent it came from: the source is
 * disposed before the pending session is staged, so it is no longer there to
 * answer questions about itself.
 */
export type PendingAgentStart = {
	/**
	 * Where the agent will run. Set before it exists because it cannot be set
	 * after: a workspace is frozen at spawn, so staging is the only moment the
	 * choice is open.
	 */
	readonly cwd: string;
} & (
	| { readonly kind: "default" }
	/** model is absent only while the runtime has no authenticated model at all. */
	| { readonly kind: "new-session"; readonly profileId: string; readonly model: RuntimeModel | undefined }
);

export interface PendingAgentViewState {
	readonly start: PendingAgentStart;
	timeline: TimelineItem[];
	draft: string;
	display: {
		readonly profileId: string;
		readonly profileLabel: string;
		readonly cwd: string;
		model: RuntimeModel | undefined;
		thinkingLevel?: string;
		sessionName?: string;
	};
	nextLiveItemId: number;
}

export interface QueueState {
	steer: readonly string[];
	followUp: readonly string[];
	nextTurn: number;
}

export interface AgentDisplayFacts {
	/** The agent's workspace, which the footer and the header both name. */
	cwd?: string;
	model?: RuntimeModel;
	thinkingLevel?: string;
	/** Total tokens of the latest assistant turn (input+output+cache), for the footer context readout. */
	contextTokens?: number;
	activeToolNames: readonly string[];
	sessionName?: string;
	rehydrateRequested: boolean;
	forkedFromAgentId?: AgentId;
}

/** Human follow-up accepted by the TUI but not yet acknowledged by core. */
export interface PendingFollowUp {
	readonly id: number;
	readonly text: string;
}

/**
 * Text held back from the branch until the next human-initiated turn, so a
 * human can still read, rewrite or drop it. Staging is delay, not discard:
 * every exit path lands it, none throws it away behind the user's back.
 */
export interface StagedDraft {
	readonly id: number;
	/**
	 * The extension whose tui half staged it, which is also who the branch will
	 * record. Absent when the human staged their own text, and then it lands as
	 * plain human input like anything else they type.
	 */
	readonly extensionId?: string;
	text: string;
	/** Set once a human took it into the editor and changed it. */
	editedByHuman?: true;
}

/**
 * Lifecycle of one agent row.
 *
 * Core reports only `idle` and `running`, and only for an agent that is live;
 * the two extra states are the view's own - one before core has said anything
 * about a row the TUI already had to create, one after the agent is gone and
 * the row is kept so its transcript stays readable.
 */
export type AgentViewStatus = "creating" | "idle" | "running" | "disposed";

export interface AgentViewState {
	readonly agentId: AgentId;
	snapshot?: AgentSnapshot;
	/** The agent whose tool spawned this one; unset for user-side spawns. */
	spawnedBy?: AgentId;
	status: AgentViewStatus;
	/** Set while status "running" is maintenance work (compaction, tree
	 * navigation) rather than an agent turn: no steering or aborting applies. */
	maintenance?: AgentMaintenanceKind;
	timeline: TimelineItem[];
	extensionStatuses: Map<string, ExtensionStatusSnapshot>;
	unreadCount: number;
	attention: AgentAttention;
	hydration: "pending" | "ready" | "failed";
	bufferedEvents: OrchestratorEvent[];
	pendingInput?: PendingInput;
	/** When the current run started; set while status is "running". */
	runStartedAt?: string;
	/** Tool calls started in the current run, reset when one begins. */
	runToolCount: number;
	/** Tool failures in a row within the current run; any success clears it. */
	runToolErrorStreak: number;
	/** Totals of the run that just ended, for the working line's completion form. */
	lastRun?: { readonly startedAt: string; readonly endedAt: string; readonly toolCount: number };
	/** What the working line is saying about this agent. Rolled on transitions only. */
	quip?: AgentQuip;
	queue: QueueState;
	/** Optimistic projection while sendMessage is waiting for a deliverable phase. */
	pendingFollowUps: PendingFollowUp[];
	/**
	 * TUI-layer staging buffer, oldest first. The invariant this layer can hold
	 * is "on the branch before the next *human-initiated* turn": a turn someone
	 * else starts begins inside core, where this buffer is not visible, and the
	 * fallback flush lands it after that turn instead of before it.
	 */
	staged: StagedDraft[];
	/** The staged draft currently held in the editor, and the slot to put it back into. */
	stagedEditing?: { readonly draft: StagedDraft; readonly index: number };
	display: AgentDisplayFacts;
	/** The live assistant item currently receiving message_update events. */
	currentAssistantId?: string;
	/** Latest assistant text waiting for the throttled streaming flush. */
	pendingAssistantText?: PendingAssistantText;
	/** Latest tool args/partial results waiting for the throttled flush. */
	pendingToolUpdates?: Map<string, PendingToolUpdate>;
	/** Monotonic projection-local identity source for harness messages. */
	nextLiveItemId: number;
}

export interface PendingAssistantText {
	readonly itemId: string;
	readonly text: string;
	readonly message: AssistantMessage;
}

export interface PendingToolUpdate {
	readonly args: unknown;
	readonly partialResult: unknown;
}

export interface NoticeItem {
	readonly id: string;
	readonly kind: "extension-notification" | "diagnostic" | "application" | "startup";
	readonly createdAt: string;
	readonly text: string;
	/** Full mode wraps sanitized text without abbreviating copy-sensitive values. */
	readonly textMode?: NoticeTextMode;
	readonly agentId?: AgentId;
	readonly extensionId?: string;
	readonly diagnostic?: OrchestratorDiagnostic;
}

export interface PendingHumanRequestView {
	readonly request: HumanRequestEnvelope;
	readonly agentId?: AgentId;
}

/** Which interaction layer owns input; derived from TuiFocusState. */
export type TuiInteractionMode = "editor" | "selector" | "human-request" | "agent-panel";

/** Docked layout components that can hold input focus instead of the editor. */
export type TuiDockedFocus = "human-request" | "agent-panel" | "selector";

export interface TuiOverlayFocusEntry {
	/** Interaction mode the overlay contributes while it sits on the stack. */
	readonly mode?: TuiInteractionMode;
}

/**
 * The single source of truth behind `state.mode`. The application overlay
 * stack pushes/pops overlay entries as overlays open and close; docked
 * components claim and release their place on `docked` as they take and lose
 * input focus. Nobody writes `mode` directly.
 *
 * `docked` is a stack rather than one slot so a claimant can preempt another
 * without evicting it: an arriving human request takes the keys while the open
 * selector keeps its filter text and its place in the layout, and answering
 * hands the keys back to whoever had them. Each claimant appears at most once.
 */
export interface TuiFocusState {
	readonly overlays: TuiOverlayFocusEntry[];
	readonly docked: TuiDockedFocus[];
}

export interface TuiApplicationState {
	activeAgentId?: AgentId;
	pendingAgent?: PendingAgentViewState;
	agents: Map<AgentId, AgentViewState>;
	globalNotices: NoticeItem[];
	humanRequests: PendingHumanRequestView[];
	/** Every diagnostic reported this session, outliving the notice that announced it. */
	readonly diagnostics: DiagnosticsLog;
	readonly focus: TuiFocusState;
	readonly mode: TuiInteractionMode;
	shuttingDown: boolean;
	/** Global toggle: show full transcript details instead of collapsed previews. */
	toolOutputExpanded: boolean;
	/** Text other runtimes added to the composed rows, keyed by layout slot. */
	readonly segments: SegmentStore;
}

export function createTuiApplicationState(): TuiApplicationState {
	return {
		agents: new Map(),
		globalNotices: [],
		humanRequests: [],
		diagnostics: new DiagnosticsLog(),
		focus: { overlays: [], docked: [] },
		get mode() {
			return interactionMode(this);
		},
		shuttingDown: false,
		toolOutputExpanded: false,
		segments: new SegmentStore(),
	};
}

/**
 * The interaction mode is derived, never assigned: the top-most overlay wins,
 * then the docked component holding input focus, then the editor. A pending
 * human request on its own is not a mode — only the open menu claims it.
 */
export function interactionMode(state: TuiApplicationState): TuiInteractionMode {
	for (let i = state.focus.overlays.length - 1; i >= 0; i--) {
		const mode = state.focus.overlays[i]?.mode;
		if (mode) return mode;
	}
	return topDockedFocus(state) ?? "editor";
}

/** The docked claimant holding the keys, if any. */
export function topDockedFocus(state: TuiApplicationState): TuiDockedFocus | undefined {
	return state.focus.docked[state.focus.docked.length - 1];
}

/**
 * Whether a claimant is on the stack at all. Not the same question as who has
 * the keys: a preempted selector is still docked and still owns its position.
 */
export function hasDockedFocus(state: TuiApplicationState, docked: TuiDockedFocus): boolean {
	return state.focus.docked.includes(docked);
}

/** Record an opened overlay at the top of the focus stack. */
export function pushOverlayFocus(state: TuiApplicationState, entry: TuiOverlayFocusEntry): TuiOverlayFocusEntry {
	state.focus.overlays.push(entry);
	return entry;
}

export function removeOverlayFocus(state: TuiApplicationState, entry: TuiOverlayFocusEntry): void {
	const index = state.focus.overlays.indexOf(entry);
	if (index >= 0) state.focus.overlays.splice(index, 1);
}

/** A docked component takes input focus; re-claiming raises it to the top. */
export function setDockedFocus(state: TuiApplicationState, docked: TuiDockedFocus): void {
	const existing = state.focus.docked.indexOf(docked);
	if (existing >= 0) state.focus.docked.splice(existing, 1);
	state.focus.docked.push(docked);
}

/**
 * Release one claimant's place, wherever it sits — a preempted component that
 * closes must not linger under the one that preempted it. A claimant that
 * never claimed leaves the stack alone. Omitting it clears every claim, which
 * is what switching agents does.
 */
export function clearDockedFocus(state: TuiApplicationState, docked?: TuiDockedFocus): void {
	if (docked === undefined) {
		state.focus.docked.length = 0;
		return;
	}
	const index = state.focus.docked.indexOf(docked);
	if (index >= 0) state.focus.docked.splice(index, 1);
}

export function createAgentViewState(agentId: AgentId, status: AgentViewStatus = "creating"): AgentViewState {
	return {
		agentId,
		status,
		timeline: [],
		extensionStatuses: new Map(),
		unreadCount: 0,
		attention: "none",
		hydration: "ready",
		bufferedEvents: [],
		runToolCount: 0,
		runToolErrorStreak: 0,
		queue: { steer: [], followUp: [], nextTurn: 0 },
		pendingFollowUps: [],
		staged: [],
		display: { activeToolNames: [], rehydrateRequested: false },
		nextLiveItemId: 1,
	};
}

export function ensureAgentProjection(
	state: TuiApplicationState,
	agentId: AgentId,
	status: AgentViewStatus = "creating",
): AgentViewState {
	const existing = state.agents.get(agentId);
	if (existing) return existing;
	const created = createAgentViewState(agentId, status);
	state.agents.set(agentId, created);
	return created;
}

/** The agent every view renders against, or undefined while one is pending. */
export function activeAgent(state: TuiApplicationState): AgentViewState | undefined {
	return state.activeAgentId ? state.agents.get(state.activeAgentId) : undefined;
}

export function setActiveAgent(state: TuiApplicationState, agentId: AgentId): AgentViewState {
	const agent = ensureAgentProjection(state, agentId);
	state.activeAgentId = agentId;
	agent.unreadCount = 0;
	agent.attention = retainedAttention(state, agent);
	return agent;
}

/**
 * Attention that survives being viewed: pending human requests, an
 * unavailable agent and diagnostic-backed severity. Transient signals such as
 * completed runs or background tool failures are dropped once the user looks
 * at the agent.
 */
export function retainedAttention(state: TuiApplicationState, agent: AgentViewState): AgentAttention {
	if (state.humanRequests.some((item) => item.agentId === agent.agentId)) {
		return "human-request";
	}
	let attention: AgentAttention = "none";
	const diagnostics = [
		...agent.timeline.flatMap((item) => (item.type === "diagnostic" ? [item.diagnostic] : [])),
		...(agent.snapshot?.diagnostics ?? []),
	];
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity === "error") return "error";
		if (diagnostic.severity === "warning") attention = "warning";
	}
	return attention;
}

export function extensionStatusKey(extensionId: string, key: string): string {
	return `${extensionId}\u0000${key}`;
}

export function isTimelineEvent(event: OrchestratorEvent): boolean {
	if (event.type === "agent_harness_event") {
		return isTimelineHarnessEvent(event.event);
	}
	return (
		event.type === "extension_output" ||
		event.type === "extension_message_published" ||
		event.type === "diagnostic" ||
		event.type === "human_request_resolved"
	);
}

function isTimelineHarnessEvent(event: AgentHarnessEvent): boolean {
	return (
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

export function isToolResultMessage(message: unknown): message is ToolResultMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "toolResult";
}
