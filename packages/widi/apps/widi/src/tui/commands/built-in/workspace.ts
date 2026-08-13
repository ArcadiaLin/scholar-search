import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

/**
 * Point the staged session at another directory.
 *
 * Only a session that has not started yet: a running agent's paths, system
 * prompt and stored session all name one directory, and there is no way to make
 * all three change together. Which is why this is a staging command rather than
 * a "cd" - the answer to "move this conversation" is to open a new one.
 */
export function workspaceCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "pending",
		name: "workspace",
		description: "Open the staged session in another directory.",
		argumentHint: "<path>",
		requiresArgument: true,
		execute: async (_context, argument) => await host.setWorkspace(argument.trim()),
	};
}
