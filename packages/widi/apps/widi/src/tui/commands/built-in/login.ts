import type { CommandDefinition } from "../types.ts";

export const loginCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "runtime",
	name: "login",
	description: "Log in to an LLM provider subscription.",
	argumentHint: "[provider]",
	complete: async ({ orchestrator }) => orchestrator.listAuthProviderCandidates().providers,
	argumentCompletes: true,
	execute: async ({ orchestrator, agentId }, argument) => {
		const result = await orchestrator.loginAuthProvider(argument.trim(), { agentId });
		return `Logged in to ${result.providerName}`;
	},
};
