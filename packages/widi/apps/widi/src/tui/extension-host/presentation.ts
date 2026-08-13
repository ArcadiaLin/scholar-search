/**
 * The message and status shapes this TUI knows how to draw.
 *
 * Core stores a published message as a `kind` plus opaque JSON and never learns
 * what any kind means; the vocabulary is a contract between an extension and
 * whoever renders it, so it lives beside the renderers. `registerMessageRenderer`
 * already takes an arbitrary kind string - these are simply the kinds shipped
 * built in.
 *
 * Everything here parses rather than validates: it returns `undefined` for a
 * shape it cannot draw instead of throwing. A branch outlives the build that
 * wrote into it, so encountering a message this build cannot render is ordinary
 * rather than exceptional, and the frame degrades to the raw kind and title.
 */

import type { ExtensionMessage } from "../../core/extension/api.ts";
import type { JsonValue } from "../../utils/json.ts";

export const MAX_EXTENSION_MESSAGE_TITLE_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_CELL_BYTES = 1_024;
export const MAX_EXTENSION_MESSAGE_TABLE_COLUMNS = 12;
export const MAX_EXTENSION_MESSAGE_TABLE_ROWS = 200;
export const MAX_EXTENSION_MESSAGE_FIELDS = 64;

export const EXTENSION_MESSAGE_KINDS = ["text", "markdown", "code", "table", "fields", "diff", "banner"] as const;

export type ExtensionMessageKind = (typeof EXTENSION_MESSAGE_KINDS)[number];

/** Semantic emphasis, mapped onto the active theme by `tonePaint`. */
export const EXTENSION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;

export type ExtensionTone = (typeof EXTENSION_TONES)[number];

export const EXTENSION_TABLE_ALIGNMENTS = ["left", "right"] as const;

export type ExtensionTableAlignment = (typeof EXTENSION_TABLE_ALIGNMENTS)[number];

export const EXTENSION_STATUS_REGIONS = ["panel", "footer", "agent-strip"] as const;

export type ExtensionStatusRegion = (typeof EXTENSION_STATUS_REGIONS)[number];

export interface ExtensionTableColumn {
	readonly label: string;
	readonly align?: ExtensionTableAlignment;
}

export interface ExtensionMessageField {
	readonly label: string;
	readonly value: string;
	readonly tone?: ExtensionTone;
}

export interface ExtensionTextMessage {
	readonly kind: "text" | "markdown";
	readonly title?: string;
	readonly content: string;
}

export interface ExtensionCodeMessage {
	readonly kind: "code";
	readonly title?: string;
	readonly content: string;
	readonly language?: string;
}

export interface ExtensionTableMessage {
	readonly kind: "table";
	readonly title?: string;
	readonly columns: readonly ExtensionTableColumn[];
	readonly rows: readonly (readonly string[])[];
}

export interface ExtensionFieldsMessage {
	readonly kind: "fields";
	readonly title?: string;
	readonly fields: readonly ExtensionMessageField[];
}

export interface ExtensionDiffMessage {
	readonly kind: "diff";
	readonly title?: string;
	readonly path?: string;
	readonly patch: string;
}

export interface ExtensionBannerMessage {
	readonly kind: "banner";
	readonly title?: string;
	readonly severity: ExtensionTone;
	readonly content: string;
}

export type BuiltInExtensionMessage =
	| ExtensionTextMessage
	| ExtensionCodeMessage
	| ExtensionTableMessage
	| ExtensionFieldsMessage
	| ExtensionDiffMessage
	| ExtensionBannerMessage;

export interface ExtensionStatusProgress {
	readonly completed: number;
	readonly total?: number;
}

export interface ExtensionStatus {
	readonly text: string;
	readonly progress?: ExtensionStatusProgress;
	/** Where to surface it; defaults to "panel". */
	readonly region?: ExtensionStatusRegion;
	/** A single grapheme shown in place of, or before, the text. */
	readonly icon?: string;
	readonly tone?: ExtensionTone;
}

/**
 * Read a published message as one of the built-in kinds, or `undefined` when it
 * is some other kind or is malformed.
 */
export function parseBuiltInMessage(message: ExtensionMessage): BuiltInExtensionMessage | undefined {
	const title = optionalText(message.title, MAX_EXTENSION_MESSAGE_TITLE_BYTES);
	switch (message.kind) {
		case "text":
		case "markdown": {
			const content = requiredText(message.content);
			return content === undefined ? undefined : { kind: message.kind, title, content };
		}
		case "code": {
			const content = requiredText(message.content);
			return content === undefined
				? undefined
				: { kind: "code", title, content, language: optionalText(message.language, 32) };
		}
		case "table":
			return parseTable(message, title);
		case "fields":
			return parseFields(message, title);
		case "diff": {
			const patch = requiredText(message.patch);
			return patch === undefined ? undefined : { kind: "diff", title, path: optionalText(message.path, 4_096), patch };
		}
		case "banner": {
			const content = requiredText(message.content);
			const severity = parseTone(message.severity);
			return content === undefined || severity === undefined ? undefined : { kind: "banner", title, severity, content };
		}
		default:
			return undefined;
	}
}

/** Read a keyed status, or `undefined` when it is not one this TUI can draw. */
export function parseExtensionStatus(status: JsonValue): ExtensionStatus | undefined {
	if (typeof status !== "object" || status === null || Array.isArray(status)) return undefined;
	const record = status as { readonly [key: string]: JsonValue };
	const text = requiredText(record.text);
	if (text === undefined) return undefined;
	return {
		text,
		progress: parseProgress(record.progress),
		region: parseRegion(record.region),
		icon: optionalText(record.icon, 32),
		tone: parseTone(record.tone),
	};
}

function parseProgress(value: JsonValue | undefined): ExtensionStatusProgress | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as { readonly [key: string]: JsonValue };
	const completed = record.completed;
	if (!Number.isInteger(completed) || (completed as number) < 0) return undefined;
	const total = record.total;
	if (total === undefined) return { completed: completed as number };
	if (!Number.isInteger(total) || (total as number) < (completed as number)) return { completed: completed as number };
	return { completed: completed as number, total: total as number };
}

function parseRegion(value: JsonValue | undefined): ExtensionStatusRegion | undefined {
	return typeof value === "string" && (EXTENSION_STATUS_REGIONS as readonly string[]).includes(value)
		? (value as ExtensionStatusRegion)
		: undefined;
}

function parseTone(value: JsonValue | undefined): ExtensionTone | undefined {
	return typeof value === "string" && (EXTENSION_TONES as readonly string[]).includes(value)
		? (value as ExtensionTone)
		: undefined;
}

function parseTable(message: ExtensionMessage, title: string | undefined): ExtensionTableMessage | undefined {
	const rawColumns = message.columns;
	if (
		!Array.isArray(rawColumns) ||
		rawColumns.length === 0 ||
		rawColumns.length > MAX_EXTENSION_MESSAGE_TABLE_COLUMNS
	) {
		return undefined;
	}
	const columns: ExtensionTableColumn[] = [];
	for (const entry of rawColumns) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
		const record = entry as { readonly [key: string]: JsonValue };
		if (typeof record.label !== "string") return undefined;
		const align = record.align;
		columns.push({
			label: record.label,
			align:
				typeof align === "string" && (EXTENSION_TABLE_ALIGNMENTS as readonly string[]).includes(align)
					? (align as ExtensionTableAlignment)
					: undefined,
		});
	}
	const rawRows = message.rows;
	if (!Array.isArray(rawRows) || rawRows.length > MAX_EXTENSION_MESSAGE_TABLE_ROWS) return undefined;
	const rows: string[][] = [];
	for (const row of rawRows) {
		// A ragged row leaves this renderer guessing which column a cell belongs
		// to, which is exactly the guess the kind exists to remove.
		if (!Array.isArray(row) || row.length !== columns.length) return undefined;
		if (!row.every((cell): cell is string => typeof cell === "string")) return undefined;
		rows.push([...row]);
	}
	return { kind: "table", title, columns, rows };
}

function parseFields(message: ExtensionMessage, title: string | undefined): ExtensionFieldsMessage | undefined {
	const rawFields = message.fields;
	if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > MAX_EXTENSION_MESSAGE_FIELDS) {
		return undefined;
	}
	const fields: ExtensionMessageField[] = [];
	for (const entry of rawFields) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
		const record = entry as { readonly [key: string]: JsonValue };
		if (typeof record.label !== "string" || record.label.trim().length === 0) return undefined;
		if (typeof record.value !== "string") return undefined;
		fields.push({ label: record.label, value: record.value, tone: parseTone(record.tone) });
	}
	return { kind: "fields", title, fields };
}

function requiredText(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalText(value: JsonValue | undefined, maxLength: number): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength ? value : undefined;
}
