import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import { boundedText, formatUnknown, sanitizeTerminalText } from "./format.ts";
import type { CommandResultItem } from "./state.ts";
import { theme } from "./theme/theme.ts";

export interface PresentCommandOptions {
	/** Show full output instead of the collapsed preview (ctrl+o toggle). */
	readonly expanded?: boolean;
}

// --- Presenter contract -----------------------------------------------------
//
// A presenter renders one completed command-result timeline item, mirroring
// the tool presenter contract. "lines" is the default form: a stateless pure
// function, so the per-item render cache keeps working unchanged. "component"
// is opt-in for rows that need interaction; the timeline layer (ChatView) owns
// its per-commandId instance cache: the factory runs once per result, updates
// are fed through update() as the item changes, and dispose() runs when the
// row leaves the timeline or the view switches agents.
//
// Only the completed state is presentable: the shared frame owns the running
// (`/name …`) and failed (`/name error`) rows, so a presenter never has to
// repeat them.

/** Context the timeline layer hands a component factory. */
export interface CommandRowContext {
	/** Transcript-wide expanded state (ctrl+o toggle). */
	readonly expanded: boolean;
}

/**
 * A stateful command-result row. update() is fed the latest item if the row
 * changes under a live component; dispose() runs when the row is dropped.
 */
export type CommandRowComponent = Component & {
	update?(item: CommandResultItem, context: CommandRowContext): void;
	dispose?(): void;
};

export type CommandPresenter =
	| {
			readonly kind: "lines";
			present(item: CommandResultItem, width: number, options: PresentCommandOptions): string[];
	  }
	| { readonly kind: "component"; factory(item: CommandResultItem, context: CommandRowContext): CommandRowComponent };

/**
 * Render a command-result timeline item. The frame owns the running and
 * failed states; a completed result goes to the registered presenter, falling
 * back to the command's formatResult display (or the raw result value).
 */
export function presentCommandResult(
	item: CommandResultItem,
	width: number,
	options: PresentCommandOptions = {},
): string[] {
	const usableWidth = Math.max(8, width);
	if (item.status === "running") {
		return [theme.dim(`/${item.name} …`)];
	}
	if (item.status === "failed") {
		return [
			truncateToWidth(
				`${theme.dim(`/${item.name}`)} ${theme.severityPaint("error")(item.error?.message ?? "command failed")}`,
				usableWidth,
				"…",
			),
		];
	}
	const presenter = lookupCommandPresenter(item.name);
	if (presenter?.kind === "lines") {
		return presenter.present(item, usableWidth, options);
	}
	// A component presenter is instantiated by the timeline layer (ChatView);
	// anywhere else the row degrades to the generic fallback.
	return fallbackLines(item, usableWidth, options);
}

/**
 * The unregistered rendering, in the same frame a registered presenter builds
 * from: the outcome glyph, the name, and the answer. A one-line answer rides
 * the headline - a command whose whole result is "Theme set to prism" should
 * not cost two rows - and anything longer becomes the dim body under it.
 *
 * A command that answers with nothing renders nothing, and the row disappears.
 * That is a command's own choice to make (/exit has nowhere to draw), so it is
 * left as one rather than forced into an empty frame here.
 */
function fallbackLines(item: CommandResultItem, width: number, options: PresentCommandOptions): string[] {
	const answer = item.display ?? (item.result === undefined ? undefined : formatUnknown(item.result));
	if (answer === undefined) return [];
	const text = options.expanded ? sanitizeTerminalText(answer) : boundedText(answer);
	const lines = text.split("\n");
	if (lines.length <= 1) {
		const suffix = lines[0]?.trim();
		return [truncateToWidth(commandHeadline(item.name, suffix ? ` ${suffix}` : undefined), width, "…")];
	}
	return [
		truncateToWidth(commandHeadline(item.name), width, "…"),
		...lines.map((line) => theme.dim(truncateToWidth(line, width, "…"))),
	];
}

// --- Shared row idioms ------------------------------------------------------
//
// The completed-row headline matches the tool rows: an ok glyph, an accent
// `/name`, and a dim suffix. A lines presenter composes it with an optional
// dim preview instead of re-deriving the paint.

export function commandHeadline(name: string, suffix?: string): string {
	return `${theme.ok("✓")} ${theme.bold(theme.command(`/${name}`))}${suffix ? theme.dim(suffix) : ""}`;
}

/** Dim preview body with collapsed/expanded line budgets, after the tool rows. */
export function commandPreviewLines(
	text: string,
	width: number,
	options: PresentCommandOptions,
	budget: { readonly collapsed: number; readonly expanded: number },
): string[] {
	const limit = (options.expanded ?? false) ? budget.expanded : budget.collapsed;
	if (limit <= 0) return [];
	const lines = sanitizeTerminalText(text)
		.split("\n")
		.filter((line, index, all) => line.trim() !== "" || index < all.length - 1);
	const shown = lines.slice(0, limit);
	const rendered = shown.map((line) => theme.dim(truncateToWidth(line, width, "…")));
	const hidden = lines.length - shown.length;
	if (hidden > 0) rendered.push(theme.dim(`… +${hidden} lines`));
	return rendered;
}

// --- Registry ---------------------------------------------------------------
//
// Command presenters ride on the command definitions: CommandEngine.register
// syncs an action command's presenter here, so built-ins and host-registered
// commands share the one lookup path. Registration through the engine already
// refuses name conflicts, so this map never sees a collision.

const registeredPresenters = new Map<string, CommandPresenter>();

/** The presenter a command name resolves to, if any. */
export function lookupCommandPresenter(name: string): CommandPresenter | undefined {
	return registeredPresenters.get(name);
}

/**
 * Register a presenter for a command name. Replacing a live registration is
 * reported, not silent - the engine refuses command name conflicts outright,
 * so a replace here means a host presenter shadows a command's own.
 */
export function registerCommandPresenter(
	name: string,
	presenter: CommandPresenter,
): OrchestratorDiagnostic | undefined {
	const replaced = registeredPresenters.has(name);
	registeredPresenters.set(name, presenter);
	if (!replaced) return undefined;
	return {
		severity: "warning",
		code: "command_presenter.overridden",
		message: `The registered presenter for command "/${name}" replaces the previous one.`,
	};
}

/** Drop a registration; returns whether one was present. */
export function unregisterCommandPresenter(name: string): boolean {
	return registeredPresenters.delete(name);
}

/** Helper for presenters that interpret their command's result record. */
export function resultRecord(result: unknown): Record<string, unknown> | undefined {
	return typeof result === "object" && result !== null && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: undefined;
}
