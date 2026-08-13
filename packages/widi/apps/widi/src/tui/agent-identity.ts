import { parseSessionOrigin } from "../core/persistence/index.ts";
import type { AgentId } from "../core/types.ts";
import { singleLine } from "./format.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";

/**
 * How the strip names an agent: its id, exactly as the model is handed it and
 * exactly as `send_message` and `dispose_agent` take it back. Anything shorter
 * still looks like an id while resolving to nothing, and the id already carries
 * the profile - `explore-ycfk` - so repeating the profile label beside it says
 * the same word twice. A session name set with `/rename` belongs to the header,
 * which is where a human-readable name for the open agent already lives.
 */
export function agentIdentityLabel(state: TuiApplicationState, agent: AgentViewState): string {
	const ownId = agentIdText(agent.agentId);
	const source = findForkSource(state, agent);
	return source ? `${ownId} ← ${agentIdText(source.agentId)}` : ownId;
}

/** Sanitized but never shortened; the strip truncates to the width it has. */
function agentIdText(agentId: AgentId): string {
	return singleLine(agentId, agentId.length);
}

export function forkSourceAgentId(state: TuiApplicationState, agent: AgentViewState): AgentId | undefined {
	return findForkSource(state, agent)?.agentId;
}

/**
 * The fork event when this runtime took the fork, the session header otherwise.
 *
 * The header records which session the history was copied from, which is what
 * survives the runtime that did the copying. It is deliberately not the session
 * that *spawned* this one - every subagent has one of those, and treating it as
 * fork provenance would label the whole spawn tree as forks.
 */
function findForkSource(state: TuiApplicationState, agent: AgentViewState): AgentViewState | undefined {
	if (agent.display.forkedFromAgentId) {
		return state.agents.get(agent.display.forkedFromAgentId);
	}
	const forkedFrom = forkSourceRef(agent);
	if (!forkedFrom) return undefined;
	return [...state.agents.values()].find((candidate) => candidate.snapshot?.sessionRef === forkedFrom);
}

function forkSourceRef(agent: AgentViewState): string | undefined {
	const metadata = agent.snapshot?.sessionMetadata;
	return parseSessionOrigin(metadata && "metadata" in metadata ? metadata.metadata : undefined)?.forkedFrom;
}
