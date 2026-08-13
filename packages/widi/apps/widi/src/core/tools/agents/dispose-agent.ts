import { type Static, Type } from "typebox";
import { formatError } from "../../../utils/errors.ts";
import type { AgentDisposeScope, AgentRequestedDisposeOutcome, AgentToOrchestratorHost } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const disposeAgentSchema = Type.Object({
	agentIds: Type.Array(Type.String(), {
		description:
			"Ids of same-tree agents to destroy. With scope agent, their descendants keep running; with scope subtree, every descendant is destroyed too.",
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("agent"), Type.Literal("subtree")], {
			description:
				"How much to destroy. agent affects only each named agent; subtree recursively includes all descendants. Defaults to agent.",
		}),
	),
	reason: Type.Optional(Type.String({ description: "Short note recorded on the cancellations this dispose causes." })),
});

export type DisposeAgentInput = Static<typeof disposeAgentSchema>;

/**
 * Per-agent result:
 * - `disposed`: the agent was live and has been destroyed;
 * - `already_disposed`: the selected scope is already gone or being torn down;
 * - `outside_tree`: target exists but lifecycle control is tree-local;
 * - `unknown`: no agent with that id;
 * - `self`: refused, the selected scope contains the caller;
 * - `failed`: the teardown reported an error.
 */
export type DisposeAgentState = "disposed" | "already_disposed" | "outside_tree" | "unknown" | "self" | "failed";

export interface DisposeAgentAgentStatus {
	readonly agentId: string;
	readonly state: DisposeAgentState;
	/** Present for a successful recursive request, in leaf-to-root order. */
	readonly disposedAgentIds?: readonly string[];
	readonly message?: string;
}

export interface DisposeAgentDetails {
	readonly scope: AgentDisposeScope;
	readonly agents: readonly DisposeAgentAgentStatus[];
}

/**
 * Destroy named same-tree agents.
 *
 * Each id is handled on its own so one bad entry cannot hide the others, and
 * nothing outside the selected scope is destroyed. The default single-agent
 * mode preserves the existing non-cascading lifecycle; subtree mode is an
 * explicit recursive request and reports every agent it actually transitioned.
 *
 * Any selection containing the caller is refused. Returning a tool result to
 * an agent whose harness is being torn down needs deferred disposal, which the
 * runtime does not have.
 */
export function createDisposeAgentToolDefinition(): ToolDefinition<typeof disposeAgentSchema, DisposeAgentDetails> {
	return {
		name: "dispose_agent",
		label: "dispose_agent",
		description:
			"Destroy one or more agents in your agent tree. scope agent destroys only the named agents and leaves their descendants running; scope subtree recursively destroys each named agent and all descendants. Each destroyed agent is stopped and its background work is cancelled; if you were watching one, you are told it is gone rather than left waiting. A selection containing you is refused. Only the running agents list_agents reports can be disposed; a resumable session is already not running. Dispose an agent once you are done with it - an agent you stop needing but leave running is a decision, not a way to finish its work.",
		promptSnippet: "Destroy same-tree agents individually or recursively by subtree",
		parameters: disposeAgentSchema,
		execute: async (_toolCallId, { agentIds, scope, reason }, context) => {
			const host = requireAgentHost(context);
			const disposeScope: AgentDisposeScope = scope ?? "agent";
			const requestedIds = Array.from(new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean)));
			const note = reason?.trim();
			const action = disposeScope === "subtree" ? "recursively disposed this agent subtree" : "disposed this agent";
			const disposeReason = note ? `Agent ${host.agentId} ${action}: ${note}` : `Agent ${host.agentId} ${action}.`;

			const agents: DisposeAgentAgentStatus[] = [];
			for (const agentId of requestedIds) {
				agents.push(await disposeOne(host, agentId, disposeScope, disposeReason));
			}
			return {
				content: [{ type: "text", text: formatDisposeSummary(agents, disposeScope) }],
				details: { scope: disposeScope, agents },
			};
		},
	};
}

async function disposeOne(
	host: AgentToOrchestratorHost,
	agentId: string,
	scope: AgentDisposeScope,
	reason: string,
): Promise<DisposeAgentAgentStatus> {
	try {
		const outcome = await host.dispose(agentId, { scope, reason });
		return toDisposeStatus(agentId, scope, outcome);
	} catch (error) {
		return { agentId, state: "failed", message: formatError(error) };
	}
}

function toDisposeStatus(
	agentId: string,
	scope: AgentDisposeScope,
	outcome: AgentRequestedDisposeOutcome,
): DisposeAgentAgentStatus {
	if (outcome.kind !== "disposed") {
		return { agentId, state: outcome.kind };
	}
	return scope === "subtree"
		? { agentId, state: "disposed", disposedAgentIds: outcome.agentIds }
		: { agentId, state: "disposed" };
}

function formatDisposeSummary(agents: readonly DisposeAgentAgentStatus[], scope: AgentDisposeScope): string {
	if (agents.length === 0) {
		return "No agent id was given, so nothing was disposed.";
	}
	const lines = agents.map((agent) => {
		switch (agent.state) {
			case "disposed":
				return agent.disposedAgentIds
					? `- ${agent.agentId}: disposed subtree (${agent.disposedAgentIds.join(", ")})`
					: `- ${agent.agentId}: disposed`;
			case "already_disposed":
				return `- ${agent.agentId}: already disposed or being disposed`;
			case "outside_tree":
				return `- ${agent.agentId}: refused, agent belongs to another tree`;
			case "unknown":
				return `- ${agent.agentId}: unknown agent`;
			case "self":
				return scope === "subtree"
					? `- ${agent.agentId}: refused, subtree contains the calling agent`
					: `- ${agent.agentId}: refused, an agent cannot dispose itself`;
			default:
				return `- ${agent.agentId}: dispose failed: ${agent.message ?? "unknown error"}`;
		}
	});
	return `Dispose requested for agents:\n${lines.join("\n")}`;
}
