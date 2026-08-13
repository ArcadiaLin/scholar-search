import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

/**
 * Open a second conversation instead of replacing the current one: the agent
 * that was running keeps running and stays in the strip. Nothing is spawned
 * until the first message is submitted, so an abandoned /new costs nothing.
 */
export function newCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "new",
		description: "Stage a new agent on a profile, keeping the current one.",
		argumentHint: "[profile]",
		argumentCompletes: true,
		complete: async ({ orchestrator }) => (await orchestrator.listAgentProfileCandidates()).profiles,
		// Reached with an empty argument only when no profile could be offered:
		// with candidates the engine opens the picker instead.
		execute: async (_context, argument) => {
			const profileId = argument.trim() || undefined;
			await host.newAgent(profileId);
			return profileId
				? `Staged a new agent on ${profileId}; it spawns with the first message.`
				: "Staged a new agent on the default profile; it spawns with the first message.";
		},
	};
}
