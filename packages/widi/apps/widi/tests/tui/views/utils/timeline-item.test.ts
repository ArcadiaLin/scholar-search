import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionMessage } from "../../../../src/core/extension/api.ts";
import { EXTENSION_MESSAGE_CUSTOM_TYPE } from "../../../../src/core/session-manager.ts";
import { SPINNER_FRAMES } from "../../../../src/tui/format.ts";
import { createWidiKeybindings } from "../../../../src/tui/keybindings.ts";
import { hydrateSessionEntries } from "../../../../src/tui/session-hydrator.ts";
import type {
	ApplicationNoticeItem,
	AssistantMessageItem,
	CommandResultItem,
	HumanRequestTraceItem,
	OrchestratorMessageItem,
	PersistentMessageItem,
	SessionMarkerItem,
	ThinkingStatusItem,
	ToolExecutionItem,
	UserMessageItem,
} from "../../../../src/tui/state.ts";
import { theme } from "../../../../src/tui/theme/theme.ts";
import {
	renderDeps,
	renderTimelineItem,
	type TimelineRenderContext,
} from "../../../../src/tui/views/utils/timeline-item.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The opening SGR sequence of a paint, for asserting a specific hue applied. */
function paintOpen(paint: (text: string) => string): string {
	return paint("x").split("x")[0];
}

const context: TimelineRenderContext = {
	liveThinkingIds: new Set(),
	livePreparingAssistantIds: new Set(),
	toolOutputExpanded: false,
};

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trim());
}

describe("renderTimelineItem", () => {
	// The attribution is a line of its own, so the body stays as the producer
	// wrote it. The model reads the prefixed `modelText`; showing that here
	// would state the same fact twice.
	it("names the source above an orchestrator message and leaves the body unprefixed", () => {
		const item: OrchestratorMessageItem = {
			type: "orchestrator-message",
			id: "msg-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { kind: "agent", label: "worker-7" },
			text: "three duplicates found",
			modelText: "[Message from worker-7]\n\nthree duplicates found",
		};

		const lines = plain(renderTimelineItem(item, 60, context));

		expect(lines).toContain("↳ agent worker-7");
		expect(lines).toContain("three duplicates found");
		expect(lines.join("\n")).not.toContain("[Message from worker-7]");
	});

	// `kind` is open by design: a producer may declare one core has never heard
	// of, and that is a normal message rather than a broken one.
	it("falls back to the label for a source kind it does not know", () => {
		const item: OrchestratorMessageItem = {
			type: "orchestrator-message",
			id: "msg-2",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { kind: "slack-bridge", label: "Slack @arcadia" },
			text: "why is CI red",
		};

		expect(plain(renderTimelineItem(item, 60, context))).toContain("↳ Slack @arcadia");
		expect(renderDeps(item, context)).toEqual(["why is CI red", "slack-bridge", "Slack @arcadia", undefined, false]);
	});

	it("says on the attribution line when a human rewrote the body", () => {
		const item: OrchestratorMessageItem = {
			type: "orchestrator-message",
			id: "msg-3",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { kind: "extension:notes", label: "notes" },
			text: "the reviewer asked for benchmarks",
			editedByHuman: true,
		};

		expect(plain(renderTimelineItem(item, 60, context))).toContain("↳ extension notes, edited by you");
	});

	it("collapses an orchestrator message to two lines until the transcript is expanded", () => {
		const item: OrchestratorMessageItem = {
			type: "orchestrator-message",
			id: "msg-3",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { kind: "agent", label: "worker-7" },
			text: "one\ntwo\nthree\nfour",
		};

		const collapsed = plain(renderTimelineItem(item, 60, context)).join("\n");
		expect(collapsed).toContain("two");
		expect(collapsed).not.toContain("three");
		expect(collapsed).toContain("[truncated]");

		const expanded = plain(renderTimelineItem(item, 60, { ...context, toolOutputExpanded: true })).join("\n");
		expect(expanded).toContain("four");
		expect(expanded).not.toContain("[truncated]");
	});

	it("paints a tool row with the surface its outcome earned, at full width", () => {
		const base = {
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "call-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			toolName: "read",
			args: { path: "a.ts" },
		} as const;
		const surfaceOf = (item: ToolExecutionItem): string => {
			const lines = renderTimelineItem(item, 30, context);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBe(30);
			return lines[0].slice(0, lines[0].indexOf("m") + 1);
		};

		expect(surfaceOf({ ...base, status: "running" })).toBe(paintOpen(theme.toolPending));
		expect(surfaceOf({ ...base, status: "completed", result: "ok" })).toBe(paintOpen(theme.toolSuccess));
		expect(surfaceOf({ ...base, status: "completed", isError: true, result: "boom" })).toBe(paintOpen(theme.toolError));
		expect(surfaceOf({ ...base, status: "cancelled" })).toBe(paintOpen(theme.toolError));
	});

	it("paints an orchestrator message with the message surface", () => {
		const item: OrchestratorMessageItem = {
			type: "orchestrator-message",
			id: "msg-4",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { kind: "agent", label: "worker-7" },
			text: "done",
		};

		const lines = renderTimelineItem(item, 30, context);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line.startsWith(paintOpen(theme.messageSurface))).toBe(true);
			expect(visibleWidth(line)).toBe(30);
		}
	});

	it("paints user message rows with the surface background at full width", () => {
		const item: UserMessageItem = {
			type: "user-message",
			id: "user-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "hello",
		};

		const lines = renderTimelineItem(item, 24, context);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			// #1e2833 as a background color.
			expect(line).toContain("48;2;30;40;51");
			expect(visibleWidth(line)).toBe(24);
		}
	});

	it("never bounds an assistant reply", () => {
		const text = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text,
			streaming: false,
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines.some((line) => line.includes("[truncated]"))).toBe(false);
		expect(lines).toContain("row 0");
		expect(lines).toContain("row 399");
	});

	it("says so when the model stopped at its output limit", () => {
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "a reply that stops mid-",
			streaming: false,
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "huggingface",
				model: "moonshotai/Kimi-K2.7-Code",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "length",
				timestamp: 0,
			},
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines).toContain("a reply that stops mid-");
		expect(lines.some((line) => line.includes("Response was truncated before completion."))).toBe(true);
	});

	it("bounds a long typed message by default and expands it on demand", () => {
		const item: UserMessageItem = {
			type: "user-message",
			id: "user-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n"),
		};

		const collapsed = plain(renderTimelineItem(item, 80, context)).map((line) => line.trim());

		expect(collapsed.some((line) => line.includes("[truncated]"))).toBe(true);
		expect(collapsed).not.toContain("row 399");

		const expanded = plain(renderTimelineItem(item, 80, { ...context, toolOutputExpanded: true })).map((line) =>
			line.trim(),
		);
		expect(expanded.some((line) => line.includes("[truncated]"))).toBe(false);
		expect(expanded).toContain("row 399");
	});

	it("does not invalidate streamed Markdown for an unused spinner frame", () => {
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "streamed text",
			streaming: true,
		};
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);
		const first = renderDeps(item, context);
		now.mockReturnValue(1_000);
		const second = renderDeps(item, context);
		expect(second).toEqual(first);

		item.text = "";
		now.mockReturnValue(0);
		const placeholderFirst = renderDeps(item, context);
		now.mockReturnValue(1_000);
		const placeholderSecond = renderDeps(item, context);
		expect(placeholderSecond).not.toEqual(placeholderFirst);
		now.mockRestore();
	});

	it("prefers the command display text over the raw result", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "resume",
			argument: "",
			status: "completed",
			result: { agentId: "agent-2", snapshot: { big: "object" } },
			display: "resumed agent-2 · Default · test-model",
		};

		const lines = renderTimelineItem(item, 80, context);

		expect(plain(lines)).toEqual(["", "✓ /resume resumed agent-2 · Default · test-model", ""]);
		expect(lines.every((line) => line.startsWith(paintOpen(theme.commandSurface)))).toBe(true);
	});

	it("sanitizes and bounds formatted command display text", () => {
		const escapeCharacter = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-unsafe",
			commandId: "command-unsafe",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "compact",
			argument: "",
			status: "completed",
			display: [
				`safe${escapeCharacter}]52;c;SGVsbG8=${bell}tail`,
				...Array.from({ length: 30 }, (_, index) => `line ${index}`),
			].join("\n"),
		};

		const output = renderTimelineItem(item, 80, context).join("\n");

		expect(output).not.toContain(`${escapeCharacter}]52`);
		expect(output).not.toContain(bell);
		expect(output).toContain("safetail");
		expect(output).toContain("[truncated]");
		expect(output).not.toContain("line 29");

		const expanded = renderTimelineItem(item, 80, { ...context, toolOutputExpanded: true }).join("\n");
		expect(expanded).not.toContain(`${escapeCharacter}]52`);
		expect(expanded).not.toContain(bell);
		expect(expanded).toContain("line 29");
	});

	it("falls back to the raw result when no display text exists", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-2",
			commandId: "command-2",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "status",
			argument: "",
			status: "completed",
			result: "idle",
		};

		const lines = renderTimelineItem(item, 80, context);

		expect(plain(lines)).toEqual(["", "✓ /status idle", ""]);
		expect(lines.every((line) => line.startsWith(paintOpen(theme.commandSurface)))).toBe(true);
	});

	it("wraps full application notices without abbreviating login URLs", () => {
		const url = `https://auth.example.test/oauth/authorize?${"state=a".repeat(120)}&complete=yes`;
		const item: ApplicationNoticeItem = {
			type: "application-notice",
			id: "login-url",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: `Login: open ${url}`,
			textMode: "full",
		};

		const output = plain(renderTimelineItem(item, 40, context)).join("");

		expect(output).toContain(url);
		expect(output).not.toContain("…");
	});

	it("renders a live thinking status with a spinner and a two-line preview", () => {
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "live-1:thinking",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "thinking",
			preview: "second line\nthird line",
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines).toHaveLength(3);
		expect(SPINNER_FRAMES).toContain(lines[0]?.[0]);
		expect(lines[0]?.slice(1)).toBe(" Thinking…");
		expect(lines.slice(1)).toEqual(["second line", "third line"]);
	});

	it("sanitizes terminal controls from the thinking preview", () => {
		const escapeCharacter = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "live-unsafe:thinking",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "thinking",
			preview: `safe${escapeCharacter}]52;c;SGVsbG8=${bell}tail`,
		};

		const output = renderTimelineItem(item, 80, context).join("\n");

		expect(output).not.toContain(`${escapeCharacter}]52`);
		expect(output).not.toContain(bell);
		expect(output).toContain("safetail");
	});

	it("renders a completed thinking status as nothing", () => {
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "awaiting:main",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "completed",
		};

		expect(renderTimelineItem(item, 80, context)).toEqual([]);
	});

	it("collapses a compaction marker into a full-width separator by default", () => {
		setKeybindings(createWidiKeybindings());
		const item: SessionMarkerItem = {
			type: "session-marker",
			id: "compaction-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			marker: "compaction",
			summary: "## Goal\nhidden summary body",
		};

		const lines = plain(renderTimelineItem(item, 60, context));

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("── Compacted session · Ctrl+O expand ─");
		expect(lines[0]?.endsWith("──")).toBe(true);
		expect(lines[0]).not.toContain("hidden summary body");
	});

	it("expands a compaction marker with the transcript toggle", () => {
		setKeybindings(createWidiKeybindings());
		const item: SessionMarkerItem = {
			type: "session-marker",
			id: "compaction-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			marker: "compaction",
			summary: "## Goal\nhidden summary body",
		};

		const lines = plain(renderTimelineItem(item, 60, { ...context, toolOutputExpanded: true }));

		expect(lines[0]).toContain("── Compacted session · Ctrl+O collapse ─");
		expect(lines).toContain("hidden summary body");
	});

	it("renders a table extension message with computed column widths and alignment", () => {
		const item = extensionMessageItem({
			kind: "table",
			title: "Files",
			columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
			rows: [
				["src/a.ts", "12"],
				["src/long-file-name.ts", "300"],
			],
		});

		const lines = plain(renderTimelineItem(item, 60, context));

		expect(lines[0]).toContain("Files");
		expect(lines).toContain(`Path${" ".repeat(17)} │ Lines`);
		expect(lines).toContain(`src/a.ts${" ".repeat(13)} │ ${" ".repeat(3)}12`);
		expect(lines).toContain(`src/long-file-name.ts │ ${" ".repeat(2)}300`);
	});

	it("caps a table column and truncates the overflowing cell", () => {
		const cell = "x".repeat(100);
		const item = extensionMessageItem({ kind: "table", columns: [{ label: "Data" }], rows: [[cell]] });

		const row = plain(renderTimelineItem(item, 80, context)).find((line) => line.includes("xxx"));

		expect(row).toBeDefined();
		expect(row).toContain("…");
		expect(row).not.toContain(cell);
		// The column cap is 40 columns wide.
		expect(visibleWidth(row ?? "")).toBe(40);
	});

	it("aligns field labels to the longest label and paints toned values", () => {
		const item = extensionMessageItem({
			kind: "fields",
			fields: [
				{ label: "Host", value: "example.test" },
				{ label: "Region", value: "us-east" },
				{ label: "Files", value: "3 written", tone: "success" },
			],
		});

		const rendered = renderTimelineItem(item, 60, context);
		const lines = plain(rendered);

		expect(lines).toContain("Host    example.test");
		expect(lines).toContain("Region  us-east");
		expect(lines).toContain("Files   3 written");
		expect(rendered.join("\n")).toContain(`${paintOpen(theme.ok)}3 written`);
	});

	it("renders a diff extension message through the diff paint", () => {
		const item = extensionMessageItem({
			kind: "diff",
			path: "src/a.ts",
			patch: " 1 context\n-2 old line\n+2 new line",
		});

		const raw = renderTimelineItem(item, 60, context).join("\n");
		const lines = plain(renderTimelineItem(item, 60, context));

		expect(lines).toContain("src/a.ts");
		expect(lines).toContain("-2 old line");
		expect(lines).toContain("+2 new line");
		expect(raw).toContain(`${paintOpen(theme.error)}-2 `);
		expect(raw).toContain(`${paintOpen(theme.ok)}+2 `);
	});

	it("paints a banner with its severity tone", () => {
		const item = extensionMessageItem({ kind: "banner", severity: "warning", content: "Index rebuilt" });

		const raw = renderTimelineItem(item, 60, context).join("\n");

		expect(raw).toContain(`${paintOpen(theme.warn)}Index rebuilt`);
	});

	it("leaves a neutral banner unpainted", () => {
		const item = extensionMessageItem({ kind: "banner", severity: "neutral", content: "All quiet" });

		const raw = renderTimelineItem(item, 60, context).join("\n");

		expect(raw).toContain("All quiet");
		// No foreground color anywhere: title and meta are dim decorations only.
		expect(raw).not.toContain("38;2;");
	});

	it("renders a structured message that survived persistence and hydration", () => {
		const persisted = JSON.parse(
			JSON.stringify({
				extensionId: "reports",
				message: {
					kind: "table",
					title: "Files",
					columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
					rows: [["src/a.ts", "12"]],
				},
			}),
		) as unknown;
		const result = hydrateSessionEntries([
			{
				type: "custom",
				id: "ext-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: EXTENSION_MESSAGE_CUSTOM_TYPE,
				data: persisted,
			},
		]);

		const item = result.timeline[0];
		expect(item?.type).toBe("extension-message");
		const lines = plain(renderTimelineItem(item as PersistentMessageItem, 60, context));

		expect(lines).toContain(`Path${" ".repeat(4)} │ Lines`);
		expect(lines).toContain(`src/a.ts │ ${" ".repeat(3)}12`);
	});
});

function extensionMessageItem(message: ExtensionMessage): PersistentMessageItem {
	return {
		type: "extension-message",
		id: "ext-1",
		entryId: "ext-1",
		extensionId: "reports",
		message,
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("per-item tool expansion (parity §4.3-3)", () => {
	function bashToolItem(expanded?: boolean): ToolExecutionItem {
		return {
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "tool-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			toolName: "bash",
			args: { command: "seq 10" },
			status: "completed",
			isError: false,
			...(expanded !== undefined ? { expanded } : {}),
			result: { content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") }] },
		};
	}

	it("renders the full output for an expanded item while the global toggle is off", () => {
		const collapsed = plain(renderTimelineItem(bashToolItem(), 80, context));
		const expanded = plain(renderTimelineItem(bashToolItem(true), 80, context));

		expect(collapsed.some((line) => line.includes("+6 lines"))).toBe(true);
		expect(collapsed.some((line) => line.includes("line 6"))).toBe(false);
		expect(expanded.some((line) => line.includes("+6 lines"))).toBe(false);
		expect(expanded.some((line) => line.includes("line 10"))).toBe(true);
	});

	it("collapses an item whose flag is false while the global toggle is on", () => {
		const lines = plain(renderTimelineItem(bashToolItem(false), 80, { ...context, toolOutputExpanded: true }));

		expect(lines.some((line) => line.includes("+6 lines"))).toBe(true);
	});

	it("includes the per-item flag in the render deps", () => {
		expect(renderDeps(bashToolItem(), context)).not.toEqual(renderDeps(bashToolItem(true), context));
	});
});

describe("renderTimelineItem results and traces", () => {
	it("renders a completed command with its result", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: timestamp(1),
			name: "status",
			argument: "",
			status: "completed",
			result: { status: "idle" },
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/status");
		expect(text).toContain('"status": "idle"');
	});

	it("renders a failed assistant turn with its error message", () => {
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: timestamp(1),
			text: "",
			streaming: false,
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "huggingface",
				model: "moonshotai/Kimi-K2.7-Code",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "Request timed out.",
				timestamp: Date.parse(timestamp(1)),
			},
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("✕");
		expect(text).toContain("Request timed out.");
	});

	it("renders a failed command with its error message", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: timestamp(1),
			name: "resume",
			argument: "some-session",
			status: "failed",
			error: { message: "not available while the agent is running" },
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/resume");
		expect(text).toContain("not available while the agent is running");
	});

	it("renders a multi-select trace as a joined summary and an expanded list", () => {
		const item: HumanRequestTraceItem = {
			type: "human-request-trace",
			id: "request-1",
			requestId: "request-1",
			requestKind: "multi-select",
			title: "Pick targets",
			options: ["Safe", "Fast", "Cheap"],
			answer: { kind: "selected-options", values: ["Safe", "Cheap"] },
			durability: "ephemeral",
			createdAt: timestamp(1),
		};
		const collapsed = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Pick targets → Safe, Cheap");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: true,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("▸ Safe");
		expect(expanded).toContain("▸ Cheap");
		expect(expanded).toContain("Fast");
		expect(expanded).not.toContain("▸ Fast");
	});

	it("renders a questions-batch trace as a summary and a grouped expansion", () => {
		const item: HumanRequestTraceItem = {
			type: "human-request-trace",
			id: "request-1",
			requestId: "request-1",
			requestKind: "questions",
			title: "Deploy setup",
			answer: {
				kind: "answered-questions",
				items: [
					{ title: "Target", values: ["Staging"] },
					{ title: "Regions", values: ["us", "eu"] },
				],
			},
			durability: "ephemeral",
			createdAt: timestamp(1),
		};
		const collapsed = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Target: Staging");
		expect(collapsed).toContain("Regions: us, eu");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: true,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("Target");
		expect(expanded).toContain("▸ Staging");
		expect(expanded).toContain("▸ us");
		expect(expanded).toContain("▸ eu");
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
