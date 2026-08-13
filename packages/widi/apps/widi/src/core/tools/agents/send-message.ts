import { type Static, Type } from "typebox";
import { formatError } from "../../../utils/errors.ts";
import type { AgentToOrchestratorHost } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { findOwnTreeTarget, requireAgentHost } from "./shared.ts";
import { type AgentWatches, describeOutcome } from "./watch-agent.ts";

const sendMessageSchema = Type.Object({
	agentId: Type.String({ description: "Id of the agent to send to." }),
	message: Type.String({
		description: "The text the other agent will read. It cannot see your conversation, so state the whole thing.",
	}),
	watch: Type.Optional(
		Type.Boolean({
			description:
				"Be told when that agent next stops. Use it when this message is work you are waiting on; leave it off when you are replying to someone.",
		}),
	),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export interface SendMessageDetails {
	/** Who actually received it, which is not the requested id after a reopen. */
	readonly targetAgentId: string;
	readonly watching: boolean;
	/** Address of the session this target was reopened from, when it was. */
	readonly resumedFrom?: string;
}

/** Where a named target turned out to be, once the runtime has been asked. */
interface ResolvedTarget {
	readonly agentId: string;
	readonly resumedFrom?: string;
}

/**
 * Find the agent a name points at, reopening its session when the name outlived
 * the agent.
 *
 * The caller's own tree is searched before the runtime-wide id, and that order
 * is the whole point: a forked conversation names the agents of the tree it was
 * copied from, and every one of them has a copy of its own under the fork. The
 * fork must reach its copy, not the original still running for someone else.
 *
 * Reopening is what replaces telling the model its agents are gone. A branch
 * survives the runtime that wrote it and goes on naming what it delegated to;
 * the session is still on disk, so the name still resolves and the work
 * continues where it stopped rather than starting again.
 */
async function resolveTarget(host: AgentToOrchestratorHost, targetAgentId: string): Promise<ResolvedTarget> {
	// Answered from memory, which keeps ordinary delegation off the filesystem.
	if (host.describe(targetAgentId) && host.sharesTree(targetAgentId)) return { agentId: targetAgentId };

	const listing = await host.listAgents();
	const found = findOwnTreeTarget(listing.entries, host.agentId, targetAgentId);
	if (found?.kind === "live") return { agentId: found.agentId };
	if (found?.kind === "resumable") {
		try {
			const agentId = await host.spawn({ origin: { kind: "resume", reference: found.sessionRef } });
			return { agentId, resumedFrom: found.sessionRef };
		} catch (error) {
			throw new Error(
				`Agent ${targetAgentId} is not running and its session ${found.sessionRef} could not be reopened: ${formatError(error)}`,
			);
		}
	}
	// The soft bridge between trees: an exact id somebody shared with the caller.
	if (host.describe(targetAgentId)) return { agentId: targetAgentId };

	throw new Error(
		listing.closedUnavailable
			? `Unknown agent: ${targetAgentId}. It is not running, and the sessions that could be reopened for it could not be read.`
			: `Unknown agent: ${targetAgentId}. Nothing running answers to that id and no session of yours was written under it.`,
	);
}

/**
 * One verb for everything an agent says to another agent: hand a piece of text
 * to a named agent.
 *
 * It carries no completion or task bookkeeping. An agent's report is whatever
 * it last said before it stopped, and the runtime observes the stop itself, so
 * there is nothing here for a worker to remember to call.
 */
export function createSendMessageToolDefinition(
	watches: AgentWatches,
): ToolDefinition<typeof sendMessageSchema, SendMessageDetails> {
	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a message to another runtime-local agent by exact id. It delivers the text and returns once the other agent has it; that agent reads it on its next turn and may reply with its own send_message. An agent of yours that is no longer running is reopened from its session first, so an id from earlier in this conversation stays usable after a restart or a fork. The target may be in another agent tree if its id was shared with you; this tool does not discover ids. Pass watch: true when the message is work you are waiting on, and you will be told when that agent stops.",
		promptSnippet: "Send a message to another agent",
		promptGuidelines: [
			"send_message never waits for a reply: it returns once the other agent has the text. Continue working, or end your turn and wait to be woken.",
			"list_agents only discovers the agents you spawned, one level down. An exact agent id shared by a human, another agent, or an incoming message is enough to reach any other agent, at any level or in any tree.",
			"An agent you delegated to earlier is still reachable by the id you know it by, even after a restart or a fork: messaging it reopens its session with everything it had. Spawn a new agent only when you want the work started over.",
			"Include everything the other agent needs in the message: agents do not share conversations, sessions, or context.",
		],
		parameters: sendMessageSchema,
		execute: async (_toolCallId, { agentId, message, watch }, context) => {
			const host = requireAgentHost(context);
			const requestedAgentId = agentId.trim();
			const body = message.trim();
			if (!requestedAgentId) {
				throw new Error("send_message requires a non-empty agentId.");
			}
			if (!body) {
				throw new Error("send_message requires a non-empty message.");
			}
			if (requestedAgentId === host.agentId) {
				throw new Error("send_message cannot target yourself; it delivers text to another agent.");
			}
			const target = await resolveTarget(host, requestedAgentId);
			const targetAgentId = target.agentId;

			// Watching first is what makes the subscription reliable: a pending
			// delivery already counts the target busy, so a stop cannot slip between
			// the two calls. Nothing is rolled back if the send then fails - the
			// caller is told, and is watching an agent it did not reach.
			const watchOutcome = watch === true ? watches.start(host, targetAgentId) : undefined;
			const outcome = await host.sendMessage(targetAgentId, body);
			if (outcome.kind === "blocked") {
				const reason = outcome.reason ? `${outcome.blockedBy}: ${outcome.reason}` : `blocked by ${outcome.blockedBy}`;
				throw new Error(`The message to agent ${targetAgentId} was blocked (${reason}) and was not delivered.`);
			}
			const watching = watchOutcome === "watching";
			return {
				content: [
					{
						type: "text",
						text: [
							...(target.resumedFrom === undefined
								? []
								: [
										targetAgentId === requestedAgentId
											? `Agent ${requestedAgentId} was not running and was reopened from session ${target.resumedFrom}, with everything it had.`
											: `Agent ${requestedAgentId} was not running and was reopened from session ${target.resumedFrom}, with everything it had. It runs as ${targetAgentId} now, because another agent holds its old id; address it by the new one.`,
									]),
							`Message delivered to agent ${targetAgentId}. It reads the message on its next turn.`,
							watchOutcome === undefined
								? "Nothing is waiting on a reply, so continue or end your turn."
								: watching
									? "You will be told when it stops; end your turn to wait."
									: `It was not subscribed: ${describeOutcome(targetAgentId, watchOutcome)}`,
						].join(" "),
					},
				],
				details: {
					targetAgentId,
					watching,
					...(target.resumedFrom === undefined ? undefined : { resumedFrom: target.resumedFrom }),
				},
			};
		},
	};
}
