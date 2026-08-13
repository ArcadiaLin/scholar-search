import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { CommandEngine } from "../commands/engine.ts";
import type { SelectorHintContext } from "../selectors/hints.ts";
import type { TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import type { WidiEditor } from "./editor.ts";
import { operationHintKeys, resolveOperationHintDetail } from "./utils/operation-hint.ts";

/** The row under the footer that names the keys the current situation accepts. */
export class OperationHintView implements Component {
	private readonly state: TuiApplicationState;
	private readonly engine: CommandEngine;
	private readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
	private readonly selectorHint: () => SelectorHintContext | undefined;

	constructor(options: {
		readonly state: TuiApplicationState;
		readonly engine: CommandEngine;
		readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
		readonly selectorHint: () => SelectorHintContext | undefined;
	}) {
		this.state = options.state;
		this.engine = options.engine;
		this.editor = options.editor;
		this.selectorHint = options.selectorHint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const detail = resolveOperationHintDetail({
			state: this.state,
			engine: this.engine,
			editorText: this.editor.getText(),
			editorAutocompleteVisible: this.editor.isShowingAutocomplete(),
			selector: this.selectorHint(),
			keys: operationHintKeys(),
		});
		// The working line prints the run hint beside what the run is doing; the
		// same keys a row further down would be the only thing on screen twice.
		// Segments stay either way: they are not about the run.
		const hintText = !detail || detail.kind === "run" || detail.kind === "maintenance" ? undefined : detail.text;
		const parts = [hintText, ...this.state.segments.texts("operationHint")].filter(
			(part): part is string => part !== undefined,
		);
		if (parts.length === 0) return [];
		return [theme.dim(truncateToWidth(parts.join(" · "), width, "…"))];
	}
}
