import { describe, expect, it, vi } from "vitest";
import { HumanInterruptRegistry } from "../../src/core/human-interrupt.ts";

describe("HumanInterruptRegistry", () => {
	it("notifies when no empty queue update followed the enqueue", () => {
		const registry = new HumanInterruptRegistry();
		const watch = registry.watch("agent-1");
		const listener = vi.fn();
		watch.subscribe(listener);

		const clearRevision = registry.captureClearRevision("agent-1");

		expect(registry.notifyIfUncleared("agent-1", clearRevision)).toBe(true);
		expect(watch.pending()).toBe(true);
		expect(listener).toHaveBeenCalledOnce();
	});

	it("does not resurrect an interrupt drained before steer resolves", () => {
		const registry = new HumanInterruptRegistry();
		const watch = registry.watch("agent-1");
		const clearRevision = registry.captureClearRevision("agent-1");

		registry.clear("agent-1");

		expect(registry.notifyIfUncleared("agent-1", clearRevision)).toBe(false);
		expect(watch.pending()).toBe(false);
	});

	it("invalidates an in-flight notification when the agent is forgotten", () => {
		const registry = new HumanInterruptRegistry();
		const clearRevision = registry.captureClearRevision("agent-1");

		registry.forget("agent-1");

		expect(registry.notifyIfUncleared("agent-1", clearRevision)).toBe(false);
		expect(registry.watch("agent-1").pending()).toBe(false);
	});
});
