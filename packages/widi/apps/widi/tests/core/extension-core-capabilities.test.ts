/**
 * Core capabilities exposed to extensions in ME stage 0: session reads,
 * context usage, structured input presentation, and the small read-only
 * getters. The pi-extensions ecosystem survey (chat_notes/tui-extension-host.md
 * section 4) is what picked these four.
 */

import type { AgentMessage } from "@arcadialin/agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { ExtensionObservedEventName } from "../../src/core/extension/api.ts";
import { EXTENSION_OBSERVED_EVENT_NAMES } from "../../src/core/extension/index.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	createOrchestrator,
	defaultModel,
	defaultProfile,
	harnessEventDriver,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireLiveAgent,
	seedAgentContextUsage,
	stubCompaction,
} from "../helpers/orchestrator.ts";

// Same private-access precedent as the orchestrator suite: a real settled fact
// requires a full model run, which unit tests never perform.
async function emitSettled(orchestrator: AgentOrchestrator, agentId: string): Promise<void> {
	await harnessEventDriver(orchestrator)(agentId, { type: "settled", nextTurnCount: 0 });
}

/**
 * Set the harness's own queues and then announce them.
 *
 * The pending judgement reads `getQueuedMessageCounts()` rather than mirroring
 * the event payload, so the queues themselves are the input; the event is only
 * what asks the orchestrator to look again.
 */
async function emitQueueUpdate(
	orchestrator: AgentOrchestrator,
	agentId: string,
	queues: { steer?: UserMessage[]; followUp?: UserMessage[]; nextTurn?: AgentMessage[] },
): Promise<void> {
	const steer = queues.steer ?? [];
	const followUp = queues.followUp ?? [];
	const nextTurn = queues.nextTurn ?? [];
	const harness = requireAgentHarness(orchestrator, agentId) as unknown as {
		steerQueue: unknown[];
		followUpQueue: unknown[];
		nextTurnQueue: unknown[];
	};
	harness.steerQueue.splice(0, harness.steerQueue.length, ...steer);
	harness.followUpQueue.splice(0, harness.followUpQueue.length, ...followUp);
	harness.nextTurnQueue.splice(0, harness.nextTurnQueue.length, ...nextTurn);
	await harnessEventDriver(orchestrator)(agentId, { type: "queue_update", steer, followUp, nextTurn });
}

function assistantMessage(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn" }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/**
 * A trusted project with one persistent agent, so the cross-session readers
 * have real JSONL sessions to find and the trust gate is open by default.
 */
async function createHarness() {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	await orchestrator.settingManager.setProjectTrusted(true);
	orchestrator.registerExtension("sample", () => {});
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const stored = await orchestrator.sessionManager.createAgentSession({ agentId, agentProfile: defaultProfile });
	const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	const context = runner.createContext("sample");
	return { env, orchestrator, agentId, actions: context.actions, session: context.session, stored };
}

describe("extension session reads", () => {
	it("exposes the agent's own session snapshot, tree, and leaf", async () => {
		const { agentId, session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		const snapshot = await session.getSnapshot();
		const tree = await session.getTree();
		const leafId = await session.getLeafId();

		expect(snapshot.id).toBe(agentId);
		expect(tree.entries.length).toBeGreaterThan(0);
		expect(leafId).toBe(snapshot.leafId);
		expect(tree.pathToRoot).toEqual(snapshot.pathToRoot);
		// Identity and conversation only: no filesystem layout reaches the author.
		expect(snapshot).not.toHaveProperty("metadata");
		expect(snapshot).not.toHaveProperty("path");
		expect(snapshot).not.toHaveProperty("cwd");
	});

	it("lists the project's sessions and reads one back by its opaque ref", async () => {
		const { agentId, session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "remembered", timestamp: 1 });

		const sessions = await session.listSessions();
		const own = sessions.find((candidate) => candidate.id === agentId);
		expect(own).toBeDefined();
		if (!own) throw new Error("Expected the agent's own session to be listed.");

		// A candidate carries a ref, never the path it stands for.
		expect(own).not.toHaveProperty("path");
		expect(own).not.toHaveProperty("cwd");
		expect(own).not.toHaveProperty("parentSessionPath");
		expect(own.ref).toEqual(expect.any(String));
		expect(own.ref).not.toContain("/");

		const read = await session.readSession(own.ref);
		expect(read.id).toBe(agentId);
		expect(read.entries.length).toBeGreaterThan(0);
		// The agent's own session answers under the same ref either way.
		expect((await session.getSnapshot()).ref).toBe(own.ref);
	});

	it("refuses a session ref it never handed out", async () => {
		const { session } = await createHarness();

		await expect(session.readSession("/sessions/somewhere.jsonl")).rejects.toThrow(/Unknown session handle/);
	});

	it("reads a live session through its open handle rather than a stale reopen", async () => {
		const { agentId, session, stored } = await createHarness();
		const sessions = await session.listSessions();
		const own = sessions.find((candidate) => candidate.id === agentId);
		if (!own) throw new Error("Expected the agent's own session to be listed.");

		await stored.appendMessage({ role: "user", content: "written after listing", timestamp: 1 });

		const read = await session.readSession(own.ref);
		expect(read.leafId).toBe(await stored.getLeafId());
	});

	it("gates cross-session reads on project trust but leaves the own session open", async () => {
		const { orchestrator, session } = await createHarness();
		await orchestrator.settingManager.setProjectTrusted(false);

		await expect(session.listSessions()).rejects.toThrow(/may not list the project's sessions/);
		await expect(session.readSession("whatever")).rejects.toThrow(/may not read another session/);
		// The extension already runs inside this session, so reading it needs no
		// further permission.
		await expect(session.getSnapshot()).resolves.toBeDefined();
	});

	it("reports a cross-session read denial as an attributed action failure", async () => {
		const { orchestrator, session } = await createHarness();
		await orchestrator.settingManager.setProjectTrusted(false);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(session.listSessions()).rejects.toThrow();

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					extensionId: "sample",
					message: expect.stringContaining("action 'listSessions' failed"),
				}),
			}),
		);
	});

	it("returns detached entries that cannot mutate the live session", async () => {
		const { session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "stored text", timestamp: 1 });

		const firstRead = await session.getTree();
		const userEntry = firstRead.pathToRoot.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (userEntry?.type !== "message" || userEntry.message.role !== "user") {
			throw new Error("Expected a user message.");
		}
		userEntry.message.content = "mutated through the read API";

		const secondRead = await session.getTree();
		const storedUserEntry = secondRead.pathToRoot.find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		expect(
			storedUserEntry?.type === "message" && storedUserEntry.message.role === "user"
				? storedUserEntry.message.content
				: undefined,
		).toBe("stored text");
	});
});

describe("extension context usage", () => {
	it("has no measurement before the branch carries an assistant usage", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("measures the branch on settled and publishes the change once", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		// The default reserve exceeds defaultModel's 1000-token window, so any
		// usage would trip auto-compaction. This is the gauge's test, not the
		// trigger's: measure without compacting.
		orchestrator.settingManager.setCompactionEnabled(false);
		// 250 of a 1000-token window is a quarter full.
		await stored.appendMessage(assistantMessage(250));
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await emitSettled(orchestrator, agentId);
		// A second settled measuring the same branch is not news.
		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toEqual({
			tokens: 250,
			contextWindow: 1000,
			percent: 25,
			model: `${defaultModel.provider}/${defaultModel.id}`,
		});
		const usageEvents = events.filter((event) => event.type === "agent_context_usage_changed");
		expect(usageEvents).toEqual([
			expect.objectContaining({
				type: "agent_context_usage_changed",
				agentId,
				usage: expect.objectContaining({ tokens: 250, percent: 25 }),
			}),
		]);
	});

	it("reports percent on Pi's 0-100 scale so ported thresholds still fire", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		// 960 of a 1000-token window is the kind of level a ported extension
		// checks with `percent >= 95`.
		await stored.appendMessage(assistantMessage(960));

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()?.percent).toBe(96);
	});

	it("drops the measurement when the model, and so the window, changes", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()?.model).toBe(`${defaultModel.provider}/${defaultModel.id}`);

		await orchestrator.setAgentModel(agentId, { ...defaultModel, id: "wide-model", contextWindow: 100_000 });

		// Never report the old window, or the old model's name, as current.
		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("drops the measurement when the branch no longer has one", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		const measuredLeafId = await stored.getLeafId();
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()).toBeDefined();

		// Move back to a branch point with no assistant usage on it.
		await stored.moveTo(measuredLeafId);
		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("invalidates on a real tree move but not on a no-op navigation", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		const measuredEntryId = await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);

		await orchestrator.navigateAgentTree(agentId, measuredEntryId);
		expect(actions.getContextUsage()).toBeDefined();

		await stored.appendMessage({ role: "user", content: "later branch", timestamp: 3 });
		await orchestrator.navigateAgentTree(agentId, measuredEntryId);
		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("clears a stale measurement when refreshing the branch fails", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		seedAgentContextUsage(orchestrator, agentId, { tokens: 10, contextWindow: 100, percent: 10, model: "test/model" });
		Object.assign(orchestrator.sessionManager, {
			getAgentSessionSnapshot: async () => {
				throw new Error("session read failed");
			},
		});

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("drops the measurement after compaction instead of reporting the old branch", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()).toBeDefined();

		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const compaction = stubCompaction(requireAgentHarness(orchestrator, agentId));
		const compacting = orchestrator.compactAgent(agentId);
		compaction.resolve({ summary: "s", firstKeptEntryId: "e", tokensBefore: 250 });
		await compacting;

		expect(actions.getContextUsage()).toBeUndefined();
		expect(events).toContainEqual(
			expect.objectContaining({ type: "agent_context_usage_changed", agentId, usage: undefined }),
		);
	});

	it("returns detached usage and exposes it in the agent snapshot", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		seedAgentContextUsage(orchestrator, agentId, { tokens: 10, contextWindow: 100, percent: 10, model: "test/model" });

		const usage = actions.getContextUsage();
		if (!usage) throw new Error("Expected context usage.");
		(usage as { tokens: number }).tokens = 99;

		expect(actions.getContextUsage()?.tokens).toBe(10);
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10, model: "test/model" },
		});
	});
});

describe("extension read-only runtime getters", () => {
	it("reports project trust as the gate its own actions are checked against", async () => {
		const { orchestrator, actions } = await createHarness();
		expect(actions.isProjectTrusted()).toBe(true);

		await orchestrator.settingManager.setProjectTrusted(false);

		expect(actions.isProjectTrusted()).toBe(false);
	});

	it("reads the effective system prompt including extension sections", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerExtension("sample", (api) => {
			api.appendSystemPrompt("extension guidance section");
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");

		const prompt = await runner.createContext("sample").actions.getSystemPrompt();

		expect(prompt).toContain(defaultProfile.systemPrompt);
		expect(prompt).toContain("extension guidance section");
	});

	/**
	 * Scoped steer/followUp hand text straight to the harness, which keeps its
	 * queues private and reports them only through `queue_update`. Checking the
	 * orchestrator's own queue alone therefore answered "nothing pending" for
	 * text an extension had just handed over. Driving the harness event bridge
	 * is the same precedent as `emitSettled`: a real queued follow-up needs a
	 * running model turn, which unit tests never perform.
	 */
	it("counts messages sitting in the harness queue as pending", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		expect(actions.hasPendingMessages()).toBe(false);

		await emitQueueUpdate(orchestrator, agentId, {
			followUp: [{ role: "user", content: "read this next", timestamp: 1 }],
		});
		expect(actions.hasPendingMessages()).toBe(true);

		// Drained by the agent loop: pending again becomes false.
		await emitQueueUpdate(orchestrator, agentId, {});
		expect(actions.hasPendingMessages()).toBe(false);
	});
});

describe("extension observer delivery", () => {
	// The observed-event set is declared as a type; this is the check that the
	// dispatcher actually routes every name in it.
	it("delivers every declared observable event name to registered observers", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const observed: string[] = [];
		orchestrator.registerExtension("sample", (api) => {
			for (const name of Object.keys(EXTENSION_OBSERVED_EVENT_NAMES) as ExtensionObservedEventName[]) {
				api.observe(name, (event) => {
					observed.push(event.type);
				});
			}
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const stored = await orchestrator.sessionManager.createAgentSession({ agentId, agentProfile: defaultProfile });
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));

		await emitSettled(orchestrator, agentId);

		expect(observed).toContain("agent_context_usage_changed");
	});
});
