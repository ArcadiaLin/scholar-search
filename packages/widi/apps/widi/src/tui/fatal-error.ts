import { type Component, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { boundedText, singleLine } from "./format.ts";
import { theme } from "./theme/theme.ts";

/**
 * Modal view for the only two overlay-worthy failures: startup without any
 * usable agent and an uncaught fatal application error. Quit exits; View
 * diagnostics closes the overlay and opens the session's diagnostics list.
 */
export class FatalErrorView implements Component {
	focused = false;
	private readonly code: string;
	private readonly message: string;
	private readonly list: SelectList;

	constructor(options: {
		readonly code: string;
		readonly message: string;
		readonly onQuit: () => void;
		readonly onViewDiagnostics: () => void;
	}) {
		this.code = singleLine(options.code, 120);
		this.message = boundedText(options.message, { maxLines: 8, maxCharacters: 1_000 });
		this.list = new SelectList(
			[
				{ value: "quit", label: "Quit" },
				{ value: "diagnostics", label: "View diagnostics" },
			],
			2,
			theme.selectListTheme,
		);
		this.list.onSelect = (item) => {
			if (item.value === "quit") options.onQuit();
			else options.onViewDiagnostics();
		};
		this.list.onCancel = options.onViewDiagnostics;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		// Same family as the other overlays: horizontal rules above and below,
		// no side borders.
		const rule = theme.border("─".repeat(Math.max(1, width)));
		const lines = [rule, "", theme.error("✕ WIDI cannot continue"), theme.dim(this.code)];
		for (const line of this.message.split("\n")) lines.push(line);
		lines.push("", ...this.list.render(width), "", rule);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
