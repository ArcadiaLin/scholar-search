import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import { ListSelector } from "../../src/tui/selectors/list-selector.ts";
import {
	clearDockedFocus,
	createTuiApplicationState,
	hasDockedFocus,
	setDockedFocus,
	topDockedFocus,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("docked focus stack", () => {
	it("derives the mode from the top claimant and falls back to the editor", () => {
		const state = createTuiApplicationState();
		expect(state.mode).toBe("editor");

		setDockedFocus(state, "selector");
		expect(state.mode).toBe("selector");

		setDockedFocus(state, "human-request");
		expect(state.mode).toBe("human-request");

		clearDockedFocus(state, "human-request");
		expect(state.mode).toBe("selector");

		clearDockedFocus(state, "selector");
		expect(state.mode).toBe("editor");
	});

	it("keeps a preempted claimant docked while another holds the keys", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");
		setDockedFocus(state, "human-request");

		expect(topDockedFocus(state)).toBe("human-request");
		expect(hasDockedFocus(state, "selector")).toBe(true);
	});

	it("removes a preempted claimant that closes from under the one above it", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");
		setDockedFocus(state, "human-request");

		clearDockedFocus(state, "selector");

		expect(state.focus.docked).toEqual(["human-request"]);
	});

	it("leaves the stack alone when a claimant that never claimed releases", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");

		clearDockedFocus(state, "agent-panel");

		expect(state.focus.docked).toEqual(["selector"]);
	});

	it("raises a re-claiming component instead of stacking it twice", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");
		setDockedFocus(state, "human-request");

		setDockedFocus(state, "selector");

		expect(state.focus.docked).toEqual(["human-request", "selector"]);
	});

	it("clears every claim when no claimant is named", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");
		setDockedFocus(state, "human-request");

		clearDockedFocus(state);

		expect(state.focus.docked).toEqual([]);
		expect(state.mode).toBe("editor");
	});

	it("puts an overlay above every docked claimant", () => {
		const state = createTuiApplicationState();
		setDockedFocus(state, "selector");
		state.focus.overlays.push({ mode: "human-request" });

		expect(state.mode).toBe("human-request");
	});
});

describe("preempted selector rendering", () => {
	function render(selector: ListSelector): string {
		return selector.render(80).join("\n").replace(ANSI_SEQUENCE, "");
	}

	it("drops the key hints while another layer holds the keys", () => {
		const selector = new ListSelector({
			title: "/model",
			items: [{ value: "a", label: "alpha" }],
			onSelect: () => {},
			onClose: () => {},
		});
		selector.focused = true;
		expect(render(selector)).toContain("Enter select");

		selector.focused = false;

		const preempted = render(selector);
		expect(preempted).not.toContain("Enter select");
		expect(preempted).not.toContain("Esc cancel");
		// The view keeps its place and its cursor row; it just is not listening.
		expect(preempted).toContain("/model");
		expect(preempted).toContain("→ alpha");
	});
});
