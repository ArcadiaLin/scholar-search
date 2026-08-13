import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { widiCommands } from "../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../src/tui/commands/engine.ts";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import { setSteadyQuip, setTransientQuip } from "../../../src/tui/quips.ts";
import {
	type AgentViewState,
	createTuiApplicationState,
	setActiveAgent,
	type TuiApplicationState,
} from "../../../src/tui/state.ts";
import { WorkingLineView } from "../../../src/tui/views/working-line.ts";
import { stubCommandHost } from "../../helpers/command-host.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const engine = new CommandEngine(widiCommands(stubCommandHost()));
const editor = { getText: () => "", isShowingAutocomplete: () => false };

function render(state: TuiApplicationState, width = 120): string {
	return new WorkingLineView({ state, engine, editor }).render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

function running(state: TuiApplicationState, startedMsAgo = 72_000): AgentViewState {
	const agent = setActiveAgent(state, "main");
	agent.status = "running";
	agent.runStartedAt = new Date(Date.now() - startedMsAgo).toISOString();
	setSteadyQuip(agent, "working", () => 0);
	return agent;
}

/** A named subject for the facts segment, which only a tool call gives it. */
function withRunningTool(agent: AgentViewState, toolName = "Bash"): AgentViewState {
	agent.timeline.push({
		type: "tool-execution",
		id: "call-1",
		toolCallId: "call-1",
		durability: "durable",
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		toolName,
		status: "running",
	});
	return agent;
}

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("WorkingLineView", () => {
	it("says nothing about an agent that has not transitioned yet", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main");

		expect(new WorkingLineView({ state, engine, editor }).render(120)).toEqual([]);
	});

	// The spacer belongs to this component so it disappears with the line; a
	// blank row left behind by a silent working line is just a hole.
	it("keeps a blank row between itself and the transcript", () => {
		const state = createTuiApplicationState();
		running(state);

		const lines = new WorkingLineView({ state, engine, editor }).render(120);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("");
	});

	it("reports the quip, the run and the keys that apply", () => {
		const state = createTuiApplicationState();
		withRunningTool(running(state));

		const line = render(state);

		expect(line).toContain("Working");
		expect(line).toContain("Bash · 1m12s");
		expect(line).toContain("Esc abort");
	});

	// The transcript already shows a live "Thinking…" row, so this line saying it
	// again would be the same fact in two places; the dots carry the liveness.
	it("says nothing but the quip while the run only waits on the model", () => {
		const state = createTuiApplicationState();
		running(state, 8_000);

		const line = render(state);

		expect(line).toContain("Working");
		expect(line).not.toContain("thinking");
		expect(line).not.toContain("8s");
	});

	it("names the maintenance phase instead of a tool", () => {
		const state = createTuiApplicationState();
		const agent = running(state, 3_000);
		agent.maintenance = "compaction";

		const line = render(state);

		expect(line).toContain("Compacting · 3s");
		expect(line).toContain("queue follow-up");
		expect(line).not.toContain("abort");
	});

	it("reports what the finished run cost", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.lastRun = { startedAt: new Date(0).toISOString(), endedAt: new Date(108_000).toISOString(), toolCount: 3 };
		setTransientQuip(agent, "done", Date.now(), () => 0);

		const line = render(state);

		expect(line).toContain("✔");
		expect(line).toContain("Done");
		expect(line).toContain("3 tools · 1m48s");
	});

	it("says who stopped the run", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.lastRun = { startedAt: new Date(0).toISOString(), endedAt: new Date(4_000).toISOString(), toolCount: 0 };

		setTransientQuip(agent, "aborted-by-human", Date.now(), () => 0);
		expect(render(state)).toContain("aborted by you · 4s");

		setTransientQuip(agent, "aborted-by-extension", Date.now(), () => 0);
		expect(render(state)).toContain("aborted by an extension · 4s");
	});

	// The whole point of pinning the column: the two segments to its right must
	// land in the same place whatever the quip happens to be saying.
	it("keeps the segments after the quip from moving", () => {
		const state = createTuiApplicationState();
		const agent = withRunningTool(running(state, 5_000));

		setSteadyQuip(agent, "idle", () => 0);
		const short = render(state).indexOf("5s");
		agent.quip = undefined;
		setSteadyQuip(agent, "working", () => 0.4);
		const other = render(state).indexOf("5s");

		expect(short).toBeGreaterThan(0);
		expect(other).toBe(short);
	});

	it("drops the keys first, then the subject, as the terminal narrows", () => {
		const state = createTuiApplicationState();
		withRunningTool(running(state, 5_000), "Bash");

		expect(render(state, 120)).toContain("Esc abort");
		const narrow = render(state, 48);
		expect(narrow).not.toContain("Esc abort");
		expect(narrow).toContain("Bash · 5s");
		const narrower = render(state, 40);
		expect(narrower).not.toContain("Bash");
		expect(narrower).toContain("5s");
	});

	it("stays inside the terminal width", () => {
		const state = createTuiApplicationState();
		running(state);

		for (const width of [20, 40, 80, 120]) {
			for (const line of new WorkingLineView({ state, engine, editor }).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
