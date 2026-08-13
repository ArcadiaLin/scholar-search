import { homedir } from "node:os";
import type { MessageEntry, SessionTreeEntry } from "@arcadialin/agent-core";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSessionTreeSnapshot } from "../core/session-manager.ts";
import { singleLine } from "./format.ts";

/** What a tree row is; the selector paints each kind differently (pi parity). */
export type SessionEntryRowKind =
	| "user"
	| "assistant"
	| "tool"
	| "compaction"
	| "branch-summary"
	| "model-change"
	| "thinking-change"
	| "custom"
	| "custom-message"
	| "label"
	| "session-info";

/**
 * One navigable row of a session tree. Rows cover every displayable entry
 * type - user and assistant messages, tool calls, branch summaries, and the
 * dim bookkeeping entries - like pi's tree selector, so the graph shows the
 * conversation as it actually happened, not just the user's own messages.
 */
export interface SessionEntryTreeRow {
	readonly entryId: string;
	readonly kind: SessionEntryRowKind;
	/**
	 * Display text without the kind prefix, already single-lined and capped.
	 * Tool rows carry the fully formatted `[name: args]` label.
	 */
	readonly headline: string;
	/** Kind-specific tag the renderer needs (custom-message's customType). */
	readonly tag?: string;
	readonly timestamp: string;
	/**
	 * Indent level in 4-column units, following pi's flattenTree semantics: a
	 * single-child chain stays flat instead of drifting right, +1 only under a
	 * branching parent, plus one grouping step for the first generation below a
	 * connector-bearing row.
	 */
	readonly indent: number;
	/** Draw a ├─/└─ connector: the row belongs to a sibling group. */
	readonly connector: boolean;
	/** Whether the row is the last among its siblings (└── vs ├──). */
	readonly last: boolean;
	/**
	 * Per level, whether an ancestor's sibling group continues below the row
	 * (│ gutter). Index 0 is the leftmost level; unset levels read as gaps.
	 */
	readonly gutters: readonly boolean[];
	/** The row the current leaf hangs at or under; navigation starts from here. */
	readonly current: boolean;
}

interface RowDisplay {
	readonly kind: SessionEntryRowKind;
	readonly headline: string;
	readonly tag?: string;
}

interface ToolCallInfo {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/**
 * Flatten a session tree snapshot into preorder rows over every displayable
 * entry. Row-less bookkeeping entries (leaf markers, active-tools changes,
 * unknown message roles) still shape the tree: a row's parent is its nearest
 * ancestor that has a row of its own. Sibling order follows append order,
 * which is stable across reads.
 */
export function buildSessionEntryRows(tree: AgentSessionTreeSnapshot): SessionEntryTreeRow[] {
	const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
	const toolCalls = collectToolCalls(tree.entries);
	const displayOf = (entry: SessionTreeEntry): RowDisplay | undefined => entryDisplay(entry, toolCalls);
	const currentId = nearestRowEntryId(byId, tree.leafId, displayOf);
	const roots: SessionTreeEntry[] = [];
	const childrenOf = new Map<string, SessionTreeEntry[]>();
	for (const entry of tree.entries) {
		if (displayOf(entry) === undefined) continue;
		const parentId = nearestRowEntryId(byId, entry.parentId, displayOf);
		if (parentId === null) {
			roots.push(entry);
			continue;
		}
		const siblings = childrenOf.get(parentId) ?? [];
		siblings.push(entry);
		childrenOf.set(parentId, siblings);
	}
	const rows: SessionEntryTreeRow[] = [];
	const visit = (
		entries: readonly SessionTreeEntry[],
		indent: number,
		justBranched: boolean,
		rootLevel: boolean,
		gutters: readonly boolean[],
	): void => {
		const multiple = entries.length > 1;
		for (const [index, entry] of entries.entries()) {
			const display = displayOf(entry);
			if (!display) continue;
			const last = index === entries.length - 1;
			rows.push({
				entryId: entry.id,
				kind: display.kind,
				headline: display.headline,
				...(display.tag === undefined ? {} : { tag: display.tag }),
				timestamp: entry.timestamp,
				indent,
				connector: multiple,
				last,
				gutters,
				current: entry.id === currentId,
			});
			const children = childrenOf.get(entry.id) ?? [];
			// pi's flattenTree rules: children of a branching parent form a
			// sibling group one level deeper; a single child groups one level
			// deeper only right below a connector-bearing row, then the chain
			// stays flat. A root-level connector (multiple roots) groups too.
			const childIndent = children.length > 1 || (justBranched && (indent > 0 || rootLevel)) ? indent + 1 : indent;
			// A displayed connector leaves a │ gutter for everything below it.
			const childGutters = [...gutters];
			if (multiple) childGutters[rootLevel ? 0 : indent - 1] = !last;
			visit(children, childIndent, children.length > 1, false, childGutters);
		}
	};
	visit(roots, 0, roots.length > 1, true, []);
	return rows;
}

/** Display text of one entry, or undefined when the entry gets no row. */
function entryDisplay(entry: SessionTreeEntry, toolCalls: ReadonlyMap<string, ToolCallInfo>): RowDisplay | undefined {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "user") return { kind: "user", headline: userMessageHeadline(message) };
			if (message.role === "assistant") return { kind: "assistant", headline: assistantHeadline(message) };
			if (message.role === "toolResult") {
				const call = toolCalls.get(message.toolCallId);
				return { kind: "tool", headline: call ? formatToolCall(call.name, call.arguments) : `[${message.toolName}]` };
			}
			return undefined;
		}
		case "compaction":
			return { kind: "compaction", headline: `${Math.round(entry.tokensBefore / 1000)}k tokens` };
		case "branch_summary":
			return { kind: "branch-summary", headline: singleLine(entry.summary, 200) };
		case "model_change":
			return { kind: "model-change", headline: entry.modelId };
		case "thinking_level_change":
			return { kind: "thinking-change", headline: entry.thinkingLevel };
		case "custom":
			return { kind: "custom", headline: entry.customType };
		case "custom_message":
			return { kind: "custom-message", tag: entry.customType, headline: singleLine(contentText(entry.content), 200) };
		case "label":
			return { kind: "label", headline: entry.label ?? "(cleared)" };
		case "session_info":
			return { kind: "session-info", headline: entry.name ?? "empty" };
		default:
			// leaf and active_tools_change carry no displayable content.
			return undefined;
	}
}

/** Tool call blocks of every assistant message, keyed by call id. */
function collectToolCalls(entries: readonly SessionTreeEntry[]): Map<string, ToolCallInfo> {
	const toolCalls = new Map<string, ToolCallInfo>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, { name: block.name, arguments: block.arguments });
		}
	}
	return toolCalls;
}

/** pi's one-line tool label: `[read: README.md]`, `[bash: git status]`, … */
function formatToolCall(name: string, args: Record<string, unknown>): string {
	const shortenPath = (path: string): string => {
		const home = homedir();
		return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	};
	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset === undefined && limit === undefined) return `[read: ${path}]`;
			const start = offset ?? 1;
			const end = limit !== undefined ? start + limit - 1 : "";
			return `[read: ${path}:${start}${end ? `-${end}` : ""}]`;
		}
		case "write":
		case "edit":
			return `[${name}: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "bash": {
			const raw = String(args.command || "");
			const command = singleLine(raw, 50);
			return `[bash: ${command}${raw.length > 50 ? "..." : ""}]`;
		}
		case "grep":
			return `[grep: /${String(args.pattern || "")}/ in ${shortenPath(String(args.path || "."))}]`;
		case "find":
			return `[find: ${String(args.pattern || "")} in ${shortenPath(String(args.path || "."))}]`;
		case "ls":
			return `[ls: ${shortenPath(String(args.path || "."))}]`;
		default: {
			const serialized = JSON.stringify(args);
			return `[${name}: ${serialized.slice(0, 40)}${serialized.length > 40 ? "..." : ""}]`;
		}
	}
}

/** First text the assistant produced; status placeholders when there is none. */
function assistantHeadline(message: MessageEntry["message"]): string {
	if (message.role !== "assistant") return "";
	const text = singleLine(
		message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join(""),
		200,
	);
	if (text) return text;
	if (message.stopReason === "aborted") return "(aborted)";
	if (message.errorMessage) return singleLine(message.errorMessage, 80);
	return "(no content)";
}

/** Joined text of a string-or-blocks content payload. */
function contentText(content: string | readonly { type: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * Preselect for a typed query that did not resolve to an entry: an exact or
 * unique-prefix id hit wins, then the first headline containing the query.
 */
export function findSessionEntryRow(rows: readonly SessionEntryTreeRow[], query: string): string | undefined {
	const trimmed = query.trim();
	if (trimmed === "") return undefined;
	const exact = rows.find((row) => row.entryId === trimmed);
	if (exact) return exact.entryId;
	const prefixed = rows.filter((row) => row.entryId.startsWith(trimmed));
	if (prefixed.length === 1 && prefixed[0]) return prefixed[0].entryId;
	const lower = trimmed.toLowerCase();
	return rows.find((row) => row.headline.toLowerCase().includes(lower))?.entryId;
}

/** First non-empty line of the user's text, capped at one display line. */
export function userMessageHeadline(message: UserMessage): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join(" ");
	const line =
		text
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Nearest entry at or above `startId` that has a row, walking the parent chain. */
function nearestRowEntryId(
	byId: ReadonlyMap<string, SessionTreeEntry>,
	startId: string | null,
	displayOf: (entry: SessionTreeEntry) => RowDisplay | undefined,
): string | null {
	let cursor = startId;
	while (cursor !== null) {
		const entry = byId.get(cursor);
		if (!entry) return null;
		if (displayOf(entry) !== undefined) return entry.id;
		cursor = entry.parentId;
	}
	return null;
}
