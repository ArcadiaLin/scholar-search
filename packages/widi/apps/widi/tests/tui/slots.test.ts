import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type LayoutSlotEntry, LayoutSlots } from "../../src/tui/layout/slots.ts";
import { createTuiApplicationState } from "../../src/tui/state.ts";

function stubComponent(lines: string[] = ["line"]): Component {
	return { render: () => lines, invalidate: () => {} };
}

function entry(key: string, overrides: Partial<LayoutSlotEntry> = {}): LayoutSlotEntry {
	return { key, slot: "aboveEditor", scope: "global", factory: () => stubComponent([key]), ...overrides };
}

describe("LayoutSlots", () => {
	it("keeps entries of one slot in registration order", () => {
		const slots = new LayoutSlots();
		slots.register(entry("first"));
		slots.register(entry("second"));
		slots.register(entry("third"));

		expect(slots.entries().map((registered) => registered.key)).toEqual(["first", "second", "third"]);
	});

	it("orders entries by slot regardless of registration order", () => {
		const slots = new LayoutSlots();
		slots.register(entry("strip", { slot: "agentStrip" }));
		slots.register(entry("editor", { slot: "editor" }));
		slots.register(entry("header", { slot: "header" }));
		slots.register(entry("footer", { slot: "footer" }));
		slots.register(entry("chat", { slot: "chat" }));

		expect(slots.entries().map((registered) => registered.key)).toEqual([
			"header",
			"chat",
			"editor",
			"footer",
			"strip",
		]);
	});

	it("puts belowEditor between the editor and the footer, and belowFooter after it", () => {
		const slots = new LayoutSlots();
		slots.register(entry("footer", { slot: "footer" }));
		slots.register(entry("hint", { slot: "belowFooter" }));
		slots.register(entry("working", { slot: "belowEditor" }));
		slots.register(entry("editor", { slot: "editor" }));

		expect(slots.entries().map((registered) => registered.key)).toEqual(["editor", "working", "footer", "hint"]);
	});

	it("breaks ties within a slot by order, then by registration", () => {
		const slots = new LayoutSlots();
		slots.register(entry("default"));
		slots.register(entry("last", { order: 10 }));
		slots.register(entry("first", { order: -10 }));
		slots.register(entry("alsoDefault"));

		expect(slots.entries().map((registered) => registered.key)).toEqual(["first", "default", "alsoDefault", "last"]);
	});

	it("refuses a duplicate key with a diagnostic and keeps the first entry", () => {
		const slots = new LayoutSlots();
		const first = entry("taken", { slot: "header" });
		expect(slots.register(first)).toBeUndefined();

		const diagnostic = slots.register(entry("taken", { slot: "footer" }));

		expect(diagnostic).toMatchObject({ severity: "warning", code: "layout.slot_conflict" });
		expect(slots.entries()).toHaveLength(1);
		expect(slots.entries()[0]).toBe(first);
	});

	it("unregisters by key", () => {
		const slots = new LayoutSlots();
		slots.register(entry("first"));
		slots.register(entry("second"));

		expect(slots.unregister("first")).toBe(true);
		expect(slots.unregister("first")).toBe(false);
		expect(slots.entries().map((registered) => registered.key)).toEqual(["second"]);
	});

	it("mounts instantiated components in slot order", () => {
		const slots = new LayoutSlots();
		slots.register(entry("footer", { slot: "footer" }));
		slots.register(entry("header", { slot: "header" }));
		const mounted: Component[] = [];

		slots.mount({ addChild: (component) => mounted.push(component) }, createTuiApplicationState());

		expect(mounted.map((component) => component.render(80))).toEqual([["header"], ["footer"]]);
	});

	it("routes transcript slots separately from the fixed dock", () => {
		const slots = new LayoutSlots();
		slots.register(entry("footer", { slot: "footer" }));
		slots.register(entry("chat", { slot: "chat" }));
		slots.register(entry("header", { slot: "header" }));
		const transcript: Component[] = [];
		const dock: Component[] = [];

		slots.mount(
			{
				transcript: { addChild: (component) => transcript.push(component), children: transcript },
				dock: { addChild: (component) => dock.push(component), children: dock },
			},
			createTuiApplicationState(),
		);

		expect(transcript.map((component) => component.render(80))).toEqual([["header"], ["chat"]]);
		expect(dock.map((component) => component.render(80))).toEqual([["footer"]]);
	});

	it("gates a visible? entry per render from current state", () => {
		const state = createTuiApplicationState();
		const slots = new LayoutSlots();
		slots.register(entry("gated", { visible: (current) => current.toolOutputExpanded }));
		const mounted: Component[] = [];
		slots.mount({ addChild: (component) => mounted.push(component) }, state);
		const gated = mounted[0];
		if (!gated) throw new Error("Expected the gated entry to be mounted.");

		expect(gated.render(80)).toEqual([]);
		state.toolOutputExpanded = true;
		expect(gated.render(80)).toEqual(["gated"]);
		state.toolOutputExpanded = false;
		expect(gated.render(80)).toEqual([]);
	});
});

describe("LayoutSlots runtime mounting", () => {
	function createMountedHost(entries: readonly LayoutSlotEntry[]) {
		const children: Component[] = [];
		const host = {
			addChild: (component: Component) => {
				children.push(component);
			},
			removeChild: (component: Component) => {
				const index = children.indexOf(component);
				if (index >= 0) children.splice(index, 1);
			},
			children,
		};
		const slots = new LayoutSlots();
		for (const registered of entries) slots.register(registered);
		slots.mount(host, createTuiApplicationState());
		return { slots, children };
	}

	it("inserts a runtime registration after the last entry of its slot", () => {
		const { slots, children } = createMountedHost([
			entry("queued", { slot: "aboveEditor" }),
			entry("requests", { slot: "aboveEditor" }),
			entry("editor", { slot: "editor" }),
			entry("footer", { slot: "footer" }),
		]);

		expect(slots.register(entry("widget", { slot: "aboveEditor" }))).toBeUndefined();

		expect(children.map((component) => component.render(80))).toEqual([
			["queued"],
			["requests"],
			["widget"],
			["editor"],
			["footer"],
		]);
	});

	it("inserts runtime entries into their layout region", () => {
		const transcript: Component[] = [];
		const dock: Component[] = [];
		const slots = new LayoutSlots();
		slots.register(entry("header", { slot: "header" }));
		slots.register(entry("editor", { slot: "editor" }));
		slots.mount(
			{
				transcript: { addChild: (component) => transcript.push(component), children: transcript },
				dock: { addChild: (component) => dock.push(component), children: dock },
			},
			createTuiApplicationState(),
		);

		slots.register(entry("notices", { slot: "notices" }));
		slots.register(entry("footer", { slot: "footer" }));

		expect(transcript.map((component) => component.render(80))).toEqual([["header"], ["notices"]]);
		expect(dock.map((component) => component.render(80))).toEqual([["editor"], ["footer"]]);
	});

	it("appends a runtime registration whose slot has no mounted anchor", () => {
		const { slots, children } = createMountedHost([entry("header", { slot: "header" })]);

		slots.register(entry("widget", { slot: "belowEditor" }));

		expect(children.map((component) => component.render(80))).toEqual([["header"], ["widget"]]);
	});

	it("lands a runtime registration in its slot even when that slot is empty", () => {
		const { slots, children } = createMountedHost([
			entry("header", { slot: "header" }),
			entry("editor", { slot: "editor" }),
			entry("footer", { slot: "footer" }),
		]);

		slots.register(entry("widget", { slot: "status" }));

		expect(children.map((component) => component.render(80))).toEqual([["header"], ["widget"], ["editor"], ["footer"]]);
	});

	it("removes a runtime registration from the host and disposes it", () => {
		const { slots, children } = createMountedHost([
			entry("header", { slot: "header" }),
			entry("footer", { slot: "footer" }),
		]);
		let disposed = false;
		slots.register(
			entry("widget", {
				slot: "footer",
				factory: () => ({
					render: () => ["widget"],
					invalidate: () => {},
					dispose: () => {
						disposed = true;
					},
				}),
			}),
		);
		expect(children.map((component) => component.render(80))).toEqual([["header"], ["footer"], ["widget"]]);

		expect(slots.unregister("widget")).toBe(true);

		expect(children.map((component) => component.render(80))).toEqual([["header"], ["footer"]]);
		expect(disposed).toBe(true);
	});

	it("disposes the inner component when a gated entry is unregistered", () => {
		const { slots } = createMountedHost([entry("header", { slot: "header" })]);
		let disposed = false;
		slots.register(
			entry("gated", {
				visible: () => true,
				factory: () => ({
					render: () => ["gated"],
					invalidate: () => {},
					dispose: () => {
						disposed = true;
					},
				}),
			}),
		);

		expect(slots.unregister("gated")).toBe(true);
		expect(disposed).toBe(true);
	});

	it("rolls back the registration when the runtime factory throws", () => {
		const { slots, children } = createMountedHost([entry("header", { slot: "header" })]);

		expect(() =>
			slots.register(
				entry("broken", {
					factory: () => {
						throw new Error("factory boom");
					},
				}),
			),
		).toThrow("factory boom");

		expect(slots.entries().map((registered) => registered.key)).toEqual(["header"]);
		expect(children).toHaveLength(1);
	});
});
