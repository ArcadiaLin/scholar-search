import { formatPromptTemplateInvocation, parseCommandArgs } from "@arcadialin/agent-core";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const promptCommand: CommandDefinition = {
	kind: "prompt",
	agentPolicy: "materialize",
	name: "prompt",
	description: "Send a prompt template as the prompt.",
	argumentHint: "<template> [args…]",
	requiresArgument: true,
	complete: async (context) =>
		(await context.orchestrator.listAgentPromptTemplateCandidates(requireAgentId(context))).templates,
	expand: async (context, argument) => {
		// The template name is the first token; the rest are positional
		// arguments for the template's own "$1"/"$@" placeholders.
		const [name, ...args] = parseCommandArgs(argument);
		if (!name) throw new Error("Command /prompt requires a template name.");
		const template = await context.orchestrator.getAgentPromptTemplate(requireAgentId(context), name);
		return formatPromptTemplateInvocation(template, args);
	},
};
