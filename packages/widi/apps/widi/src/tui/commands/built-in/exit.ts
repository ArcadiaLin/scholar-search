import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

export function exitCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "exit",
		description: "Exit the application.",
		execute: async () => {
			host.quit();
			return undefined;
		},
	};
}
