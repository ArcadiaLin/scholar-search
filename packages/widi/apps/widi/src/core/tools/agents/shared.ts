import type { AgentToOrchestratorHost, AgentTreeEntry } from "../../host.ts";
import type { ToolExecutionContext } from "../types.ts";

export function requireAgentHost<TDetails>(context: ToolExecutionContext<TDetails>): AgentToOrchestratorHost {
	const host = context.agents;
	if (!host) {
		throw new Error("Agent collaboration is not available in this runtime, so there are no other agents to work with.");
	}
	return host;
}

/**
 * The agents and sessions directly under the caller.
 *
 * The listing arrives rooted at the tree root, which is where discovery used to
 * start; anchoring on the caller is what makes "one level" mean the level the
 * caller owns rather than the level below the root. A caller that is somehow not
 * in its own tree falls back to the roots.
 */
export function callerChildren(entries: readonly AgentTreeEntry[], callerAgentId: string): readonly AgentTreeEntry[] {
	const caller = findCaller(entries, callerAgentId);
	return caller ? caller.children : entries;
}

function findCaller(entries: readonly AgentTreeEntry[], callerAgentId: string): AgentTreeEntry | undefined {
	for (const entry of entries) {
		if (entry.status === "running" && entry.agentId === callerAgentId) return entry;
		const nested = findCaller(entry.children, callerAgentId);
		if (nested) return nested;
	}
	return undefined;
}

export type OwnTreeTarget =
	| { readonly kind: "live"; readonly agentId: string }
	| { readonly kind: "resumable"; readonly sessionRef: string };

/**
 * Where a name from this caller's own conversation points, now.
 *
 * A name is matched against the id a node's session was written under, not the
 * id it happens to run as: those differ once a session has been reopened under
 * a taken id, and the conversation goes on using the name it was given.
 *
 * Breadth first, so the nearest node wins. An agent that forked itself carries
 * a copy of its own children below the fork, and both copies answer to the same
 * name; the shallower one is the caller's own rather than the copy's.
 */
export function findOwnTreeTarget(
	entries: readonly AgentTreeEntry[],
	callerAgentId: string,
	targetAgentId: string,
): OwnTreeTarget | undefined {
	const queue = [...callerChildren(entries, callerAgentId)];
	for (let index = 0; index < queue.length; index += 1) {
		const entry = queue[index];
		if (entry === undefined) continue;
		if (entry.status === "running" && (entry.agentId === targetAgentId || entry.sessionAgentId === targetAgentId)) {
			return { kind: "live", agentId: entry.agentId };
		}
		if (entry.status === "closed" && entry.sessionAgentId === targetAgentId) {
			return { kind: "resumable", sessionRef: entry.sessionRef };
		}
		queue.push(...entry.children);
	}
	return undefined;
}
