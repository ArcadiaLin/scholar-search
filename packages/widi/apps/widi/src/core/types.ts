import type { AgentHarnessEvent, AgentHarnessPhase } from "@arcadialin/agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./agent-profile.js";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type { ExtensionMessage, ExtensionStatus } from "./extension/types.ts";
import type { HumanRequestEvent } from "./human-request.ts";

export type RuntimeModel = Model<Api>;

/** Runtime-local agent identity allocated by the orchestrator. */
export type AgentId = string;

/** Current activity derived directly from the live harness phase. */
export type AgentActivity = "idle" | "running";

/**
 * Maintenance work that marks an agent "running" without driving an agent
 * loop. Steering and aborting do not apply while it is set.
 */
export type AgentMaintenanceKind = "compaction" | "tree-navigation";

/**
 * The one place a harness phase is judged to be maintenance. Everything that
 * has to know reads it here - the activity a surface shows, the turn controls
 * it refuses, the messages held rather than queued, the idle with no turn
 * behind it - so the set cannot drift between them.
 */
export function maintenanceKindOf(phase: AgentHarnessPhase): AgentMaintenanceKind | undefined {
	if (phase === "compaction") return "compaction";
	if (phase === "branch_summary") return "tree-navigation";
	return undefined;
}

/** The work as a noun, for the surfaces that have to say what is blocking. */
export function maintenanceDescription(kind: AgentMaintenanceKind): string {
	return kind === "compaction" ? "compaction" : "tree navigation";
}

export interface AgentActivitySnapshot {
	readonly activity: AgentActivity;
	readonly maintenance?: AgentMaintenanceKind;
}

/**
 * How an agent arrived at the idle reported by `agent_idle`.
 *
 * `settled` and `aborted` are the two ways a turn can end and are the pair a
 * delegating consumer actually has to tell apart: the first means the agent
 * stopped because it was done talking, the second means something cut it off,
 * so its last message may be a fragment. `ready` is the first idle after the
 * harness is built, before any turn has run. `maintenance` follows compaction
 * or tree navigation, which occupy the agent without being a turn at all.
 */
export type AgentIdleReason = "ready" | "settled" | "aborted" | "maintenance";

/**
 * Who asked for an abort. Absent when nobody did: a run can end aborted because
 * the harness cancelled it, and a consumer that treats that as a person at the
 * keyboard would wait for an instruction nobody is coming to give.
 */
export type AgentAbortOrigin = "human" | "extension";

export interface AgentToolsSnapshot {
	readonly toolNames: readonly string[];
	readonly activeToolNames: readonly string[];
}

export interface RuntimeShutdownRequest {
	readonly requestedBy: string;
	readonly requestedByAgentId: AgentId;
	readonly reason?: string;
}

/**
 * How much of the model's context window the agent's current branch occupies.
 *
 * Derived from exactly the facts the automatic compaction trigger consumes -
 * the last assistant usage on the active branch versus the model context
 * window - so a consumer showing this gauge and the runtime deciding to compact
 * never disagree. Absent until the branch carries an assistant usage: a fresh
 * agent, and the window right after compaction, have no measurement rather than
 * a zero.
 */
export interface AgentContextUsage {
	readonly tokens: number;
	readonly contextWindow: number;
	/**
	 * `tokens / contextWindow * 100`, so a quarter-full window reads 25, not
	 * 0.25. The scale matches Pi's `ContextUsage.percent` on purpose: ported
	 * extensions compare it against thresholds like `>= 95`, and a 0..1 scale
	 * would make those conditions silently unreachable. Can exceed 100 before
	 * compaction runs.
	 */
	readonly percent: number;
	/** Model reference (`provider/id`) whose window this measures. */
	readonly model: string;
}

export type OrchestratorEvent =
	| { readonly type: "agent_harness_event"; agentId: AgentId; event: AgentHarnessEvent }
	| {
			readonly type: "agent_status_changed";
			agentId: AgentId;
			previousActivity?: AgentActivity;
			activity: AgentActivity;
			/** Set when this "running" transition is maintenance work, not a turn. */
			maintenance?: AgentMaintenanceKind;
			changedAt: string;
	  }
	// The agent has stopped and nothing is waiting to be read: the same
	// judgement `waitForAgentIdle` settles on, published as an event so a
	// consumer can be told rather than poll. Edge-triggered - one event per
	// arrival at idle, not one per fact that re-confirms it.
	//
	// Deliberately not the same question as "the work is finished". An agent
	// that stopped mid-task or was interrupted is idle here too; `reason` is
	// what a consumer judges that from.
	| {
			readonly type: "agent_idle";
			agentId: AgentId;
			reason: AgentIdleReason;
			/** Only with `aborted`, and only when the abort was asked for. */
			abortedBy?: AgentAbortOrigin;
			idleAt: string;
	  }
	// Input interception facts (ME slice 6): the model-facing text can differ
	// from the human original, so both are published with extension attribution.
	| {
			readonly type: "input_transformed";
			agentId: AgentId;
			inputId: string;
			originalText: string;
			text: string;
			// Extensions that returned a rewrite, in application order.
			transformedBy: readonly string[];
			createdAt: string;
	  }
	| {
			readonly type: "input_blocked";
			agentId: AgentId;
			inputId: string;
			originalText: string;
			reason?: string;
			// The extension whose handler ended the pipeline - a deliberate
			// block, or a crash blocked fail-closed (the extension.handler_failed
			// diagnostic tells the two apart).
			blockedBy: string;
			createdAt: string;
	  }
	// Append-only plain text an extension pushes for direct client display.
	// It is ephemeral: not persisted, not added to model context, and never
	// fed back to extension observers.
	| {
			readonly type: "extension_output";
			// Core-generated stable identity: consumers use it as the output
			// item's view key and for RPC/log correlation.
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			text: string;
			createdAt: string;
	  }
	// Transient info-only notice. Consumers choose its display lifetime; it
	// does not imply severity, attention, persistence, dedupe, or clear.
	| {
			readonly type: "extension_notification";
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			text: string;
			createdAt: string;
	  }
	| {
			readonly type: "extension_status_changed";
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			key: string;
			// Absent means the keyed status was cleared.
			status?: ExtensionStatus;
			changedAt: string;
	  }
	| {
			readonly type: "extension_message_published";
			presentationId: string;
			// Session custom entry id: the stable identity consumers use to
			// dedupe between this live event and hydration.
			entryId: string;
			agentId: AgentId;
			extensionId: string;
			message: ExtensionMessage;
			createdAt: string;
	  }
	// An extension asked the runtime to shut down. Core publishes the request
	// and does nothing else: the process and the terminal belong to the host,
	// and a host that tore them down from underneath itself would skip its own
	// restoration path. The host performs the ordered shutdown; an embedder with
	// no host of its own can call disposeAll instead.
	| {
			readonly type: "runtime_shutdown_requested";
			/** Extension that asked, injected by core. */
			requestedBy: string;
			/** Agent whose extension runtime made the request, for attribution. */
			requestedByAgentId: AgentId;
			reason?: string;
			createdAt: string;
	  }
	| HumanRequestEvent
	// OAuth login flow facts. The URL and device code must reach the human
	// even when the flow completes through a local callback server without
	// further input, so they are broadcast facts, not human requests. agentId
	// is the agent whose surface initiated the login, for display attribution.
	| {
			readonly type: "auth_login_url";
			providerId: string;
			agentId?: AgentId;
			url: string;
			instructions?: string;
			createdAt: string;
	  }
	| {
			readonly type: "auth_login_code";
			providerId: string;
			agentId?: AgentId;
			userCode: string;
			verificationUri: string;
			createdAt: string;
	  }
	| { readonly type: "auth_login_progress"; providerId: string; agentId?: AgentId; message: string; createdAt: string }
	| { readonly type: "diagnostic"; diagnostic: OrchestratorDiagnostic; createdAt: string }
	| {
			readonly type: "agent_spawned";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
			/**
			 * Where the agent's context came from. A resume is its own event, so only
			 * these two land here - and they are worth telling apart: a fork carries a
			 * spawn tree it does not own, every member of which refuses its messages.
			 */
			origin: "new" | "fork";
			/** Set when another agent's tool initiated the spawn. */
			spawnedBy?: AgentId;
	  }
	| {
			readonly type: "agent_resumed";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
			spawnedBy?: AgentId;
	  }
	| {
			readonly type: "agent_disposed";
			agentId: AgentId;
			intent: "removed" | "runtime_shutdown";
			reason?: string;
			disposedAt: string;
	  }
	| { readonly type: "agent_session_info_changed"; agentId: AgentId; name?: string; changedAt: string }
	// Context gauge fact, recomputed when the agent settles. Push rather than
	// poll: a footer or a budget-watching extension would otherwise have to
	// re-read the whole branch on a timer. An absent `usage` means the previous
	// measurement no longer describes the branch and no new one exists yet -
	// what compaction leaves behind until the next assistant message.
	| { readonly type: "agent_context_usage_changed"; agentId: AgentId; usage?: AgentContextUsage; changedAt: string }
	| {
			readonly type: "agent_session_forked";
			agentId: AgentId;
			forkedSessionId: string;
			entryId?: string;
			createdAt: string;
	  }
	// Which state a persistence namespace now has on this agent's branch. The
	// ref itself is a pure index - it never becomes model context - so without
	// this event nothing outside the namespace can see that the branch changed
	// its mind about what a namespace holds.
	//
	// Published from the write's own `session_write`, not from the call that
	// asked for it: the harness buffers writes behind a running turn and reports
	// no entry id until it flushes. That makes `entryId` always real, at the cost
	// of the event arriving at the save point rather than at the commit.
	| {
			readonly type: "agent_persistence_ref_changed";
			agentId: AgentId;
			namespace: string;
			/** Null when the branch's last word on this namespace is to clear it. */
			stateRoot: string | null;
			entryId: string;
			changedAt: string;
	  };

export type OrchestratorEventListener = (event: OrchestratorEvent) => Promise<void> | void;

/** A completion candidate returned by orchestrator list methods. */
export interface CandidateItem {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
}

/** Result of promptAgent: the prompt completed or an interceptor blocked it. */
export type PromptOutcome =
	| { readonly kind: "completed"; readonly message: AssistantMessage }
	| { readonly kind: "blocked"; readonly inputId: string; readonly reason?: string; readonly blockedBy: string };
