/**
 * The on-the-wire shape of an orchestrator event.
 *
 * Every event but one crosses unchanged: the persistence layer already writes
 * session entries with `JSON.stringify`, so everything reachable from a branch
 * is JSON-safe by construction, and the remaining payloads were audited to be
 * plain data (`notes/develop/rpc-mode.md`, "已核实的事实").
 *
 * The exception is `message_update`, which carries the whole assistant message
 * accumulated so far - twice, as `message` and as `assistantMessageEvent
 * .partial`. In process those are pointer copies and the TUI re-renders from
 * them. Serialised, they make one response cost bytes quadratic in its own
 * length, with any image re-encoded on every token. So both accumulations are
 * dropped and the client accumulates deltas itself; `message_start` and
 * `message_end` still carry the authoritative message, once each.
 *
 * `usage` survives because it is the one fact only the accumulation carried and
 * its size is constant.
 *
 * The projected type is exported, not just the function: a client author who
 * writes against the in-process type would reach for a `partial` that is not
 * there.
 */

import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { AgentId, OrchestratorEvent } from "../core/types.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

export type WireAssistantMessageEvent = WithoutPartial<AssistantMessageEvent>;

export interface WireMessageUpdateEvent {
	readonly type: "message_update";
	/** Absent when the streamed message was not an assistant message. */
	readonly usage?: Usage;
	readonly assistantMessageEvent: WireAssistantMessageEvent;
}

export type WireHarnessEvent = Exclude<AgentHarnessEvent, { type: "message_update" }> | WireMessageUpdateEvent;

export type WireOrchestratorEvent =
	| Exclude<OrchestratorEvent, { type: "agent_harness_event" }>
	| { readonly type: "agent_harness_event"; readonly agentId: AgentId; readonly event: WireHarnessEvent };

export function toWireEvent(event: OrchestratorEvent): WireOrchestratorEvent {
	if (event.type !== "agent_harness_event") return event;
	const inner = event.event;
	if (inner.type !== "message_update") {
		return { type: "agent_harness_event", agentId: event.agentId, event: inner };
	}
	return { type: "agent_harness_event", agentId: event.agentId, event: toWireMessageUpdate(inner) };
}

function toWireMessageUpdate(event: Extract<AgentHarnessEvent, { type: "message_update" }>): WireMessageUpdateEvent {
	const usage = event.message.role === "assistant" ? event.message.usage : undefined;
	const assistantMessageEvent = stripPartial(event.assistantMessageEvent);
	return usage === undefined
		? { type: "message_update", assistantMessageEvent }
		: { type: "message_update", usage, assistantMessageEvent };
}

function stripPartial(event: AssistantMessageEvent): WireAssistantMessageEvent {
	if (!("partial" in event)) return event as WireAssistantMessageEvent;
	const { partial: _partial, ...rest } = event;
	return rest as WireAssistantMessageEvent;
}
