import { describe, expect, it } from "vitest";
import { EventProjector } from "../../src/tui/event-projector.ts";
import {
	createAgentViewState,
	createTuiApplicationState,
	setActiveAgent,
	type TimelineItem,
} from "../../src/tui/state.ts";
import { applyTimelineWindow, groupTurns, turnsToTrim } from "../../src/tui/timeline-window.ts";

describe("groupTurns", () => {
	it("opens a new turn at each user message", () => {
		const turns = groupTurns([
			userItem("u1"),
			assistantItem("a1"),
			toolItem("t1"),
			userItem("u2"),
			assistantItem("a2"),
		]);
		expect(turns.map((turn) => turn.items.map((item) => item.id))).toEqual([
			["u1", "a1", "t1"],
			["u2", "a2"],
		]);
	});

	it("attaches leading stray items to the next turn", () => {
		const turns = groupTurns([noticeItem("n1"), userItem("u1"), assistantItem("a1")]);
		expect(turns.map((turn) => turn.items.map((item) => item.id))).toEqual([["n1", "u1", "a1"]]);
	});

	it("collects stray items into their own turn when no user message exists", () => {
		const turns = groupTurns([noticeItem("n1"), noticeItem("n2")]);
		expect(turns.map((turn) => turn.items.map((item) => item.id))).toEqual([["n1", "n2"]]);
	});
});

describe("turnsToTrim", () => {
	it("trims nothing within maxTurns", () => {
		const turns = groupTurns(turnItems(3));
		expect(turnsToTrim(turns, 15, 5).size).toBe(0);
	});

	it("trims nothing while within the hysteresis band", () => {
		const turns = groupTurns(turnItems(20));
		expect(turnsToTrim(turns, 15, 5).size).toBe(0);
	});

	it("trims the oldest turns down to maxTurns once hysteresis is exceeded", () => {
		const turns = groupTurns(turnItems(21));
		const trim = turnsToTrim(turns, 15, 5);
		expect(trim).toContain("user-message:user-0");
		expect(trim).toContain("user-message:user-5");
		expect(trim).not.toContain("user-message:user-6");
		expect(trim).not.toContain("user-message:user-20");
		// Six whole turns (user + assistant each) are removed.
		expect(trim.size).toBe(12);
	});

	it("never trims the most recent turn", () => {
		const turns = groupTurns(turnItems(3));
		const trim = turnsToTrim(turns, 1, 0);
		expect(trim).toContain("user-message:user-0");
		expect(trim).toContain("user-message:user-1");
		expect(trim).not.toContain("user-message:user-2");
	});

	it("treats maxTurns 0 as disabled", () => {
		const turns = groupTurns(turnItems(30));
		expect(turnsToTrim(turns, 0, 0).size).toBe(0);
	});
});

describe("applyTimelineWindow", () => {
	it("trims old turns and inserts a single marker", () => {
		const agent = createAgentViewState("main");
		agent.timeline = turnItems(21);

		expect(applyTimelineWindow(agent)).toBe(true);

		const marker = agent.timeline[0];
		expect(marker).toMatchObject({ type: "window-marker", hiddenTurns: 6 });
		expect(agent.timeline).toHaveLength(1 + 15 * 2);
		expect(agent.timeline[1]).toMatchObject({ type: "user-message", id: "user-6" });
	});

	it("is idempotent and accumulates hiddenTurns across later trims", () => {
		const agent = createAgentViewState("main");
		agent.timeline = turnItems(21);
		applyTimelineWindow(agent);

		// No new turns: nothing changes, no second marker.
		expect(applyTimelineWindow(agent)).toBe(false);
		expect(agent.timeline.filter((item) => item.type === "window-marker")).toHaveLength(1);

		// Six more turns arrive; the window trims again and the count adds up.
		agent.timeline.push(...turnItems(6, 21));
		expect(applyTimelineWindow(agent)).toBe(true);
		const marker = agent.timeline[0];
		expect(marker).toMatchObject({ type: "window-marker", hiddenTurns: 12 });
		expect(agent.timeline).toHaveLength(1 + 15 * 2);
	});

	it("does nothing below the trim threshold", () => {
		const agent = createAgentViewState("main");
		agent.timeline = turnItems(20);
		expect(applyTimelineWindow(agent)).toBe(false);
		expect(agent.timeline.some((item) => item.type === "window-marker")).toBe(false);
	});
});

describe("timeline window integration", () => {
	it("trims when a new user message opens a turn beyond the threshold", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		for (let i = 0; i < 21; i++) {
			projector.apply(userMessageStart("main", `question ${i}`));
		}

		const agent = state.agents.get("main");
		if (!agent) throw new Error("Expected main projection.");
		expect(agent.timeline[0]).toMatchObject({ type: "window-marker", hiddenTurns: 6 });
		expect(agent.timeline).toHaveLength(1 + 15);
	});

	it("re-applies the window after hydration without double counting", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		// A marker from the live view must not survive the rebuild: the hydrated
		// timeline contains the full history again.
		agent.timeline.push({
			type: "window-marker",
			id: "window-marker",
			durability: "ephemeral",
			createdAt: timestamp(0),
			hiddenTurns: 3,
		});

		projector.beginHydration("main");
		projector.completeHydration("main", { timeline: turnItems(25), display: {} });

		const markers = agent.timeline.filter((item) => item.type === "window-marker");
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({ hiddenTurns: 10 });
		expect(agent.timeline).toHaveLength(1 + 15 * 2);
	});
});

function turnItems(count: number, startIndex = 0): TimelineItem[] {
	const items: TimelineItem[] = [];
	for (let i = startIndex; i < startIndex + count; i++) {
		items.push(userItem(`user-${i}`), assistantItem(`assistant-${i}`));
	}
	return items;
}

function userItem(id: string): TimelineItem {
	return { type: "user-message", id, durability: "durable", createdAt: timestamp(0), text: `message ${id}` };
}

function assistantItem(id: string): TimelineItem {
	return {
		type: "assistant-message",
		id,
		durability: "durable",
		createdAt: timestamp(0),
		text: `reply ${id}`,
		streaming: false,
	};
}

function toolItem(id: string): TimelineItem {
	return {
		type: "tool-execution",
		id,
		toolCallId: id,
		durability: "durable",
		createdAt: timestamp(0),
		toolName: "bash",
		status: "completed",
	};
}

function noticeItem(id: string): TimelineItem {
	return { type: "application-notice", id, durability: "ephemeral", createdAt: timestamp(0), text: `notice ${id}` };
}

function userMessageStart(agentId: string, text: string) {
	return {
		type: "agent_harness_event" as const,
		agentId,
		event: {
			type: "message_start" as const,
			message: { role: "user" as const, content: text, timestamp: Date.parse(timestamp(0)) },
		},
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
