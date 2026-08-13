import { type Component, Text } from "@earendil-works/pi-tui";
import { fixCjkLineStarts } from "../cjk-wrap.ts";
import { lookupCommandPresenter } from "../command-presenter.ts";
import {
	activeAgent,
	type CommandResultItem,
	type TimelineItem,
	type ToolExecutionItem,
	type TuiApplicationState,
} from "../state.ts";
import { theme, themeGeneration } from "../theme/theme.ts";
import { lookupToolPresenter } from "../tool-presenter.ts";
import { renderDeps, renderTimelineItem, type TimelineRenderContext } from "./utils/timeline-item.ts";

interface CachedItemRender {
	readonly deps: readonly unknown[];
	readonly width: number;
	readonly lines: string[];
}

/** The component contract every row presenter (tool or command) satisfies. */
interface RowComponent<Item> extends Component {
	update?(item: Item, context: { expanded: boolean }): void;
	dispose?(): void;
}

/**
 * One live component-presenter row (parity §4.3-2, component form). The
 * instance outlives individual renders: a changed item is fed through
 * update() instead of rebuilding the component, while the rendered lines
 * still ride the same deps cache as every other item.
 */
interface ComponentRow<Item> {
	readonly component: RowComponent<Item>;
	item: Item;
	expanded: boolean;
	cached?: CachedItemRender;
}

/** Live component rows keyed by the item's stable id, one cache per presenter family. */
class ComponentRowCache<Item> {
	private readonly rows = new Map<string, ComponentRow<Item>>();

	/**
	 * Render through the live instance: created on first sight, updated in
	 * place as the item changes, rendered through the same deps cache as the
	 * pure items. A factory, update, or render that throws degrades to the
	 * lines fallback for that frame.
	 */
	render(
		id: string,
		item: Item,
		factory: (item: Item, context: { expanded: boolean }) => RowComponent<Item>,
		expanded: boolean,
		width: number,
		deps: readonly unknown[],
		fallback: () => string[],
	): string[] {
		let row = this.rows.get(id);
		if (!row) {
			let component: RowComponent<Item>;
			try {
				component = factory(item, { expanded });
			} catch {
				return fallback();
			}
			row = { component, item, expanded };
			this.rows.set(id, row);
		} else if (row.item !== item || row.expanded !== expanded) {
			try {
				row.component.update?.(item, { expanded });
			} catch {
				return fallback();
			}
			row.item = item;
			row.expanded = expanded;
		}

		const cached = row.cached;
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		let lines: string[];
		try {
			lines = row.component.render(width);
		} catch {
			return fallback();
		}
		row.cached = { deps, width, lines: fixCjkLineStarts(lines, width) };
		return row.cached.lines;
	}

	/** Dispose instances whose item id left the timeline (windowing, trims). */
	retain(ids: ReadonlySet<string>): void {
		for (const [id, row] of this.rows) {
			if (!ids.has(id)) {
				row.component.dispose?.();
				this.rows.delete(id);
			}
		}
	}

	/** Drop the line caches but keep the live component instances. */
	clearLineCaches(): void {
		for (const row of this.rows.values()) row.cached = undefined;
	}

	disposeAll(): void {
		for (const row of this.rows.values()) row.component.dispose?.();
		this.rows.clear();
	}
}

export class ChatView implements Component {
	private readonly state: TuiApplicationState;
	private readonly itemCache = new Map<string, CachedItemRender>();
	/** Component-presenter instances, tool rows by toolCallId. */
	private readonly toolRows = new ComponentRowCache<ToolExecutionItem>();
	/** Component-presenter instances, command rows by commandId. */
	private readonly commandRows = new ComponentRowCache<CommandResultItem>();
	private cachedAgentId?: string;
	private cachedThemeGeneration?: number;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// renderDeps cannot see a theme switch (the paints change underneath an
		// unchanged item), so the generation guards the whole cache instead.
		const generation = themeGeneration();
		if (generation !== this.cachedThemeGeneration) {
			this.itemCache.clear();
			this.toolRows.clearLineCaches();
			this.commandRows.clearLineCaches();
			this.cachedThemeGeneration = generation;
		}
		const agent = activeAgent(this.state);
		const pending = this.state.pendingAgent;
		if (!agent && !pending) {
			return new Text(theme.dim("Preparing the first agent…"), 1, 1).render(width);
		}
		const timeline = agent?.timeline ?? pending?.timeline ?? [];
		const viewId = agent?.agentId ?? "pending";
		if (viewId !== this.cachedAgentId) {
			this.itemCache.clear();
			this.toolRows.disposeAll();
			this.commandRows.disposeAll();
			this.cachedAgentId = viewId;
		}

		const liveThinkingIds = new Set<string>();
		const livePreparingAssistantIds = new Set<string>();
		const seenToolCallIds = new Set<string>();
		const seenCommandIds = new Set<string>();
		for (const item of timeline) {
			if (item.type === "thinking-status" && item.status === "thinking") {
				liveThinkingIds.add(item.id);
			} else if (item.type === "tool-execution") {
				if (item.status === "preparing" && item.sourceAssistantId) {
					livePreparingAssistantIds.add(item.sourceAssistantId);
				}
				seenToolCallIds.add(item.toolCallId);
			} else if (item.type === "command-result") {
				seenCommandIds.add(item.commandId);
			}
		}
		// Windowing (or any trim) dropped the row: dispose the live instance.
		// This runs before the empty-timeline early return on purpose.
		this.toolRows.retain(seenToolCallIds);
		this.commandRows.retain(seenCommandIds);
		if (timeline.length === 0) {
			return new Text(theme.dim("Ask WIDI to inspect, explain, or change this workspace."), 1, 1).render(width);
		}
		const context: TimelineRenderContext = {
			liveThinkingIds,
			livePreparingAssistantIds,
			toolOutputExpanded: this.state.toolOutputExpanded,
		};

		const lines: string[] = [];
		const seen = new Set<string>();
		for (const item of timeline) {
			const key = `${item.type}:${item.id}`;
			seen.add(key);
			const rendered = this.renderItem(item, width, context, key);
			if (rendered.length === 0) continue;
			// Exactly one unpainted line between two items. The air inside a block
			// belongs to the block - a painted row carries its own edge lines, so
			// adding more here would put uncolored gaps inside the color.
			if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
			lines.push(...rendered);
		}
		for (const key of this.itemCache.keys()) {
			if (!seen.has(key)) this.itemCache.delete(key);
		}
		return lines;
	}

	/**
	 * Timeline items keep a stable identity, so historical Markdown parsing and
	 * wrapping only reruns when an item's render-relevant facts change.
	 */
	private renderItem(item: TimelineItem, width: number, context: TimelineRenderContext, key: string): string[] {
		if (item.type === "tool-execution") {
			const presenter = lookupToolPresenter(item.toolName);
			if (presenter?.kind === "component") {
				return this.toolRows.render(
					item.toolCallId,
					item,
					presenter.factory,
					item.expanded ?? context.toolOutputExpanded,
					width,
					renderDeps(item, context),
					() => this.renderPureItem(item, width, context, key),
				);
			}
		}
		// Only a completed command result is presentable; running and failed
		// rows always go through the shared frame inside presentCommandResult.
		if (item.type === "command-result" && item.status === "completed") {
			const presenter = lookupCommandPresenter(item.name);
			if (presenter?.kind === "component") {
				return this.commandRows.render(
					item.commandId,
					item,
					presenter.factory,
					context.toolOutputExpanded,
					width,
					renderDeps(item, context),
					() => this.renderPureItem(item, width, context, key),
				);
			}
		}
		return this.renderPureItem(item, width, context, key);
	}

	/** The pure lines rendering of any timeline item, cached per item key. */
	private renderPureItem(item: TimelineItem, width: number, context: TimelineRenderContext, key: string): string[] {
		const deps = renderDeps(item, context);
		const cached = this.itemCache.get(key);
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		const lines = fixCjkLineStarts(renderTimelineItem(item, width, context), width);
		this.itemCache.set(key, { deps, width, lines });
		return lines;
	}
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
