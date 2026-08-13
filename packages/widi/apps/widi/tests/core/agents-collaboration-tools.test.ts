import { AgentHarness } from "@arcadialin/agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { AgentProfileRegistry, InMemoryProfileStorageBackend } from "../../src/core/agent-profile.ts";
import type { AgentToOrchestratorHost } from "../../src/core/host.ts";
import { createDisposeAgentToolDefinition } from "../../src/core/tools/agents/dispose-agent.ts";
import { createListAgentsToolDefinition, type ListAgentsDetails } from "../../src/core/tools/agents/list-agents.ts";
import { createSendMessageToolDefinition } from "../../src/core/tools/agents/send-message.ts";
import { createSpawnAgentToolDefinition } from "../../src/core/tools/agents/spawn-agent.ts";
import { AgentWatches, createWatchAgentToolDefinition } from "../../src/core/tools/agents/watch-agent.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";
import {
	createOrchestrator,
	defaultProfile,
	harnessInputText,
	MemoryExecutionEnv,
	requireAgentHarness,
	restoredProfile,
	spawnParentOf,
} from "../helpers/orchestrator.ts";

const watches = new AgentWatches();
const listAgents = createListAgentsToolDefinition();
const spawnAgent = createSpawnAgentToolDefinition(watches);
const sendMessage = createSendMessageToolDefinition(watches);
const watchAgent = createWatchAgentToolDefinition(watches);
const disposeAgent = createDisposeAgentToolDefinition();

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The execution context an agent's own turn would carry: the real host closure
 * the orchestrator builds for that agent.
 */
function toolContext<TDetails>(orchestrator: AgentOrchestrator, agentId: string): ToolExecutionContext<TDetails> {
	const host = (
		orchestrator as unknown as { _createAgentHost: (agentId: string) => AgentToOrchestratorHost }
	)._createAgentHost(agentId);
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd: "/workspace/project" },
		extension: undefined,
		human: undefined,
		agents: host,
	};
}

/**
 * Let the agent accept deliveries without running a model. A resolved prompt is
 * enough for the orchestrator to report the message as accepted.
 */
function stubPrompt(orchestrator: AgentOrchestrator, agentId: string) {
	return vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockResolvedValue({} as AssistantMessage);
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function liveIds(details: ListAgentsDetails): readonly string[] {
	return (details.live ?? []).map((entry) => entry.agentId);
}

function resumableRefs(details: ListAgentsDetails): readonly string[] {
	return (details.resumable ?? []).map((entry) => entry.sessionRef);
}

/** The address of an agent's session directory, which a persistent agent always has. */
function sessionRef(orchestrator: AgentOrchestrator, agentId: string): string {
	const ref = orchestrator.sessionManager.getAgentSessionRef(agentId);
	if (ref === undefined) throw new Error(`Expected a persistent session for ${agentId}.`);
	return ref;
}

let spawnCallSeq = 0;

async function spawnChild(orchestrator: AgentOrchestrator, parentAgentId: string, profile = "worker"): Promise<string> {
	const result = await spawnAgent.execute(
		`spawn-${++spawnCallSeq}`,
		{ agents: [{ profile }] },
		toolContext(orchestrator, parentAgentId),
	);
	const status = result.details.agents[0];
	if (!status?.agentId) throw new Error(`Expected a spawned agent, got: ${status?.error}`);
	return status.agentId;
}

/** An owner and a worker, both able to accept messages. */
async function createPair() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	const owner = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const worker = await spawnChild(orchestrator, owner);
	return {
		orchestrator,
		owner,
		worker,
		ownerPrompt: stubPrompt(orchestrator, owner),
		workerPrompt: stubPrompt(orchestrator, worker),
	};
}

describe("list_agents profiles section", () => {
	it("lists enabled profiles only", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), { enabledProfileIds: ["main"] });
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const result = await listAgents.execute("call-1", { include: ["profiles"] }, toolContext(orchestrator, agentId));

		expect(result.details.profiles?.map((profile) => profile.id)).toEqual(["main"]);
		expect(result.details.live).toBeUndefined();
		expect(result.details.resumable).toBeUndefined();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("main (Main Agent)") });
	});

	// The menu exists so the model can choose, and `whenToUse` is the only field
	// that tells it how. Indented under its own entry, because the advice runs to
	// a paragraph and flush-left it would read as the next profile.
	it("renders whenToUse indented under its profile", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: defaultProfile },
					{
						profile: {
							id: "explore",
							label: "Explore Agent",
							whenToUse: "Use for a wide search.\n\nIt cannot edit anything.",
							systemPrompt: "explore prompt",
							persist: false,
						},
					},
				]),
			),
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const result = await listAgents.execute("call-1", { include: ["profiles"] }, toolContext(orchestrator, agentId));

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: [
				"Profiles you can spawn an agent from:",
				"- explore (Explore Agent) [ephemeral session]",
				"  Use for a wide search.",
				"",
				"  It cannot edit anything.",
				"- main (Main Agent) [persistent session]",
			].join("\n"),
		});
	});
});

describe("list_agents live and resumable sections", () => {
	// The directories are the complete set and memory is a subset of them: a
	// disposed agent leaves the live registry and stays on the list as the session
	// it wrote, which is exactly what it now is.
	it("splits running agents from resumable sessions and excludes other trees", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const running = await spawnChild(orchestrator, caller);
		const gone = await spawnChild(orchestrator, caller);
		const goneRef = sessionRef(orchestrator, gone);
		const otherRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const otherChild = await spawnChild(orchestrator, otherRoot);
		await orchestrator.disposeAgent(gone, { intent: "removed" });

		const result = await listAgents.execute("call-1", {}, toolContext(orchestrator, caller));

		expect(result.details.callerAgentId).toBe(caller);
		expect(liveIds(result.details)).toEqual([running]);
		expect(resumableRefs(result.details)).toEqual([goneRef]);
		expect(orchestrator.listAgents().agents.map((agent) => agent.agentId)).toEqual([
			caller,
			running,
			otherRoot,
			otherChild,
		]);
	});

	// §5.2: the old listing refused to say what an agent was doing because the
	// task lived in a runtime table. Activity is to hand now; who is watching whom is
	// not this tool's to know.
	it("reports each agent's activity", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const other = await spawnChild(orchestrator, owner);

		const result = await listAgents.execute("call-1", { include: ["live"] }, toolContext(orchestrator, owner));

		expect(result.details.live?.map((entry) => [entry.agentId, entry.activity])).toEqual([
			[worker, "idle"],
			[other, "idle"],
		]);
		const text = result.content[0];
		expect(text).toMatchObject({
			type: "text",
			text: expect.stringContaining(`- agent ${worker} [profile worker] idle`),
		});
		expect(text).toMatchObject({ type: "text", text: expect.not.stringContaining("watch") });
	});

	// Every caller sees the level it owns, not the level below the root: a list
	// that answered the same thing everywhere would tell a child about agents it
	// did not spawn and hide the ones it did.
	it("anchors the level on the caller and counts what is below it", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);
		const grandchild = await spawnChild(orchestrator, child);
		const sibling = await spawnChild(orchestrator, root);
		await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const fromRoot = await listAgents.execute("list-root", { include: ["live"] }, toolContext(orchestrator, root));
		const fromChild = await listAgents.execute("list-child", { include: ["live"] }, toolContext(orchestrator, child));
		const fromGrandchild = await listAgents.execute(
			"list-grandchild",
			{ include: ["live"] },
			toolContext(orchestrator, grandchild),
		);

		expect(liveIds(fromRoot.details)).toEqual([child, sibling]);
		expect(liveIds(fromChild.details)).toEqual([grandchild]);
		expect(liveIds(fromGrandchild.details)).toEqual([]);
		// The hidden level is counted rather than dropped without a word.
		expect(fromRoot.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`- agent ${child} [profile worker] idle (+1 nested)`),
		});
	});

	// The point of reading the directories: subagents never come back, so after a
	// resume the whole tree below the root is resumable - and still visible, which
	// is how the model learns what this session did before.
	it("reads the subagents of an earlier run as resumable sessions", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const root = await first.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(first, root);
		await spawnChild(first, child);
		const rootRef = sessionRef(first, root);
		const childRef = sessionRef(first, child);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: rootRef } });
		const result = await listAgents.execute("list-after-resume", {}, toolContext(second, resumed));

		expect(liveIds(result.details)).toEqual([]);
		expect(resumableRefs(result.details)).toEqual([childRef]);
		expect(result.details.resumable?.[0]).toMatchObject({ status: "closed", profileId: "worker" });
		expect(result.content[0]).toMatchObject({
			type: "text",
			// The grandchild's session is still on disk under the child; it is
			// counted, not expanded.
			text: expect.stringContaining(`- agent ${child} ${childRef} [profile worker] started `),
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("(+1 nested)") });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Send a message to one of the agent ids above"),
		});
	});

	// An ephemeral agent owns no directory, so its children are top-level
	// sessions. The spawn edge is still the truth about who spawned whom.
	it("keeps a child of an ephemeral agent under it", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: { ...defaultProfile, persist: false } },
					{ profile: restoredProfile },
				]),
			),
		});
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);

		const result = await listAgents.execute(
			"list-from-ephemeral",
			{ include: ["live"] },
			toolContext(orchestrator, root),
		);

		expect(result.details.live).toMatchObject([{ agentId: child, sessionRef: sessionRef(orchestrator, child) }]);
	});
});

describe("spawn_agent", () => {
	it("creates an idle unwatched agent", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const context = toolContext(orchestrator, caller);

		const result = await spawnAgent.execute("call-1", { agents: [{ profile: "worker" }] }, context);

		const status = result.details.agents[0];
		expect(status).toMatchObject({ origin: "new", profileId: "worker", watching: false });
		expect(orchestrator.getAgentActivity(status?.agentId ?? "").activity).toBe("idle");
	});

	// Batch is the whole reason the schema takes an array: several agents in one
	// turn stops depending on the model emitting several tool calls.
	it("creates every entry in order and keeps a failure from taking out the rest", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const result = await spawnAgent.execute(
			"call-1",
			{
				agents: [
					{ profile: "worker" },
					{ profile: "nonexistent" },
					{ profile: "worker", resume: "also-this" },
					{ profile: "worker" },
				],
			},
			toolContext(orchestrator, caller),
		);

		const [first, unknownProfile, ambiguous, last] = result.details.agents;
		expect(first?.agentId).toBeDefined();
		expect(last?.agentId).toBeDefined();
		expect(unknownProfile).toEqual({ origin: "new", error: expect.stringContaining("nonexistent") });
		expect(ambiguous).toEqual({
			origin: "new",
			error: expect.stringContaining("exactly one of profile, resume, or fork"),
		});
		expect(orchestrator.listAgents().agents).toHaveLength(3);
	});

	// The task is an ordinary message now, not an assignment: nothing is opened and
	// the worker has nothing to remember to settle.
	it("sends the first task as a message and watches the agent by default", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		// The child does not exist yet when the call starts, so its harness cannot
		// be stubbed per instance the way the other tests do it.
		const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);

		const result = await spawnAgent.execute(
			"call-1",
			{ agents: [{ profile: "worker", task: "audit the parser" }] },
			toolContext(orchestrator, caller),
		);

		const status = result.details.agents[0];
		expect(status).toMatchObject({ profileId: "worker", watching: true });
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe(`[Message from ${caller}]\n\naudit the parser`);
		expect(watches.isWatchedBy(status?.agentId ?? "", caller)).toBe(true);
	});

	// The window the other order opens: the child could run the task and stop
	// before the subscription exists, and nothing would ever say so.
	it("subscribes before the task is handed over", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);
		const context = toolContext(orchestrator, caller);
		const host = context.agents;
		if (!host) throw new Error("Expected an agent host.");
		const order: string[] = [];
		const start = vi.spyOn(watches, "start").mockImplementation(() => {
			order.push("watch");
			return "watching";
		});
		vi.spyOn(host, "sendMessage").mockImplementation(async () => {
			order.push("send");
			return { kind: "accepted" };
		});

		await spawnAgent.execute("call-1", { agents: [{ profile: "worker", task: "audit the parser" }] }, context);

		expect(order).toEqual(["watch", "send"]);
		expect(start).toHaveBeenCalledWith(host, expect.any(String));
	});

	it("honours watch false against the task default", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);

		const result = await spawnAgent.execute(
			"call-1",
			{ agents: [{ profile: "worker", task: "audit the parser", watch: false }] },
			toolContext(orchestrator, caller),
		);

		expect(result.details.agents[0]?.watching).toBe(false);
	});

	// Destroying a working agent to tidy up a failed call is worse than leaving
	// it, so both facts are reported and the id stays usable.
	it("keeps the agent when its task cannot be delivered", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		vi.spyOn(AgentHarness.prototype, "prompt").mockRejectedValue(new Error("harness exploded"));

		const result = await spawnAgent.execute(
			"call-1",
			{ agents: [{ profile: "worker", task: "audit the parser" }] },
			toolContext(orchestrator, caller),
		);

		const status = result.details.agents[0];
		expect(status?.agentId).toBeDefined();
		expect(status?.error).toContain("harness exploded");
		expect(orchestrator.getAgentActivity(status?.agentId ?? "").activity).toBe("idle");
	});

	it("reopens a session with resume and copies a live branch with fork", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const root = await first.spawnAgent({ origin: { kind: "new" } });
		const closed = await spawnChild(first, root);
		const closedRef = sessionRef(first, closed);

		const second = await createOrchestrator(env);
		const caller = await second.spawnAgent({ origin: { kind: "resume", reference: sessionRef(first, root) } });
		const result = await spawnAgent.execute(
			"call-1",
			{ agents: [{ resume: closedRef }, { fork: caller }] },
			toolContext(second, caller),
		);

		expect(result.details.agents.map((agent) => agent.origin)).toEqual(["resume", "fork"]);
		for (const agent of result.details.agents) {
			expect(agent.error).toBeUndefined();
			expect(second.getAgentActivity(agent.agentId ?? "").activity).toBe("idle");
		}
	});

	it("refuses a fork of an agent whose profile does not persist", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: defaultProfile },
					{ profile: { ...restoredProfile, persist: false } },
				]),
			),
		});
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const ephemeral = await spawnChild(orchestrator, caller);

		const result = await spawnAgent.execute(
			"call-1",
			{ agents: [{ fork: ephemeral }] },
			toolContext(orchestrator, caller),
		);

		expect(result.details.agents[0]).toMatchObject({ origin: "fork", error: expect.any(String) });
		expect(result.details.agents[0]?.agentId).toBeUndefined();
	});

	it("rejects a call with no entries", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(spawnAgent.execute("call-1", { agents: [] }, toolContext(orchestrator, caller))).rejects.toThrow(
			/at least one entry/,
		);
	});
});

describe("send_message", () => {
	it("delivers attributed text and does not wait for a reply", async () => {
		const { orchestrator, owner, worker, workerPrompt } = await createPair();

		const result = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "have a look at the diff" },
			toolContext(orchestrator, owner),
		);

		expect(result.details).toEqual({ targetAgentId: worker, watching: false });
		expect(harnessInputText(workerPrompt.mock.calls[0]?.[0])).toBe(
			`[Message from ${owner}]\n\nhave a look at the diff`,
		);
	});

	// Subscribe before the send, never after: a pending delivery already counts
	// the target busy, so the subscription cannot lose a race with the stop it is
	// there to catch.
	it("subscribes before handing over the work when watch is set", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const order: string[] = [];
		const host = toolContext(orchestrator, owner).agents;
		if (!host) throw new Error("Expected an agent host.");
		vi.spyOn(watches, "start").mockImplementation((_host, targetAgentId) => {
			order.push(`watch:${targetAgentId}`);
			return "watching";
		});
		vi.spyOn(host, "sendMessage").mockImplementation(async (targetAgentId) => {
			order.push(`send:${targetAgentId}`);
			return { kind: "accepted" };
		});

		const result = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", watch: true },
			{
				signal: undefined,
				onUpdate: undefined,
				workspace: { cwd: "/workspace/project" },
				extension: undefined,
				human: undefined,
				agents: host,
			},
		);

		expect(order).toEqual([`watch:${worker}`, `send:${worker}`]);
		expect(result.details.watching).toBe(true);
	});

	it("reports a refused subscription instead of claiming one", async () => {
		const { orchestrator, owner, worker } = await createPair();
		// Same tree, so the refusal is `taken` rather than the tree boundary: a stop
		// has exactly one reader and the owner already holds it.
		const bystander = await spawnChild(orchestrator, owner);
		await watchAgent.execute("watch-1", { agentId: worker, watching: true }, toolContext(orchestrator, owner));

		const result = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "mine now", watch: true },
			toolContext(orchestrator, bystander),
		);

		expect(result.details.watching).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already watched") });
	});

	it("delivers across trees when the caller knows the exact agent id", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const firstRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondPrompt = stubPrompt(orchestrator, secondRoot);

		const listed = await listAgents.execute(
			"list-first-tree",
			{ include: ["live"] },
			toolContext(orchestrator, firstRoot),
		);
		expect(liveIds(listed.details)).toEqual([]);

		await sendMessage.execute(
			"cross-tree-message",
			{ agentId: secondRoot, message: "shared id bridge" },
			toolContext(orchestrator, firstRoot),
		);

		expect(harnessInputText(secondPrompt.mock.calls[0]?.[0])).toBe(`[Message from ${firstRoot}]\n\nshared id bridge`);
	});

	// The name outlives the runtime that could answer to it. Nothing tells the
	// model its agents are gone any more, so the name has to keep working: the
	// session is on disk, and the message is what reopens it.
	it("reopens an agent of an earlier run that the branch still names", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const root = await first.spawnAgent({ origin: { kind: "new" } });
		const worker = await spawnChild(first, root);
		const rootRef = sessionRef(first, root);
		const workerRef = sessionRef(first, worker);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: rootRef } });
		// The worker does not exist yet when the call starts, so its harness cannot
		// be stubbed per instance the way the other tests do it.
		const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);

		const result = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "still there?" },
			toolContext(second, resumed),
		);

		expect(result.details).toEqual({ targetAgentId: worker, watching: false, resumedFrom: workerRef });
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe(`[Message from ${resumed}]\n\nstill there?`);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("was reopened from session"),
		});
	});

	// A fork inherits a conversation that names the source's agents, and a copy of
	// each of their sessions came with it. Its own copy is what those names have to
	// reach: the originals are still working for the agent it was forked from.
	it("reaches its own copy of an inherited agent rather than the original", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const owner = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const worker = await spawnChild(orchestrator, owner);
		const workerPrompt = stubPrompt(orchestrator, worker);
		const forked = await orchestrator.spawnAgent({ origin: { kind: "fork", sourceAgentId: owner } });
		// The copy keeps the directory name its original has, under the fork's own.
		const copyRef = `${sessionRef(orchestrator, forked)}/${sessionRef(orchestrator, worker).split("/").pop()}`;
		const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);

		const woken = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "carry on" },
			toolContext(orchestrator, forked),
		);

		const copy = woken.details.targetAgentId;
		expect(copy).not.toBe(worker);
		expect(woken.details.resumedFrom).toBe(copyRef);
		expect(woken.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`It runs as ${copy} now`) });
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe(`[Message from ${forked}]\n\ncarry on`);

		// The conversation goes on using the name it inherited, and it keeps landing
		// on the copy that name already woke.
		const again = await sendMessage.execute(
			"call-2",
			{ agentId: worker, message: "and this too" },
			toolContext(orchestrator, forked),
		);

		expect(again.details).toEqual({ targetAgentId: copy, watching: false });
		expect(workerPrompt).not.toHaveBeenCalled();
	});

	it("rejects an empty, self-addressed, or disposed target before anything happens", async () => {
		const { orchestrator, owner, worker, workerPrompt } = await createPair();
		const context = toolContext(orchestrator, owner);

		await expect(sendMessage.execute("call-1", { agentId: " ", message: "nowhere" }, context)).rejects.toThrow(
			/non-empty agentId/,
		);
		await expect(sendMessage.execute("call-2", { agentId: owner, message: "to myself" }, context)).rejects.toThrow(
			/cannot target yourself/,
		);
		await orchestrator.disposeAgent(worker, { intent: "removed" });
		await expect(sendMessage.execute("call-3", { agentId: worker, message: "anyone there" }, context)).rejects.toThrow(
			/Unknown agent/,
		);

		expect(workerPrompt).not.toHaveBeenCalled();
	});

	it("refuses to deliver into a dispose already under way", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const harness = requireAgentHarness(orchestrator, worker);
		const teardown = createDeferred<Awaited<ReturnType<typeof harness.abort>>>();
		vi.spyOn(harness, "abort").mockReturnValue(teardown.promise);
		const disposing = orchestrator.disposeAgent(worker, { intent: "removed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The registry cutover is the first thing dispose does, well ahead of the
		// teardown it is still waiting on: the agent is unaddressable already.
		expect(() => orchestrator.getAgentActivity(worker)).toThrow(/is gone|Unknown agent/);

		await expect(
			sendMessage.execute("call-1", { agentId: worker, message: "one more thing" }, toolContext(orchestrator, owner)),
		).rejects.toThrow(/is gone|Unknown agent/);

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
	});
});

describe("watch_agent", () => {
	it("subscribes and unsubscribes", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const context = toolContext(orchestrator, owner);

		const watched = await watchAgent.execute("call-1", { agentId: worker, watching: true }, context);
		expect(watched.details).toEqual({ agentId: worker, outcome: "watching" });
		expect(watches.isWatchedBy(worker, owner)).toBe(true);

		const dropped = await watchAgent.execute("call-3", { agentId: worker, watching: false }, context);
		expect(dropped.details).toEqual({ agentId: worker, outcome: "not_watching" });
		expect(watches.isWatchedBy(worker, owner)).toBe(false);
	});

	// A refused subscription that read as success is the failure the whole
	// mechanism exists to remove: the caller ends its turn waiting for a
	// notification nobody will send.
	it("throws when a subscription is refused", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const outsider = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await watchAgent.execute("call-1", { agentId: worker, watching: true }, toolContext(orchestrator, owner));

		await expect(
			watchAgent.execute("call-2", { agentId: worker, watching: true }, toolContext(orchestrator, outsider)),
		).rejects.toThrow(/another tree/);
		await expect(
			watchAgent.execute("call-3", { agentId: owner, watching: true }, toolContext(orchestrator, owner)),
		).rejects.toThrow(/cannot watch itself/);
		await expect(
			watchAgent.execute("call-4", { agentId: "nobody", watching: true }, toolContext(orchestrator, owner)),
		).rejects.toThrow(/Unknown agent/);
	});

	// Dropping never fails: whatever the reason, the caller is not watching the
	// agent afterwards, which is the state it asked for.
	it("reports rather than throws when dropping a subscription it never held", async () => {
		const { orchestrator, owner, worker } = await createPair();

		const result = await watchAgent.execute(
			"call-1",
			{ agentId: worker, watching: false },
			toolContext(orchestrator, owner),
		);

		expect(result.details.outcome).toBe("not_watching");
	});
});

describe("dispose_agent", () => {
	it("handles each target on its own and enforces the tree boundary", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const alreadyGone = await spawnChild(orchestrator, owner);
		const outsideTree = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.disposeAgent(alreadyGone, { intent: "removed" });

		const result = await disposeAgent.execute(
			"call-1",
			{ agentIds: [worker, alreadyGone, outsideTree, "nobody", owner], reason: "cleanup" },
			toolContext(orchestrator, owner),
		);

		expect(result.details.scope).toBe("agent");
		expect(result.details.agents).toEqual([
			{ agentId: worker, state: "disposed" },
			{ agentId: alreadyGone, state: "already_disposed" },
			{ agentId: outsideTree, state: "outside_tree" },
			{ agentId: "nobody", state: "unknown" },
			{ agentId: owner, state: "self" },
		]);
		expect(orchestrator.getAgentActivity(owner).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(outsideTree).activity).toBe("idle");
	});

	// Disposing a watched agent is the caller's own doing, so the notice is the
	// courtesy of not leaving it waiting rather than news.
	it("tells a watcher that the agent it was watching is gone", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		await watchAgent.execute("call-1", { agentId: worker, watching: true }, toolContext(orchestrator, owner));

		await disposeAgent.execute("call-2", { agentIds: [worker] }, toolContext(orchestrator, owner));

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		const delivered = harnessInputText(ownerPrompt.mock.calls[0]?.[0]);
		expect(delivered).toContain(`<agent-notification from="${worker}" status="gone">`);
		expect(delivered).toContain("will not report");
	});

	it("keeps surviving descendants in the original tree after single-agent disposal", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const grandchild = await spawnChild(orchestrator, parent);
		const sibling = await spawnChild(orchestrator, root);
		const parentRef = sessionRef(orchestrator, parent);

		await disposeAgent.execute(
			"dispose-parent-only",
			{ agentIds: [parent], scope: "agent" },
			toolContext(orchestrator, root),
		);

		expect(() => orchestrator.getAgentActivity(parent)).toThrow(/is gone|Unknown agent/);
		expect(orchestrator.getAgentActivity(grandchild).activity).toBe("idle");
		expect(spawnParentOf(orchestrator, parent)).toBe(root);
		expect(spawnParentOf(orchestrator, grandchild)).toBe(parent);
		// The disposed agent's directory still holds the grandchild's, so from the
		// root the entry turns resumable and keeps counting what survived under it.
		const listed = await listAgents.execute("list-from-root", {}, toolContext(orchestrator, root));
		expect(liveIds(listed.details)).toEqual([sibling]);
		expect(resumableRefs(listed.details)).toEqual([parentRef]);
		expect(listed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("(+1 nested)") });
		// The grandchild owns its own level and still sees nothing but itself.
		const fromGrandchild = await listAgents.execute(
			"list-from-grandchild",
			{ include: ["live"] },
			toolContext(orchestrator, grandchild),
		);
		expect(liveIds(fromGrandchild.details)).toEqual([]);

		await orchestrator.spawnAgent({ origin: { kind: "resume", reference: parentRef } });
		expect(spawnParentOf(orchestrator, parent)).toBe(root);
		const relisted = await listAgents.execute("list-after-parent-resume", {}, toolContext(orchestrator, root));
		expect(liveIds(relisted.details)).toEqual([parent, sibling]);
		expect(resumableRefs(relisted.details)).toEqual([]);
	});

	it("recursively disposes a subtree in leaf-to-root order", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const firstChild = await spawnChild(orchestrator, parent);
		const grandchild = await spawnChild(orchestrator, firstChild);
		const secondChild = await spawnChild(orchestrator, parent);
		const sibling = await spawnChild(orchestrator, root);

		const result = await disposeAgent.execute(
			"dispose-subtree",
			{ agentIds: [parent], scope: "subtree", reason: "branch complete" },
			toolContext(orchestrator, root),
		);

		expect(result.details).toEqual({
			scope: "subtree",
			agents: [{ agentId: parent, state: "disposed", disposedAgentIds: [grandchild, firstChild, secondChild, parent] }],
		});
		for (const agentId of [parent, firstChild, grandchild, secondChild]) {
			expect(() => orchestrator.getAgentActivity(agentId)).toThrow(/is gone|Unknown agent/);
		}
		expect(orchestrator.getAgentActivity(root).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(sibling).activity).toBe("idle");
		// Nothing points into the disposed subtree afterwards: a whole branch went,
		// so there is no surviving descendant for an edge to be about.
		expect(spawnParentOf(orchestrator, parent)).toBeUndefined();
	});

	it("waits for an overlapping descendant disposal before removing its parent", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const leaf = await spawnChild(orchestrator, parent);
		const leafHarness = requireAgentHarness(orchestrator, leaf);
		const teardown = createDeferred<Awaited<ReturnType<typeof leafHarness.abort>>>();
		const abort = vi.spyOn(leafHarness, "abort").mockReturnValue(teardown.promise);

		const leafDisposal = orchestrator.disposeAgent(leaf, { intent: "removed" });
		await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
		let parentFinished = false;
		const parentDisposal = orchestrator
			.disposeAgent(parent, { intent: "removed", scope: "subtree" })
			.then((agentIds) => {
				parentFinished = true;
				return agentIds;
			});
		await Promise.resolve();

		expect(parentFinished).toBe(false);
		expect(orchestrator.getAgentActivity(parent).activity).toBe("idle");

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await expect(leafDisposal).resolves.toEqual([leaf]);
		await expect(parentDisposal).resolves.toEqual([parent]);
		expect(() => orchestrator.getAgentActivity(leaf)).toThrow(/is gone|Unknown agent/);
		expect(() => orchestrator.getAgentActivity(parent)).toThrow(/is gone|Unknown agent/);
	});

	it("marks the whole subtree unaddressable before recursive teardown awaits", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const leaf = await spawnChild(orchestrator, parent);
		const leafHarness = requireAgentHarness(orchestrator, leaf);
		const teardown = createDeferred<Awaited<ReturnType<typeof leafHarness.abort>>>();
		vi.spyOn(leafHarness, "abort").mockReturnValue(teardown.promise);

		const escapingSpawn = spawnAgent.execute(
			"late-subtree-spawn",
			{ agents: [{ profile: "worker" }] },
			toolContext(orchestrator, leaf),
		);
		const disposing = disposeAgent.execute(
			"dispose-blocked-subtree",
			{ agentIds: [parent], scope: "subtree" },
			toolContext(orchestrator, root),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((await escapingSpawn).details.agents[0]?.error).toMatch(/is gone|Unknown agent/);
		await expect(
			sendMessage.execute(
				"late-subtree-message",
				{ agentId: parent, message: "late" },
				toolContext(orchestrator, root),
			),
		).rejects.toThrow(/is gone|Unknown agent/);

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
	});

	it("refuses a recursive selection that contains the caller", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);

		const result = await disposeAgent.execute(
			"dispose-own-tree",
			{ agentIds: [root], scope: "subtree" },
			toolContext(orchestrator, child),
		);

		expect(result.details.agents).toEqual([{ agentId: root, state: "self" }]);
		expect(orchestrator.getAgentActivity(root).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(child).activity).toBe("idle");
	});
});
