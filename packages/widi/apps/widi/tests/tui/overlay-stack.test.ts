import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { OverlayStack, type OverlayStackHost } from "../../src/tui/layout/overlay-stack.ts";
import { createTuiApplicationState, type TuiApplicationState } from "../../src/tui/state.ts";

type StubComponent = Component & { readonly name: string };

function stubComponent(name: string): StubComponent {
	return { name, render: () => [name], invalidate: () => {} };
}

function createHarness() {
	const state: TuiApplicationState = createTuiApplicationState();
	const editor = stubComponent("editor");
	const docked = stubComponent("docked");
	let dockedOpen = false;
	let focused: Component | null = editor;
	const visible: Component[] = [];
	const host: OverlayStackHost = {
		showOverlay(component) {
			visible.push(component);
			focused = component;
			return {
				hide: () => {
					const index = visible.indexOf(component);
					if (index >= 0) visible.splice(index, 1);
				},
				setHidden: () => {},
				isHidden: () => false,
				focus: () => {
					focused = component;
				},
				unfocus: () => {},
				isFocused: () => focused === component,
			};
		},
		setFocus(component) {
			focused = component;
		},
		requestRender: () => {},
	};
	const stack = new OverlayStack({ host, state, editor, dockedFocusTarget: () => (dockedOpen ? docked : undefined) });
	return {
		state,
		editor,
		docked,
		stack,
		visible,
		focusName: () => (focused as StubComponent | null)?.name ?? null,
		setDockedOpen: (open: boolean) => {
			dockedOpen = open;
			if (open) focused = docked;
		},
	};
}

describe("OverlayStack", () => {
	it("captures focus on show and contributes its mode to state.mode", () => {
		const { state, stack, focusName } = createHarness();

		stack.show(stubComponent("selector"), { mode: "selector", dismissible: true });

		expect(focusName()).toBe("selector");
		expect(state.mode).toBe("selector");
	});

	it("falls back to the editor when the only overlay closes", () => {
		const { state, editor, stack, focusName } = createHarness();
		const handle = stack.show(stubComponent("selector"), { mode: "selector" });

		handle.close();

		expect(handle.closed).toBe(true);
		expect(focusName()).toBe("editor");
		expect(state.mode).toBe("editor");
		expect(editor).toBeDefined();
	});

	it("returns focus to the overlay below when a nested overlay closes", () => {
		const { state, stack, focusName } = createHarness();
		const first = stack.show(stubComponent("first"), { mode: "selector", dismissible: true });
		const second = stack.show(stubComponent("second"), { mode: "selector", dismissible: true });
		expect(focusName()).toBe("second");

		second.close();
		expect(focusName()).toBe("first");
		expect(state.mode).toBe("selector");

		first.close();
		expect(focusName()).toBe("editor");
		expect(state.mode).toBe("editor");
	});

	it("hands focus to the open docked component before the editor", () => {
		const { stack, focusName, setDockedOpen } = createHarness();
		setDockedOpen(true);
		const handle = stack.show(stubComponent("selector"), { mode: "selector" });

		handle.close();

		expect(focusName()).toBe("docked");
	});

	it("dismiss closes the topmost dismissible overlay and skips the rest", () => {
		const { stack, focusName } = createHarness();
		const dismissible = stack.show(stubComponent("selector"), { mode: "selector", dismissible: true });
		const modal = stack.show(stubComponent("fatal"));

		// The modal on top is not dismissible; interrupt still retires the
		// selector underneath it, and focus stays with the modal.
		expect(stack.dismiss()).toBe(true);
		expect(dismissible.closed).toBe(true);
		expect(modal.closed).toBe(false);
		expect(focusName()).toBe("fatal");

		expect(stack.dismiss()).toBe(false);
		modal.close();
		expect(focusName()).toBe("editor");
	});

	it("keeps state.mode unchanged for an overlay without a mode", () => {
		const { state, stack } = createHarness();

		stack.show(stubComponent("fatal"));

		expect(state.mode).toBe("editor");
	});

	it("close is idempotent", () => {
		const { state, stack, focusName } = createHarness();
		const handle = stack.show(stubComponent("selector"), { mode: "selector" });

		handle.close();
		handle.close();

		expect(handle.closed).toBe(true);
		expect(focusName()).toBe("editor");
		expect(state.focus.overlays).toHaveLength(0);
		expect(stack.list()).toHaveLength(0);
	});
});
