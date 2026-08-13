/**
 * Sliding window for the agent timeline.
 *
 * The timeline grows unbounded as the conversation goes on. To keep memory
 * and event-replay cost bounded, only the most recent N *turns* are kept — a
 * turn opens at each user message and covers everything until the next one —
 * and older turns are removed wholesale, leaving a single window-marker item
 * that records how many turns were hidden.
 *
 * All threshold logic here is pure so it can be unit-tested in isolation; the
 * projector only calls applyTimelineWindow when the turn count can grow (a
 * new user message, or a completed hydration).
 */

import type { AgentViewState, TimelineItem } from "./state.ts";
import { readEnvInt } from "./streaming-flush.ts";

/** Keep the most recent N turns. `0` disables trimming. */
export const TIMELINE_MAX_TURNS = readEnvInt("WIDI_TUI_MAX_TURNS", 15);

/** Only trim once the window exceeds maxTurns by this much (avoids churn). */
export const TIMELINE_HYSTERESIS = readEnvInt("WIDI_TUI_HYSTERESIS", 5);

const WINDOW_MARKER_ID = "window-marker";

export interface TimelineTurn {
	readonly items: readonly TimelineItem[];
}

/**
 * Group items into turns that open at each message the model reads as input -
 * what the person typed, and what the runtime put there on someone else's
 * behalf. Both start a reply, so both start a turn; counting only the typed
 * ones would leave a session driven by agent messages as one unbounded turn
 * that never trims. Items before the first such message (command results,
 * notices) attach to the next turn; stray items after the last turn's content
 * form their own tail turn.
 */
export function groupTurns(items: readonly TimelineItem[]): TimelineTurn[] {
	const turns: TimelineItem[][] = [];
	let pending: TimelineItem[] = [];
	for (const item of items) {
		if (item.type === "user-message" || item.type === "orchestrator-message") {
			turns.push([...pending, item]);
			pending = [];
		} else if (turns.length === 0) {
			pending.push(item);
		} else {
			turns[turns.length - 1]?.push(item);
		}
	}
	if (pending.length > 0) turns.push(pending);
	return turns.map((turnItems) => ({ items: turnItems }));
}

/**
 * Decide which items to remove so the remaining turns fit within `maxTurns`.
 * Returns an empty set while the turn count is within `maxTurns + hysteresis`.
 * Oldest turns are removed first; the most recent turn is never removed.
 */
export function turnsToTrim(turns: readonly TimelineTurn[], maxTurns: number, hysteresis: number): Set<string> {
	const toRemove = new Set<string>();
	if (maxTurns <= 0 || turns.length <= maxTurns + hysteresis) return toRemove;

	let remaining = turns.length;
	// `turns.length - 1` keeps the most recent turn off-limits.
	for (let i = 0; i < turns.length - 1 && remaining > maxTurns; i++) {
		const turn = turns[i];
		if (!turn) break;
		for (const item of turn.items) toRemove.add(timelineKey(item));
		remaining--;
	}
	return toRemove;
}

/**
 * Remove trimmed turns from the agent timeline and insert (or update) a
 * single window-marker item in front of the kept items. Idempotent: repeated
 * calls never create a second marker, and hiddenTurns accumulates across
 * incremental trims. Returns whether the timeline changed.
 */
export function applyTimelineWindow(agent: AgentViewState): boolean {
	const marker = agent.timeline.find((item) => item.type === "window-marker");
	const base = agent.timeline.filter((item) => item.type !== "window-marker");
	const turns = groupTurns(base);
	const trim = turnsToTrim(turns, TIMELINE_MAX_TURNS, TIMELINE_HYSTERESIS);
	if (trim.size === 0) return false;

	const kept = base.filter((item) => !trim.has(timelineKey(item)));
	const hiddenTurns = (marker?.type === "window-marker" ? marker.hiddenTurns : 0) + countTrimmedTurns(turns, trim);
	agent.timeline = [
		{
			type: "window-marker",
			id: WINDOW_MARKER_ID,
			durability: "ephemeral",
			createdAt: marker?.createdAt ?? new Date().toISOString(),
			hiddenTurns,
		},
		...kept,
	];
	return true;
}

function countTrimmedTurns(turns: readonly TimelineTurn[], trim: ReadonlySet<string>): number {
	let count = 0;
	for (const turn of turns) {
		if (turn.items.every((item) => trim.has(timelineKey(item)))) count++;
	}
	return count;
}

function timelineKey(item: TimelineItem): string {
	return `${item.type}:${item.id}`;
}
