import type { ExtensionReloadResult } from "../../../core/agent-orchestrator.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const reloadCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "reload",
	description: "Reload extensions for the current agent.",
	execute: async (context) => await context.orchestrator.reloadExtensions({ agentIds: [requireAgentId(context)] }),
	formatResult: (result) => {
		const reload = result as ExtensionReloadResult;
		return [
			`${reload.catalog.loaded.length} extensions loaded`,
			...reload.agents.map((agent) => `${agent.agentId}: ${agent.status}${agent.reason ? ` (${agent.reason})` : ""}`),
		].join("\n");
	},
};
