import type { CompactResult } from "@arcadialin/agent-core";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const compactCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "compact",
	description: "Compact the current agent session.",
	argumentHint: "[instructions]",
	execute: async (context, argument) =>
		await context.orchestrator.compactAgent(requireAgentId(context), argument.trim() || undefined),
	formatResult: (result) => {
		const compact = result as CompactResult;
		return `compacted ${compact.tokensBefore} tokens`;
	},
};
