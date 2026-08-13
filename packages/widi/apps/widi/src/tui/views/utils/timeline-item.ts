import { getKeybindings, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionMessage } from "../../../core/extension/api.ts";
import { presentCommandResult } from "../../command-presenter.ts";
import { renderDiffText } from "../../diff.ts";
import {
	type BuiltInExtensionMessage,
	type ExtensionFieldsMessage,
	type ExtensionTableMessage,
	MAX_EXTENSION_MESSAGE_CELL_BYTES,
	parseBuiltInMessage,
} from "../../extension-host/presentation.ts";
import { renderExtensionEntry, renderExtensionMessageBody } from "../../extension-host/renderers.ts";
import { boundedText, sanitizeTerminalText, singleLine, spinnerFrame } from "../../format.ts";
import { formatKeyLabel } from "../../keybindings.ts";
import { diagnosticGlyph } from "../../labels.ts";
import type { CommandResultItem, TimelineItem, ToolExecutionItem } from "../../state.ts";
import { theme } from "../../theme/theme.ts";
import { presentToolExecution } from "../../tool-presenter.ts";
import { tonePaint } from "./extension-status.ts";

export interface TimelineRenderContext {
	readonly liveThinkingIds: ReadonlySet<string>;
	readonly livePreparingAssistantIds: ReadonlySet<string>;
	readonly toolOutputExpanded: boolean;
}

/**
 * The render-relevant facts of a timeline item. ChatView caches rendered
 * lines per item and only re-renders when these change, so this list must
 * cover every input renderTimelineItem reads.
 */
export function renderDeps(item: TimelineItem, context: TimelineRenderContext): readonly unknown[] {
	switch (item.type) {
		case "user-message":
			return [item.text, context.toolOutputExpanded];
		case "orchestrator-message":
			return [item.text, item.source.kind, item.source.label, item.editedByHuman, context.toolOutputExpanded];
		case "assistant-message": {
			const liveThinking = context.liveThinkingIds.has(`${item.id}:thinking`);
			const livePreparing = context.livePreparingAssistantIds.has(item.id);
			const showsSpinner = item.streaming && !/\S/u.test(item.text) && !liveThinking && !livePreparing;
			// The streaming placeholder spins, so the cache must expire per frame.
			return [
				item.text,
				item.streaming,
				item.message?.stopReason,
				item.message?.errorMessage,
				liveThinking,
				livePreparing,
				...(showsSpinner ? [spinnerTick()] : []),
			];
		}
		case "tool-execution":
			// The preparing glyph spins and a running row's duration counts up, so
			// the cache must expire with each of them.
			return [
				item.status,
				item.isError,
				item.toolName,
				item.args,
				item.partialResult,
				item.result,
				item.expanded,
				item.endedAt,
				context.toolOutputExpanded,
				...(item.status === "preparing" ? [spinnerTick()] : []),
				...(item.status === "running" ? [secondTick()] : []),
			];
		case "thinking-status":
			// The spinner and the rolling preview both animate while thinking.
			return [item.status, item.preview, ...(item.status === "thinking" ? [spinnerTick()] : [])];
		case "command-result":
			return [item.status, item.result, item.error, item.display, context.toolOutputExpanded];
		case "window-marker":
			return [item.hiddenTurns];
		case "session-marker":
			return [item.summary, context.toolOutputExpanded, expandKeyLabel()];
		case "human-request-trace":
			return [context.toolOutputExpanded];
		case "extension-output":
			return [item.text, item.expanded];
		case "application-notice":
			return [item.text, item.textMode];
		default:
			return [];
	}
}

/** A table column never grows past this, however long its cells are. */
const TABLE_COLUMN_MAX_WIDTH = 40;
/** Below this a column cannot even show an ellipsis next to a character. */
const TABLE_COLUMN_MIN_WIDTH = 3;
const TABLE_SEPARATOR_WIDTH = 3;

/** Painted at render time so a theme switch shows up in the next render. */
function tableSeparator(): string {
	return ` ${theme.dim("│")} `;
}

/**
 * Render a published extension message into styled lines, dispatched on kind:
 * tables get computed column widths, fields get aligned labels, diffs get the
 * edit tool's diff paint, and banners get their tone's color. Width is the
 * usable text width (render width minus the Text padding).
 *
 * A kind this build has no renderer for - an extension's own, or one written by
 * a newer build - degrades to the frame's header rather than dropping the entry.
 */
function extensionMessageLines(message: ExtensionMessage, width: number): string[] {
	const parsed = parseBuiltInMessage(message);
	return parsed ? builtInMessageLines(parsed, width) : [];
}

function builtInMessageLines(message: BuiltInExtensionMessage, width: number): string[] {
	switch (message.kind) {
		case "text":
		case "markdown":
		case "code":
			return boundedText(message.content, { maxLines: 24, maxCharacters: 8_000 }).split("\n");
		case "banner": {
			const paint = tonePaint(message.severity);
			return boundedText(message.content, { maxLines: 24, maxCharacters: 8_000 })
				.split("\n")
				.map((line) => (line ? paint(line) : line));
		}
		case "diff": {
			const patch = boundedText(message.patch, { maxLines: 24, maxCharacters: 8_000 });
			const lines = renderDiffText(patch);
			return message.path === undefined ? lines : [theme.dim(singleLine(message.path, 400)), ...lines];
		}
		case "table":
			return extensionTableLines(message, width);
		case "fields":
			return extensionFieldsLines(message);
	}
}

/**
 * Column widths come from the widest content per column (header included),
 * capped at TABLE_COLUMN_MAX_WIDTH; when the row still overflows, the longest
 * column shrinks one cell at a time so narrower columns keep their content.
 */
function extensionTableLines(message: ExtensionTableMessage, width: number): string[] {
	const header = message.columns.map((column) => singleLine(column.label, MAX_EXTENSION_MESSAGE_CELL_BYTES));
	const rows = message.rows.map((row) => row.map((cell) => singleLine(cell, MAX_EXTENSION_MESSAGE_CELL_BYTES)));
	const widths = message.columns.map((_, index) => {
		let natural = visibleWidth(header[index]);
		for (const row of rows) natural = Math.max(natural, visibleWidth(row[index]));
		return Math.min(TABLE_COLUMN_MAX_WIDTH, Math.max(TABLE_COLUMN_MIN_WIDTH, natural));
	});
	const totalWidth = () =>
		widths.reduce((sum, columnWidth) => sum + columnWidth, 0) + TABLE_SEPARATOR_WIDTH * (widths.length - 1);
	while (totalWidth() > width) {
		let longest = 0;
		for (let index = 1; index < widths.length; index += 1) {
			if (widths[index] > widths[longest]) longest = index;
		}
		if (widths[longest] <= TABLE_COLUMN_MIN_WIDTH) break;
		widths[longest]--;
	}
	const formatRow = (cells: readonly string[]): string =>
		cells
			.map((cell, index) => {
				const truncated = truncateToWidth(cell, widths[index], "…");
				const padding = " ".repeat(Math.max(0, widths[index] - visibleWidth(truncated)));
				return message.columns[index].align === "right" ? `${padding}${truncated}` : `${truncated}${padding}`;
			})
			.join(tableSeparator());
	return boundLines([theme.bold(formatRow(header)), ...rows.map(formatRow)]).map((line) =>
		truncateToWidth(line, width, "…"),
	);
}

function extensionFieldsLines(message: ExtensionFieldsMessage): string[] {
	const fields = message.fields.map((field) => ({
		label: singleLine(field.label, MAX_EXTENSION_MESSAGE_CELL_BYTES),
		value: singleLine(field.value, MAX_EXTENSION_MESSAGE_CELL_BYTES),
		tone: field.tone,
	}));
	const labelWidth = Math.max(...fields.map((field) => visibleWidth(field.label)));
	return boundLines(
		fields.map(
			(field) =>
				`${theme.dim(field.label)}${" ".repeat(Math.max(0, labelWidth - visibleWidth(field.label)))}  ${tonePaint(
					field.tone,
				)(field.value)}`,
		),
	);
}

/** boundedText for lines that are already rendered: same budget, same marker. */
function boundLines(lines: string[], maxLines = 24): string[] {
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), theme.dim("… [truncated]")];
}

/** Current spinner frame index; advances every 160ms (see spinnerFrame). */
function spinnerTick(): number {
	return Math.floor(Date.now() / 160);
}

/** Whole seconds since the epoch: the cadence a live duration changes at. */
function secondTick(): number {
	return Math.floor(Date.now() / 1_000);
}

/** Key label for the transcript-expand toggle, for collapsed-marker hints. */
function expandKeyLabel(): string | undefined {
	const key = getKeybindings().getKeys("app.expand")[0];
	return key ? formatKeyLabel(key) : undefined;
}

/** `── title ─────…` filled to the render width: a visible section break. */
function markerSeparator(title: string, width: number): string {
	const head = `── ${title} `;
	// Text adds one column of left padding; keep one column right margin.
	const fill = Math.max(2, width - visibleWidth(head) - 2);
	return `${head}${"─".repeat(fill)}`;
}

/** One line naming who wrote a message the person did not type. */
function orchestratorMessageTitle(kind: string, label: string): string {
	if (kind === "human") return `from ${label}`;
	if (kind === "agent") return `agent ${label}`;
	if (kind === "recap") return `recap · ${label}`;
	if (kind.startsWith("extension:")) return `extension ${label}`;
	return label;
}

/**
 * Pad each row to the full width so a background color spans the whole line,
 * and close the block with a painted blank row at each edge. The background is
 * what marks where a block begins and ends, so it needs a line of air inside it
 * - text flush against the color's edge reads as a clipped row, not a card.
 */
function paintRows(lines: string[], paint: (text: string) => string, width: number): string[] {
	const edge = paint(" ".repeat(width));
	return [edge, ...lines.map((line) => paint(line + " ".repeat(Math.max(0, width - visibleWidth(line))))), edge];
}

/** Outcome at a glance, before reading a word of the row. */
function toolRowSurface(item: ToolExecutionItem): (text: string) => string {
	if (item.status === "preparing" || item.status === "running") return theme.toolPending;
	return item.isError || item.status === "cancelled" ? theme.toolError : theme.toolSuccess;
}

/** Commands paint like the action they are: working and failed rows echo the tool rows. */
function commandRowSurface(item: CommandResultItem): (text: string) => string {
	if (item.status === "running") return theme.toolPending;
	if (item.status === "failed") return theme.toolError;
	return theme.commandSurface;
}

export function renderTimelineItem(item: TimelineItem, width: number, context: TimelineRenderContext): string[] {
	switch (item.type) {
		// What the person typed is never summarized away: the bound is only there
		// so one pasted log cannot make every frame wrap fifty thousand lines, and
		// expanding lifts it entirely.
		case "user-message": {
			const text = context.toolOutputExpanded
				? sanitizeTerminalText(item.text)
				: boundedText(item.text, { maxLines: 200, maxCharacters: 30_000 });
			return paintRows(new Text(`${theme.bold("❯")} ${text}`, 1, 0).render(width), theme.surface, width);
		}
		// Everything that entered the model's context without the person typing
		// it. The source line carries the attribution, so the body is shown
		// unprefixed even though the model read the prefixed form: repeating
		// "[Message from worker-7]" in the text would say it twice.
		//
		// Dispatch is on `source.kind`, which is open - a kind core has never
		// heard of is a normal case, not corruption - so the fallback is the
		// same shape as every other branch rather than an error path.
		case "orchestrator-message": {
			const label = item.source.label ?? item.source.kind;
			const title = `${orchestratorMessageTitle(item.source.kind, label)}${
				item.editedByHuman ? ", edited by you" : ""
			}`;
			// Nobody typed this, so it stays out of the way until asked for: two
			// lines of summary collapsed, the whole thing expanded.
			const body = context.toolOutputExpanded
				? boundedText(item.text, { maxLines: 24, maxCharacters: 8_000 })
				: boundedText(item.text, { maxLines: 2, maxCharacters: Math.max(80, width * 2) });
			const lines = new Text(`${theme.dim(`↳ ${title}`)}\n${body}`, 1, 0).render(width);
			return paintRows(lines, theme.messageSurface, width);
		}
		case "assistant-message": {
			const text = item.text.trim();
			// A failed run (stopReason "error", e.g. provider timeout after a
			// model switch) often carries no text at all; without this the
			// failure is completely invisible in the transcript.
			const errorMessage =
				item.message?.stopReason === "error"
					? item.message.errorMessage
					: // The model hit its output limit, so the text below stops
						// mid-sentence through no fault of the transcript. Say so, or the
						// reply reads as if the model simply chose to stop there.
						item.message?.stopReason === "length"
						? "Response was truncated before completion."
						: undefined;
			if (!text) {
				if (errorMessage) {
					return new Text(`${theme.error("✕")} ${theme.error(singleLine(errorMessage, 400))}`, 1, 0).render(width);
				}
				// A live thinking-status or preparing tool already shows progress;
				// render nothing here so indicators never appear twice.
				if (
					item.streaming &&
					!context.liveThinkingIds.has(`${item.id}:thinking`) &&
					!context.livePreparingAssistantIds.has(item.id)
				) {
					return new Text(theme.dim(`${spinnerFrame()} Thinking…`), 1, 0).render(width);
				}
				return [];
			}
			// Unbounded on purpose: the model's own output limit is the bound, and
			// a reply cut short by the renderer is indistinguishable from one the
			// model ended there.
			const lines = new Markdown(sanitizeTerminalText(text), 1, 0, theme.markdownTheme).render(width);
			if (errorMessage) {
				lines.push(
					...new Text(`${theme.error("✕")} ${theme.error(singleLine(errorMessage, 400))}`, 1, 0).render(width),
				);
			}
			return lines;
		}
		case "thinking-status": {
			if (item.status !== "thinking") return [];
			// The spinner line plus a rolling tail of the streamed thinking text.
			const lines = [theme.dim(`${spinnerFrame()} ${item.label ?? "Thinking…"}`)];
			if (item.preview) {
				for (const line of item.preview.split("\n")) {
					lines.push(theme.dim(truncateToWidth(sanitizeTerminalText(line), Math.max(1, width - 2), "…")));
				}
			}
			return new Text(lines.join("\n"), 1, 0).render(width);
		}
		case "tool-execution": {
			const lines = new Text(
				presentToolExecution(item, Math.max(8, width - 2), {
					expanded: item.expanded ?? context.toolOutputExpanded,
				}).join("\n"),
				1,
				0,
			).render(width);
			return paintRows(lines, toolRowSurface(item), width);
		}
		case "diagnostic": {
			const color = theme.severityPaint(item.diagnostic.severity);
			return new Text(
				`${color(
					`${diagnosticGlyph(item.diagnostic)} ${item.diagnostic.code}`,
				)}\n${boundedText(item.diagnostic.message)}`,
				1,
				0,
			).render(width);
		}
		case "command-result": {
			// Running/failed and the unregistered fallback live in the shared
			// frame; a completed result may carry its own presenter.
			const lines = new Text(
				presentCommandResult(item, Math.max(8, width - 2), { expanded: context.toolOutputExpanded }).join("\n"),
				1,
				0,
			).render(width);
			return paintRows(lines, commandRowSurface(item), width);
		}
		case "extension-output":
			return new Text(
				`${theme.dim(`[${item.extensionId}]`)} ${
					item.expanded
						? sanitizeTerminalText(item.text)
						: boundedText(item.text, { maxLines: 16, maxCharacters: 4_000 })
				}`,
				1,
				0,
			).render(width);
		case "extension-message": {
			const usableWidth = Math.max(8, width - 2);
			// A registered entry renderer owns the whole frame; its renderBody()
			// wraps the message renderer (or the built-in body) inside it. A
			// message renderer alone only replaces the body. A throwing renderer
			// already reported its diagnostic; what remains is the built-in path.
			const entry = renderExtensionEntry(item, width, (bodyWidth) => extensionMessageLines(item.message, bodyWidth));
			if (entry) return entry;
			const title =
				typeof item.message.title === "string" && item.message.title
					? theme.title(singleLine(item.message.title, 400))
					: theme.dim(`[${item.extensionId}]`);
			const meta = theme.dim(`persistent · ${item.extensionId} · ${item.message.kind}`);
			const body = renderExtensionMessageBody(item, usableWidth) ?? extensionMessageLines(item.message, usableWidth);
			return new Text(`${title}  ${meta}\n\n${body.join("\n")}`, 1, 0).render(width);
		}
		case "human-request-trace": {
			if (item.answer.kind === "answered-questions") {
				const { items } = item.answer;
				if (context.toolOutputExpanded) {
					const lines = [theme.dim(`❯ ${singleLine(item.title, 400)}`)];
					for (const entry of items) {
						lines.push(theme.dim(`  ${singleLine(entry.title, 400)}`));
						if (entry.values.length === 0) {
							lines.push(theme.dim("    → (no answer)"));
						} else {
							for (const value of entry.values) {
								lines.push(`    ${theme.selection("▸")} ${singleLine(value, 400)}`);
							}
						}
					}
					return new Text(lines.join("\n"), 1, 0).render(width);
				}
				const summary = items
					.map(
						(entry) =>
							`${singleLine(entry.title, 80)}: ${entry.values.length > 0 ? entry.values.join(", ") : "(none)"}`,
					)
					.join(" · ");
				return new Text(theme.dim(`❯ ${singleLine(item.title, 200)} → `) + singleLine(summary, 400), 1, 0).render(
					width,
				);
			}
			// The selected labels drive both the inline summary and the ▸ marks
			// in the expanded list; multi-select carries several at once.
			const selected =
				item.answer.kind === "confirm"
					? [item.answer.confirmed ? "Yes" : "No"]
					: item.answer.kind === "selected-option"
						? [item.answer.value]
						: item.answer.kind === "selected-options"
							? item.answer.values
							: [];
			const summary = selected.length > 0 ? selected.join(", ") : "Answered";
			// input/custom/free-input answers never expand: only options the
			// request itself offered may appear in the transcript.
			const options =
				item.answer.kind === "confirm"
					? ["Yes", "No"]
					: item.answer.kind === "selected-option" || item.answer.kind === "selected-options"
						? (item.options ?? [])
						: [];
			if (context.toolOutputExpanded && options.length > 0) {
				const selectedSet = new Set(selected);
				const lines = [theme.dim(`❯ ${singleLine(item.title, 400)}`)];
				for (const option of options) {
					lines.push(
						selectedSet.has(option)
							? `  ${theme.selection("▸")} ${singleLine(option, 400)}`
							: theme.dim(`    ${singleLine(option, 400)}`),
					);
				}
				return new Text(lines.join("\n"), 1, 0).render(width);
			}
			return new Text(theme.dim(`❯ ${singleLine(item.title, 400)} → `) + singleLine(summary, 400), 1, 0).render(width);
		}
		case "application-notice":
			return new Text(
				theme.dim(
					`✱ ${
						item.textMode === "full"
							? sanitizeTerminalText(item.text)
							: boundedText(item.text, { maxLines: 4, maxCharacters: 600 })
					}`,
				),
				1,
				0,
			).render(width);
		case "session-marker": {
			const title = item.marker === "compaction" ? "Compacted session" : "Branch summary";
			const keyLabel = expandKeyLabel();
			if (!context.toolOutputExpanded) {
				const hint = keyLabel ? ` · ${keyLabel} expand` : "";
				return new Text(theme.dim(markerSeparator(`${title}${hint}`, width)), 1, 0).render(width);
			}
			const hint = keyLabel ? ` · ${keyLabel} collapse` : "";
			return new Text(
				theme.dim(`${markerSeparator(`${title}${hint}`, width)}\n${sanitizeTerminalText(item.summary)}`),
				1,
				0,
			).render(width);
		}
		case "window-marker":
			return new Text(theme.dim(`— earlier turns hidden (${item.hiddenTurns} turns trimmed) —`), 1, 0).render(width);
	}
}
