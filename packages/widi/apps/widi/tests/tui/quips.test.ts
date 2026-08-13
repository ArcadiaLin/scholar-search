import { describe, expect, it } from "vitest";
import {
	type AgentQuip,
	currentQuip,
	hasLiveTransientQuip,
	QUIP_COLUMN_WIDTH,
	QUIP_LINGER_MS,
	rollQuip,
	setSteadyQuip,
	setTransientQuip,
	type WorkingState,
} from "../../src/tui/quips.ts";

/** Always the first candidate, so a roll is a table lookup in tests. */
const first = () => 0;

const STATES: readonly WorkingState[] = [
	"idle",
	"working",
	"done",
	"aborted",
	"aborted-by-human",
	"aborted-by-extension",
	"poked",
	"error",
];

describe("quips", () => {
	it("has a line for every state", () => {
		for (const state of STATES) {
			expect(rollQuip(state, first)).not.toBe("");
		}
	});

	// The plain wording is in the pool rather than behind a setting: one pool is
	// the whole point of not making this a choice.
	it("draws plain and flavoured lines from the same pool", () => {
		expect(rollQuip("working", () => 0)).toBe("Working");
		expect(rollQuip("working", () => 0.3)).toBe("Zug zug.");
		expect(rollQuip("working", () => 0.9)).toBe("As you wish.");
	});

	it("pins the column to the longest line the pool can produce", () => {
		expect(QUIP_COLUMN_WIDTH).toBe("That's beyond me, milord.".length);
	});
});

describe("quip state", () => {
	it("keeps the line it rolled while the state does not change", () => {
		const carrier: { quip?: AgentQuip } = {};
		setSteadyQuip(carrier, "working", () => 0.3);
		setSteadyQuip(carrier, "working", () => 0.9);

		expect(carrier.quip?.steady.text).toBe("Zug zug.");
	});

	it("rolls again once the state actually changes", () => {
		const carrier: { quip?: AgentQuip } = {};
		setSteadyQuip(carrier, "working", first);
		setSteadyQuip(carrier, "idle", first);

		expect(carrier.quip?.steady).toEqual({ state: "idle", text: "Ready" });
	});

	it("shows the transient line until it expires, then the steady one", () => {
		const carrier: { quip?: AgentQuip } = {};
		setSteadyQuip(carrier, "idle", first);
		setTransientQuip(carrier, "done", 1_000, first);

		expect(currentQuip(carrier.quip, 1_000)).toMatchObject({ state: "done", text: "Done" });
		expect(hasLiveTransientQuip(carrier.quip, 1_000)).toBe(true);
		expect(currentQuip(carrier.quip, 1_000 + QUIP_LINGER_MS)).toEqual({ state: "idle", text: "Ready" });
		expect(hasLiveTransientQuip(carrier.quip, 1_000 + QUIP_LINGER_MS)).toBe(false);
	});

	// The stop and the return to idle are two events whose order this layer does
	// not choose; the transient has to survive the steady line landing after it.
	it("keeps a transient line when the steady one lands afterwards", () => {
		const carrier: { quip?: AgentQuip } = {};
		setSteadyQuip(carrier, "working", first);
		setTransientQuip(carrier, "done", 1_000, first);
		setSteadyQuip(carrier, "idle", first);

		expect(currentQuip(carrier.quip, 1_100)?.state).toBe("done");
		expect(currentQuip(carrier.quip, 1_000 + QUIP_LINGER_MS)?.state).toBe("idle");
	});

	it("says nothing about an agent that never transitioned", () => {
		expect(currentQuip(undefined)).toBeUndefined();
		expect(hasLiveTransientQuip(undefined)).toBe(false);
	});
});
