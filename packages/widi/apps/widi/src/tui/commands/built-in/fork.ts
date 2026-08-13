import { ListSelector } from "../../selectors/list-selector.ts";
import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";
import { agentSnapshotResultText, requireAgentId } from "./utils/agents.ts";
import { listUserMessageEntryCandidates } from "./utils/sessions.ts";

export function forkCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "active",
		name: "fork",
		description: "Fork the current agent session.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		argumentCompletes: true,
		// Forking at the current leaf is a choice the entry list cannot express,
		// so the picker carries it as a row of its own. The empty value reaches
		// the submit path as "/fork:", the only syntax for an explicit blank.
		selector: (request) =>
			new ListSelector({
				...request,
				items: [
					{ value: "", label: "Fork here (current position)", description: "Use the current session position" },
					...request.items,
				],
			}),
		execute: async (context, argument) => {
			const entryId = argument.trim() || undefined;
			const agentId = await context.orchestrator.spawnAgent({
				origin: {
					kind: "fork",
					sourceAgentId: requireAgentId(context),
					...(entryId === undefined ? undefined : { entryId }),
				},
			});
			await host.switchToAgent(agentId);
			return context.orchestrator.inspectAgent(agentId);
		},
		formatResult: (result) => agentSnapshotResultText("forked", result),
	};
}
