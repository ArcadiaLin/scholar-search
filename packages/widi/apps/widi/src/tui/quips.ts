import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * What the working line is reporting. Not the agent's status: several of these
 * are moments rather than states, and they are what the line is for - a run
 * that ended is worth a beat of its own before the line settles back to idle.
 */
export type WorkingState =
	| "idle"
	| "working"
	| "done"
	| "aborted"
	| "aborted-by-human"
	| "aborted-by-extension"
	| "poked"
	| "error";

/** States that pass rather than hold, and how long the line keeps saying them. */
export const QUIP_LINGER_MS = 2_500;

/**
 * One pool per state, drawn from at random. There is deliberately no setting
 * here: this is a handful of lines, not a feature, and asking which voice it
 * should speak in would make more of it than it is. The plain wording sits in
 * the same pool as the rest and comes up as often.
 */
const QUIPS: Readonly<Record<WorkingState, readonly string[]>> = {
	idle: ["Ready", "Yes?", "Something need doing?", "Ready to work.", "What you want?", "Yes, milord?", "More work?"],
	working: ["Working", "Work work.", "Zug zug.", "Okey dokey.", "Right-o.", "Off I go, then!", "As you wish."],
	done: ["Done", "Job's done."],
	aborted: ["Stopped", "Me stop.", "I've stopped, milord."],
	"aborted-by-human": ["Stopped", "Okay, okay!", "As you wish, milord."],
	"aborted-by-extension": ["Stopped", "Something stop me.", "I've been called off."],
	poked: ["Working", "Stop poking me!", "I'm going, I'm going!"],
	error: ["Failed", "Me not that kind of orc!", "That's beyond me, milord."],
};

export interface Quip {
	readonly state: WorkingState;
	readonly text: string;
}

/**
 * The steady line plus, when something just happened, the line saying so.
 *
 * Two slots rather than one because the two arrive independently: a run ending
 * publishes both the stop and the return to idle, in an order this layer does
 * not get to choose, and the transient must survive the steady line landing
 * either side of it.
 */
export interface AgentQuip {
	steady: Quip;
	transient?: Quip & { readonly expiresAt: number };
}

/** A quip holder, kept structural so state.ts stays out of this module. */
interface QuipCarrier {
	quip?: AgentQuip;
}

export function rollQuip(state: WorkingState, random: () => number = Math.random): string {
	const lines = QUIPS[state];
	return lines[Math.floor(random() * lines.length)] ?? lines[0];
}

/**
 * The line the agent holds while nothing is happening to it. Re-entering a
 * state it is already in keeps the line it already rolled: rolling per event
 * would reword the same situation every time anything touched the agent.
 */
export function setSteadyQuip(carrier: QuipCarrier, state: WorkingState, random?: () => number): void {
	if (carrier.quip?.steady.state === state) return;
	const steady = { state, text: rollQuip(state, random) };
	carrier.quip = carrier.quip ? { ...carrier.quip, steady } : { steady };
}

/** A line for something that just happened, shown for QUIP_LINGER_MS. */
export function setTransientQuip(
	carrier: QuipCarrier,
	state: WorkingState,
	at: number = Date.now(),
	random?: () => number,
): void {
	const transient = { state, text: rollQuip(state, random), expiresAt: at + QUIP_LINGER_MS };
	carrier.quip = carrier.quip ? { ...carrier.quip, transient } : { steady: transient, transient };
}

/** What the line says now: the unexpired transient, else the steady line. */
export function currentQuip(quip: AgentQuip | undefined, at: number = Date.now()): Quip | undefined {
	if (!quip) return undefined;
	if (quip.transient && at < quip.transient.expiresAt) return quip.transient;
	return quip.steady;
}

export function hasLiveTransientQuip(quip: AgentQuip | undefined, at: number = Date.now()): boolean {
	return quip?.transient !== undefined && at < quip.transient.expiresAt;
}

/**
 * Width the quip column is pinned to: the longest line the pool can produce.
 * Without this the two segments to its right jump sideways every time the line
 * changes, which is the one way this row is easy to ruin.
 */
export const QUIP_COLUMN_WIDTH = Object.values(QUIPS)
	.flat()
	.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0);
