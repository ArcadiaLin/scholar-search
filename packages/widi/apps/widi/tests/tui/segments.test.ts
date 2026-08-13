import { describe, expect, it } from "vitest";
import { SegmentStore } from "../../src/tui/segments.ts";

describe("SegmentStore", () => {
	it("keeps segments per slot", () => {
		const store = new SegmentStore();
		store.set("header", { id: "a", text: "left", order: 0 });
		store.set("footer", { id: "a", text: "right", order: 0 });

		expect(store.texts("header")).toEqual(["left"]);
		expect(store.texts("footer")).toEqual(["right"]);
		expect(store.texts("status")).toEqual([]);
	});

	it("sorts by order, then by when it was first set", () => {
		const store = new SegmentStore();
		store.set("header", { id: "second", text: "second", order: 0 });
		store.set("header", { id: "first", text: "first", order: -1 });
		store.set("header", { id: "third", text: "third", order: 0 });

		expect(store.texts("header")).toEqual(["first", "second", "third"]);
	});

	// Replacing must not shuffle the row: a segment that updates every second
	// would otherwise walk across the line.
	it("keeps a replaced segment where it was", () => {
		const store = new SegmentStore();
		store.set("footer", { id: "a", text: "a", order: 0 });
		store.set("footer", { id: "b", text: "b", order: 0 });
		store.set("footer", { id: "a", text: "a updated", order: 0 });

		expect(store.texts("footer")).toEqual(["a updated", "b"]);
	});

	it("removes, and forgets an unknown id quietly", () => {
		const store = new SegmentStore();
		store.set("status", { id: "a", text: "a", order: 0 });

		store.remove("status", "nothing-here");
		expect(store.texts("status")).toEqual(["a"]);

		store.remove("status", "a");
		expect(store.list("status")).toEqual([]);
	});
});
