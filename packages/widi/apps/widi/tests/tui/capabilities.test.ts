import { describe, expect, it } from "vitest";
import { APPLICATION_CALLER, type EditorCapability, TuiCapabilityRegistry } from "../../src/tui/capabilities.ts";

function editorCapability(state: { text: string }): EditorCapability {
	return {
		getText: () => state.text,
		setText: (text) => {
			state.text = text;
		},
		insertAtCursor: (text) => {
			state.text += text;
		},
		clear: () => {
			state.text = "";
		},
	};
}

describe("TuiCapabilityRegistry", () => {
	it("hands back what was published under a key", () => {
		const registry = new TuiCapabilityRegistry();
		const state = { text: "draft" };
		registry.publish("editor", editorCapability(state));

		const editor = registry.get("editor");

		expect(editor?.getText()).toBe("draft");
		editor?.setText("rewritten");
		expect(state.text).toBe("rewritten");
	});

	// An extension asking for a key nobody publishes is the normal case, not an
	// error: the application it is running against may simply be older.
	it("misses quietly on an unpublished key", () => {
		const registry = new TuiCapabilityRegistry();

		expect(registry.get("editor")).toBeUndefined();
		expect(registry.get("nothing-here")).toBeUndefined();
		expect(registry.keys()).toEqual([]);
	});

	it("lists what it published, for /layout and the drill ledger", () => {
		const registry = new TuiCapabilityRegistry();
		registry.publish("editor", editorCapability({ text: "" }));
		registry.publishScoped("chat", () => ({ insert: () => {}, remove: () => {}, setExpanded: () => {} }));

		expect(registry.keys()).toEqual(["editor", "chat"]);
	});

	it("binds a scoped capability once per caller", () => {
		const registry = new TuiCapabilityRegistry();
		const callers: string[] = [];
		registry.publishScoped("chat", (caller) => {
			callers.push(caller);
			return { insert: () => {}, remove: () => {}, setExpanded: () => {} };
		});

		const first = registry.get("chat", "drill");
		expect(registry.get("chat", "drill")).toBe(first);
		expect(registry.get("chat", "other")).not.toBe(first);
		// A caller nobody named is the application itself, not an extension.
		expect(registry.get("chat")).not.toBe(first);
		expect(callers).toEqual(["drill", "other", APPLICATION_CALLER]);
	});
});
