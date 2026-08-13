import type { AgentSessionSnapshot } from "../../../core/session-manager.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const renameCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "materialize",
	name: "rename",
	description: "Rename the current agent session.",
	argumentHint: "<name>",
	requiresArgument: true,
	execute: async (context, argument) =>
		await context.orchestrator.setAgentSessionName(requireAgentId(context), argument.trim()),
	formatResult: (result) => {
		const snapshot = result as AgentSessionSnapshot;
		return `renamed to ${snapshot.name ?? "(unnamed)"}`;
	},
};
