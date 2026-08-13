import type { CommandDefinition } from "../types.ts";

export const logoutCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "runtime",
	name: "logout",
	description: "Remove a stored LLM provider credential.",
	argumentHint: "[provider]",
	complete: async ({ orchestrator }) => (await orchestrator.listAuthCredentialCandidates()).providers,
	argumentCompletes: true,
	execute: async ({ orchestrator }, argument) => {
		const result = await orchestrator.logoutAuthProvider(argument.trim());
		return result.removed
			? `Removed the stored credential for ${result.providerId}`
			: `No stored credential for ${result.providerId}`;
	},
};
