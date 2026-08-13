/**
 * The orchestrator's collaboration capabilities, bound to one agent's identity.
 *
 * The binding supplies the identity so a holder never passes it: that is how
 * the surface is built, not what it is for.
 */

import type { ThinkingLevel } from "@arcadialin/agent-core";
import type { HumanRequestDraft, HumanResponse } from "./human-request.ts";
import type { AgentNotice, MessageDeliveryMode, MessageSendOutcome } from "./message.ts";
import type { AgentAbortOrigin, AgentActivity, AgentId, AgentIdleReason } from "./types.ts";

export interface AgentProfileBrief {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly persist: boolean;
}

/** Model-visible summary of one currently live agent. */
export interface AgentBrief {
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly label?: string;
	readonly activity: AgentActivity;
}

/**
 * Where a spawned agent's context comes from. Narrower than the orchestrator's
 * own origin type, which also carries a full profile override: a profile is the
 * unit an agent may choose from, not a set of fields it may assemble.
 */
export type AgentSpawnOrigin =
	/** Fresh context from a profile; omitted takes the runtime default. */
	| { readonly kind: "new"; readonly profileId?: string }
	/** Reopen a session left behind by an agent that is no longer running. */
	| { readonly kind: "resume"; readonly reference: string }
	/** Copy a live agent's branch. Only for a source whose profile persists. */
	| { readonly kind: "fork"; readonly sourceAgentId: AgentId; readonly entryId?: string };

export interface AgentSpawnRequest {
	readonly origin: AgentSpawnOrigin;
	/** Model reference (`provider/id`); refused when the runtime does not have it. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
}

/** One agent stopping, as the runtime observed it. */
export interface AgentStop {
	readonly reason: AgentIdleReason;
	/** Only with `aborted`, and only when the abort was asked for. */
	readonly abortedBy?: AgentAbortOrigin;
}

/** Something the runtime tells an agent about another agent. */
export interface AgentSelfNotification {
	/** Whose stop this is; the text is attributed to it, not to the caller. */
	readonly aboutAgentId: AgentId;
	readonly notice: AgentNotice;
	readonly body: string;
	/**
	 * How hard it lands: `interrupt` reaches a turn already running, `next_turn`
	 * waits for that turn to end, `precede` only records it on the branch.
	 */
	readonly mode: MessageDeliveryMode;
}

/** A wait ended because an agent it depended on is gone; `agentId` names which. */
export class AgentGoneError extends Error {
	readonly agentId: AgentId;

	constructor(agentId: AgentId) {
		super(`Agent ${agentId} is gone.`);
		this.name = "AgentGoneError";
		this.agentId = agentId;
	}
}

/**
 * One node of the caller's agent tree: an agent running now, or the session
 * directory an agent that is no longer running left behind.
 *
 * Both kinds carry `sessionAgentId`, the id their session was written under,
 * which is the name a conversation older than this runtime still uses. A closed
 * entry withholds it once this runtime has buried that id - an agent it disposed
 * or is disposing - so a message can never resurrect one it has already answered
 * for.
 */
export type AgentTreeEntry = AgentTreeRunningEntry | AgentTreeClosedEntry;

export interface AgentTreeRunningEntry {
	readonly status: "running";
	readonly agentId: AgentId;
	readonly sessionAgentId?: string;
	readonly activity: AgentActivity;
	readonly profileId: string;
	readonly label?: string;
	/** Address of its session directory; absent for an ephemeral agent. */
	readonly sessionRef?: string;
	readonly children: readonly AgentTreeEntry[];
}

export interface AgentTreeClosedEntry {
	readonly status: "closed";
	/**
	 * Address of the session directory, which is this entry's whole identity.
	 *
	 * The full address rather than the bare directory name: below the top level
	 * the name alone resolves to nothing, and the address is the form `/resume`
	 * and every other session reference already take.
	 */
	readonly sessionRef: string;
	readonly sessionAgentId?: string;
	/** Absent when the session header predates profile references. */
	readonly profileId?: string;
	readonly label?: string;
	readonly createdAt: string;
	readonly children: readonly AgentTreeEntry[];
}

export interface AgentTreeListing {
	/** The tree roots, normally exactly one: the root of the caller's own tree. */
	readonly entries: readonly AgentTreeEntry[];
	/**
	 * Set when the session directories could not be read, so the listing holds
	 * running agents only. Reported rather than thrown: a broken filesystem
	 * should not take out the caller's view of who is running.
	 */
	readonly closedUnavailable?: boolean;
}

export type AgentDisposeScope = "agent" | "subtree";

export interface AgentRequestedDisposeOptions {
	readonly scope: AgentDisposeScope;
	readonly reason: string;
}

export type AgentRequestedDisposeOutcome =
	| { readonly kind: "disposed"; readonly agentIds: readonly AgentId[] }
	| { readonly kind: "already_disposed" | "outside_tree" | "self" | "unknown" };

/**
 * What one agent can ask of the orchestrator, with the asking agent already
 * bound.
 *
 * Every method is missing the same parameter - who is asking - because the
 * binding already carries it. That is what makes this one surface usable by any
 * runtime allowed to act as the agent: `spawn` parents under it, `listAgents`
 * scopes to its level, `dispose` checks their shared tree, and `sendMessage`
 * attributes to it, whoever is holding the object. Tools are the first holder.
 */
export interface AgentToOrchestratorHost {
	readonly agentId: AgentId;
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	listAgents(): Promise<AgentTreeListing>;
	describe(agentId: AgentId): AgentBrief | undefined;
	spawn(request: AgentSpawnRequest): Promise<AgentId>;
	sendMessage(targetAgentId: AgentId, body: string): Promise<MessageSendOutcome>;
	/** Whether the target is in the caller's own tree, the scope lifecycle control uses. */
	sharesTree(targetAgentId: AgentId): boolean;
	/**
	 * The target's *next* stop, edge-triggered: an agent already idle keeps this
	 * waiting until it runs and stops again. Rejects when either side is disposed.
	 */
	waitForAgentStop(targetAgentId: AgentId, options?: { readonly signal?: AbortSignal }): Promise<AgentStop>;
	/** What the target said in the run that just ended. */
	readAgentReport(targetAgentId: AgentId): Promise<string | undefined>;
	/**
	 * Put text into the caller's own inbox, attributed to another agent.
	 *
	 * `sendMessage` cannot express this: it always speaks *as* the caller, and it
	 * fixes the delivery mode because one agent must not preempt another's turn.
	 * Here the turn being interrupted is the caller's own, so the urgency is its
	 * to choose.
	 */
	notifySelf(notification: AgentSelfNotification): Promise<MessageSendOutcome>;
	dispose(agentId: AgentId, options: AgentRequestedDisposeOptions): Promise<AgentRequestedDisposeOutcome>;
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
}
