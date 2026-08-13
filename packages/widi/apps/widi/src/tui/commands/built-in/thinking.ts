import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentThinkingLevelResult } from "../../../core/agent-orchestrator.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const thinkingCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "materialize",
	name: "thinking",
	description: "Set the current agent thinking level.",
	argumentHint: "[level]",
	requiresArgument: true,
	complete: async (context) => {
		if (context.agentId) {
			return context.orchestrator.listAgentThinkingLevelCandidates(context.agentId).levels;
		}
		if (!context.pendingModel?.reasoning) return [];
		return getSupportedThinkingLevels(context.pendingModel).map((level) => ({ value: level, label: level }));
	},
	argumentCompletes: true,
	execute: async (context, argument) => {
		const result = await context.orchestrator.setAgentThinkingLevelByName(requireAgentId(context), argument.trim());
		// Same rule as /model: choosing a level chooses it for what comes next and
		// for the next run, not only for the agent that happens to be open.
		context.orchestrator.setDefaultThinkingLevel(result.level);
		return result;
	},
	formatResult: (result) => `Thinking level set to ${(result as AgentThinkingLevelResult).level}`,
};
