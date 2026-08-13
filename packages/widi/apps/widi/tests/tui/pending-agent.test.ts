import { describe, expect, it, vi } from "vitest";
import type { RuntimeModel } from "../../src/core/types.ts";
import {
	PendingAgentController,
	type PendingAgentDisplay,
	type PendingAgentRuntime,
} from "../../src/tui/pending-agent.ts";
import { createTuiApplicationState } from "../../src/tui/state.ts";

describe("PendingAgentController", () => {
	it("does not spawn while creating default and new-session intents", () => {
		const spawnAgent = vi.fn(async () => "main");
		const controller = createController({ spawnAgent });

		controller.beginDefault(display());
		controller.beginNewSession({ profileId: "main-agent", model: model() }, display());

		expect(spawnAgent).not.toHaveBeenCalled();
	});

	it("materializes one default agent for concurrent callers", async () => {
		let resolveSpawn: (agentId: string) => void = () => {};
		const spawnPromise = new Promise<string>((resolve) => {
			resolveSpawn = resolve;
		});
		const spawnAgent = vi.fn(() => spawnPromise);
		const state = createTuiApplicationState();
		const controller = createController({ spawnAgent }, state);
		controller.beginDefault(display());

		const first = controller.materialize();
		const second = controller.materialize();
		resolveSpawn("main");

		await expect(Promise.all([first, second])).resolves.toEqual(["main", "main"]);
		expect(spawnAgent).toHaveBeenCalledTimes(1);
		expect(state.pendingAgent).toBeUndefined();
	});

	it("reopens a pending new session on the captured profile and model", async () => {
		const spawnAgent = vi.fn(async () => "main-2");
		const controller = createController({ spawnAgent });
		const sourceModel = model();
		controller.beginNewSession({ profileId: "main-agent", model: sourceModel }, display());

		await expect(controller.materialize()).resolves.toBe("main-2");
		expect(spawnAgent).toHaveBeenCalledWith({
			origin: { kind: "new", profileId: "main-agent" },
			model: sourceModel,
			cwd: "/workspace/project",
		});
	});

	// The orchestrator reads `options.origin` before anything else, so a default
	// start that hands it nothing fails on the first line of the spawn.
	it("materializes the default agent on a new-origin spawn", async () => {
		const spawnAgent = vi.fn(async () => "main");
		const controller = createController({ spawnAgent });
		controller.beginDefault(display());

		await expect(controller.materialize()).resolves.toBe("main");
		expect(spawnAgent).toHaveBeenCalledWith({ origin: { kind: "new" }, cwd: "/workspace/project" });
	});

	it("keeps the pending intent after materialization fails", async () => {
		const spawnAgent = vi.fn(async () => {
			throw new Error("spawn failed");
		});
		const state = createTuiApplicationState();
		const controller = createController({ spawnAgent }, state);
		controller.beginDefault(display());

		await expect(controller.materialize()).rejects.toThrow("spawn failed");
		expect(state.pendingAgent?.start).toEqual({ kind: "default", cwd: "/workspace/project" });
	});
});

function createController(
	overrides: Partial<PendingAgentRuntime> = {},
	state = createTuiApplicationState(),
): PendingAgentController {
	const runtime: PendingAgentRuntime = { spawnAgent: async () => "main", ...overrides };
	return new PendingAgentController(state, runtime, display());
}

function display(): PendingAgentDisplay {
	return {
		profileId: "main-agent",
		profileLabel: "Main Agent",
		cwd: "/workspace/project",
		model: model(),
		thinkingLevel: "medium",
	};
}

function model(): RuntimeModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}
