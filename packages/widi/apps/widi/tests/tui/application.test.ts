import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import type { WidiRuntime, WidiRuntimeServices } from "../../src/core/runtime-service.ts";
import type { OrchestratorEvent, RuntimeModel } from "../../src/core/types.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { SEGMENT_SLOTS } from "../../src/tui/capabilities.ts";
import type { CommandEngine } from "../../src/tui/commands/engine.ts";
import { setTransientQuip } from "../../src/tui/quips.ts";
import { ensureAgentProjection, type StagedDraft, setActiveAgent } from "../../src/tui/state.ts";
import type { WidiEditor } from "../../src/tui/views/editor.ts";
import type { HumanRequestMenu } from "../../src/tui/views/human-request.ts";
import type { SelectorDock } from "../../src/tui/views/selector-dock.ts";

describe("WidiTuiApplication lazy agent spawn", () => {
	it("does not spawn an agent when the TUI starts", async () => {
		const harness = await createApplicationHarness();
		const runPromise = harness.application.run();
		try {
			await vi.waitFor(() => {
				expect(harness.tuiStart).toHaveBeenCalledTimes(1);
			});
			expect(harness.spawnAgent).not.toHaveBeenCalled();
		} finally {
			await harness.application.shutdown("test cleanup");
			await runPromise;
		}
	});

	it("spawns and prompts on the first plain message", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "hello");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.promptAgent).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: "main", body: "hello" }));
	});

	it("stages the picked model on the pending session before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/model:test/next-model");

		// No agent exists yet, so there is nothing to retarget: the model lands
		// on the staged session and becomes the runtime default, and spawning
		// waits for the first prompt.
		expect(harness.spawnAgent).not.toHaveBeenCalled();
		expect(harness.resolveModelByReference).toHaveBeenCalledWith("test/next-model");
		expect(harness.setDefaultModel).toHaveBeenCalled();
		expect(harness.setAgentModelByReference).not.toHaveBeenCalled();
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	it("spawns and persists /thinking before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/thinking:high");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.setAgentThinkingLevelByName).toHaveBeenCalledWith("main", "high");
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	it("spawns and persists /rename before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/rename:planned session");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.setAgentSessionName).toHaveBeenCalledWith("main", "planned session");
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	// A command with nothing to ask for never reaches the engine's needs-argument
	// exit, so a bare submit is the only form it has. Refusing to materialize on
	// it would leave the command unreachable until the human had paid for a turn.
	it("spawns for an argument-less setting command on a cold start", async () => {
		const harness = await createApplicationHarness();
		const ran = vi.fn();
		(harness.application as unknown as { engine: CommandEngine }).engine.register({
			kind: "action",
			agentPolicy: "materialize",
			name: "rehearse",
			description: "needs an agent, asks for nothing",
			execute: async () => {
				ran();
				return "done";
			},
		});

		await submit(harness.application, "/rehearse");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(ran).toHaveBeenCalledTimes(1);
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	// The counter-case the rule exists for: a bare picker must not cost a session
	// to answer a question the human can still cancel.
	it("does not spawn when a bare setting command only opens its picker", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/model");

		expect(harness.spawnAgent).not.toHaveBeenCalled();
	});

	it("keeps the current agent on /new and stages a second one beside it", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.promptAgent.mockClear();
		harness.spawnAgent.mockClear();

		await submit(harness.application, "/new main");

		expect(harness.disposeAgent).not.toHaveBeenCalled();
		expect(harness.application.state.agents.has("main")).toBe(true);
		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.spawnAgent).not.toHaveBeenCalled();
		expect(harness.application.state.pendingAgent?.start).toEqual({
			kind: "new-session",
			profileId: "main",
			model: model(),
			// The staged session opens where the agent it was typed beside runs.
			cwd: "/workspace",
		});
		// The row belongs to the conversation the command was typed in.
		expect(
			harness.application.state.agents
				.get("main")
				?.timeline.find((item) => item.type === "command-result" && item.name === "new"),
		).toMatchObject({ type: "command-result", status: "completed" });
	});

	it("picks the profile when /new names none", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");

		const outcome = await harness.application.capabilities.get("commands")?.run("/new");

		expect(outcome).toMatchObject({ kind: "needs-argument", name: "new", candidates: [{ value: "main" }] });
		expect(harness.application.state.pendingAgent).toBeUndefined();
	});

	it("creates the /new session when its first message is submitted", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.promptAgent.mockClear();
		harness.spawnAgent.mockClear();

		await submit(harness.application, "/new main");
		await submit(harness.application, "second");

		expect(harness.spawnAgent).toHaveBeenCalledOnce();
		expect(harness.spawnAgent).toHaveBeenCalledWith({
			origin: { kind: "new", profileId: "main" },
			model: model(),
			cwd: "/workspace",
		});
		expect(harness.promptAgent).toHaveBeenCalledWith(
			expect.objectContaining({ targetAgentId: "main-2", body: "second" }),
		);
	});

	it("closes the current agent on /clear too", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");

		await submit(harness.application, "/clear");

		expect(harness.disposeAgent).toHaveBeenCalledWith(
			"main",
			expect.objectContaining({ reason: expect.stringContaining("new session") }),
		);
		expect(harness.application.state.pendingAgent?.start).toMatchObject({ kind: "new-session", profileId: "main" });
	});

	it("disposes a fork and returns to its source agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source) throw new Error("Expected source agent.");
		const fork = ensureAgentProjection(harness.application.state, "main-fork", "idle");
		fork.snapshot = snapshot("main-fork", model());
		fork.display.forkedFromAgentId = "main";
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(harness.disposeAgent).toHaveBeenCalledWith(
			"main-fork",
			expect.objectContaining({ reason: expect.any(String) }),
		);
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("skips a disposed fork source and switches to another usable agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source?.snapshot) throw new Error("Expected source agent.");
		source.status = "disposed";
		const worker = ensureAgentProjection(harness.application.state, "worker", "idle");
		worker.snapshot = snapshot("worker", model());
		const fork = ensureAgentProjection(harness.application.state, "main-fork", "idle");
		fork.snapshot = snapshot("main-fork", model());
		fork.display.forkedFromAgentId = "main";
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("worker");
	});

	it("returns to pending when disposed-agent inspection fails", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.spawnAgent.mockClear();
		harness.inspectAgent.mockImplementationOnce(() => {
			throw new Error("inspect failed");
		});

		await submit(harness.application, "/dispose");

		expect(harness.application.state.agents.get("main")?.status).toBe("disposed");
		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.application.state.pendingAgent?.start).toEqual({ kind: "default", cwd: "/workspace" });
		expect(harness.spawnAgent).not.toHaveBeenCalled();
	});

	it("returns to a fork source matched only by parent session path", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source?.snapshot) throw new Error("Expected source agent.");
		source.snapshot = {
			...source.snapshot,
			sessionMetadata: {
				id: "main",
				createdAt: new Date(0).toISOString(),
				cwd: "/workspace",
				path: "/sessions/main.jsonl",
			},
		};
		const fork = ensureAgentProjection(harness.application.state, "main-fork", "idle");
		fork.snapshot = {
			...snapshot("main-fork", model()),
			sessionMetadata: {
				id: "main-fork",
				createdAt: new Date(0).toISOString(),
				cwd: "/workspace",
				path: "/sessions/main-fork.jsonl",
				parentSessionPath: "/sessions/main.jsonl",
			},
		};
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(fork.display.forkedFromAgentId).toBeUndefined();
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("returns to pending without spawning after disposing the final agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.spawnAgent.mockClear();

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.application.state.pendingAgent?.start).toEqual({ kind: "default", cwd: "/workspace" });
		expect(harness.spawnAgent).not.toHaveBeenCalled();
	});

	it("switches to another live agent after disposing a non-fork agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const worker = ensureAgentProjection(harness.application.state, "worker", "idle");
		worker.snapshot = snapshot("worker", model());
		setActiveAgent(harness.application.state, "main");

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("worker");
	});

	// The staged session has no id, so leaving it is losing it. Everywhere else
	// in the shell a draft survives being left, which is why this one says so.
	it("says the staged session is gone when leaving it drops typed text", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		await submit(harness.application, "/new main");
		const staged = harness.application.state.pendingAgent;
		if (!staged) throw new Error("Expected a staged session.");
		staged.draft = "half a thought";

		harness.application.capabilities.get("agentStrip")?.switchTo("main");
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(harness.application.state.pendingAgent).toBeUndefined();
		expect(harness.application.state.globalNotices.at(-1)?.text).toContain("Dropped the staged main session");
	});

	it("says nothing when the staged session it drops is empty", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const notices = harness.application.state.globalNotices.length;
		await submit(harness.application, "/new main");

		harness.application.capabilities.get("agentStrip")?.switchTo("main");
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(harness.application.state.pendingAgent).toBeUndefined();
		expect(harness.application.state.globalNotices).toHaveLength(notices);
	});

	// Nothing in this shell asked: another agent's `dispose_agent` call, or a
	// subtree dispose taken above this one, arrives only as an event.
	it("leaves an agent disposed outside the shell", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const worker = ensureAgentProjection(harness.application.state, "worker", "idle");
		worker.snapshot = snapshot("worker", model());
		setActiveAgent(harness.application.state, "worker");

		deliverEvent(harness.application, {
			type: "agent_disposed",
			agentId: "worker",
			intent: "removed",
			disposedAt: new Date(0).toISOString(),
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(harness.application.state.agents.get("worker")?.status).toBe("disposed");
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("keeps showing the current agent when another one is disposed", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const worker = ensureAgentProjection(harness.application.state, "worker", "idle");
		worker.snapshot = snapshot("worker", model());

		deliverEvent(harness.application, {
			type: "agent_disposed",
			agentId: "worker",
			intent: "removed",
			disposedAt: new Date(0).toISOString(),
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(harness.application.state.agents.get("worker")?.status).toBe("disposed");
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("keeps the current agent selected when disposal fails", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.disposeAgent.mockRejectedValueOnce(new Error("dispose failed"));

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("main");
		expect(harness.application.state.pendingAgent).toBeUndefined();
		expect(
			harness.application.state.agents
				.get("main")
				?.timeline.find((item) => item.type === "command-result" && item.name === "dispose"),
		).toMatchObject({
			type: "command-result",
			status: "failed",
			error: { message: expect.stringContaining("dispose failed") },
		});
	});

	it("keeps the current agent selected when /clear disposal fails", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.disposeAgent.mockRejectedValueOnce(new Error("dispose failed"));

		await submit(harness.application, "/clear");

		expect(harness.application.state.activeAgentId).toBe("main");
		expect(harness.application.state.agents.has("main")).toBe(true);
		expect(harness.application.state.pendingAgent).toBeUndefined();
		expect(
			harness.application.state.agents
				.get("main")
				?.timeline.find((item) => item.type === "command-result" && item.name === "clear"),
		).toMatchObject({
			type: "command-result",
			status: "failed",
			error: { message: expect.stringContaining("dispose failed") },
		});
	});
});

describe("WidiTuiApplication animation ticker", () => {
	it("uses spinner cadence only for the visible running agent", async () => {
		const harness = await createApplicationHarness();
		setActiveAgent(harness.application.state, "main").status = "idle";
		ensureAgentProjection(harness.application.state, "background", "running");
		const ticker = harness.application as unknown as {
			updateAnimationTicker(): void;
			switchAgent(agentId: string): void;
			animationTickerInterval?: number;
			hydratedAgents: Set<string>;
		};
		ticker.hydratedAgents.add("main");
		ticker.hydratedAgents.add("background");

		ticker.updateAnimationTicker();
		expect(ticker.animationTickerInterval).toBeUndefined();

		ticker.switchAgent("background");
		expect(ticker.animationTickerInterval).toBe(160);

		ticker.switchAgent("main");
		expect(ticker.animationTickerInterval).toBeUndefined();
	});

	// A quip expiring is not an event; without a tick "Job's done." would
	// stay on screen until the next keystroke.
	it("ticks while the working line is holding a line that expires", async () => {
		const harness = await createApplicationHarness();
		const agent = setActiveAgent(harness.application.state, "main");
		agent.status = "idle";
		const ticker = harness.application as unknown as {
			updateAnimationTicker(): void;
			animationTickerInterval?: number;
		};

		setTransientQuip(agent, "done");
		ticker.updateAnimationTicker();
		expect(ticker.animationTickerInterval).toBe(250);

		agent.quip = undefined;
		ticker.updateAnimationTicker();
		expect(ticker.animationTickerInterval).toBeUndefined();
	});
});

describe("WidiTuiApplication working line", () => {
	function interrupt(application: WidiTuiApplication): void {
		(application as unknown as { interrupt(): void }).interrupt();
	}

	it("rolls a line for an agent the user just switched to", async () => {
		const harness = await createApplicationHarness();
		const agent = ensureAgentProjection(harness.application.state, "worker", "running");
		(harness.application as unknown as { hydratedAgents: Set<string> }).hydratedAgents.add("worker");

		(harness.application as unknown as { switchAgent(agentId: string): void }).switchAgent("worker");

		expect(agent.quip?.steady.state).toBe("working");
	});

	it("says something after the third interrupt in a row", async () => {
		const harness = await createApplicationHarness();
		const agent = setActiveAgent(harness.application.state, "main");
		agent.status = "running";

		interrupt(harness.application);
		interrupt(harness.application);
		expect(agent.quip?.transient).toBeUndefined();

		interrupt(harness.application);
		expect(agent.quip?.transient?.state).toBe("poked");
		expect(harness.abortAgent).toHaveBeenCalledTimes(3);
	});

	it("keeps quiet when the interrupts are spread out", async () => {
		const harness = await createApplicationHarness();
		const agent = setActiveAgent(harness.application.state, "main");
		agent.status = "running";
		const now = vi.spyOn(Date, "now");

		try {
			now.mockReturnValue(0);
			interrupt(harness.application);
			now.mockReturnValue(11_000);
			interrupt(harness.application);
			now.mockReturnValue(22_000);
			interrupt(harness.application);
		} finally {
			now.mockRestore();
		}

		expect(agent.quip?.transient).toBeUndefined();
	});
});

describe("WidiTuiApplication follow-up projection", () => {
	it("keeps a deferred follow-up visible until core acknowledges it", async () => {
		const harness = await createApplicationHarness();
		const agent = setActiveAgent(harness.application.state, "main");
		agent.status = "running";
		agent.maintenance = "compaction";
		agent.snapshot = snapshot("main", model());
		const delivery = createDeferred<{ kind: "accepted" }>();
		harness.sendMessage.mockReturnValueOnce(delivery.promise);

		const submitting = (harness.application as unknown as { submit(text: string): Promise<void> }).submit("queue this");
		await vi.waitFor(() => expect(agent.pendingFollowUps).toEqual([expect.objectContaining({ text: "queue this" })]));

		delivery.resolve({ kind: "accepted" });
		await submitting;
		expect(agent.pendingFollowUps).toEqual([]);
	});
});

describe("WidiTuiApplication staging", () => {
	function stage(application: WidiTuiApplication, text: string, extensionId?: string) {
		return (
			application as unknown as { stageDraft(text: string, extensionId?: string): StagedDraft | undefined }
		).stageDraft(text, extensionId);
	}

	function editStaged(application: WidiTuiApplication): void {
		(application as unknown as { takeStagedIntoEditor(): void }).takeStagedIntoEditor();
	}

	function interrupt(application: WidiTuiApplication): void {
		(application as unknown as { interrupt(): void }).interrupt();
	}

	function editor(application: WidiTuiApplication): WidiEditor {
		return (application as unknown as { editor: WidiEditor }).editor;
	}

	async function readyAgent(harness: Awaited<ReturnType<typeof createApplicationHarness>>) {
		const agent = setActiveAgent(harness.application.state, "main");
		agent.status = "idle";
		agent.snapshot = snapshot("main", model());
		return agent;
	}

	it("lands staged text on the branch before the human's own prompt", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "read docs/pi-fork.md first", "notes");

		await submit(harness.application, "now fix the build");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ body: "read docs/pi-fork.md first", mode: "precede" }),
		);
		expect(harness.messageSinkFor).toHaveBeenCalledWith(
			expect.objectContaining({ source: { kind: "extension:notes", label: "notes" } }),
		);
		expect(harness.promptAgent).toHaveBeenCalledWith(expect.objectContaining({ body: "now fix the build" }));
		expect(agent.staged).toEqual([]);
	});

	it("keeps a draft staged when its delivery fails, and keeps the order", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "first", "notes");
		stage(harness.application, "second", "notes");
		harness.sendMessage.mockRejectedValueOnce(new Error("no route to agent"));

		await submit(harness.application, "go");

		expect(agent.staged.map((draft) => draft.text)).toEqual(["first", "second"]);
	});

	it("lands the buffer on a turn this shell did not start", async () => {
		const harness = await createApplicationHarness();
		await readyAgent(harness);
		stage(harness.application, "context for the next turn", "notes");

		deliverEvent(harness.application, {
			type: "agent_status_changed",
			agentId: "main",
			activity: "running",
			changedAt: new Date(0).toISOString(),
		});
		await vi.waitFor(() =>
			expect(harness.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ body: "context for the next turn", mode: "precede" }),
			),
		);
	});

	it("takes the newest draft into the editor and puts an edit back in its place", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "older", "notes");
		stage(harness.application, "newer", "notes");

		editStaged(harness.application);
		expect(editor(harness.application).getText()).toBe("newer");
		expect(agent.staged.map((draft) => draft.text)).toEqual(["older"]);

		editor(harness.application).setText("newer, rewritten");
		interrupt(harness.application);

		expect(agent.staged.map((draft) => draft.text)).toEqual(["older", "newer, rewritten"]);
		expect(agent.staged[1]?.editedByHuman).toBe(true);
		expect(editor(harness.application).getText()).toBe("");
	});

	it("records the human edit on the entry that lands", async () => {
		const harness = await createApplicationHarness();
		await readyAgent(harness);
		stage(harness.application, "as written by the extension", "notes");
		editStaged(harness.application);
		editor(harness.application).setText("as rewritten by the human");
		interrupt(harness.application);

		await submit(harness.application, "go");

		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ body: "as rewritten by the human", editedByHuman: true }),
		);
	});

	it("does not mark the human's own staged text as edited by a human", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "note to self");

		editStaged(harness.application);
		editor(harness.application).setText("note to self, revised");
		interrupt(harness.application);

		expect(agent.staged[0]).toMatchObject({ text: "note to self, revised" });
		expect(agent.staged[0]?.editedByHuman).toBeUndefined();
	});

	it("discards a staged draft only when the editor is emptied first", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "never mind this", "notes");

		editStaged(harness.application);
		editor(harness.application).setText("");
		interrupt(harness.application);

		expect(agent.staged).toEqual([]);
		expect(agent.timeline.some((item) => item.type === "application-notice")).toBe(true);
	});

	it("refuses to take a draft into an editor the human is already using", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "staged", "notes");
		editor(harness.application).setText("half-typed thought");

		editStaged(harness.application);

		expect(agent.staged.map((draft) => draft.text)).toEqual(["staged"]);
		expect(editor(harness.application).getText()).toBe("half-typed thought");
	});

	it("submitting an edited draft adopts it as the human's own message", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		stage(harness.application, "extension wording", "notes");
		editStaged(harness.application);

		await submit(harness.application, "human wording");

		expect(agent.staged).toEqual([]);
		expect(agent.stagedEditing).toBeUndefined();
		expect(harness.promptAgent).toHaveBeenCalledWith(expect.objectContaining({ body: "human wording" }));
		expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "precede" }));
	});

	it("lands the buffer instead of growing it past the cap", async () => {
		const harness = await createApplicationHarness();
		const agent = await readyAgent(harness);
		for (let i = 0; i < 21; i++) stage(harness.application, `draft ${i}`, "notes");

		await vi.waitFor(() => expect(agent.staged).toEqual([]));
		expect(harness.sendMessage).toHaveBeenCalledTimes(21);
		expect(agent.timeline.some((item) => item.type === "diagnostic")).toBe(true);
	});
});

describe("WidiTuiApplication OAuth notices", () => {
	it("preserves complete login URLs with and without an active agent", async () => {
		const harness = await createApplicationHarness();
		const url = `https://auth.example.test/oauth/authorize?${"state=a".repeat(120)}&complete=yes`;

		deliverEvent(harness.application, {
			type: "auth_login_url",
			providerId: "test-oauth",
			url,
			createdAt: new Date().toISOString(),
		});
		expect(harness.application.state.globalNotices.at(-1)).toMatchObject({
			text: expect.stringContaining(url),
			textMode: "full",
		});

		setActiveAgent(harness.application.state, "main");
		deliverEvent(harness.application, {
			type: "auth_login_url",
			providerId: "test-oauth",
			agentId: "main",
			url,
			createdAt: new Date().toISOString(),
		});
		expect(harness.application.state.agents.get("main")?.timeline.at(-1)).toMatchObject({
			type: "application-notice",
			text: expect.stringContaining(url),
			textMode: "full",
		});
	});
});

describe("WidiTuiApplication runtime shutdown requests", () => {
	// Core only publishes the request: the terminal restoration and the ordered
	// teardown are the application's, so this is where the request is honored.
	it("shuts down and names the extension that asked", async () => {
		const harness = await createApplicationHarness();

		deliverEvent(harness.application, {
			type: "runtime_shutdown_requested",
			requestedBy: "quit-and-delete",
			requestedByAgentId: "main",
			reason: "session archived",
			createdAt: new Date().toISOString(),
		});

		expect(harness.application.state.globalNotices.at(-1)).toMatchObject({
			text: expect.stringContaining("quit-and-delete"),
		});
		expect(harness.application.state.globalNotices.at(-1)?.text).toContain("session archived");
		await vi.waitFor(() => {
			expect(harness.disposeAll).toHaveBeenCalled();
		});
		expect(harness.application.state.shuttingDown).toBe(true);
	});
});

async function submit(application: WidiTuiApplication, text: string): Promise<void> {
	await (application as unknown as { submit(text: string): Promise<void> }).submit(text);
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function selectorInput(application: WidiTuiApplication, data: string): void {
	(application as unknown as { selectorDock: SelectorDock }).selectorDock.handleInput(data);
}

function deliverEvent(application: WidiTuiApplication, event: OrchestratorEvent): void {
	(application as unknown as { handleEvent(event: OrchestratorEvent): void }).handleEvent(event);
}

describe("WidiTuiApplication user config diagnostics", () => {
	it("projects keybindings and theme load diagnostics into the startup notices", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "widi-tui-config-"));
		try {
			await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.nope": "x" }));
			await mkdir(join(agentDir, "themes"), { recursive: true });
			await writeFile(join(agentDir, "themes", "broken.json"), "{ not json");
			const harness = await createApplicationHarness({ agentDir });
			const runPromise = harness.application.run();
			try {
				await vi.waitFor(() => {
					expect(harness.tuiStart).toHaveBeenCalledTimes(1);
				});
				const codes = harness.application.state.globalNotices
					.filter((notice) => notice.kind === "diagnostic")
					.map((notice) => notice.diagnostic?.code);
				expect(codes).toContain("keybindings.invalid_entry");
				expect(codes).toContain("theme.read_failed");
			} finally {
				await harness.application.shutdown("test cleanup");
				await runPromise;
			}
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

describe("WidiTuiApplication TUI extension host", () => {
	it("activates tui halves at create() and merges their shortcuts into the keybindings table", async () => {
		const dir = await mkdtemp(join(tmpdir(), "widi-tui-ext-"));
		const agentDir = await mkdtemp(join(tmpdir(), "widi-tui-config-"));
		try {
			const entryPath = join(dir, "index.ts");
			await writeFile(
				entryPath,
				`export const tui = {
					apiVersion: 1,
					activate(api) {
						api.registerCommand({
							kind: "action",
							agentPolicy: "runtime",
							name: "ext-wiring",
							description: "wiring test command",
							execute: async () => "ok",
						});
						api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => {} });
					},
				};
				export default { apiVersion: 1, activate: () => {} };
				`,
			);
			// The user override targets an extension action: valid only because the
			// host activated before keybindings.json was validated.
			await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "ext.wiring.poke": "ctrl+g" }));
			const extensionLoad = {
				discovery: { roots: [], candidates: [], diagnostics: [] },
				loaded: [
					{
						id: "wiring",
						source: { kind: "file", path: entryPath, resolvedPath: entryPath, root: { kind: "settings", path: dir } },
						divisions: [],
					},
				],
				diagnostics: [],
			};
			const harness = await createApplicationHarness({ agentDir, extensionLoad });

			const engine = (harness.application as unknown as { engine: CommandEngine }).engine;
			expect(engine.get("ext-wiring")?.description).toBe("wiring test command");
			expect(getKeybindings().getKeys("ext.wiring.poke" as Keybinding)).toEqual(["ctrl+g"]);

			const runPromise = harness.application.run();
			try {
				await vi.waitFor(() => {
					expect(harness.tuiStart).toHaveBeenCalledTimes(1);
				});
				const codes = harness.application.state.globalNotices
					.filter((notice) => notice.kind === "diagnostic")
					.map((notice) => notice.diagnostic?.code);
				expect(codes).not.toContain("keybindings.invalid_entry");
				expect(codes.filter((code) => code?.startsWith("tui_extension."))).toEqual([]);
			} finally {
				await harness.application.shutdown("test cleanup");
				await runPromise;
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});

/**
 * The capability layer's load-bearing claim: a write is deferred past the
 * current frame, which is what makes calling one from inside a render safe
 * rather than something an extension author has to remember not to do.
 */
describe("WidiTuiApplication capabilities", () => {
	it("publishes the editor surface under its layout key", async () => {
		const harness = await createApplicationHarness();

		expect(harness.application.capabilities.keys()).toContain("editor");
		expect(harness.application.capabilities.get("no-such-part")).toBeUndefined();
	});

	it("reads immediately and writes after the frame", async () => {
		const harness = await createApplicationHarness();
		const editor = harness.application.capabilities.get("editor");
		if (!editor) throw new Error("Expected the editor capability to be published.");

		editor.setText("from an extension");
		expect(editor.getText()).toBe("");

		await vi.waitFor(() => {
			expect(editor.getText()).toBe("from an extension");
		});

		editor.insertAtCursor("!");
		await vi.waitFor(() => {
			expect(editor.getText()).toBe("from an extension!");
		});

		editor.clear();
		await vi.waitFor(() => {
			expect(editor.getText()).toBe("");
		});
	});

	it("runs a command and leaves the same transcript trace a typed one leaves", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const commands = harness.application.capabilities.get("commands");
		if (!commands) throw new Error("Expected the commands capability to be published.");

		const outcome = await commands.run("/model:test/next-model");

		expect(outcome).toMatchObject({ kind: "executed", name: "model" });
		expect(harness.setAgentModelByReference).toHaveBeenCalledWith("main", "test/next-model");
		expect(harness.application.state.agents.get("main")?.timeline.at(-1)).toMatchObject({
			type: "command-result",
			name: "model",
			status: "completed",
		});
	});

	it("lists commands with availability, and reports a failing one without throwing", async () => {
		const harness = await createApplicationHarness();
		const commands = harness.application.capabilities.get("commands");
		if (!commands) throw new Error("Expected the commands capability to be published.");

		expect(commands.list().map((command) => command.name)).toContain("status");

		// /status needs an active agent and there is none yet.
		expect(await commands.run("/status")).toMatchObject({ kind: "failed", name: "status" });
	});

	it("hands back candidates instead of opening a picker, and prompt text instead of sending it", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const commands = harness.application.capabilities.get("commands");
		if (!commands) throw new Error("Expected the commands capability to be published.");
		harness.promptAgent.mockClear();

		expect(await commands.run("/model")).toMatchObject({
			kind: "needs-argument",
			name: "model",
			candidates: [{ value: "test/next-model" }],
		});
		(harness.application as unknown as { engine: CommandEngine }).engine.register({
			kind: "prompt",
			agentPolicy: "active",
			name: "expander",
			description: "expands into prompt text",
			expand: async () => "expanded prompt text",
		});
		expect(await commands.run("/expander")).toEqual({ kind: "expanded", text: "expanded prompt text" });
		expect(await commands.run("plain text")).toEqual({ kind: "not-a-command" });
		expect(harness.promptAgent).not.toHaveBeenCalled();
		// The expansion left nothing behind: the row belongs to a prompt that was
		// never sent.
		expect(
			harness.application.state.agents.get("main")?.timeline.filter((item) => item.type === "command-result"),
		).toEqual([]);
	});

	it("reports the visible agent and every change of it", async () => {
		const harness = await createApplicationHarness();
		const strip = harness.application.capabilities.get("agentStrip");
		if (!strip) throw new Error("Expected the agent strip capability to be published.");
		const seen: Array<string | undefined> = [];
		const detach = strip.onVisibleAgentChanged((agentId) => seen.push(agentId));

		expect(strip.visibleAgentId()).toBeUndefined();
		expect(strip.list()).toEqual([]);
		await submit(harness.application, "hello");

		expect(strip.visibleAgentId()).toBe("main");
		expect(strip.list()).toEqual([
			{ agentId: "main", label: "Main Agent", depth: 0, status: "idle", spawnedBy: undefined, unreadCount: 0 },
		]);
		expect(seen).toEqual(["main"]);

		detach();
		await submit(harness.application, "/new main");
		expect(seen).toEqual(["main"]);
	});

	it("switches and disposes agents after the frame", async () => {
		const harness = await createApplicationHarness();
		const strip = harness.application.capabilities.get("agentStrip");
		if (!strip) throw new Error("Expected the agent strip capability to be published.");
		await submit(harness.application, "hello");
		await submit(harness.application, "/new main");
		await submit(harness.application, "second");
		expect(strip.visibleAgentId()).toBe("main-2");

		strip.switchTo("main-2");
		await strip.dispose("main-2");

		expect(harness.disposeAgent).toHaveBeenCalledWith("main-2", expect.objectContaining({ intent: "removed" }));
		// /new left the first conversation alive, so disposal falls back to it.
		expect(strip.visibleAgentId()).toBe("main");
	});

	it("writes an attributed ephemeral row and takes it back", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const chat = harness.application.capabilities.get("chat", "drill");
		if (!chat) throw new Error("Expected the chat capability to be published.");
		const timeline = () => harness.application.state.agents.get("main")?.timeline ?? [];

		chat.insert("step", "chapter one");
		await vi.waitFor(() => {
			expect(timeline().at(-1)).toMatchObject({
				type: "extension-output",
				extensionId: "drill",
				durability: "ephemeral",
				text: "chapter one",
			});
		});

		// The same id is an update, not a second row.
		const before = timeline().length;
		chat.insert("step", "chapter one, revised");
		await vi.waitFor(() => {
			expect(timeline().at(-1)).toMatchObject({ text: "chapter one, revised" });
		});
		expect(timeline()).toHaveLength(before);

		chat.remove("step");
		await vi.waitFor(() => {
			expect(timeline().filter((item) => item.type === "extension-output")).toEqual([]);
		});
	});

	it("expands a row it wrote, and keeps it open across a rewrite", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const chat = harness.application.capabilities.get("chat", "drill");
		if (!chat) throw new Error("Expected the chat capability to be published.");
		const row = () =>
			harness.application.state.agents.get("main")?.timeline.find((item) => item.type === "extension-output");

		chat.insert("step", "chapter one");
		chat.setExpanded("step", true);
		await vi.waitFor(() => {
			expect(row()).toMatchObject({ expanded: true });
		});

		chat.insert("step", "chapter one, revised");
		await vi.waitFor(() => {
			expect(row()).toMatchObject({ text: "chapter one, revised", expanded: true });
		});

		chat.setExpanded("step", false);
		await vi.waitFor(() => {
			expect(row()).toMatchObject({ expanded: false });
		});

		// Another extension's id is not this one's, so it reaches nothing.
		harness.application.capabilities.get("chat", "other")?.setExpanded("step", true);
		await vi.waitFor(() => {
			expect(row()).toMatchObject({ expanded: false });
		});
	});

	it("reads the whole staging buffer and writes only its own entries", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const staged = harness.application.capabilities.get("stagedInput", "drill");
		if (!staged) throw new Error("Expected the staged input capability to be published.");
		const buffer = () => harness.application.state.agents.get("main")?.staged ?? [];

		const mine = await staged.add("from the extension");
		const theirs = harness.application.stageDraft("from the human");
		expect(mine).toBe(1);
		expect(staged.list()).toEqual([
			{ id: 1, text: "from the extension", extensionId: "drill" },
			{ id: 2, text: "from the human" },
		]);

		staged.update(1, "rewritten by its own producer");
		await vi.waitFor(() => {
			expect(buffer()[0]?.text).toBe("rewritten by its own producer");
		});

		// The human's entry is not this caller's to rewrite or drop: the branch
		// would file words under a producer that never wrote them.
		staged.update(theirs?.id ?? 0, "hijacked");
		staged.remove(theirs?.id ?? 0);
		await vi.waitFor(() => {
			expect(buffer()).toHaveLength(2);
		});
		expect(buffer()[1]?.text).toBe("from the human");

		staged.remove(1);
		await vi.waitFor(() => {
			expect(staged.list()).toEqual([{ id: 2, text: "from the human" }]);
		});
	});

	// Left out of the listing, an extension polling the buffer would watch its
	// own text vanish and stage it a second time.
	it("still lists a draft a human took into the editor", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const staged = harness.application.capabilities.get("stagedInput", "drill");
		if (!staged) throw new Error("Expected the staged input capability to be published.");

		await staged.add("first");
		await staged.add("second");
		(harness.application as unknown as { takeStagedIntoEditor(): void }).takeStagedIntoEditor();

		expect(staged.list()).toEqual([
			{ id: 1, text: "first", extensionId: "drill" },
			{ id: 2, text: "second", extensionId: "drill", heldInEditor: true },
		]);
		// It is out of the buffer while a human is rewriting it, and theirs until
		// they put it back.
		staged.update(2, "taken back mid-edit");
		await vi.waitFor(() => {
			expect(harness.application.state.agents.get("main")?.stagedEditing?.draft.text).toBe("second");
		});
	});

	it("reports the input queue and promotes it to steering", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const queued = harness.application.capabilities.get("queuedInput");
		if (!queued) throw new Error("Expected the queued input capability to be published.");
		const agent = harness.application.state.agents.get("main");
		if (!agent) throw new Error("Expected the agent projection.");
		agent.queue = { steer: ["stop that"], followUp: ["then this", "and this"], nextTurn: 0 };
		agent.pendingFollowUps = [{ id: 1, text: "on its way" }];

		expect(queued.list()).toEqual({
			steer: ["stop that"],
			followUp: ["then this", "and this"],
			unacknowledged: ["on its way"],
		});

		expect(await queued.steer()).toBe(2);
		expect(harness.steerQueuedFollowUps).toHaveBeenCalledWith("main");
		// The queue row empties on core's own event; nothing is said on top of it.
		expect(harness.application.state.globalNotices.some((notice) => notice.text.includes("steering"))).toBe(false);
	});

	it("docks a selection of its own and waits for the answer", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const dock = harness.application.capabilities.get("selectorDock");
		if (!dock) throw new Error("Expected the selector dock capability to be published.");

		const answer = dock.open({
			title: "Which chapter?",
			description: "pick where the drill starts",
			choices: [{ value: "one", label: "Chapter one" }, { value: "two" }],
		});
		await vi.waitFor(() => {
			expect(dock.isOpen()).toBe(true);
		});
		// The selection took the editor's place rather than floating over it.
		expect(harness.application.state.mode).toBe("selector");

		selectorInput(harness.application, "\r");
		expect(await answer).toBe("one");
		expect(dock.isOpen()).toBe(false);
		expect(harness.application.state.mode).toBe("editor");
	});

	it("resolves a docked selection as a cancel however it was taken down", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const dock = harness.application.capabilities.get("selectorDock");
		if (!dock) throw new Error("Expected the selector dock capability to be published.");
		const choices = [{ value: "one" }];

		const escaped = dock.open({ title: "Escaped", choices });
		await vi.waitFor(() => expect(dock.isOpen()).toBe(true));
		selectorInput(harness.application, "\x1b");
		expect(await escaped).toBeUndefined();

		const withdrawn = dock.open({ title: "Withdrawn", choices });
		await vi.waitFor(() => expect(dock.isOpen()).toBe(true));
		dock.close();
		expect(await withdrawn).toBeUndefined();

		// Nothing reaches the view on this path, so only the dock can report it.
		const interrupted = dock.open({ title: "Interrupted", choices });
		await vi.waitFor(() => expect(dock.isOpen()).toBe(true));
		(harness.application as unknown as { interrupt(): void }).interrupt();
		expect(await interrupted).toBeUndefined();

		// An occupied dock belongs to whoever the human is answering.
		const held = dock.open({ title: "Held", choices });
		await vi.waitFor(() => expect(dock.isOpen()).toBe(true));
		await expect(dock.open({ title: "Second", choices })).rejects.toThrow("already docked");
		dock.close();
		expect(await held).toBeUndefined();
	});

	it("lists pending requests and reports a presenter that throws exactly once", async () => {
		const harness = await createApplicationHarness();
		const runPromise = harness.application.run();
		try {
			await submit(harness.application, "hello");
			const requests = harness.application.capabilities.get("humanRequests", "drill");
			if (!requests) throw new Error("Expected the human requests capability to be published.");
			const menu = (harness.application as unknown as { humanRequests: HumanRequestMenu }).humanRequests;
			requests.present(() => {
				throw new Error("presenter is broken");
			});

			const answer = menu.request({
				id: "request-1",
				agentId: "main",
				source: { kind: "tool", agentId: "main", toolCallId: "call-1", toolName: "ask_human" },
				kind: "confirm",
				title: "Deploy?",
				createdAt: new Date(0).toISOString(),
			});
			expect(requests.list()).toEqual([expect.objectContaining({ id: "request-1", title: "Deploy?" })]);

			menu.render(80);
			menu.render(80);
			const reported = harness.application.state.diagnostics
				.list()
				.filter((record) => record.diagnostic.code === "tui_extension.request_presenter_failed");
			expect(reported).toHaveLength(1);
			// Once, not once per frame: the log's own dedupe would still count two.
			expect(reported[0]?.count).toBe(1);
			expect(reported[0]?.diagnostic.extensionId).toBe("drill");

			menu.close();
			await expect(answer).rejects.toThrow();
			expect(requests.list()).toEqual([]);
		} finally {
			await harness.application.shutdown("test cleanup");
			await runPromise;
		}
	});

	it("puts named text into all five composed rows", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "hello");
		const state = harness.application.state;

		for (const slot of SEGMENT_SLOTS) {
			const segments = harness.application.capabilities.get(slot, "drill");
			if (!segments) throw new Error(`Expected the ${slot} capability to be published.`);
			segments.set("mark", `${slot} mark`);
		}

		await vi.waitFor(() => {
			expect(state.segments.texts("header")).toEqual(["header mark"]);
		});
		expect(state.segments.texts("workingLine")).toEqual(["workingLine mark"]);
		expect(harness.application.capabilities.get("footer", "drill")?.list()).toEqual([
			{ id: "ext:drill:mark", text: "footer mark", order: 0 },
		]);
		// Scoped: a second extension neither sees nor can drop the first one's text.
		expect(harness.application.capabilities.get("footer", "other")?.list()).toEqual([]);

		harness.application.capabilities.get("status", "drill")?.remove("mark");
		await vi.waitFor(() => {
			expect(state.segments.texts("status")).toEqual([]);
		});
	});

	it("posts a notice that expires, and one that waits to be dismissed", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createApplicationHarness();
			const notices = harness.application.capabilities.get("notices", "drill");
			if (!notices) throw new Error("Expected the notices capability to be published.");
			const texts = () => harness.application.state.globalNotices.map((notice) => notice.text);

			notices.post("hint", "type /drill next", { ttlMs: 1_000 });
			notices.post("pinned", "waiting for you", { ttlMs: 0 });
			await vi.advanceTimersByTimeAsync(0);
			expect(texts()).toEqual(expect.arrayContaining(["type /drill next", "waiting for you"]));
			expect(harness.application.state.globalNotices.at(-1)?.extensionId).toBe("drill");

			await vi.advanceTimersByTimeAsync(1_000);
			expect(texts()).not.toContain("type /drill next");
			expect(texts()).toContain("waiting for you");

			notices.dismiss("pinned");
			await vi.advanceTimersByTimeAsync(0);
			expect(texts()).not.toContain("waiting for you");
		} finally {
			vi.useRealTimers();
		}
	});
});

async function createApplicationHarness(options: { agentDir?: string; extensionLoad?: unknown } = {}) {
	const runtimeModel = model();
	// The first spawn is the startup agent; later ones are the sessions /new
	// opens after closing it.
	let spawnCount = 0;
	const spawnAgent = vi.fn(async (_options?: unknown) => {
		spawnCount += 1;
		return spawnCount === 1 ? "main" : `main-${spawnCount}`;
	});
	const promptAgent = vi.fn(async () => ({
		kind: "completed" as const,
		message: {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		},
	}));
	const setAgentModelByReference = vi.fn(async () => runtimeModel);
	const resolveModelByReference = vi.fn(async () => runtimeModel);
	const setDefaultModel = vi.fn(() => {});
	const setAgentThinkingLevelByName = vi.fn(async () => "high");
	const setAgentSessionName = vi.fn(async () => {});
	const sendMessage = vi.fn(async (_request?: unknown) => ({ kind: "accepted" as const }));
	const messageSinkFor = vi.fn((_binding?: unknown) => ({ send: sendMessage, prompt: promptAgent }));
	const disposedAgentIds = new Set<string>();
	// Core answers with every agent it destroyed; a leaf answers with itself.
	const disposeAgent = vi.fn(async (agentId: string) => {
		disposedAgentIds.add(agentId);
		return [agentId];
	});
	const inspectAgent = vi.fn((agentId: string) => {
		const inspected = snapshot(agentId, runtimeModel);
		return disposedAgentIds.has(agentId) ? { ...inspected, status: "disposed" as const, hasHarness: false } : inspected;
	});
	const disposeAll = vi.fn(async () => {});
	const abortAgent = vi.fn(async () => ({ kind: "aborted" as const }));
	const steerQueuedFollowUps = vi.fn(async () => 2);
	const orchestrator = {
		subscribe: () => () => {},
		registerClient: () => () => {},
		disposeAll,
		disposeAgent,
		abortAgent,
		steerQueuedFollowUps,
		spawnAgent,
		promptAgent,
		sendMessage,
		// The shell holds one sink; every submit path goes through it.
		messageSinkFor,
		setAgentModelByReference,
		resolveModelByReference,
		setDefaultModel,
		setAgentThinkingLevelByName,
		setAgentSessionName,
		// Argument resolution consults the completers before execute.
		listAvailableModelCandidates: async () => ({ models: [{ value: "test/next-model", label: "Next Model" }] }),
		listAgentProfileCandidates: async () => ({ profiles: [{ value: "main", label: "Main Agent" }] }),
		listAgentThinkingLevelCandidates: () => ({
			levels: [
				{ value: "high", label: "high" },
				{ value: "medium", label: "medium" },
			],
		}),
		getDefaultModel: () => runtimeModel,
		getDefaultThinkingLevel: () => "medium",
		getAgentStatus: () => "idle",
		inspectAgent,
		getAgentSession: async () => ({
			metadata: { id: "main", createdAt: new Date(0).toISOString() },
			leafId: null,
			pathToRoot: [],
		}),
		listExtensionStatuses: () => [],
		listAgents: () => ({ agents: [] }),
		// /workspace resolves and stats the path before staging it.
		executionEnv: {
			absolutePath: async (path: string) => ({ ok: true as const, value: path.startsWith("/") ? path : `/${path}` }),
			fileInfo: async (path: string) => ({ ok: true as const, value: { kind: "directory" as const, path } }),
		},
	} as unknown as AgentOrchestrator;
	const runtime = {
		orchestrator,
		diagnostics: [],
		services: {
			cwd: "/workspace",
			workspaces: { startup: { cwd: "/workspace" }, resolve: async (cwd: string) => ({ cwd }) },
			settingManager: {
				getTheme: () => undefined,
				setTheme: () => {},
				getTerminalSettings: () => ({ wheelScrollLines: 3 }),
			},
			agentDir: options.agentDir ?? "/workspace/.widi-test-missing",
			defaultProfile: { id: "main", source: "builtin_fallback", profileSource: { kind: "builtin" } },
			defaultModel: { provider: runtimeModel.provider, modelId: runtimeModel.id, source: "runtime_override" },
			defaultThinkingLevel: { level: "medium", requestedLevel: "medium", source: "runtime_override", clamped: false },
			extensionLoad: options.extensionLoad ?? {
				discovery: { roots: [], candidates: [], diagnostics: [] },
				loaded: [],
				diagnostics: [],
			},
		} as unknown as WidiRuntimeServices,
	} satisfies WidiRuntime;
	const applicationPromise = WidiTuiApplication.create({ cwd: "/workspace", runtime });
	const application = await applicationPromise;
	const tuiStart = vi.spyOn(application.tui, "start").mockImplementation(() => {});
	vi.spyOn(application.tui, "stop").mockImplementation(() => {});
	vi.spyOn(application.tui.terminal, "setTitle").mockImplementation(() => {});
	return {
		application,
		tuiStart,
		disposeAll,
		abortAgent,
		steerQueuedFollowUps,
		spawnAgent,
		promptAgent,
		sendMessage,
		messageSinkFor,
		disposeAgent,
		inspectAgent,
		setAgentModelByReference,
		resolveModelByReference,
		setDefaultModel,
		setAgentThinkingLevelByName,
		setAgentSessionName,
	};
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function snapshot(agentId: string, runtimeModel: RuntimeModel) {
	return {
		agentId,
		generation: 1,
		cwd: "/workspace",
		profile: {
			reference: { id: "main", label: "Main Agent" },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		model: runtimeModel,
		thinkingLevel: "off",
		tools: { toolNames: [], activeToolNames: [] },
		activity: { activity: "idle" },
		extensions: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			systemPromptContributions: [],
			divisions: [],
			stale: { stale: false },
		},
		diagnostics: [],
	} satisfies AgentSnapshot;
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

describe("WidiTuiApplication workspaces", () => {
	it("moves the staged session with /workspace and spawns it there", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/workspace /workspace/other");

		expect(harness.application.state.pendingAgent?.start).toEqual({ kind: "default", cwd: "/workspace/other" });
		expect(harness.spawnAgent).not.toHaveBeenCalled();

		await submit(harness.application, "first");

		expect(harness.spawnAgent).toHaveBeenCalledWith({ origin: { kind: "new" }, cwd: "/workspace/other" });
	});

	it("refuses to move a conversation that already exists", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");

		await submit(harness.application, "/workspace /workspace/other");

		// The agent stays where it was spawned; only its own notice says why.
		expect(harness.application.state.agents.get("main")?.display.cwd).toBe("/workspace");
		expect(harness.application.state.pendingAgent).toBeUndefined();
	});
});
