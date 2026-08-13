import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import { createTuiApplicationState, setActiveAgent } from "../../../src/tui/state.ts";
import { QueuedInputView } from "../../../src/tui/views/queued-input.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("QueuedInputView", () => {
	it("renders follow-ups that core has not acknowledged yet", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "running";
		agent.maintenance = "compaction";
		agent.pendingFollowUps.push({ id: 1, text: "wait until compacted" });

		const rendered = new QueuedInputView(state).render(100).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toContain("wait until compacted");
		expect(rendered).not.toContain("steer now");
	});

	it("offers steering only while a real agent turn is running", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.queue.followUp = ["queued"];
		const view = new QueuedInputView(state);
		const render = () => view.render(100).join("\n").replace(ANSI_SEQUENCE, "");

		agent.status = "running";
		expect(render()).toContain("steer now");
		agent.status = "idle";
		expect(render()).not.toContain("steer now");
	});
});
