import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { toWireEvent } from "../../src/rpc/wire-event.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test-provider",
		model: "default-model",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageUpdate(assistantMessageEvent: AssistantMessageEvent): OrchestratorEvent {
	return {
		type: "agent_harness_event",
		agentId: "agent-1",
		event: { type: "message_update", message: assistantMessage("hello"), assistantMessageEvent },
	};
}

describe("toWireEvent", () => {
	it("drops both accumulations from a streaming delta and keeps usage", () => {
		const wire = toWireEvent(
			messageUpdate({ type: "text_delta", contentIndex: 0, delta: "o", partial: assistantMessage("hello") }),
		);

		expect(wire.type).toBe("agent_harness_event");
		if (wire.type !== "agent_harness_event") return;
		const inner = wire.event;
		expect(inner.type).toBe("message_update");
		if (inner.type !== "message_update") return;

		// The per-token accumulations are what make this quadratic on the wire.
		expect("message" in inner).toBe(false);
		expect("partial" in inner.assistantMessageEvent).toBe(false);
		// The one fact only the accumulation carried, and its size is constant.
		expect(inner.usage?.totalTokens).toBe(30);
		expect(inner.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "o" });
	});

	it("leaves a delta that carries no accumulation alone", () => {
		const wire = toWireEvent(messageUpdate({ type: "done", reason: "stop" } as AssistantMessageEvent));
		if (wire.type !== "agent_harness_event" || wire.event.type !== "message_update") {
			throw new Error("expected a projected message_update");
		}
		expect(wire.event.assistantMessageEvent).toEqual({ type: "done", reason: "stop" });
	});

	it("omits usage when the streamed message is not an assistant message", () => {
		const wire = toWireEvent({
			type: "agent_harness_event",
			agentId: "agent-1",
			event: {
				type: "message_update",
				message: { role: "user", content: "hi", timestamp: 1 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o", partial: assistantMessage("h") },
			} as AgentHarnessEvent,
		});
		if (wire.type !== "agent_harness_event" || wire.event.type !== "message_update") {
			throw new Error("expected a projected message_update");
		}
		expect(wire.event.usage).toBeUndefined();
	});

	it("passes every other harness event through by identity", () => {
		const event: OrchestratorEvent = {
			type: "agent_harness_event",
			agentId: "agent-1",
			event: { type: "message_end", message: assistantMessage("hello") },
		};
		const wire = toWireEvent(event);
		if (wire.type !== "agent_harness_event") throw new Error("expected a harness event");
		// message_end carries the authoritative message once, which is what makes
		// dropping the per-delta accumulations lossless.
		expect(wire.event).toBe(event.event);
	});

	it("passes non-harness events through by identity", () => {
		const event: OrchestratorEvent = {
			type: "agent_idle",
			agentId: "agent-1",
			reason: "settled",
			idleAt: "2026-08-13T00:00:00.000Z",
		};
		expect(toWireEvent(event)).toBe(event);
	});
});
