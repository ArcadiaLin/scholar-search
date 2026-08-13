import type { AgentSnapshot } from "../../../../core/agent-types.ts";
import type { CommandContext } from "../../types.ts";

export function requireAgentId(context: CommandContext): string {
	if (!context.agentId) throw new Error("Command requires an active agent.");
	return context.agentId;
}

// Resume and fork both answer "which agent did I land on".
export function agentSnapshotResultText(verb: string, result: unknown): string {
	const snapshot = result as AgentSnapshot;
	const reference = snapshot.profile.reference;
	return `${verb} ${snapshot.agentId} · ${reference.label ?? reference.id} · ${snapshot.model.id}`;
}
