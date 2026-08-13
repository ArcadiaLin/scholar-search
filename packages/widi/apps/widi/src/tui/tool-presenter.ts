import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import { renderDiffText } from "./diff.ts";
import { formatElapsed, formatUnknown, sanitizeTerminalText, singleLine, spinnerFrame } from "./format.ts";
import type { ToolExecutionItem } from "./state.ts";
import { theme } from "./theme/theme.ts";

const SUCCESS_PREVIEW_LINES = 4;
const ERROR_PREVIEW_LINES = 8;
const COLLAPSED_DIFF_LINES = 8;
const EXPANDED_PREVIEW_LINES = 400;
const PREVIEW_MAX_CHARACTERS = 1_600;
const EXPANDED_MAX_CHARACTERS = 40_000;

export interface PresentToolOptions {
	/** Show full output instead of the collapsed preview (ctrl+o toggle). */
	readonly expanded?: boolean;
}

// --- Presenter contract (parity plan §4.3-2) --------------------------------
//
// A presenter renders one tool-execution timeline item. "lines" is the
// default form: a stateless pure function, so hydration, windowing, and the
// per-item render cache all keep working unchanged. "component" is opt-in for
// tool rows that need interaction; the timeline layer (ChatView) owns its
// per-toolCallId instance cache: the factory runs once per call, updates are
// fed through update() as the item changes, and dispose() runs when the row
// leaves the timeline (windowing) or the view switches agents.

/** Semantic headline of a tool call: an accent verb plus a plain target. */
export interface ToolCallHeadline {
	readonly verb: string;
	readonly target: string;
}

/** Preview body override for a successful run. */
export interface ToolPreviewLines {
	readonly lines: readonly string[];
	/** Line budget collapsed / expanded; 0 collapsed shows the headline only. */
	readonly limit: { readonly collapsed: number; readonly expanded: number };
	/** Lines carry their own paint (e.g. a diff); skip the default dim. */
	readonly styled?: boolean;
}

/** What a successful run adds to the row beyond the bare headline. */
export interface ToolSuccessPresentation {
	/** Dimmed headline suffix, e.g. " · 3 entries". */
	readonly suffix?: string;
	/** Preview override; absent, the dimmed result text is previewed. */
	readonly preview?: ToolPreviewLines;
}

/**
 * Declarative spec the shared lines frame renders: the per-tool table entry
 * carries the headline description and the success presentation, while the
 * frame owns glyphs, budgets, truncation, and the preparing/cancelled/error
 * paths.
 */
export interface LinesToolPresenterSpec {
	describe(args: unknown): ToolCallHeadline;
	success?(item: ToolExecutionItem, resultLines: readonly string[]): ToolSuccessPresentation;
}

/** Context the timeline layer hands a component factory. */
export interface ToolRowContext {
	/** Per-item expanded state maintained by the timeline layer. */
	readonly expanded: boolean;
}

/**
 * A stateful tool row. update() is fed the latest item as the timeline entry
 * changes under a live row (stream transitions replace the item object);
 * dispose() runs when the row is dropped from the view.
 */
export type ToolRowComponent = Component & {
	update?(item: ToolExecutionItem, context: ToolRowContext): void;
	dispose?(): void;
};

export type ToolPresenter =
	| { readonly kind: "lines"; present(item: ToolExecutionItem, width: number, options: PresentToolOptions): string[] }
	| { readonly kind: "component"; factory(item: ToolExecutionItem, context: ToolRowContext): ToolRowComponent };

/**
 * Render a tool execution as a semantic headline plus a bounded result
 * preview, through the presenter registry. Registered tools get their
 * presenter; unknown tools fall back to compact key-value arguments instead
 * of raw JSON.
 */
export function presentToolExecution(
	item: ToolExecutionItem,
	width: number,
	options: PresentToolOptions = {},
): string[] {
	const presenter = lookupToolPresenter(item.toolName);
	if (presenter?.kind === "lines") return presenter.present(item, width, options);
	// A component presenter is instantiated by the timeline layer (ChatView);
	// anywhere else the row degrades to the generic lines fallback.
	return presentLines(item, width, options, {
		describe: () => ({ verb: item.toolName, target: compactArguments(item.args) }),
	});
}

// --- Registry ---------------------------------------------------------------
//
// Resolution order: host-registered presenter, then the built-in table, then
// the generic fallback. The built-in tools dogfood the same lines contract;
// there is no privileged path.

const registeredPresenters = new Map<string, ToolPresenter>();

/** The presenter a tool name resolves to, if any (registered, then built-in). */
export function lookupToolPresenter(toolName: string): ToolPresenter | undefined {
	return registeredPresenters.get(toolName) ?? builtInPresenters.get(toolName);
}

/**
 * Register a presenter for a tool name. Overriding a built-in takes effect
 * but is reported, not silent; re-registering a host name replaces it.
 */
export function registerToolPresenter(toolName: string, presenter: ToolPresenter): OrchestratorDiagnostic | undefined {
	registeredPresenters.set(toolName, presenter);
	if (!builtInPresenters.has(toolName)) return undefined;
	return {
		severity: "warning",
		code: "tool_presenter.overridden",
		message: `The registered presenter for tool "${toolName}" overrides the built-in one.`,
	};
}

/** Drop a host registration; a shadowed built-in becomes visible again. */
export function unregisterToolPresenter(toolName: string): boolean {
	return registeredPresenters.delete(toolName);
}

/** Build a lines presenter from its per-tool spec. */
export function defineLinesPresenter(spec: LinesToolPresenterSpec): ToolPresenter {
	return { kind: "lines", present: (item, width, options) => presentLines(item, width, options, spec) };
}

/**
 * How long the call took, or has been taking. Under a second is left off: a
 * row that finished instantly gains nothing from a "0s", and every tool row
 * carrying one would bury the ones that are actually slow.
 */
function toolDuration(item: ToolExecutionItem): string {
	if (!item.startedAt) return "";
	const startedAt = Date.parse(item.startedAt);
	const endedAt = item.endedAt ? Date.parse(item.endedAt) : Date.now();
	const elapsed = endedAt - startedAt;
	if (!Number.isFinite(elapsed) || elapsed < 1_000) return "";
	return ` · ${formatElapsed(elapsed)}`;
}

/**
 * Shared lines frame: semantic headline plus a bounded result preview. The
 * per-tool spec supplies the headline and the success presentation; glyphs,
 * budgets, truncation, and the preparing/cancelled/error paths live here.
 */
function presentLines(
	item: ToolExecutionItem,
	width: number,
	options: PresentToolOptions,
	spec: LinesToolPresenterSpec,
): string[] {
	const expanded = options.expanded ?? false;
	const { verb, target } = spec.describe(item.args);

	// Streamed tool calls appear before execution starts; a call whose run
	// ended first is cancelled. Neither has a result to preview.
	if (item.status === "preparing" || item.status === "cancelled") {
		const verbText = singleLine(verb, 80);
		const targetText = target ? ` ${singleLine(target, 400)}` : "";
		const headline =
			item.status === "preparing"
				? `${theme.info(spinnerFrame())} ${theme.bold(theme.info(verbText))}${targetText} ${theme.dim("preparing…")}`
				: `${theme.muted("⊘")} ${theme.dim(`${verbText}${targetText}`)}`;
		return [truncateToWidth(headline, Math.max(8, width), "…")];
	}

	const glyph = item.status === "running" ? theme.info("●") : item.isError ? theme.error("✕") : theme.ok("✓");

	const resultText = item.status === "running" ? toolResultText(item.partialResult) : toolResultText(item.result);
	const maxCharacters = expanded ? EXPANDED_MAX_CHARACTERS : PREVIEW_MAX_CHARACTERS;
	const resultLines = resultText
		? sanitizeTerminalText(resultText)
				.slice(0, maxCharacters)
				.split("\n")
				.filter((line, index, all) => line.trim() !== "" || index < all.length - 1)
		: [];

	const completedOk = item.status === "completed" && !item.isError;
	const success = completedOk ? spec.success?.(item, resultLines) : undefined;

	const headline = `${glyph} ${theme.bold(theme.info(singleLine(verb, 80)))}${
		target ? ` ${singleLine(target, 400)}` : ""
	}${success?.suffix ? theme.dim(success.suffix) : ""}${theme.dim(toolDuration(item))}`;
	const lines = [truncateToWidth(headline, Math.max(8, width), "…")];

	// Errors preview the raw result text. A success spec may override the
	// preview (a diff, the written content, a collapse-to-count); the default
	// is the dimmed result text.
	let preview: readonly string[];
	let previewLimit: number;
	let styleLine: (line: string) => string;
	if (item.isError) {
		preview = resultLines;
		previewLimit = expanded ? EXPANDED_PREVIEW_LINES : ERROR_PREVIEW_LINES;
		styleLine = (line) => line;
	} else if (success?.preview) {
		preview = success.preview.lines;
		previewLimit = expanded ? success.preview.limit.expanded : success.preview.limit.collapsed;
		styleLine = success.preview.styled ? (line) => line : theme.dim;
	} else {
		preview = resultLines;
		previewLimit = expanded ? EXPANDED_PREVIEW_LINES : SUCCESS_PREVIEW_LINES;
		styleLine = theme.dim;
	}

	if (previewLimit > 0 && preview.length > 0) {
		const shown = preview.slice(0, previewLimit);
		for (const line of shown) {
			lines.push(styleLine(truncateToWidth(line, Math.max(8, width), "…")));
		}
		const hidden = preview.length - shown.length;
		if (hidden > 0) lines.push(theme.dim(`… +${hidden} lines`));
	}
	return lines;
}

// --- Built-in table -----------------------------------------------------------

/** ls/read/find collapse a successful result to a count of its lines. */
function countSuffixPresenter(unit: string, describe: (args: unknown) => ToolCallHeadline): ToolPresenter {
	return defineLinesPresenter({
		describe,
		success: (_item, resultLines) => ({
			suffix: resultLines.length > 0 ? ` · ${countLines(resultLines)} ${unit}` : undefined,
			preview: { lines: resultLines, limit: { collapsed: 0, expanded: EXPANDED_PREVIEW_LINES } },
		}),
	});
}

const builtInPresenters = new Map<string, ToolPresenter>([
	[
		"ls",
		countSuffixPresenter("entries", (args) => ({ verb: "List", target: stringField(argRecord(args), "path") ?? "." })),
	],
	[
		"read",
		countSuffixPresenter("lines", (args) => {
			const record = argRecord(args);
			return { verb: "Read", target: joinParts(stringField(record, "path"), readRange(record)) };
		}),
	],
	[
		"bash",
		defineLinesPresenter({
			describe: (args) => ({ verb: "Bash", target: stringField(argRecord(args), "command") ?? "" }),
		}),
	],
	[
		"grep",
		defineLinesPresenter({
			describe: (args) => {
				const record = argRecord(args);
				const pattern = stringField(record, "pattern") ?? "";
				const path = stringField(record, "path");
				const glob = stringField(record, "glob");
				return { verb: "Grep", target: joinParts(pattern, path && `in ${path}`, glob && `[${glob}]`) };
			},
		}),
	],
	[
		"find",
		countSuffixPresenter("matches", (args) => {
			const record = argRecord(args);
			const pattern = stringField(record, "pattern") ?? "";
			const path = stringField(record, "path");
			return { verb: "Find", target: joinParts(pattern, path && `in ${path}`) };
		}),
	],
	[
		"edit",
		defineLinesPresenter({
			describe: (args) => {
				const record = argRecord(args);
				const edits = Array.isArray(record.edits) ? record.edits.length : undefined;
				return {
					verb: "Edit",
					target: joinParts(
						stringField(record, "path"),
						edits !== undefined && `(${edits} ${edits === 1 ? "edit" : "edits"})`,
					),
				};
			},
			success: (item) => {
				const diff = editDiffText(item);
				if (diff === undefined) return {};
				return {
					preview: {
						lines: renderDiffText(sanitizeTerminalText(diff)),
						limit: { collapsed: COLLAPSED_DIFF_LINES, expanded: EXPANDED_PREVIEW_LINES },
						styled: true,
					},
				};
			},
		}),
	],
	[
		"write",
		defineLinesPresenter({
			describe: (args) => ({ verb: "Write", target: stringField(argRecord(args), "path") ?? "" }),
			success: (item) => {
				const written = writeContentLines(item.args);
				if (written === undefined) return {};
				return {
					suffix: ` · ${written.length} ${written.length === 1 ? "line" : "lines"}`,
					preview: { lines: written, limit: { collapsed: 0, expanded: EXPANDED_PREVIEW_LINES } },
				};
			},
		}),
	],
]);

/** The display diff the edit tool attaches to its result, if present. */
function editDiffText(item: ToolExecutionItem): string | undefined {
	const result = item.result;
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return undefined;
	}
	const details = (result as { details?: unknown }).details;
	if (!isRecord(details)) return undefined;
	return typeof details.diff === "string" ? details.diff : undefined;
}

function writeContentLines(args: unknown): string[] | undefined {
	if (!isRecord(args)) return undefined;
	const content = args.content;
	if (typeof content !== "string") return undefined;
	return sanitizeTerminalText(content).slice(0, EXPANDED_MAX_CHARACTERS).split("\n");
}

function readRange(record: Record<string, unknown>): string | undefined {
	const offset = numberField(record, "offset");
	const limit = numberField(record, "limit");
	const start = offset ?? 1;
	if (limit !== undefined) return `${start}–${start + limit - 1}`;
	if (offset !== undefined) return `${start}–`;
	return undefined;
}

function compactArguments(args: unknown): string {
	if (args === undefined) return "";
	if (!isRecord(args)) return singleLine(formatUnknown(args), 120);
	const parts = Object.entries(args)
		.slice(0, 4)
		.map(([key, value]) => `${key}: ${compactValue(value)}`);
	return parts.join(", ");
}

function compactValue(value: unknown): string {
	if (typeof value === "string") return singleLine(value, 60);
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length}]`;
	return "…";
}

function countLines(lines: readonly string[]): number {
	return lines.filter((line) => line.trim() !== "").length;
}

function joinParts(...parts: (string | false | undefined)[]): string {
	return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function argRecord(args: unknown): Record<string, unknown> {
	return isRecord(args) ? args : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the text content of a tool result message or fall back to JSON. */
export function toolResultText(result: unknown): string {
	if (result === undefined) return "";
	if (typeof result !== "object" || result === null || !("content" in result)) {
		return formatUnknown(result);
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return formatUnknown(result);
	const text = content
		.filter(
			(item): item is { type: "text"; text: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
	// A valid content array with no text yet (e.g. a quiet running command) is
	// "no output", not a malformed result to dump as JSON.
	return text;
}
