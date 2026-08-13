/**
 * The message and status shapes this TUI draws.
 *
 * Core stores a published message as a kind plus opaque JSON, so every rule
 * that used to be a write-time rejection is now a render-time degrade: a shape
 * this build cannot draw returns undefined and the frame falls back, rather
 * than the entry being refused or dropped.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionMessage } from "../../src/core/extension/api.ts";
import {
	MAX_EXTENSION_MESSAGE_TABLE_ROWS,
	parseBuiltInMessage,
	parseExtensionStatus,
} from "../../src/tui/extension-host/presentation.ts";

describe("parseBuiltInMessage", () => {
	it("reads every built-in kind", () => {
		const messages: ExtensionMessage[] = [
			{ kind: "text", content: "plain" },
			{ kind: "markdown", title: "Report", content: "# Heading" },
			{ kind: "code", content: "const x = 1;", language: "typescript" },
			{
				kind: "table",
				title: "Files",
				columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
				rows: [
					["src/a.ts", "12"],
					["src/b.ts", "340"],
				],
			},
			{
				kind: "fields",
				fields: [
					{ label: "Indexed", value: "672" },
					{ label: "Failed", value: "3", tone: "danger" },
				],
			},
			{ kind: "diff", path: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
			{ kind: "banner", severity: "warning", content: "Index is stale." },
		];

		for (const message of messages) {
			expect(parseBuiltInMessage(message)).toMatchObject({ kind: message.kind });
		}
	});

	// The case core no longer rejects: an extension's own kind, or one a newer
	// build wrote. The renderer says "not mine" and the frame keeps the entry.
	it("returns undefined for a kind it has no shape for", () => {
		expect(parseBuiltInMessage({ kind: "acme:coverage", percent: 91.2 })).toBeUndefined();
	});

	// A ragged row leaves the renderer guessing which column a cell belongs to,
	// which is the guess the table kind exists to remove.
	it("refuses a row whose width does not match the columns", () => {
		expect(
			parseBuiltInMessage({ kind: "table", columns: [{ label: "Path" }, { label: "Lines" }], rows: [["src/a.ts"]] }),
		).toBeUndefined();
	});

	it("admits an empty cell but not an empty column set", () => {
		expect(
			parseBuiltInMessage({ kind: "table", columns: [{ label: "Path" }, { label: "Note" }], rows: [["src/a.ts", ""]] }),
		).toMatchObject({ rows: [["src/a.ts", ""]] });
		expect(parseBuiltInMessage({ kind: "table", columns: [], rows: [] })).toBeUndefined();
	});

	it("declines what it cannot lay out", () => {
		const wideColumns = Array.from({ length: 13 }, (_, index) => ({ label: `c${index}` }));
		expect(parseBuiltInMessage({ kind: "table", columns: wideColumns, rows: [] })).toBeUndefined();
		expect(
			parseBuiltInMessage({
				kind: "table",
				columns: [{ label: "Path" }],
				rows: Array.from({ length: MAX_EXTENSION_MESSAGE_TABLE_ROWS + 1 }, () => ["src/a.ts"]),
			}),
		).toBeUndefined();
		expect(
			parseBuiltInMessage({
				kind: "fields",
				fields: Array.from({ length: 65 }, (_, index) => ({ label: `f${index}`, value: "v" })),
			}),
		).toBeUndefined();
	});

	it("declines the malformed variants of a kind it knows", () => {
		const invalid: ExtensionMessage[] = [
			{ kind: "text" },
			{ kind: "diff", patch: "" },
			{ kind: "banner", severity: "critical", content: "x" },
			{ kind: "fields", fields: [] },
			{ kind: "fields", fields: [{ label: "  ", value: "v" }] },
			{ kind: "table", columns: [{ label: "Path" }], rows: [[7]] },
		];

		for (const message of invalid) {
			expect(parseBuiltInMessage(message)).toBeUndefined();
		}
	});
});

describe("parseExtensionStatus", () => {
	it("reads text, progress, and the placement hints", () => {
		expect(
			parseExtensionStatus({
				text: "Indexing",
				progress: { completed: 3, total: 10 },
				region: "footer",
				icon: "◈",
				tone: "info",
			}),
		).toEqual({ text: "Indexing", progress: { completed: 3, total: 10 }, region: "footer", icon: "◈", tone: "info" });
	});

	it("drops a hint it cannot use rather than the whole status", () => {
		expect(parseExtensionStatus({ text: "Busy", region: "header", tone: "critical" })).toEqual({
			text: "Busy",
			progress: undefined,
			region: undefined,
			icon: undefined,
			tone: undefined,
		});
	});

	it("returns undefined without the one field it needs", () => {
		expect(parseExtensionStatus({ progress: { completed: 1 } })).toBeUndefined();
		expect(parseExtensionStatus("Indexing")).toBeUndefined();
	});
});
