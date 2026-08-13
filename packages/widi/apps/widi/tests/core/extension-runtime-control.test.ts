/**
 * Runtime control an extension may exercise (stage 0, capability C6):
 * `waitForIdle`, the host-owned `requestShutdown`, and the hostless
 * `disposeRuntime` escape hatch.
 */

import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	createOrchestrator,
	harnessEventDriver,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireLiveAgent,
} from "../helpers/orchestrator.ts";

function requireActions(orchestrator: AgentOrchestrator, agentId: string, extensionId = "control") {
	const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return runner.createContext(extensionId).actions;
}

async function createHarness() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	orchestrator.registerExtension("control", () => {});
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	return { orchestrator, agentId, actions: requireActions(orchestrator, agentId) };
}

// The idle judgement reads the harness's own queue depth rather than mirroring
// the queue_update payload, so the queue is what has to change; the event is
// only what asks the orchestrator to judge again.
async function emitQueueUpdate(orchestrator: AgentOrchestrator, agentId: string, steerCount: number): Promise<void> {
	const steer = Array.from({ length: steerCount }, () => ({ role: "user" as const, content: "queued", timestamp: 1 }));
	const queue = (requireAgentHarness(orchestrator, agentId) as unknown as { steerQueue: unknown[] }).steerQueue;
	queue.splice(0, queue.length, ...steer);
	const event: AgentHarnessEvent = { type: "queue_update", steer, followUp: [], nextTurn: [] };
	await harnessEventDriver(orchestrator)(agentId, event);
}

function settled(promise: Promise<void>): Promise<"settled" | "pending"> {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"pending">((resolve) => {
			setTimeout(() => resolve("pending"), 0);
		}),
	]);
}

describe("extension waitForIdle", () => {
	it("returns immediately for an agent that is already idle and drained", async () => {
		const { actions } = await createHarness();
		await expect(actions.waitForIdle()).resolves.toBeUndefined();
	});

	// Same judgement as hasPendingMessages: text the harness has accepted but
	// not read still counts, or an extension would act on a half-delivered turn.
	it("waits while the harness still holds unread messages", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);

		const waiting = actions.waitForIdle();
		expect(await settled(waiting)).toBe("pending");

		await emitQueueUpdate(orchestrator, agentId, 0);
		await expect(waiting).resolves.toBeUndefined();
	});

	it("rejects rather than hangs when the agent is disposed while waiting", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);

		const waiting = actions.waitForIdle();
		await orchestrator.disposeAgent(agentId, { intent: "removed", reason: "test teardown" });

		await expect(waiting).rejects.toThrow("was disposed while waiting");
	});

	it("rejects for an agent that can never idle again", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await orchestrator.disposeAgent(agentId, { intent: "removed", reason: "test teardown" });

		await expect(actions.waitForIdle()).rejects.toThrow("disposed");
	});

	it("honors an abort signal", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);
		const controller = new AbortController();

		const waiting = actions.waitForIdle({ signal: controller.signal });
		controller.abort(new Error("caller gave up"));

		await expect(waiting).rejects.toThrow("caller gave up");
	});
});

describe("extension shutdown requests", () => {
	it("publishes the request once, with core-injected attribution", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const requests: Extract<OrchestratorEvent, { type: "runtime_shutdown_requested" }>[] = [];
		orchestrator.subscribe((event) => {
			if (event.type === "runtime_shutdown_requested") requests.push(event);
		});

		await actions.requestShutdown("done here");
		await actions.requestShutdown("again");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.requestedBy).toBe("control");
		expect(requests[0]?.requestedByAgentId).toBe(agentId);
		expect(requests[0]?.reason).toBe("done here");
	});

	// Core publishes and stops there: the process and the terminal belong to the
	// host, so an unhandled request must leave the agents running.
	it("does not tear anything down by itself", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await actions.requestShutdown();

		expect(orchestrator.getAgentActivity(agentId).activity).toBe("idle");
	});

	it("reaches the extension runtimes of every agent, not just the requester", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const notified: string[] = [];
		orchestrator.registerExtension("control", (api) => {
			api.observe("runtime_shutdown_requested", (_event, context) => {
				notified.push(context.agentId);
			});
		});
		const firstAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, firstAgentId).requestShutdown();

		expect(notified.sort()).toEqual([firstAgentId, secondAgentId].sort());
	});

	it("finishes extension observers before a host can start teardown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const notified: string[] = [];
		let pauseFirstObserver = true;
		let releaseFirstObserver!: () => void;
		const firstObserverReleased = new Promise<void>((resolve) => {
			releaseFirstObserver = resolve;
		});
		let firstObserverStarted = false;
		orchestrator.registerExtension("control", (api) => {
			api.observe("runtime_shutdown_requested", async (_event, context) => {
				if (pauseFirstObserver) {
					pauseFirstObserver = false;
					firstObserverStarted = true;
					await firstObserverReleased;
				}
				notified.push(context.agentId);
			});
		});
		const firstAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		let hostSawRequest = false;
		let hostDisposal: Promise<void> | undefined;
		orchestrator.subscribe((event) => {
			if (event.type !== "runtime_shutdown_requested") return;
			hostSawRequest = true;
			hostDisposal = orchestrator.disposeAll("host shutdown");
		});

		const request = requireActions(orchestrator, firstAgentId).requestShutdown();
		try {
			await vi.waitFor(() => {
				expect(firstObserverStarted || hostSawRequest).toBe(true);
			});
			expect(hostSawRequest).toBe(false);
		} finally {
			releaseFirstObserver();
			await request;
			if (hostDisposal) await hostDisposal;
		}

		expect(hostSawRequest).toBe(true);
		expect(notified.sort()).toEqual([firstAgentId, secondAgentId].sort());
		expect(() => orchestrator.getAgentActivity(firstAgentId)).toThrow(/is gone|Unknown agent/);
		expect(() => orchestrator.getAgentActivity(secondAgentId)).toThrow(/is gone|Unknown agent/);
	});
});

describe("extension disposeRuntime", () => {
	it("disposes every agent and runs the extension teardown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		let disposals = 0;
		orchestrator.registerExtension("control", (api) => {
			api.onDispose(() => {
				disposals += 1;
			});
		});
		const firstAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, firstAgentId).disposeRuntime("bye");

		expect(() => orchestrator.getAgentActivity(firstAgentId)).toThrow(/is gone|Unknown agent/);
		expect(() => orchestrator.getAgentActivity(secondAgentId)).toThrow(/is gone|Unknown agent/);
		expect(disposals).toBe(2);
	});

	it("leaves the calling context stale afterwards", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await actions.disposeRuntime("bye");

		expect(() => actions.getModel()).toThrow("Agent has been disposed.");
		expect(() => orchestrator.getAgentActivity(agentId)).toThrow(/is gone|Unknown agent/);
	});
});
