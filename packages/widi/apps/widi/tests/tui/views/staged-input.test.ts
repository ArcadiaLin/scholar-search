import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import { createTuiApplicationState, setActiveAgent } from "../../../src/tui/state.ts";
import { StagedInputView } from "../../../src/tui/views/staged-input.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("StagedInputView", () => {
	it("renders nothing until something is staged", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main");

		expect(new StagedInputView(state).render(100)).toEqual([]);
	});

	it("says what is staged and how to reach it", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.staged.push({ id: 1, text: "read the fork doc first", extensionId: "notes" });

		const rendered = new StagedInputView(state).render(100).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toContain("staged · 1 message");
		expect(rendered).toContain("read the fork doc first");
		expect(rendered).toContain("Ctrl+X edit");
	});

	it("drops the edit hint while the editor already holds a draft", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		const draft = { id: 1, text: "held in the editor", extensionId: "notes" };
		agent.staged.push({ id: 2, text: "still staged" });
		agent.stagedEditing = { draft, index: 0 };

		const rendered = new StagedInputView(state).render(100).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toContain("still staged");
		expect(rendered).not.toContain("edit");
	});

	it("counts the drafts it does not show", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		for (let i = 0; i < 5; i++) agent.staged.push({ id: i, text: `draft ${i}` });

		const rendered = new StagedInputView(state).render(100).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toContain("staged · 5 messages");
		expect(rendered).toContain("… +2 more");
		expect(rendered).not.toContain("draft 1");
	});
});
