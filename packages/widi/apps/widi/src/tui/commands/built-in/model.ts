import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

export function modelCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "model",
		description: "Set the current agent or staged session model.",
		argumentHint: "[provider/model]",
		requiresArgument: true,
		complete: async ({ orchestrator }) => (await orchestrator.listAvailableModelCandidates()).models,
		argumentCompletes: true,
		execute: async (context, argument) => {
			const reference = argument.trim();
			// A staged session has no agent to retarget: pick the model it will
			// spawn with. This is also the only path a fresh install has - with
			// no authenticated model nothing can materialize to be retargeted.
			if (!context.agentId) {
				const model = await context.orchestrator.resolveModelByReference(reference);
				context.orchestrator.setDefaultModel(model);
				return host.setPendingModel(model);
			}
			const model = await context.orchestrator.setAgentModelByReference(context.agentId, reference);
			// Picking a model is picking it: whatever is spawned next starts there too,
			// and so does the next run.
			context.orchestrator.setDefaultModel(model);
			return `Switched to ${model.provider}/${model.id}`;
		},
	};
}
