/**
 * Watches: one agent waiting on another, and being told when it stops.
 *
 * The property under test is that the report does not depend on the stopped
 * agent doing anything. It is delivered when the agent is interrupted, when it
 * stops silently, and when it is disposed before reporting - the cases a
 * voluntary "I am finished" call loses. The gates are the other half: an
 * agent that paused to wait on work it started has not stopped, and must not
 * be reported as though
 * it had.
 *
 * Driven through the tool, because the tool is where all of this lives. The
 * runtime below it only answers whether an agent stopped, what it said, and
 * delivers a message.
 */

import type { AgentHarnessEvent, CompactResult } from "@arcadialin/agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentToOrchestratorHost } from "../../src/core/host.ts";
import { messageBindingFor } from "../../src/core/message.ts";
import { SettingManager } from "../../src/core/setting-manager.ts";
import { AgentWatches, createWatchAgentToolDefinition } from "../../src/core/tools/agents/watch-agent.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";
import type { AgentAbortOrigin } from "../../src/core/types.ts";
import {
	createOrchestrator,
	defaultModel,
	harnessEventDriver,
	harnessInputText,
	MemoryExecutionEnv,
	requireAgentHarness,
	stubCompaction,
} from "../helpers/orchestrator.ts";

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

interface Deferred {
	readonly promise: Promise<AssistantMessage>;
	readonly resolve: (value: AssistantMessage) => void;
}

function createDeferred(): Deferred {
	let resolve!: (value: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function agentHost(orchestrator: AgentOrchestrator, agentId: string): AgentToOrchestratorHost {
	return (
		orchestrator as unknown as { _createAgentHost: (agentId: string) => AgentToOrchestratorHost }
	)._createAgentHost(agentId);
}

function toolContext<TDetails>(orchestrator: AgentOrchestrator, agentId: string): ToolExecutionContext<TDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd: "/workspace/project" },
		extension: undefined,
		human: undefined,
		agents: agentHost(orchestrator, agentId),
	};
}

/**
 * Take over the watcher's harness so what it is told is observable. Every
 * notice arrives as a prompt: the watcher is idle, waiting to be woken.
 */
function watchInbox(orchestrator: AgentOrchestrator, agentId: string): { readonly texts: string[] } {
	const texts: string[] = [];
	vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockImplementation(async (input) => {
		texts.push(harnessInputText(input));
		return assistantMessage("ack");
	});
	return { texts };
}

async function emit(orchestrator: AgentOrchestrator, agentId: string, event: AgentHarnessEvent): Promise<void> {
	await harnessEventDriver(orchestrator)(agentId, event);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run one turn on `agentId` and let it stop, which is the edge a watch fires
 * on. The assistant message is written to the branch as a real run would, since
 * the branch is where the report is read from.
 */
async function runAndStop(
	orchestrator: AgentOrchestrator,
	agentId: string,
	said: AssistantMessage,
	interruptedBy?: AgentAbortOrigin,
): Promise<void> {
	const run = createDeferred();
	const prompt = vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockReturnValue(run.promise);
	const accepted = orchestrator
		.messageSinkFor(messageBindingFor({ kind: "agent", senderAgentId: "watch-test" }))
		.send({ targetAgentId: agentId, body: "go", mode: "next_turn" });
	await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
	await emit(orchestrator, agentId, { type: "agent_start" });
	await accepted;
	if (interruptedBy) await orchestrator.abortAgent(agentId, interruptedBy);
	if (said.content.length > 0) await requireAgentHarness(orchestrator, agentId).appendMessage(said);
	await emit(orchestrator, agentId, { type: "turn_end", message: said, toolResults: [] });
	run.resolve(said);
	await emit(orchestrator, agentId, { type: "settled", nextTurnCount: 0 });
}

async function createPair(): Promise<{
	readonly orchestrator: AgentOrchestrator;
	readonly watches: AgentWatches;
	readonly watch: (watcherAgentId: string, targetAgentId: string) => Promise<void>;
	readonly watcherAgentId: string;
	readonly workerAgentId: string;
}> {
	// The test model's context window is smaller than the default compaction
	// reserve, so a branch that carries any usage at all would auto-compact.
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
		settingManager: new SettingManager({ compaction: { enabled: false } }),
	});
	const watches = new AgentWatches();
	const tool = createWatchAgentToolDefinition(watches);
	const watcherAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const workerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: watcherAgentId });
	const watch = async (callerAgentId: string, targetAgentId: string) => {
		await tool.execute(
			"call-watch",
			{ agentId: targetAgentId, watching: true },
			toolContext(orchestrator, callerAgentId),
		);
	};
	return { orchestrator, watches, watch, watcherAgentId, workerAgentId };
}

describe("agent watches", () => {
	it("reports a worker that was interrupted, carrying what it last said", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("Half of the router is rewritten.", "aborted"));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		const notice = inbox.texts[0] ?? "";
		expect(notice).toContain(`<agent-notification from="${workerAgentId}" status="idle" reason="aborted">`);
		expect(notice).toContain("Half of the router is rewritten.");
		expect(notice).toContain("dispose_agent");
		// Nobody asked for this abort, so it carries no origin and the watcher is
		// free to pick the work back up.
		expect(notice).not.toContain("aborted-by");
	});

	/**
	 * The one stop the watcher must not act on by itself: a person is at the
	 * keyboard of the agent it was waiting for, and a send_message from here would
	 * land in the middle of their turn.
	 */
	it("tells the watcher a human took the worker over, and keeps the subscription", async () => {
		const { orchestrator, watches, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("Halfway through.", "aborted"), "human");

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		const notice = inbox.texts[0] ?? "";
		expect(notice).toContain(`reason="aborted" aborted-by="human"`);
		expect(notice).toContain("was interrupted by a human");
		expect(notice).toContain("still watching it");
		// The delegation was interrupted, not finished, so the report it is owed has
		// not been given and the subscription is not spent.
		expect(watches.isWatchedBy(workerAgentId, watcherAgentId)).toBe(true);

		// The human hands it back and it runs to a real stop.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("Router rewritten."));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(2));
		expect(inbox.texts[1]).toContain("Router rewritten.");
		expect(inbox.texts[1]).toContain("finished a turn");
	});

	it("carries the abort origin on the idle edge", async () => {
		const { orchestrator, workerAgentId } = await createPair();
		const idles: Array<[string, string | undefined]> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_idle" && event.agentId === workerAgentId) {
				idles.push([event.reason, event.abortedBy]);
			}
		});

		await runAndStop(orchestrator, workerAgentId, assistantMessage("half done", "aborted"), "extension");

		expect(idles).toEqual([["aborted", "extension"]]);
	});

	it("reports a worker that stopped silently", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("Done: the config was already correct."));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`status="idle" reason="settled"`);
		expect(inbox.texts[0]).toContain("Done: the config was already correct.");
		expect(inbox.texts[0]).toContain("finished a turn and will not continue on its own");
		expect(inbox.texts[0]).toContain("Continue it with send_message if the task is not done");
	});

	// The case a voluntary report cannot express at all: a run that produced no
	// text still has to reach the watcher, or the delegation hangs on silence.
	it("reports a worker whose run said nothing", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage(""));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`${workerAgentId} stopped without a closing message.`);
	});

	/**
	 * A watch is not spent on the stop it reports. Nothing but a dispose or the
	 * watcher letting go ends it, so an agent that keeps working keeps being
	 * accounted for rather than going quiet after one report.
	 */
	it("keeps reporting until the watcher drops it", async () => {
		const { orchestrator, watches, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("first"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(watches.isWatchedBy(workerAgentId, watcherAgentId)).toBe(true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("second"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(2));
		expect(inbox.texts[1]).toContain("second");

		expect(watches.stop(agentHost(orchestrator, watcherAgentId), workerAgentId)).toBe("not_watching");
		await runAndStop(orchestrator, workerAgentId, assistantMessage("third"));
		await settle();
		expect(inbox.texts).toHaveLength(2);
	});

	/**
	 * How hard a report lands is the watcher's own choice, and the choice is only
	 * visible while it is busy: to an idle watcher every mode starts a turn alike.
	 */
	it("interrupts the watcher for the work it handed over, and waits its turn otherwise", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const harness = requireAgentHarness(orchestrator, watcherAgentId);
		vi.spyOn(harness, "getPhase").mockReturnValue("turn");
		const steer = vi.spyOn(harness, "steer").mockResolvedValue(undefined);
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue(undefined);
		await watch(watcherAgentId, workerAgentId);

		// The answer it delegated for reaches the turn it is in.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
		expect(followUp).not.toHaveBeenCalled();

		// That delegation is answered, so the watch is only keeping an eye on it now.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("and again"));
		await vi.waitFor(() => expect(followUp).toHaveBeenCalledTimes(1));
		expect(steer).toHaveBeenCalledTimes(1);
	});

	// Maintenance releases the agent back to idle without a turn behind it, so
	// the report it would carry is whatever the worker said before compacting.
	it("stays silent when the worker only came back from maintenance", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		const compaction = stubCompaction(requireAgentHarness(orchestrator, workerAgentId));
		const compacting = orchestrator.compactAgent(workerAgentId);
		// A real compaction emits as it runs, and each event re-arms the idle edge
		// that the release below then publishes. Without one the release is a
		// repeat of an idle already announced and never reaches the gate.
		await emit(orchestrator, workerAgentId, { type: "queue_update", steer: [], followUp: [], nextTurn: [] });
		compaction.resolve({ messages: [], summary: "compacted" } as unknown as CompactResult);
		await compacting;
		await settle();

		expect(inbox.texts).toHaveLength(0);
	});

	/**
	 * A worker waiting on its own subagent has stopped, but not in any sense its
	 * own watcher cares about; only its own watch says so.
	 */
	it("stays silent while the worker waits on a subagent of its own", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		const grandchildAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: workerAgentId });
		await watch(watcherAgentId, workerAgentId);
		await watch(workerAgentId, grandchildAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("delegated the search"));
		await settle();
		expect(inbox.texts).toHaveLength(0);

		// Once the level below reports, the worker's own next stop is a real stop.
		watchInbox(orchestrator, workerAgentId);
		await runAndStop(orchestrator, grandchildAgentId, assistantMessage("found it"));
		await runAndStop(orchestrator, workerAgentId, assistantMessage("here is the answer"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain("here is the answer");
	});

	it("tells the watcher when the agent it waited on is disposed", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await orchestrator.disposeAgent(workerAgentId, { intent: "removed", reason: "no longer needed" });

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`<agent-notification from="${workerAgentId}" status="gone">`);
		expect(inbox.texts[0]).toContain("will not report");
	});

	it("does not repeat a settled report when the worker is disposed", async () => {
		const { orchestrator, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		await orchestrator.disposeAgent(workerAgentId, { intent: "removed" });
		await settle();

		expect(inbox.texts).toHaveLength(1);
	});

	it("drops the watches a disposed watcher held", async () => {
		const { orchestrator, watches, watch, watcherAgentId, workerAgentId } = await createPair();
		await watch(watcherAgentId, workerAgentId);

		await orchestrator.disposeAgent(watcherAgentId, { intent: "removed" });
		await settle();
		expect(watches.isWatchedBy(workerAgentId, watcherAgentId)).toBe(false);

		// Nothing is delivered to an agent that is gone; the worker stopping after
		// its watcher did must not fail a send into a cancelled queue.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await settle();
	});

	it("refuses a watch it cannot honour", async () => {
		const { orchestrator, watches, watcherAgentId, workerAgentId } = await createPair();
		const otherTreeAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const host = agentHost(orchestrator, watcherAgentId);

		expect(watches.start(host, watcherAgentId)).toBe("self");
		expect(watches.start(host, "ag-nope")).toBe("unknown");
		expect(watches.start(host, otherTreeAgentId)).toBe("outside_tree");

		// A stop has one report to give, so a second claim on it is refused rather
		// than silently replacing the first.
		expect(watches.start(host, workerAgentId)).toBe("watching");
		const siblingAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: watcherAgentId });
		const siblingHost = agentHost(orchestrator, siblingAgentId);
		expect(watches.start(siblingHost, workerAgentId)).toBe("taken");
		expect(watches.stop(siblingHost, workerAgentId)).toBe("not_watching");
		expect(watches.isWatchedBy(workerAgentId, watcherAgentId)).toBe(true);
	});

	it("stops reporting once the watcher unsubscribes", async () => {
		const { orchestrator, watches, watch, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		await watch(watcherAgentId, workerAgentId);
		expect(watches.stop(agentHost(orchestrator, watcherAgentId), workerAgentId)).toBe("not_watching");

		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await settle();

		expect(inbox.texts).toHaveLength(0);
	});
});
