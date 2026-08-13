/**
 * Throttled flush for streaming timeline updates.
 *
 * message_update and tool_execution_update events arrive per token; writing
 * them straight into the timeline would invalidate the ChatView render cache
 * on every event. The projector accumulates them in pending buffers on the
 * agent view state instead, and this module folds the buffers into the
 * timeline — either on a timer (application layer) or immediately at stream
 * boundaries (message end, tool start, hydration, abort).
 */

import type { AgentViewState } from "./state.ts";

/**
 * Read a non-negative integer env var, falling back to `fallback` when it is
 * unset, empty, negative, or not an integer.
 */
export function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) return fallback;
	return value;
}

/** Interval between timer-driven streaming flushes. */
export const STREAM_FLUSH_MS = readEnvInt("WIDI_TUI_STREAM_FLUSH_MS", 80);

/**
 * Fold pending streaming buffers into the timeline. Returns whether any item
 * was written, so callers can decide whether a re-render is needed.
 */
export function flushStreaming(agent: AgentViewState): boolean {
	let wrote = false;
	const pending = agent.pendingAssistantText;
	if (pending) {
		agent.pendingAssistantText = undefined;
		const item = agent.timeline.find((entry) => entry.type === "assistant-message" && entry.id === pending.itemId);
		if (item?.type === "assistant-message") {
			item.text = pending.text;
			item.message = pending.message;
			wrote = true;
		}
	}
	if (agent.pendingToolUpdates && agent.pendingToolUpdates.size > 0) {
		for (const [toolCallId, update] of agent.pendingToolUpdates) {
			const tool = agent.timeline.find((entry) => entry.type === "tool-execution" && entry.toolCallId === toolCallId);
			if (tool?.type === "tool-execution") {
				tool.args = update.args;
				tool.partialResult = update.partialResult;
				wrote = true;
			}
		}
		agent.pendingToolUpdates.clear();
	}
	return wrote;
}
