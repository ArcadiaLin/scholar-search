import { type Static, Type } from "typebox";
import { formatError } from "../../../utils/errors.ts";
import type { AgentSpawnOrigin, AgentToOrchestratorHost } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";
import type { AgentWatches } from "./watch-agent.ts";

const spawnAgentItemSchema = Type.Object({
	profile: Type.Optional(
		Type.String({ description: "Id of a profile from list_agents to start a new agent with an empty context." }),
	),
	resume: Type.Optional(
		Type.String({ description: "Session address from the resumable list, reopened as a running agent." }),
	),
	fork: Type.Optional(
		Type.String({
			description:
				"Id of a running agent whose context to copy, yourself included. Expensive: the whole transcript is carried into every one of the new agent's turns.",
		}),
	),
	entry: Type.Optional(Type.String({ description: "With fork: copy the source's branch up to this entry id only." })),
	task: Type.Optional(
		Type.String({
			description:
				"First message to send it. It starts with no knowledge of your conversation, so state the whole job.",
		}),
	),
	watch: Type.Optional(
		Type.Boolean({
			description: "Be told when this agent stops. Defaults to true when task is given, false otherwise.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model reference as provider/id. Defaults to the one you run." })),
	thinking: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{ description: "Reasoning effort for the new agent. Defaults to the one you run." },
		),
	),
});

const spawnAgentSchema = Type.Object({
	agents: Type.Array(spawnAgentItemSchema, {
		description:
			"The agents to create, one entry each. Exactly one of profile, resume, or fork per entry. Entries are independent: one failing does not stop the rest.",
	}),
});

export type SpawnAgentInput = Static<typeof spawnAgentSchema>;

export interface SpawnAgentAgentStatus {
	readonly origin: AgentSpawnOrigin["kind"];
	/** Absent when the entry never produced an agent. */
	readonly agentId?: string;
	readonly profileId?: string;
	readonly watching?: boolean;
	/** What went wrong; an agent id may still be present beside it. */
	readonly error?: string;
}

export interface SpawnAgentDetails {
	readonly agents: readonly SpawnAgentAgentStatus[];
}

/**
 * Create agents.
 *
 * An array rather than one per call, so several agents in one turn is a
 * guarantee rather than a hope that the model emits several tool calls. No
 * count, background, or timeout arguments: agents are concurrent by nature and
 * spawning only waits for the harness to be ready.
 *
 * `model` and `thinking` are the whole of what a caller may override. The rest
 * of a profile decides the agent's tools, and a caller able to name those could
 * hand a child what it does not itself hold.
 */
export function createSpawnAgentToolDefinition(
	watches: AgentWatches,
): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "spawn_agent",
		description:
			"Create one or more agents and get their ids back. Each entry names where its context comes from: profile starts an empty one, resume reopens a session, fork copies a running agent's context. A new agent runs independently and does not see your conversation, so pass task to hand it the work. By default you then watch it and are told when it stops. Call list_agents first for the profiles and sessions available.",
		promptSnippet: "Create agents from a profile, a session, or a fork",
		promptGuidelines: [
			"Delegation is a loop with an end: spawn, get woken by the notification, read the report, then either continue that agent with send_message or release it with dispose_agent. An agent you stop needing but never dispose keeps running.",
			"Ending your turn is how you wait. You will be woken; do not poll the agent, sleep, or check on its progress.",
			"Brief an agent like a colleague who just walked into the room: it has your task text and nothing else. Never delegate the understanding itself.",
			"profile is the cheap default. fork carries your whole transcript into every one of the child's turns, so use it only when the child genuinely needs your context and the task text cannot carry it.",
		],
		parameters: spawnAgentSchema,
		execute: async (_toolCallId, { agents }, context) => {
			const host = requireAgentHost(context);
			if (agents.length === 0) {
				throw new Error("spawn_agent requires at least one entry in agents.");
			}
			const statuses: SpawnAgentAgentStatus[] = [];
			// Sequential: agent ids are handed out as each spawn runs, and a caller
			// reading its own result should see them in the order it asked for.
			for (const request of agents) {
				statuses.push(await spawnOne(watches, host, request));
			}
			return { content: [{ type: "text", text: formatSpawnSummary(statuses) }], details: { agents: statuses } };
		},
	};
}

async function spawnOne(
	watches: AgentWatches,
	host: AgentToOrchestratorHost,
	request: Static<typeof spawnAgentItemSchema>,
): Promise<SpawnAgentAgentStatus> {
	let origin: AgentSpawnOrigin;
	try {
		origin = toSpawnOrigin(request);
	} catch (error) {
		return { origin: "new", error: formatError(error) };
	}
	const task = request.task?.trim();
	if (request.task !== undefined && !task) {
		return { origin: origin.kind, error: "task was empty. Omit it to create an idle agent." };
	}

	let agentId: string;
	try {
		agentId = await host.spawn({
			origin,
			...(request.model === undefined ? undefined : { model: request.model }),
			...(request.thinking === undefined ? undefined : { thinkingLevel: request.thinking }),
		});
	} catch (error) {
		return { origin: origin.kind, error: formatError(error) };
	}
	const profileId = host.describe(agentId)?.profileId;

	// Before the task, never after: a pending delivery already counts the agent
	// busy, so a subscription registered first cannot miss the stop that follows.
	const watching = (request.watch ?? task !== undefined) && watches.start(host, agentId) === "watching";
	const status = { origin: origin.kind, agentId, ...(profileId === undefined ? undefined : { profileId }), watching };
	if (task === undefined) return status;

	try {
		const outcome = await host.sendMessage(agentId, task);
		if (outcome.kind === "blocked") {
			const reason = outcome.reason ? `${outcome.blockedBy}: ${outcome.reason}` : `blocked by ${outcome.blockedBy}`;
			return { ...status, error: `the agent was created but its task was blocked (${reason})` };
		}
	} catch (error) {
		// The agent exists and is fine; only the task failed to reach it. Destroying
		// a working agent to tidy up is worse than leaving it, so report both facts.
		return { ...status, error: `the agent was created but its task was not delivered: ${formatError(error)}` };
	}
	return status;
}

/** The one origin an entry names, refusing a request that names none or several. */
function toSpawnOrigin(request: Static<typeof spawnAgentItemSchema>): AgentSpawnOrigin {
	const profileId = request.profile?.trim();
	const reference = request.resume?.trim();
	const sourceAgentId = request.fork?.trim();
	const entryId = request.entry?.trim();
	if (entryId && !sourceAgentId) {
		throw new Error("entry only applies to fork.");
	}
	if ([profileId, reference, sourceAgentId].filter(Boolean).length === 1) {
		if (profileId) return { kind: "new", profileId };
		if (reference) return { kind: "resume", reference };
		if (sourceAgentId) return { kind: "fork", sourceAgentId, ...(entryId ? { entryId } : undefined) };
	}
	throw new Error("each spawn_agent entry needs exactly one of profile, resume, or fork.");
}

function formatSpawnSummary(statuses: readonly SpawnAgentAgentStatus[]): string {
	const lines = statuses.map((status) => {
		if (status.agentId === undefined) return `- not created (${status.origin}): ${status.error}`;
		const profile = status.profileId ? ` [profile ${status.profileId}]` : "";
		const head = `- agent ${status.agentId}${profile} created by ${status.origin}`;
		if (status.error) return `${head}, but ${status.error}`;
		return status.watching
			? `${head}, watched: it reports to you when it stops`
			: `${head}, not watched: nothing will tell you when it stops`;
	});
	const watched = statuses.some((status) => status.watching && status.error === undefined);
	return [
		"Spawn requested:",
		...lines,
		watched
			? "End your turn to wait; the notification wakes you. Then continue that agent with send_message, or dispose_agent to release it."
			: "Nothing is waiting on these agents. Use watch_agent if you want to be told when one stops.",
	].join("\n");
}
