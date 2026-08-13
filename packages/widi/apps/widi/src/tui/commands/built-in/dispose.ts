import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";
import { requireAgentId } from "./utils/agents.ts";

export function disposeCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "active",
		name: "dispose",
		description: "Close the current runtime agent without deleting its session.",
		execute: async (context) => {
			const agentId = requireAgentId(context);
			await host.disposeAgent(agentId);
			return `Closed ${agentId}; its session is kept and can be resumed.`;
		},
	};
}
