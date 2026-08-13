import {
	type Component,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { theme } from "../theme/theme.ts";
import { type SelectorHintContext, selectorKeyHints } from "./hints.ts";

const MAX_VISIBLE_ITEMS = 10;

export interface ListSelectorOperation {
	readonly description?: string;
	readonly confirmVerb: "apply" | "switch";
}

export interface ListSelectorRequest {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly operation?: ListSelectorOperation;
	/** Index selected when the selector opens (before any filtering). */
	readonly initialIndex?: number;
	/** Pre-filled filter text (a query the submit path already tried). */
	readonly initialFilter?: string;
	onSelect(item: SelectItem): void;
	onCancel?(): void;
	/**
	 * Hides the host dock and restores focus. Runs before onSelect/onCancel so
	 * a callback is free to open another selector.
	 */
	onClose(): void;
}

/**
 * Shared docked selector for picking one candidate out of a list, styled after
 * pi's ModelSelectorComponent: horizontal rules above and below, an Input
 * filter line with a live cursor, → cursor rows carrying an inline dim
 * description, a scroll indicator, and a key-hint footer. Keys that are not
 * selection bindings fall through to the Input, so typing refilters the list
 * in place and jumps to the best match. Mounting is the caller's job: the
 * application docks it in place of the editor through the SelectorDock and
 * wires onClose to close that dock.
 */
export class ListSelector implements Component {
	private readonly request: ListSelectorRequest;
	private readonly input = new Input();
	private filtered: SelectItem[];
	private selectedIndex = 0;
	private closed = false;

	constructor(request: ListSelectorRequest) {
		this.request = request;
		if (request.initialFilter) {
			// Typed through the input rather than setValue so the cursor lands at
			// the end of the pre-filled filter (setValue keeps it at 0).
			this.input.handleInput(request.initialFilter);
		}
		this.filtered = this.filterItems();
		if (request.initialIndex !== undefined) {
			this.selectedIndex = Math.min(Math.max(0, request.initialIndex), Math.max(0, this.filtered.length - 1));
		}
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	get hintContext(): SelectorHintContext | undefined {
		if (this.closed) return undefined;
		const operation = this.request.operation;
		if (!operation) return undefined;
		return {
			title: this.request.title,
			description: operation.description,
			confirmVerb: operation.confirmVerb,
			itemCount: this.filtered.length,
		};
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.confirm();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		// Everything else is filter text: the Input owns the editing keys
		// (backspace, paste, undo), and the refiltered list jumps to the best
		// match while a query is active.
		const before = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query === before) return;
		this.filtered = this.filterItems();
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		if (this.closed) return [];
		const rule = theme.border("─".repeat(Math.max(1, width)));
		const lines = [
			rule,
			"",
			truncateToWidth(theme.title(singleLine(this.request.title, 200)), Math.max(1, width - 2), "…"),
			"",
		];
		lines.push(...this.input.render(width));
		lines.push("");
		const count = this.filtered.length;
		if (count === 0) {
			lines.push(theme.faint("  No matching items"));
		} else {
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2), count - MAX_VISIBLE_ITEMS),
			);
			const end = Math.min(start + MAX_VISIBLE_ITEMS, count);
			for (let i = start; i < end; i++) {
				const item = this.filtered[i];
				if (item) lines.push(this.renderRow(item, i === this.selectedIndex, width));
			}
			if (start > 0 || end < count) lines.push(theme.faint(`  (${this.selectedIndex + 1}/${count})`));
		}
		// Preempted by another docked claimant: the keys listed here would go to
		// whoever took focus, so do not offer them.
		if (this.focused) lines.push("", theme.dim(selectorKeyHints({ filter: true })));
		lines.push(rule);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderRow(item: SelectItem, cursor: boolean, width: number): string {
		const selected = cursor && this.focused;
		const prefix = cursor ? (selected ? theme.selection("→ ") : theme.dim("→ ")) : "  ";
		const label = selected ? theme.selection(singleLine(item.label, 200)) : singleLine(item.label, 200);
		const description = item.description ? ` ${theme.dim(singleLine(item.description, 200))}` : "";
		return truncateToWidth(`${prefix}${label}${description}`, Math.max(1, width), "…");
	}

	private filterItems(): SelectItem[] {
		const query = this.input.getValue();
		return query
			? fuzzyFilter([...this.request.items], query, (item) => `${item.label} ${item.value}`)
			: [...this.request.items];
	}

	private move(delta: number): void {
		const count = this.filtered.length;
		if (count === 0) return;
		// Wrap like pi: up from the first row lands on the last and vice versa.
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private confirm(): void {
		const item = this.filtered[this.selectedIndex];
		if (!item) return;
		this.closed = true;
		this.request.onClose();
		this.request.onSelect(item);
	}

	private cancel(): void {
		this.closed = true;
		this.request.onClose();
		this.request.onCancel?.();
	}
}
