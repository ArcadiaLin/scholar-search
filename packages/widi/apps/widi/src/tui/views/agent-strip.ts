import {
	type Component,
	getKeybindings,
	type KeybindingsManager,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { agentIdentityLabel } from "../agent-identity.ts";
import { type AgentTree, type AgentTreeEntry, buildAgentTree, flattenAgentTree } from "../agent-tree.ts";
import { singleLine } from "../format.ts";
import { maintenanceLabel } from "../labels.ts";
import { type AgentViewState, clearDockedFocus, setDockedFocus, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { extensionStatusesInRegion, tonePaint } from "./utils/extension-status.ts";

const TREE_INDENT = 4;
/** Visible width of `├── ` / `└── `. */
const TREE_PREFIX_WIDTH = 4;
/** Kept clear at a column's right edge so neighbours never read as one label. */
const COLUMN_GAP = 4;
/** Smallest top-row label: glyph, a space, and an ellipsis. */
const MIN_LABEL_WIDTH = 3;
/** Top-level columns per page. Beyond this the rest become a page to the right. */
const TOP_LEVEL_PAGE_SIZE = 4;
/** Subtree rows a column shows before the remainder collapse into one marker. */
const MAX_SUBTREE_ROWS = 3;

/** A top-row column: a top-level agent, or the staged session, which has no id. */
interface StripColumn {
	readonly agentId?: string;
	readonly label: string;
}

/** Where a column landed, so its subtree can be drawn inside the same span. */
interface ColumnPlacement {
	readonly start: number;
	readonly width: number;
}

export interface AgentPanelHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

export type AgentPanelNavigation = "up" | "down" | "left" | "right";

const NOOP_HOST: AgentPanelHost = { setFocus: () => {}, requestRender: () => {} };

/**
 * Bottom agent panel. Unfocused it is a read-only strip: top-level agents sit
 * side by side on the first row with their subtrees hanging below, labels are
 * truncated per agent to fit the terminal width, and agents that still do not
 * fit are counted on the left edge (`+N`). Focused (down arrow from an empty
 * editor) it becomes the agent switcher: a cursor moves over the same
 * position layout with the arrow keys, the visible window always holds as
 * many agents as possible while keeping the cursor on screen (`‹N`/`N›`
 * count the hidden sides), enter switches, and escape or up from the top row
 * returns to the editor.
 */
export class AgentStripView implements Component {
	focused = false;
	private readonly state: TuiApplicationState;
	private readonly host: AgentPanelHost;
	private readonly onSelectAgent: (agentId: string) => void;
	private readonly onClose: () => void;
	private cursorAgentId?: string;

	constructor(
		state: TuiApplicationState,
		host: AgentPanelHost = NOOP_HOST,
		onSelectAgent: (agentId: string) => void = () => {},
		onClose: () => void = () => {},
	) {
		this.state = state;
		this.host = host;
		this.onSelectAgent = onSelectAgent;
		this.onClose = onClose;
	}

	/** Agent id under the cursor while the panel is focused. */
	get cursor(): string | undefined {
		return this.cursorAgentId;
	}

	invalidate(): void {}

	/** Focus the panel with the cursor on the active agent. No-op without agents. */
	open(): void {
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		this.cursorAgentId = undefined;
		if (!this.ensureCursor(entries) || !this.cursorAgentId) return;
		setDockedFocus(this.state, "agent-panel");
		this.host.setFocus(this);
		this.host.requestRender();
	}

	close(): void {
		if (!this.focused && this.state.mode !== "agent-panel") return;
		clearDockedFocus(this.state, "agent-panel");
		this.onClose();
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		if (!this.ensureCursor(entries) || !this.cursorAgentId) {
			this.close();
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.onSelectAgent(this.cursorAgentId);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		const navigation = matchNavigation(keybindings, data);
		if (!navigation) return;
		const next = moveAgentCursor(tree, this.cursorAgentId, navigation);
		if (next === undefined) {
			// Up from the top row: the panel sits below the editor, so the
			// position-consistent way out is back up into it.
			this.close();
			return;
		}
		this.cursorAgentId = next;
		this.host.requestRender();
	}

	render(width: number): string[] {
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		const staged = formatStagedAgent(this.state);
		if (entries.length === 0) {
			// Nothing left to navigate; hand focus back instead of trapping the
			// user. Deferred because render itself must stay side-effect free.
			if (this.focused) queueMicrotask(() => this.close());
			return staged ? [truncateToWidth(staged, width, "…")] : [];
		}
		this.ensureCursor(entries);
		const top = this.layoutTopRow(tree, width, staged);
		const lines = [top.line];

		// Child rows: every visible top-level agent's subtree hangs directly
		// beneath it, row-aligned across columns — line N holds the N-th subtree
		// row of every column at once, so a taller sibling column never pushes
		// another column's tree away from its parent.
		const columns = tree.topLevel
			.filter((agent) => top.columns.has(agent.agentId))
			.map((agent) => {
				const placement = top.columns.get(agent.agentId) ?? { start: 0, width: width };
				const descendants = flattenAgentTree({ topLevel: [agent], childrenOf: tree.childrenOf }).filter(
					(entry) => entry.depth > 0,
				);
				const window = this.subtreeWindow(descendants);
				const rows = window.visible.map((entry) => {
					const selected = this.focused && entry.agent.agentId === this.cursorAgentId;
					const agentContent = formatAgent(
						this.state,
						entry.agent,
						entry.agent.agentId === this.state.activeAgentId,
						selected,
					);
					return {
						depth: entry.depth,
						selected,
						agentContent,
						content: `${theme.dim(entry.last ? "└──" : "├──")} ${agentContent}`,
					};
				});
				// The marker counts everything the window leaves out, above and
				// below alike: it says how much more there is, not which way to go.
				if (window.hidden > 0) {
					const marker = theme.dim(`… +${window.hidden}`);
					rows.push({ depth: 1, selected: false, agentContent: marker, content: marker });
				}
				return { placement, rows };
			});
		const height = Math.max(0, ...columns.map((column) => column.rows.length));
		for (let row = 0; row < height; row++) {
			let line = "";
			for (const column of columns) {
				const entry = column.rows[row];
				if (!entry) continue;
				// A column owns its span and nothing beyond it, whether or not the
				// neighbour has a row at this height, so a long label never reads as
				// part of the tree next to it.
				const limit = column.placement.start + column.placement.width - COLUMN_GAP;
				const desiredIndent = column.placement.start + (entry.depth - 1) * TREE_INDENT;
				// Indentation eats the column a level at a time, and the id is at the
				// far end of the line. When the selected row would lose any of it,
				// drop the tree prefix and take the whole column instead: which agent
				// the cursor is on matters more than how deep it sits.
				const compactSelected =
					entry.selected && limit - desiredIndent < TREE_PREFIX_WIDTH + visibleWidth(entry.agentContent);
				const indent = compactSelected ? column.placement.start : desiredIndent;
				if (indent >= limit) continue;
				const padding = indent - visibleWidth(line);
				if (padding < 0) continue;
				line += `${" ".repeat(padding)}${truncateToWidth(
					compactSelected ? entry.agentContent : entry.content,
					Math.max(1, limit - indent),
					"…",
				)}`;
			}
			lines.push(truncateToWidth(line, width, "…"));
		}
		return lines;
	}

	/**
	 * Keep the cursor on an existing entry: after a dispose the cursor falls
	 * back to the active agent, then to the first visible one. Returns false
	 * when no agents remain.
	 */
	private ensureCursor(entries: readonly AgentTreeEntry[]): boolean {
		if (entries.length === 0) {
			this.cursorAgentId = undefined;
			return false;
		}
		if (entries.some((entry) => entry.agent.agentId === this.cursorAgentId)) {
			return true;
		}
		const active = this.state.activeAgentId;
		this.cursorAgentId = entries.some((entry) => entry.agent.agentId === active) ? active : entries[0].agent.agentId;
		return true;
	}

	/**
	 * The top row: one page of top-level columns, each given the same slice of
	 * the width. Even division rather than left packing, so a column keeps its
	 * place when a neighbour's label grows or its agent starts running, and the
	 * subtree under it stays where the eye last found it.
	 */
	private layoutTopRow(
		tree: AgentTree,
		width: number,
		staged?: string,
	): { line: string; columns: Map<string, ColumnPlacement> } {
		const all: StripColumn[] = tree.topLevel.map((agent) => ({
			agentId: agent.agentId,
			label: formatAgent(
				this.state,
				agent,
				agent.agentId === this.state.activeAgentId,
				this.focused && agent.agentId === this.cursorAgentId,
			),
		}));
		if (staged) all.push({ label: staged });

		const first = this.pageStart(tree, all.length);
		const visible = all.slice(first, first + TOP_LEVEL_PAGE_SIZE);
		const hiddenAfter = all.length - first - visible.length;
		const leftIndicator = first > 0 ? theme.dim(`‹${first} `) : "";
		const rightIndicator = hiddenAfter > 0 ? theme.dim(` ${hiddenAfter}›`) : "";
		const origin = visibleWidth(leftIndicator);
		const available = Math.max(visible.length, width - origin - visibleWidth(rightIndicator));
		const columnWidth = Math.floor(available / visible.length);

		const columns = new Map<string, ColumnPlacement>();
		let line = leftIndicator;
		for (const [index, column] of visible.entries()) {
			const last = index === visible.length - 1;
			// The last column absorbs the rounding remainder; every other one is
			// exactly a share wide, which is what keeps the starts predictable.
			const span = last ? available - index * columnWidth : columnWidth;
			const columnStart = origin + index * columnWidth;
			const padding = columnStart - visibleWidth(line);
			if (padding < 0) continue;
			line += `${" ".repeat(padding)}${truncateToWidth(column.label, Math.max(MIN_LABEL_WIDTH, span - COLUMN_GAP), "…")}`;
			if (column.agentId) columns.set(column.agentId, { start: columnStart, width: span });
		}
		if (rightIndicator) {
			line += `${" ".repeat(Math.max(0, width - visibleWidth(rightIndicator) - visibleWidth(line)))}${rightIndicator}`;
		}
		return { line: truncateToWidth(line, width, ""), columns };
	}

	/**
	 * Index of the first column on the page the user is on. Pages are fixed
	 * blocks rather than a window that slides one agent at a time: an agent's
	 * page is a property of where it sits, so paging right and back left returns
	 * the same view.
	 */
	private pageStart(tree: AgentTree, columnCount: number): number {
		const anchor = this.focused ? this.cursorAgentId : this.state.activeAgentId;
		const index = topLevelColumnIndex(tree, anchor);
		// No anchored agent means the staged session is what is on screen, and it
		// is always the last column.
		const column = index >= 0 ? index : columnCount - 1;
		return Math.floor(Math.max(0, column) / TOP_LEVEL_PAGE_SIZE) * TOP_LEVEL_PAGE_SIZE;
	}

	/**
	 * The descendants a column shows: at most MAX_SUBTREE_ROWS of them, as a
	 * window that follows the cursor down. A spawn tree has no bound, and a strip
	 * that grows with it takes the terminal one row at a time.
	 */
	private subtreeWindow(rows: readonly AgentTreeEntry[]): { visible: readonly AgentTreeEntry[]; hidden: number } {
		if (rows.length <= MAX_SUBTREE_ROWS) return { visible: rows, hidden: 0 };
		const cursor = this.focused ? rows.findIndex((entry) => entry.agent.agentId === this.cursorAgentId) : -1;
		const from = Math.min(Math.max(0, cursor - MAX_SUBTREE_ROWS + 1), rows.length - MAX_SUBTREE_ROWS);
		return { visible: rows.slice(from, from + MAX_SUBTREE_ROWS), hidden: rows.length - MAX_SUBTREE_ROWS };
	}
}

/**
 * Position-based cursor movement over the flattened tree. Returns the next
 * cursor agent id, the current id when the move hits an edge, or undefined
 * when "up" leaves the panel from the top row. Horizontal moves hop between
 * top-level columns; a cursor sitting in a subtree first returns to its
 * column's top row.
 */
export function moveAgentCursor(
	tree: AgentTree,
	cursorId: string,
	navigation: AgentPanelNavigation,
): string | undefined {
	const entries = flattenAgentTree(tree);
	const index = entries.findIndex((entry) => entry.agent.agentId === cursorId);
	if (index < 0) return entries[0]?.agent.agentId;
	const entry = entries[index];
	switch (navigation) {
		case "up":
			return entry.depth === 0 ? undefined : entries[index - 1].agent.agentId;
		case "down": {
			// Preorder flattening keeps a column's subtree contiguous: the next
			// entry belongs to this column exactly when it is not top-level.
			const next = entries[index + 1];
			return next && next.depth > 0 ? next.agent.agentId : cursorId;
		}
		case "left":
		case "right": {
			const column = topLevelColumnIndex(tree, cursorId);
			const target = column + (navigation === "left" ? -1 : 1);
			const agent = tree.topLevel[target];
			return agent ? agent.agentId : cursorId;
		}
	}
}

/**
 * Index of the top-level column an agent belongs to: itself when it is
 * top-level, its nearest ancestor above it in the flattened tree otherwise.
 * -1 when the agent is not in the tree.
 */
function topLevelColumnIndex(tree: AgentTree, agentId: string | undefined): number {
	const entries = flattenAgentTree(tree);
	const index = entries.findIndex((entry) => entry.agent.agentId === agentId);
	if (index < 0) return -1;
	for (let cursor = index; cursor >= 0; cursor--) {
		if (entries[cursor].depth === 0) {
			return tree.topLevel.findIndex((agent) => agent.agentId === entries[cursor].agent.agentId);
		}
	}
	return -1;
}

function matchNavigation(keybindings: KeybindingsManager, data: string): AgentPanelNavigation | undefined {
	if (keybindings.matches(data, "tui.select.up")) return "up";
	if (keybindings.matches(data, "tui.select.down")) return "down";
	if (keybindings.matches(data, "app.agents.previous")) return "left";
	if (keybindings.matches(data, "app.agents.next")) return "right";
	return undefined;
}

function formatAgent(state: TuiApplicationState, agent: AgentViewState, active: boolean, selected = false): string {
	const label = agentIdentityLabel(state, agent);
	const statusText =
		agent.status === "running" && agent.maintenance ? maintenanceLabel(agent.maintenance).toLowerCase() : agent.status;
	// How far into the run it is. Only while it runs: after the fact the count
	// says nothing the transcript does not, and a stale one reads as live.
	const progress =
		agent.status === "running" && !agent.maintenance && agent.runToolCount > 0
			? `${statusText} · ${agent.runToolCount} tool_use`
			: statusText;
	const base =
		agent.attention === "human-request"
			? "needs input"
			: agent.unreadCount > 0
				? `${progress} · ${agent.unreadCount} unread`
				: progress;
	const detail = base;
	// Agent-strip statuses mark the agent item itself: just the icon, painted
	// with its tone, one per publishing extension status.
	const markers = extensionStatusesInRegion(agent, "agent-strip").map((entry) =>
		tonePaint(entry.status.tone)(entry.status.icon ?? "✻"),
	);
	const text = `${agentGlyph(agent, active)} ${active ? theme.bold(label) : label} ${theme.dim(detail)}${
		markers.length > 0 ? ` ${markers.join(" ")}` : ""
	}`;
	return selected ? theme.inverse(text) : text;
}

/**
 * The staged session as a column of its own: the profile it will run, and no id
 * because nothing has been created yet. Display only - there is no agent to
 * switch to, so the cursor never reaches it, and it disappears the moment the
 * session is either started or dropped.
 */
function formatStagedAgent(state: TuiApplicationState): string | undefined {
	const staged = state.pendingAgent;
	if (!staged) return undefined;
	return `${theme.ok("●")} ${theme.bold(singleLine(staged.display.profileId, 80))} ${theme.dim("not started")}`;
}

function agentGlyph(agent: AgentViewState, active: boolean): string {
	if (agent.attention === "error") {
		return theme.error("!");
	}
	if (agent.attention === "human-request" || agent.attention === "warning") {
		return theme.warn("!");
	}
	const paint = agent.status === "running" ? theme.info : theme.ok;
	return paint(active ? "●" : "○");
}
