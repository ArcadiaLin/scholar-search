import { type Component, getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { actionKeyLabel } from "../keybindings.ts";
import type { SessionEntryTreeRow } from "../session-tree.ts";
import { theme } from "../theme/theme.ts";
import type { SelectorHintContext } from "./hints.ts";
import { ListSelector } from "./list-selector.ts";
import { TreeSelector } from "./tree-selector.ts";

export interface TreeNavigationRequest {
	readonly title: string;
	/** Preorder rows of the visible agent's session tree (buildSessionEntryRows). */
	readonly rows: readonly SessionEntryTreeRow[];
	/** Row under the cursor when the flow opens; defaults to the current row. */
	readonly initialEntryId?: string;
	/**
	 * The user committed to navigating. onClose has already run, so the
	 * callback is free to open another selector. customInstructions rides along
	 * when the "Summarize with custom prompt" step collected a non-empty text.
	 */
	onNavigate(entryId: string, summarize: boolean, customInstructions?: string): void;
	onCancel?(): void;
	/**
	 * Hides the host dock and restores focus. Runs before onNavigate/onCancel.
	 */
	onClose(): void;
}

type SelectorStep = TreeSelector | ListSelector | CustomInstructionsStep;

/**
 * /tree's navigation flow, after pi's showTreeSelector: pick the target entry
 * in the tree, then answer "Summarize branch?" (No summary / Summarize /
 * Summarize with custom prompt) before the navigation runs. The custom-prompt
 * choice opens a single-line input step; confirming it navigates with those
 * instructions. Escape walks one step back - from the input to the summary
 * step, from there to the tree with the pending row still preselected. The
 * whole flow is one docked component; the steps inside are ordinary selectors
 * whose onClose is intercepted so the dock stays open between steps.
 */
export class TreeNavigationSelector implements Component {
	private readonly request: TreeNavigationRequest;
	private step: SelectorStep;
	private pendingEntryId?: string;
	private closed = false;
	private isFocused = false;

	constructor(request: TreeNavigationRequest) {
		this.request = request;
		this.step = this.buildTreeStep(request.initialEntryId);
	}

	get focused(): boolean {
		return this.step.focused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.step.focused = value;
	}

	get hintContext(): SelectorHintContext | undefined {
		if (this.closed) return undefined;
		return this.step.hintContext;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.step.handleInput?.(data);
	}

	invalidate(): void {
		this.step.invalidate();
	}

	render(width: number): string[] {
		if (this.closed) return [];
		return this.step.render(width);
	}

	// A mid-flow step switch keeps the dock's focus: the new step's input shows
	// its cursor right away instead of waiting for a refocus that never comes.
	private switchStep(step: SelectorStep): void {
		this.step = step;
		this.step.focused = this.isFocused;
	}

	private buildTreeStep(initialEntryId: string | undefined): TreeSelector {
		return new TreeSelector({
			title: this.request.title,
			rows: this.request.rows,
			...(initialEntryId === undefined ? {} : { initialEntryId }),
			onClose: () => {},
			onSelect: (entryId) => {
				this.pendingEntryId = entryId;
				this.switchStep(this.buildSummaryStep());
			},
			onCancel: () => {
				this.closed = true;
				this.request.onClose();
				this.request.onCancel?.();
			},
		});
	}

	private buildSummaryStep(): ListSelector {
		return new ListSelector({
			title: "Summarize branch?",
			items: [
				{ value: "no", label: "No summary", description: "Navigate away without summarizing the branch" },
				{ value: "yes", label: "Summarize", description: "Write a branch summary before navigating" },
				{
					value: "custom",
					label: "Summarize with custom prompt",
					description: "Guide the summary with your own instructions",
				},
			],
			operation: { confirmVerb: "apply" },
			onClose: () => {},
			onSelect: (item) => {
				if (item.value === "custom") {
					this.switchStep(this.buildCustomStep());
					return;
				}
				this.commit(item.value === "yes");
			},
			onCancel: () => {
				// pi re-shows the tree with the pending row preselected.
				this.switchStep(this.buildTreeStep(this.pendingEntryId));
			},
		});
	}

	private buildCustomStep(): CustomInstructionsStep {
		return new CustomInstructionsStep({
			onSubmit: (instructions) => this.commit(true, instructions),
			onCancel: () => {
				this.switchStep(this.buildSummaryStep());
			},
		});
	}

	private commit(summarize: boolean, customInstructions?: string): void {
		const entryId = this.pendingEntryId;
		if (entryId === undefined) return;
		this.closed = true;
		this.request.onClose();
		this.request.onNavigate(entryId, summarize, customInstructions);
	}
}

interface CustomInstructionsRequest {
	/** Enter on a non-empty line; blank falls back to a plain summary. */
	onSubmit(instructions: string | undefined): void;
	/** Escape back to the summary step. */
	onCancel(): void;
}

/**
 * The "Summarize with custom prompt" input step: a titled single-line Input
 * with the same horizontal rules as the selector family. pi opens a full
 * editor overlay here; a one-line field covers the common instruction.
 */
class CustomInstructionsStep implements Component {
	private readonly request: CustomInstructionsRequest;
	private readonly input = new Input();

	constructor(request: CustomInstructionsRequest) {
		this.request = request;
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	/** No list under the cursor, so the operation hint line stays quiet. */
	get hintContext(): SelectorHintContext | undefined {
		return undefined;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			const text = this.input.getValue().trim();
			this.request.onSubmit(text === "" ? undefined : text);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.request.onCancel();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const rule = theme.border("─".repeat(Math.max(1, width)));
		const confirm = actionKeyLabel("tui.select.confirm");
		const cancel = actionKeyLabel("tui.select.cancel");
		const hints = [confirm && `${confirm} apply`, cancel && `${cancel} back`]
			.filter((part): part is string => Boolean(part))
			.join("  ");
		const lines = [
			rule,
			"",
			truncateToWidth(theme.title("Custom summarization instructions"), Math.max(1, width - 2), "…"),
			"",
			...this.input.render(width),
			"",
			theme.dim(singleLine("Guides the branch summary written before navigating.", 200)),
		];
		// Preempted: the keys would go to whoever took focus, so do not offer them.
		if (this.focused) lines.push("", theme.dim(hints));
		lines.push(rule);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
