import type { SessionTreeEntry } from "@arcadialin/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
} from "../../src/core/session-manager.ts";
import { hydrateSessionEntries } from "../../src/tui/session-hydrator.ts";

describe("hydrateSessionEntries", () => {
	// Both entry forms carry the same details, so both hydrate to the same item.
	// The person reads `details.body`; `modelText` holds the rendered form the
	// model read, and is absent when the renderer changed nothing.
	it("restores orchestrator messages from both entry forms", () => {
		const result = hydrateSessionEntries([
			orchestratorMessage("agent-msg", "[Message from worker-7]\n\nthree duplicates found", {
				source: { kind: "agent", label: "worker-7" },
				body: "three duplicates found",
			}),
			orchestratorNotice("watchdog-notice", "[Input from extension watchdog]\n\nthe build went quiet", {
				source: { kind: "extension:watchdog", label: "watchdog" },
				body: "the build went quiet",
			}),
		]);

		expect(result.timeline).toEqual([
			{
				type: "orchestrator-message",
				id: "agent-msg",
				durability: "durable",
				createdAt: timestamp(1),
				source: { kind: "agent", label: "worker-7" },
				text: "three duplicates found",
				modelText: "[Message from worker-7]\n\nthree duplicates found",
			},
			{
				type: "orchestrator-message",
				id: "watchdog-notice",
				durability: "durable",
				createdAt: timestamp(1),
				source: { kind: "extension:watchdog", label: "watchdog" },
				text: "the build went quiet",
				modelText: "[Input from extension watchdog]\n\nthe build went quiet",
			},
		]);
	});

	// An entry with no record of who wrote it cannot be attributed, and showing
	// it as a plain user message would claim the person said it.
	it("drops an orchestrator message that carries no source", () => {
		const foreign = {
			...orchestratorNotice("other-type", "not ours", { source: { kind: "agent" }, body: "not ours" }),
			customType: "someone-else:message",
		};
		const result = hydrateSessionEntries([
			orchestratorMessage("no-details", "orphan", undefined),
			orchestratorNotice("bad-details", "orphan", { body: 7 }),
			foreign,
		]);

		expect(result.timeline).toEqual([]);
	});

	it("restores human-facing messages, tools, extension messages and display facts", () => {
		const entries: SessionTreeEntry[] = [
			custom("transform", INPUT_TRANSFORM_CUSTOM_TYPE, {
				inputId: "input-1",
				originalText: "human original",
				text: "extension rewritten",
				transformedBy: ["rewrite"],
			}),
			message("user", userMessage("model-facing expanded text")),
			message(
				"assistant",
				assistantMessage("I will inspect.", [
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
				]),
			),
			message("tool-result", toolResult("call-1", "read", "file contents")),
			custom("extension-message", EXTENSION_MESSAGE_CUSTOM_TYPE, {
				extensionId: "reports",
				// Legacy entries may carry this removed field; structural
				// hydration ignores it without rewriting the stored entry.
				commandId: "legacy-command",
				message: { kind: "markdown", title: "Report", content: "durable result" },
			}),
			custom("private", "extension:reports:private", { secret: true }),
			{
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: timestamp(7),
				provider: "test",
				modelId: "model-2",
			},
			{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: timestamp(8), thinkingLevel: "high" },
			{ type: "active_tools_change", id: "tools", parentId: null, timestamp: timestamp(9), activeToolNames: ["read"] },
			{ type: "session_info", id: "session-info", parentId: null, timestamp: timestamp(10), name: "research" },
			{
				type: "compaction",
				id: "compact",
				parentId: null,
				timestamp: timestamp(11),
				summary: "Earlier work was compacted.",
				firstKeptEntryId: "user",
				tokensBefore: 1000,
			},
		];

		const result = hydrateSessionEntries(entries);

		expect(result.display).toEqual({
			model: { provider: "test", modelId: "model-2" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
			sessionName: "research",
		});
		expect(result.timeline.map((item) => item.type)).toEqual([
			"user-message",
			"assistant-message",
			"tool-execution",
			"extension-message",
			"session-marker",
		]);
		expect(result.timeline[0]).toMatchObject({
			type: "user-message",
			text: "human original",
			modelText: "model-facing expanded text",
		});
		expect(result.timeline[2]).toMatchObject({
			type: "tool-execution",
			toolCallId: "call-1",
			toolName: "read",
			status: "completed",
			isError: false,
		});
		expect(result.timeline[3]).toMatchObject({
			type: "extension-message",
			entryId: "extension-message",
			extensionId: "reports",
			message: { content: "durable result" },
		});
		expect(JSON.stringify(result.timeline)).not.toContain("secret");
	});

	// Live events carry the message shape straight through; hydration is the
	// path that used to enumerate the kinds a second time, so a structured
	// message that survives a restart is the thing worth asserting.
	// Hydration restores anything core would have admitted, its own kinds
	// included: whether this build can draw a shape is settled at render time,
	// where an unreadable one degrades instead of vanishing from the timeline.
	it("restores every published message with a kind, and drops the rest", () => {
		const result = hydrateSessionEntries([
			custom("table", EXTENSION_MESSAGE_CUSTOM_TYPE, {
				extensionId: "reports",
				message: {
					kind: "table",
					title: "Files",
					columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
					rows: [["src/a.ts", "12"]],
				},
			}),
			custom("foreign", EXTENSION_MESSAGE_CUSTOM_TYPE, {
				extensionId: "reports",
				message: { kind: "reports:coverage", percent: 91.2 },
			}),
			custom("kindless", EXTENSION_MESSAGE_CUSTOM_TYPE, {
				extensionId: "reports",
				message: { columns: [{ label: "Path" }] },
			}),
		]);

		expect(result.timeline).toMatchObject([
			{
				type: "extension-message",
				entryId: "table",
				message: {
					kind: "table",
					columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
					rows: [["src/a.ts", "12"]],
				},
			},
			{ type: "extension-message", entryId: "foreign", message: { kind: "reports:coverage", percent: 91.2 } },
		]);
	});

	it("creates a completed fallback tool item for orphan tool results", () => {
		const result = hydrateSessionEntries([
			message("orphan", toolResult("missing-call", "shell", "done", true)),
			{
				type: "branch_summary",
				id: "summary",
				parentId: null,
				timestamp: timestamp(2),
				fromId: "old-branch",
				summary: "Alternative branch summary.",
			},
		]);

		expect(result.timeline).toMatchObject([
			{ type: "tool-execution", toolCallId: "missing-call", status: "completed", isError: true },
			{ type: "session-marker", marker: "branch-summary" },
		]);
	});
});

/** The waking form: a typed message the agent loop persisted. */
function orchestratorMessage(
	id: string,
	content: string,
	details: unknown,
): Extract<SessionTreeEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: timestamp(1),
		message: {
			role: "custom",
			customType: ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
			content,
			display: true,
			details,
			timestamp: Date.parse(timestamp(1)),
		},
	};
}

/** The non-waking form: a `precede` notice appended straight to the branch. */
function orchestratorNotice(
	id: string,
	content: string,
	details: unknown,
): Extract<SessionTreeEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: timestamp(1),
		customType: ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
		content,
		display: true,
		details,
	};
}

function message(
	id: string,
	value: UserMessage | AssistantMessage | ToolResultMessage,
): Extract<SessionTreeEntry, { type: "message" }> {
	return { type: "message", id, parentId: null, timestamp: timestamp(1), message: value };
}

function custom(id: string, customType: string, data: unknown): Extract<SessionTreeEntry, { type: "custom" }> {
	return { type: "custom", id, parentId: null, timestamp: timestamp(1), customType, data };
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.parse(timestamp(1)) };
}

function assistantMessage(text: string, extra: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...extra],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(timestamp(2)),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.parse(timestamp(3)),
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
