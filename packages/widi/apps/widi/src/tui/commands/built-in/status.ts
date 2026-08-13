import type { AgentActivitySnapshot } from "../../../core/types.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const statusCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "status",
	description: "Get the current agent status.",
	execute: async (context) => context.orchestrator.getAgentActivity(requireAgentId(context)),
	formatResult: (result) => {
		const activity = result as AgentActivitySnapshot;
		return activity.maintenance ? `${activity.activity} (${activity.maintenance})` : activity.activity;
	},
};
