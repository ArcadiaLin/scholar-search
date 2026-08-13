import type { CandidateItem } from "../../../../core/types.ts";
import { userMessageHeadline } from "../../../session-tree.ts";
import type { CommandContext } from "../../types.ts";
import { requireAgentId } from "./agents.ts";

// Fork/navigation targets are the user's own messages: they are the natural
// "points in the conversation" a user thinks in.
export async function listUserMessageEntryCandidates(context: CommandContext): Promise<readonly CandidateItem[]> {
	const tree = await context.orchestrator.getAgentSessionTree(requireAgentId(context));
	const candidates: CandidateItem[] = [];
	for (const entry of tree.entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		candidates.push({ value: entry.id, label: userMessageHeadline(entry.message), description: entry.timestamp });
	}
	return candidates;
}
