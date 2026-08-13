import { formatSkillInvocation } from "@arcadialin/agent-core";
import { splitLeadingToken } from "../parse.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const skillCommand: CommandDefinition = {
	kind: "prompt",
	agentPolicy: "materialize",
	name: "skill",
	description: "Apply a skill as the prompt.",
	argumentHint: "<skill_name> [instructions]",
	requiresArgument: true,
	complete: async (context) => (await context.orchestrator.listAgentSkillCandidates(requireAgentId(context))).skills,
	// Naming a skill is an explicit request to apply it, so the body is
	// inlined rather than pointed at: it saves a read round-trip and keeps
	// skills usable on agents that have no read tool. Automatic discovery
	// stays the system prompt's job (see buildAgentSystemPrompt).
	expand: async (context, argument) => {
		const { token: name, rest: instructions } = splitLeadingToken(argument);
		const skill = await context.orchestrator.getAgentSkill(requireAgentId(context), name);
		return formatSkillInvocation(skill, instructions || undefined);
	},
};
