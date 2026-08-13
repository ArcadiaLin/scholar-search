import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { EventProjector } from "../../src/tui/event-projector.ts";
import { createTuiApplicationState, setActiveAgent, type TimelineItem } from "../../src/tui/state.ts";
import { flushStreaming } from "../../src/tui/streaming-flush.ts";

describe("streaming flush", () => {
	it("buffers message_update deltas until flush", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		const item = assistantItem(agent.timeline);
		const initialMessage = item.message;

		for (const text of ["Hel", "Hello", "Hello world"]) {
			projector.apply(harness("main", textUpdate(text)));
		}

		// No timeline write happened yet; the render cache stays valid.
		expect(item.text).toBe("");
		expect(item.message).toBe(initialMessage);
		expect(agent.pendingAssistantText?.text).toBe("Hello world");

		expect(flushStreaming(agent)).toBe(true);
		expect(item.text).toBe("Hello world");
		expect(item.message?.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(agent.pendingAssistantText).toBeUndefined();

		// Idempotent once the buffer is drained.
		expect(flushStreaming(agent)).toBe(false);
	});

	it("flushes immediately on message_end", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("draft")));

		projector.apply(harness("main", { type: "message_end", message: assistantMessage("final") }));

		const item = assistantItem(agent.timeline);
		expect(item.text).toBe("final");
		expect(item.streaming).toBe(false);
		expect(agent.pendingAssistantText).toBeUndefined();
	});

	it("flushes immediately on tool_execution_start", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("before tool")));

		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);

		expect(assistantItem(agent.timeline).text).toBe("before tool");
		expect(agent.pendingAssistantText).toBeUndefined();
	});

	it("flushes pending text when thinking ends", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("after thinking")));

		projector.apply(
			harness("main", {
				type: "message_update",
				message: assistantMessage("after thinking"),
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 0,
					content: "reasoning",
					partial: assistantMessage("after thinking"),
				},
			}),
		);

		expect(assistantItem(agent.timeline).text).toBe("after thinking");
		expect(agent.pendingAssistantText).toBeUndefined();
	});

	it("buffers tool_execution_update until flush and drops it on tool end", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "ls" },
			}),
		);
		const tool = toolItem(agent.timeline, "tool-1");
		projector.apply(
			harness("main", {
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "ls -la" },
				partialResult: { output: "partial" },
			}),
		);

		expect(tool.args).toEqual({ command: "ls" });
		expect(tool.partialResult).toBeUndefined();

		expect(flushStreaming(agent)).toBe(true);
		expect(tool.args).toEqual({ command: "ls -la" });
		expect(tool.partialResult).toEqual({ output: "partial" });

		projector.apply(
			harness("main", {
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "ls -la" },
				partialResult: { output: "later" },
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				result: { output: "done" },
				isError: false,
			}),
		);
		// The end event consumed the pending update; nothing left to flush.
		expect(agent.pendingToolUpdates?.size ?? 0).toBe(0);
		expect(flushStreaming(agent)).toBe(false);
	});

	it("flushes pending text when a human request opens", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("needs input")));

		projector.apply({
			type: "human_request_pending",
			agentId: "main",
			request: {
				id: "request-1",
				agentId: "main",
				source: { kind: "human" },
				kind: "confirm",
				title: "Continue?",
				createdAt: timestamp(1),
			},
		});

		expect(assistantItem(agent.timeline).text).toBe("needs input");
		expect(agent.pendingAssistantText).toBeUndefined();
	});

	it("flushes pending text when the run is aborted", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(1) });
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("interrupted tail")));

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(2) });

		expect(assistantItem(agent.timeline).text).toBe("interrupted tail");
		expect(agent.pendingAssistantText).toBeUndefined();
	});

	it("beginHydration discards pending buffers", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(harness("main", textUpdate("stale draft")));

		projector.beginHydration("main");

		expect(agent.pendingAssistantText).toBeUndefined();
		expect(flushStreaming(agent)).toBe(false);
	});
});

function harness(
	agentId: string,
	event: Extract<OrchestratorEvent, { type: "agent_harness_event" }>["event"],
): Extract<OrchestratorEvent, { type: "agent_harness_event" }> {
	return { type: "agent_harness_event", agentId, event };
}

function textUpdate(text: string): Extract<OrchestratorEvent, { type: "agent_harness_event" }>["event"] {
	return {
		type: "message_update",
		message: assistantMessage(text),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistantMessage(text) },
	};
}

function assistantItem(timeline: readonly TimelineItem[]) {
	const item = timeline.find((entry) => entry.type === "assistant-message");
	if (!item || item.type !== "assistant-message") {
		throw new Error("Expected an assistant timeline item.");
	}
	return item;
}

function toolItem(timeline: readonly TimelineItem[], toolCallId: string) {
	const item = timeline.find((entry) => entry.type === "tool-execution");
	if (!item || item.type !== "tool-execution" || item.toolCallId !== toolCallId) {
		throw new Error("Expected a tool timeline item.");
	}
	return item;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
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
		timestamp: Date.parse(timestamp(1)),
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
