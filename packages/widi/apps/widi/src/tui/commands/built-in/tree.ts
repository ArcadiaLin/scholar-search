import type { NavigateTreeResult } from "@arcadialin/agent-core";
import type { AgentSessionTreeSnapshot } from "../../../core/session-manager.ts";
import { commandHeadline, commandPreviewLines, type PresentCommandOptions } from "../../command-presenter.ts";
import { TreeNavigationSelector } from "../../selectors/tree-navigation.ts";
import { buildSessionEntryRows, findSessionEntryRow } from "../../session-tree.ts";
import type { CommandResultItem } from "../../state.ts";
import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";
import { requireAgentId } from "./utils/agents.ts";
import { listUserMessageEntryCandidates } from "./utils/sessions.ts";

export function treeCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "active",
		name: "tree",
		description: "Inspect or navigate the current session tree.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		argumentCompletes: true,
		resolveArgument: async (context, argument) => {
			// Navigation targets are every entry in the tree, not just the
			// user-message candidates the completer lists, so ids resolve against
			// the tree itself. The selector's summarize choice rides along as the
			// "summarize" modifier, custom instructions behind a "--" separator.
			const parsed = parseTreeArgument(argument);
			if (!parsed) return { kind: "open-selector", query: argument };
			const tree = await context.orchestrator.getAgentSessionTree(requireAgentId(context));
			return tree.entries.some((entry) => entry.id === parsed.targetId)
				? { kind: "resolved", value: argument.trim() }
				: { kind: "open-selector", query: argument };
		},
		// The graph picker needs the entry tree itself, not the flat candidate
		// list, so it fetches the snapshot again rather than reading request.items.
		selector: async (request, context) => {
			const tree = await context.orchestrator.getAgentSessionTree(requireAgentId(context));
			const rows = buildSessionEntryRows(tree);
			const initialEntryId = request.initialFilter ? findSessionEntryRow(rows, request.initialFilter) : undefined;
			return new TreeNavigationSelector({
				title: request.title,
				rows,
				...(initialEntryId === undefined ? undefined : { initialEntryId }),
				// The summarize choice rides along in the resubmitted argument:
				// "/tree <entryId> summarize", custom instructions behind "--".
				onNavigate: (entryId, summarize, customInstructions) =>
					request.onSelect({
						value: customInstructions
							? `${entryId} summarize -- ${customInstructions}`
							: summarize
								? `${entryId} summarize`
								: entryId,
						label: entryId,
					}),
				onCancel: request.onCancel,
				onClose: request.onClose,
			});
		},
		execute: async (context, argument) => {
			const agentId = requireAgentId(context);
			const parsed = parseTreeArgument(argument);
			if (!parsed) {
				return await context.orchestrator.getAgentSessionTree(agentId);
			}
			const navigation = await context.orchestrator.navigateAgentTree(
				agentId,
				parsed.targetId,
				parsed.summarize
					? {
							summarize: true,
							...(parsed.customInstructions === undefined ? {} : { customInstructions: parsed.customInstructions }),
						}
					: undefined,
			);
			// Navigating to a user message un-sends it: the harness returns its
			// text so the editor can offer it back for editing and resubmission.
			if (navigation.cancelled) host.restoreSubmittedText();
			else if (navigation.editorText !== undefined) host.setEditorText(navigation.editorText);
			return navigation;
		},
		presenter: { kind: "lines", present: (item, width, options) => presentTreeResult(item, width, options) },
	};
}

interface TreeArgument {
	readonly targetId: string;
	readonly summarize: boolean;
	readonly customInstructions?: string;
}

/**
 * The submitted /tree argument: an entry id, an optional "summarize"
 * modifier, and optional custom summarization instructions behind a "--"
 * separator (the selector's custom-prompt step encodes them there because a
 * SelectItem value is the only channel back through the submit path).
 */
const TREE_ARGUMENT_PATTERN = /^(\S+)(?:\s+(summarize)(?:\s+--\s*([\s\S]*))?)?$/;

function parseTreeArgument(argument: string): TreeArgument | undefined {
	const trimmed = argument.trim();
	if (trimmed === "") return undefined;
	const match = TREE_ARGUMENT_PATTERN.exec(trimmed);
	const targetId = match?.[1];
	if (!targetId) return undefined;
	const instructions = match?.[3]?.trim();
	return {
		targetId,
		summarize: match?.[2] === "summarize",
		...(instructions ? { customInstructions: instructions } : {}),
	};
}

const TREE_SUMMARY_PREVIEW_LINES = 4;
const TREE_SUMMARY_EXPANDED_LINES = 400;

/**
 * /tree's completed row: a headline naming the outcome, with the branch
 * summary previewed underneath when the navigation wrote one (the full text
 * stays on the session marker that hydration inserts).
 */
function presentTreeResult(item: CommandResultItem, width: number, options: PresentCommandOptions): string[] {
	const result = item.result;
	if (typeof result === "object" && result !== null && "entries" in result) {
		const tree = result as AgentSessionTreeSnapshot;
		return [commandHeadline(item.name, ` · ${tree.entries.length} entries · leaf ${tree.leafId ?? "none"}`)];
	}
	const navigation = result as NavigateTreeResult | undefined;
	if (!navigation) return [commandHeadline(item.name)];
	if (navigation.cancelled) return [commandHeadline(item.name, " · navigation cancelled")];
	const headline = commandHeadline(item.name, navigation.summaryEntry ? " · branch summarized" : " · navigated");
	if (!navigation.summaryEntry) return [headline];
	return [
		headline,
		...commandPreviewLines(navigation.summaryEntry.summary, width, options, {
			collapsed: TREE_SUMMARY_PREVIEW_LINES,
			expanded: TREE_SUMMARY_EXPANDED_LINES,
		}),
	];
}
