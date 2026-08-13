import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

/** End this conversation and reopen an empty one on the same role. */
export function clearCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "clear",
		description: "Close the current agent and start a new session on the same profile.",
		execute: async (context) => {
			await host.newSession(context.agentId);
			// The row lands in the session that replaced the one it closed: the
			// transcript it was typed into is gone, so this is where a person
			// looking for what happened will be.
			return "Session closed; a new one is staged on the same profile.";
		},
	};
}
