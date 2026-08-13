import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import { MessageError } from "../../src/core/message.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	agentSink,
	createOrchestrator,
	defaultProfile,
	harnessEventDriver,
	harnessInputText,
	humanSink,
	MemoryExecutionEnv,
	requireAgentHarness,
	stubCompaction,
	stubPromptRun,
} from "../helpers/orchestrator.ts";

/** The activity a live agent currently reports. */
function activityOf(orchestrator: AgentOrchestrator, agentId: string): string {
	return orchestrator.getAgentActivity(agentId).activity;
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Drive the harness `agent_start` the orchestrator subscribes to. A delivery is
 * only accepted once the agent loop is actually running, so a test that mocks
 * `prompt` has to produce that fact itself.
 */
async function driveAgentStart(orchestrator: AgentOrchestrator, agentId: string): Promise<void> {
	await harnessEventDriver(orchestrator)(agentId, { type: "agent_start" });
}

/** An orchestrator whose default profile loads the named extension. */
async function createExtensionOrchestrator(extensionId: string): Promise<AgentOrchestrator> {
	const profile: AgentProfile = { ...defaultProfile, id: `${extensionId}-profile`, persist: false };
	return await createOrchestrator(new MemoryExecutionEnv(), {
		defaultProfileId: profile.id,
		profileRegistry: new AgentProfileRegistry(InMemoryProfileStorageBackend.fromProfiles([{ profile }])),
	});
}

describe("AgentOrchestrator.sendMessage", () => {
	it("attributes the sender and returns before the target replies", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const sourceAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const { prompt, resolve: finishRun } = stubPromptRun(requireAgentHarness(orchestrator, targetAgentId));

		const accepted = agentSink(orchestrator, sourceAgentId).send({
			targetAgentId,
			body: "Please review this.",
			mode: "next_turn",
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await driveAgentStart(orchestrator, targetAgentId);
		await accepted;

		// Acceptance, not completion: the run is still in flight.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe(`[Message from ${sourceAgentId}]\n\nPlease review this.`);
		expect(activityOf(orchestrator, targetAgentId)).toBe("running");

		finishRun({} as AssistantMessage);
		await vi.waitFor(() => expect(activityOf(orchestrator, targetAgentId)).toBe("idle"));
	});

	it("lets only one of two concurrent senders claim the idle target", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const { prompt, resolve: finishRun } = stubPromptRun(harness);
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();

		const accepted = Promise.all([
			agentSink(orchestrator, "first").send({ targetAgentId, body: "first", mode: "next_turn" }),
			agentSink(orchestrator, "second").send({ targetAgentId, body: "second", mode: "next_turn" }),
		]);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await driveAgentStart(orchestrator, targetAgentId);
		await accepted;

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe("[Message from first]\n\nfirst");
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(harnessInputText(followUp.mock.calls[0]?.[0])).toBe("[Message from second]\n\nsecond");
		finishRun({} as AssistantMessage);
	});

	it("steers only when the sender asks to interrupt", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const steer = vi.spyOn(harness, "steer").mockResolvedValue();
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();
		(harness as unknown as { phase: "turn" }).phase = "turn";

		await agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "ordinary", mode: "next_turn" });
		await humanSink(orchestrator).send({ targetAgentId, body: "stop that", mode: "interrupt" });

		expect(followUp).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(harnessInputText(steer.mock.calls[0]?.[0])).toBe("stop that");
	});

	// `AgentLifecycleStatus.running` covers compaction too, but a compacting
	// harness runs no agent loop: a follow-up accepted here would never be read.
	it("holds a message through compaction and delivers it afterwards", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const compaction = stubCompaction(harness);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();
		const steer = vi.spyOn(harness, "steer").mockResolvedValue();

		const compacting = orchestrator.compactAgent(targetAgentId);
		const accepted = agentSink(orchestrator, "agent-peer").send({
			targetAgentId,
			body: "while compacting",
			mode: "next_turn",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(followUp).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
		await accepted;
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toContain("while compacting");
	});

	// The harness builds the turn context, session metadata, and tool context
	// asynchronously before its agent loop starts, and the user message is not
	// persisted until then. Reporting acceptance earlier would drop a message the
	// target never received - fatal for a notice nobody is left to resend.
	it("waits for the agent loop before reporting a message accepted", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		vi.spyOn(requireAgentHarness(orchestrator, targetAgentId), "prompt").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("failed while building the turn");
		});

		await expect(
			agentSink(orchestrator, "watchdog").send({ targetAgentId, body: "never landed", mode: "next_turn" }),
		).rejects.toThrow("failed while building the turn");
		expect(activityOf(orchestrator, targetAgentId)).toBe("idle");
	});

	it("rejects competing maintenance before it can overwrite the active kind", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const compaction = stubCompaction(harness);

		const compacting = orchestrator.compactAgent(targetAgentId);
		await vi.waitFor(() => expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction"));

		await expect(orchestrator.navigateAgentTree(targetAgentId, "entry-1")).rejects.toMatchObject({ code: "busy" });
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction");
		expect(orchestrator.getAgentActivity(targetAgentId).activity).toBe("running");
		expect(events.filter((event) => event.type === "agent_status_changed" && event.activity === "running")).toEqual([
			expect.objectContaining({ type: "agent_status_changed", maintenance: "compaction" }),
		]);

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBeUndefined();
		expect(orchestrator.getAgentActivity(targetAgentId).activity).toBe("idle");
	});

	it("does not let maintenance take over an active agent turn", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		(harness as unknown as { phase: "turn" }).phase = "turn";

		// The harness is the authority: the orchestrator no longer keeps a parallel
		// reservation that could refuse ahead of it, so the rejection comes back
		// from `compact()` itself and the active kind is never overwritten.
		await expect(orchestrator.compactAgent(targetAgentId)).rejects.toMatchObject({ code: "busy" });
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBeUndefined();
		expect(activityOf(orchestrator, targetAgentId)).toBe("running");
	});

	it("rejects low-level turn controls during maintenance", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const compaction = stubCompaction(harness);
		const abort = vi.spyOn(harness, "abort");
		const followUp = vi.spyOn(harness, "followUp");
		const steer = vi.spyOn(harness, "steer");
		const promote = vi.spyOn(harness, "promoteFollowUpsToSteer");

		const compacting = orchestrator.compactAgent(targetAgentId);
		await vi.waitFor(() => expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction"));

		await expect(orchestrator.abortAgent(targetAgentId, "human")).rejects.toMatchObject({ code: "busy" });
		await expect(orchestrator.steerQueuedFollowUps(targetAgentId)).rejects.toMatchObject({ code: "busy" });

		expect(abort).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(promote).not.toHaveBeenCalled();

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
	});

	it("refuses an unknown target and an empty body", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(
			agentSink(orchestrator, "test").send({ targetAgentId: "agent-missing", body: "hello", mode: "next_turn" }),
		).rejects.toThrow("Unknown agent");
		await expect(
			agentSink(orchestrator, "test").send({ targetAgentId, body: "   ", mode: "next_turn" }),
		).rejects.toBeInstanceOf(MessageError);
	});

	// `disposeAgent` cancels the target's queue and sweeps its outstanding work
	// up front, but only commits the `disposed` status after a teardown full of
	// awaits. Anything accepted in between would be work nobody sweeps again.
	it("stops accepting messages as soon as dispose starts, before the status commits", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const teardown = createDeferred<Awaited<ReturnType<typeof harness.abort>>>();
		vi.spyOn(harness, "abort").mockReturnValue(teardown.promise);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);

		const disposing = orchestrator.disposeAgent(targetAgentId, { intent: "removed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The registry cutover happens first, long before the teardown it is still
		// waiting on: nothing can be accepted from here on.
		expect(() => orchestrator.getAgentActivity(targetAgentId)).toThrow(/is gone|Unknown agent/);

		// Not a MessageError: the target left the registry, so the rejection is the
		// lookup's, ahead of the message pipeline entirely.
		await expect(
			agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "landed mid-teardown", mode: "next_turn" }),
		).rejects.toThrow(/is gone|Unknown agent/);
		expect(prompt).not.toHaveBeenCalled();

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
		expect(() => orchestrator.getAgentActivity(targetAgentId)).toThrow(/is gone|Unknown agent/);
	});
});

describe("AgentOrchestrator message interception", () => {
	it("shows the interceptor who sent the message and who reads it", async () => {
		const orchestrator = await createExtensionOrchestrator("observer");
		const seen: Array<{ source: string; targetAgentId: string }> = [];
		orchestrator.registerExtension("observer", (api) => {
			api.intercept("input", (event) => {
				seen.push({ source: event.source.kind, targetAgentId: event.targetAgentId });
				return undefined;
			});
		});
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);

		await agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "from a peer", mode: "next_turn" });
		await humanSink(orchestrator).prompt({ targetAgentId, body: "from a human", mode: "next_turn" });

		expect(seen).toEqual([
			{ source: "agent", targetAgentId },
			{ source: "human", targetAgentId },
		]);
	});

	it("reports a blocked agent message instead of delivering it", async () => {
		const orchestrator = await createExtensionOrchestrator("policy");
		orchestrator.registerExtension("policy", (api) => {
			api.intercept("input", (event) =>
				event.source.kind === "agent" ? { block: true, reason: "No peer messages." } : undefined,
			);
		});
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(
			agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "from a peer", mode: "next_turn" }),
		).resolves.toEqual({
			kind: "blocked",
			inputId: expect.any(String),
			reason: "No peer messages.",
			blockedBy: "policy",
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(events).toContainEqual(expect.objectContaining({ type: "input_blocked", blockedBy: "policy" }));
	});
});
