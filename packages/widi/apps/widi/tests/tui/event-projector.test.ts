import type { CustomMessage } from "@arcadialin/agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import { ORCHESTRATOR_MESSAGE_CUSTOM_TYPE } from "../../src/core/session-manager.ts";
import type { OrchestratorEvent, RuntimeModel } from "../../src/core/types.ts";
import { applyAgentSnapshot, EventProjector } from "../../src/tui/event-projector.ts";
import { hydrateSessionEntries } from "../../src/tui/session-hydrator.ts";
import { createTuiApplicationState, setActiveAgent } from "../../src/tui/state.ts";
import { groupTurns } from "../../src/tui/timeline-window.ts";

describe("EventProjector", () => {
	it("lazily creates provisional agents before spawn and tracks background facts", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({ type: "agent_status_changed", agentId: "worker", activity: "running", changedAt: timestamp(1) });
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "worker",
			extensionId: "search",
			text: "Searching…",
			createdAt: timestamp(2),
		});
		projector.apply({
			type: "extension_status_changed",
			presentationId: "status-1",
			agentId: "worker",
			extensionId: "search",
			key: "progress",
			status: { text: "Searching", progress: { completed: 1, total: 3 } },
			changedAt: timestamp(3),
		});
		projector.apply({
			type: "extension_notification",
			presentationId: "notice-1",
			agentId: "worker",
			extensionId: "search",
			text: "Index warmed",
			createdAt: timestamp(4),
		});

		const worker = state.agents.get("worker");
		expect(worker).toMatchObject({ status: "running", unreadCount: 1, attention: "none" });
		expect(worker?.timeline).toMatchObject([
			{ type: "thinking-status", id: expect.stringMatching(/^awaiting:worker:/), status: "thinking" },
			{ type: "extension-output", id: "output-1", text: "Searching…" },
		]);
		if (!worker) throw new Error("Expected worker projection.");
		expect([...worker.extensionStatuses.values()]).toMatchObject([
			{ extensionId: "search", key: "progress", status: { text: "Searching" } },
		]);
		expect(state.globalNotices).toMatchObject([{ id: "notice-1", kind: "extension-notification", agentId: "worker" }]);
	});

	it("unwraps streaming harness events and consumes pending original input", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		agent.pendingInput = { originalText: "show <file:README.md>", submittedAt: timestamp(1) };

		projector.apply(harness("main", { type: "message_start", message: userMessage("show expanded README") }));
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		projector.apply(
			harness("main", {
				type: "message_update",
				message: assistantMessage("Hello"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hello",
					partial: assistantMessage("Hello"),
				},
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "contents" }] },
				isError: false,
			}),
		);
		projector.apply(harness("main", { type: "message_end", message: assistantMessage("Hello") }));

		expect(agent.timeline).toMatchObject([
			{ type: "user-message", text: "show <file:README.md>", modelText: "show expanded README" },
			{ type: "assistant-message", text: "Hello", streaming: false },
			{ type: "tool-execution", toolCallId: "tool-1", status: "completed", isError: false },
		]);
		expect(agent.pendingInput).toBeUndefined();
	});

	it("buffers timeline and extension status events until hydration completes", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "agent_spawned",
			agentId: "main",
			profile: { id: "default", label: "Default", systemPrompt: "test", persist: true },
			model: model(),
			origin: "new",
		});
		projector.apply({
			type: "extension_message_published",
			presentationId: "published-1",
			entryId: "entry-1",
			agentId: "main",
			extensionId: "reports",
			message: { kind: "text", content: "same durable message" },
			createdAt: timestamp(2),
		});
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "main",
			extensionId: "reports",
			text: "live-only output",
			createdAt: timestamp(3),
		});
		projector.apply({
			type: "extension_status_changed",
			presentationId: "status-new",
			agentId: "main",
			extensionId: "reports",
			key: "run",
			status: { text: "new status" },
			changedAt: timestamp(4),
		});

		const agent = state.agents.get("main");
		if (!agent) throw new Error("Expected main projection.");
		expect(agent.timeline).toEqual([]);
		expect(agent.bufferedEvents).toHaveLength(3);

		const history = hydrateSessionEntries([
			{
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: timestamp(1),
				customType: "core:extension_message",
				data: { extensionId: "reports", message: { kind: "text", content: "same durable message" } },
			},
		]);
		projector.completeHydration("main", history, [
			{
				agentId: "main",
				extensionId: "reports",
				key: "run",
				status: { text: "old snapshot" },
				updatedAt: timestamp(1),
			},
		]);

		expect(agent.hydration).toBe("ready");
		expect(agent.bufferedEvents).toEqual([]);
		expect(agent.timeline.map((item) => item.type)).toEqual(["extension-message", "extension-output"]);
		expect(agent.timeline.filter((item) => item.type === "extension-message")).toHaveLength(1);
		expect([...agent.extensionStatuses.values()]).toMatchObject([{ status: { text: "new status" } }]);
	});

	it("does not discard buffered events when hydration is requested twice", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		projector.beginHydration("main");
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "main",
			extensionId: "search",
			text: "still buffered",
			createdAt: timestamp(1),
		});

		projector.beginHydration("main");

		expect(state.agents.get("main")?.bufferedEvents).toMatchObject([
			{ type: "extension_output", presentationId: "output-1" },
		]);
	});

	it("records fork lineage on the target projection and retains it on resume", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({
			type: "agent_session_forked",
			agentId: "widi-dev",
			forkedSessionId: "019f784f-4342-781c-8472-93e6547da47e",
			createdAt: timestamp(1),
		});
		projector.apply({
			type: "agent_resumed",
			agentId: "019f784f-4342-781c-8472-93e6547da47e",
			profile: { id: "widi-dev", label: "WIDI Dev", systemPrompt: "test", persist: true },
			model: model(),
		});

		expect(state.agents.get("019f784f-4342-781c-8472-93e6547da47e")?.display.forkedFromAgentId).toBe("widi-dev");
	});

	it("retains explicit fork lineage through snapshot application and hydration", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const targetId = "019f784f-4342-781c-8472-93e6547da47e";

		projector.apply({
			type: "agent_session_forked",
			agentId: "widi-dev",
			forkedSessionId: targetId,
			createdAt: timestamp(1),
		});
		applyAgentSnapshot(state, snapshot(targetId, "/sessions/fork.jsonl", "/sessions/source.jsonl"));

		expect(state.agents.get(targetId)?.display.forkedFromAgentId).toBe("widi-dev");

		projector.beginHydration(targetId);
		projector.completeHydration(
			targetId,
			hydrateSessionEntries([
				{ type: "session_info", id: "session-info", parentId: null, timestamp: timestamp(2), name: "fork work" },
			]),
		);

		expect(state.agents.get(targetId)?.display).toMatchObject({
			forkedFromAgentId: "widi-dev",
			sessionName: "fork work",
		});
	});

	it("routes diagnostics and records privacy-safe human request traces", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-1",
				agentId: "worker",
				source: { kind: "human" },
				kind: "select",
				title: "Choose target",
				options: ["safe", "fast"],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-1",
			response: { kind: "select", value: "safe" },
			completedAt: timestamp(2),
		});
		projector.apply({
			type: "diagnostic",
			diagnostic: { severity: "error", code: "extension.failed", message: "Worker failed", agentId: "worker" },
			createdAt: timestamp(3),
		});

		const worker = state.agents.get("worker");
		if (!worker) throw new Error("Expected worker projection.");
		expect(worker.attention).toBe("error");
		expect(worker.timeline).toMatchObject([
			{ type: "human-request-trace", answer: { kind: "selected-option", value: "safe" } },
			{ type: "diagnostic", id: "diagnostic:extension.failed:worker::Worker failed" },
		]);
		expect(state.humanRequests).toEqual([]);
		expect(state.mode).toBe("editor");
	});

	it("summarizes a multi-select resolution with option labels", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-multi",
				agentId: "worker",
				source: { kind: "human" },
				kind: "multi-select",
				title: "Pick targets",
				options: [
					{ label: "Safe", value: "safe" },
					{ label: "Fast", value: "fast" },
					{ label: "Cheap", value: "cheap" },
				],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-multi",
			response: { kind: "multi-select", values: ["safe", "cheap"] },
			completedAt: timestamp(2),
		});

		expect(state.agents.get("worker")?.timeline).toMatchObject([
			{
				type: "human-request-trace",
				options: ["Safe", "Fast", "Cheap"],
				answer: { kind: "selected-options", values: ["Safe", "Cheap"] },
			},
		]);
	});

	it("summarizes a questions batch resolution with per-question labels", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-q",
				agentId: "worker",
				source: { kind: "human" },
				kind: "questions",
				title: "Deploy setup",
				questions: [
					{
						title: "Target",
						options: [
							{ label: "Staging", value: "staging" },
							{ label: "Prod", value: "prod" },
						],
					},
					{ title: "Regions", multiSelect: true, options: ["us", "eu"] },
				],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-q",
			response: {
				kind: "questions",
				answers: [
					{ kind: "select", value: "staging" },
					{ kind: "multi-select", values: ["us", "eu"] },
				],
			},
			completedAt: timestamp(2),
		});

		expect(state.agents.get("worker")?.timeline).toMatchObject([
			{
				type: "human-request-trace",
				answer: {
					kind: "answered-questions",
					items: [
						{ title: "Target", values: ["Staging"] },
						{ title: "Regions", values: ["us", "eu"] },
					],
				},
			},
		]);
	});

	it("keeps active tool failures inline and gives background ones a transient warning", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const main = setActiveAgent(state, "main");

		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-main",
				toolName: "ls",
				args: { path: "missing" },
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-main",
				toolName: "ls",
				result: { content: [{ type: "text", text: "Path not found" }] },
				isError: true,
			}),
		);
		expect(main.attention).toBe("none");

		projector.apply(
			harness("worker", {
				type: "tool_execution_end",
				toolCallId: "tool-worker",
				toolName: "ls",
				result: { content: [{ type: "text", text: "Path not found" }] },
				isError: true,
			}),
		);
		expect(state.agents.get("worker")?.attention).toBe("warning");

		setActiveAgent(state, "worker");
		expect(state.agents.get("worker")?.attention).toBe("none");
	});

	it("retains diagnostic-backed attention when the agent is viewed", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "diagnostic",
			diagnostic: { severity: "warning", code: "extension.degraded", message: "Still degraded", agentId: "worker" },
			createdAt: timestamp(1),
		});

		setActiveAgent(state, "worker");

		expect(state.agents.get("worker")?.attention).toBe("warning");
	});

	it("joins multiple assistant text blocks with a blank line", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		const message = assistantMessage("first");
		message.content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];

		projector.apply(harness("main", { type: "message_start", message }));
		projector.apply(harness("main", { type: "message_end", message }));

		expect(agent.timeline).toMatchObject([{ type: "assistant-message", text: "first\n\nsecond" }]);
	});

	// A message the runtime wrote opens a turn exactly as a typed one does: the
	// model is reading it either way, so the transcript has to show the reply
	// under it rather than folded into whatever came before.
	it("projects a live orchestrator message and opens a turn with it", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply(
			harness("main", {
				type: "message_start",
				message: orchestratorMessage("[Message from worker-7]\n\nscan finished", {
					source: { kind: "agent", label: "worker-7" },
					body: "scan finished",
				}),
			}),
		);
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("noted") }));

		expect(agent.timeline).toMatchObject([
			{
				type: "orchestrator-message",
				source: { kind: "agent", label: "worker-7" },
				text: "scan finished",
				modelText: "[Message from worker-7]\n\nscan finished",
			},
			{ type: "assistant-message" },
		]);
		expect(groupTurns(agent.timeline)).toHaveLength(1);
	});

	it("previews a queued orchestrator message by its body, not its rendered form", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply(
			harness("main", {
				type: "queue_update",
				steer: [
					orchestratorMessage("[Input from extension mcp]\n\ntools refreshed", {
						source: { kind: "extension:mcp", label: "mcp" },
						body: "tools refreshed",
					}),
				],
				followUp: [],
				nextTurn: [],
			}),
		);

		expect(agent.queue).toMatchObject({ steer: ["tools refreshed"] });
	});

	it("restores diagnostic attention after a human request is resolved", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "diagnostic",
			diagnostic: { severity: "warning", code: "extension.warning", message: "Still degraded", agentId: "worker" },
			createdAt: timestamp(1),
		});
		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-1",
				agentId: "worker",
				source: { kind: "human" },
				kind: "confirm",
				title: "Continue?",
				createdAt: timestamp(2),
			},
		});
		expect(state.agents.get("worker")?.attention).toBe("human-request");

		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-1",
			response: { kind: "confirm", confirmed: true },
			completedAt: timestamp(3),
		});
		expect(state.agents.get("worker")?.attention).toBe("warning");
	});

	it("shows a preparing tool item from toolcall_start and upgrades it on execution start", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		const partial = assistantToolCallMessage("tool-1", "read");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
			}),
		);

		expect(agent.timeline).toMatchObject([
			{ type: "assistant-message" },
			{ type: "tool-execution", toolCallId: "tool-1", toolName: "read", status: "preparing" },
		]);

		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);

		const tools = agent.timeline.filter((item) => item.type === "tool-execution");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ status: "running", args: { path: "README.md" } });
	});

	it("reconciles a preparing tool whose provider id arrives in a later delta", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		const started = assistantToolCallMessage("", "");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: started },
			}),
		);
		const updated = assistantToolCallMessage("tool-1", "read", { path: "README.md" });
		projector.apply(
			harness("main", {
				type: "message_update",
				message: updated,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"path":"README.md"}',
					partial: updated,
				},
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);

		const tools = agent.timeline.filter((item) => item.type === "tool-execution");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
			status: "running",
		});
	});

	it("cancels a preparing tool item when the run ends before execution starts", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(1) });
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		const partial = assistantToolCallMessage("tool-1", "read");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
			}),
		);
		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(2) });

		expect(agent.timeline).toMatchObject([
			{ type: "assistant-message" },
			{ type: "tool-execution", toolCallId: "tool-1", status: "cancelled" },
		]);
	});

	it("covers run gaps with an ephemeral awaiting-thinking indicator", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		const awaiting = () =>
			agent.timeline.find((item) => item.type === "thinking-status" && item.id.startsWith("awaiting:main:"));

		// User submit to first token: the status change alone shows thinking.
		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(1) });
		expect(awaiting()).toMatchObject({ status: "thinking" });
		expect(awaiting()).not.toHaveProperty("preview");

		// The harness user message follows the status event, so the indicator is
		// moved behind it instead of staying above the current turn.
		projector.apply(harness("main", { type: "message_start", message: userMessage("inspect the workspace") }));
		expect(agent.timeline.map((item) => item.type)).toEqual(["user-message", "thinking-status"]);

		// The first assistant message starts the real stream; the gap closes.
		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		expect(awaiting()).toBeUndefined();

		// Between tool executions the gap indicator comes back.
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "contents" }] },
				isError: false,
			}),
		);
		expect(awaiting()).toMatchObject({ status: "thinking" });
		expect(agent.timeline.at(-1)?.type).toBe("thinking-status");

		// Leaving "running" removes the transient indicator.
		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(2) });
		expect(awaiting()).toBeUndefined();

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(3) });
		projector.apply(harness("main", { type: "message_start", message: userMessage("next turn") }));
		expect(agent.timeline.at(-1)).toMatchObject({ type: "thinking-status", status: "thinking" });
	});

	it("labels the gap indicator for maintenance work and clears it on idle", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		const awaiting = () =>
			agent.timeline.find((item) => item.type === "thinking-status" && item.id.startsWith("awaiting:main:"));

		projector.apply({
			type: "agent_status_changed",
			agentId: "main",
			activity: "running",
			maintenance: "compaction",
			changedAt: timestamp(1),
		});
		expect(agent.maintenance).toBe("compaction");
		expect(awaiting()).toMatchObject({ status: "thinking", label: "Compacting…" });

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(2) });
		expect(agent.maintenance).toBeUndefined();
		expect(awaiting()).toBeUndefined();

		// A plain run keeps the default Thinking… label.
		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(3) });
		expect(agent.maintenance).toBeUndefined();
		expect(awaiting()).toMatchObject({ status: "thinking", label: undefined });
	});

	it("tracks a rolling two-line preview of streamed thinking", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply(harness("main", { type: "message_start", message: assistantMessage("") }));
		const start = thinkingPartial("");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: start,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: start },
			}),
		);
		const thinking = agent.timeline.find((item) => item.type === "thinking-status");
		expect(thinking).toMatchObject({ status: "thinking", preview: undefined });

		const firstDelta = thinkingPartial("first line\nsec");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: firstDelta,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "first line\nsec",
					partial: firstDelta,
				},
			}),
		);
		const secondDelta = thinkingPartial("first line\nsecond line\nthird line");
		projector.apply(
			harness("main", {
				type: "message_update",
				message: secondDelta,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "ond line\nthird line",
					partial: secondDelta,
				},
			}),
		);
		expect(thinking).toMatchObject({ status: "thinking", preview: "second line\nthird line" });
	});
});

describe("EventProjector run accounting", () => {
	it("rolls a working line when a run starts and an idle one when it ends", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(1) });
		expect(state.agents.get("main")?.quip?.steady.state).toBe("working");

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(9) });
		expect(state.agents.get("main")?.quip?.steady.state).toBe("idle");
	});

	it("counts the run's tool calls and keeps the totals once it ends", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(1) });
		projector.apply(harness("main", { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", args: {} }));
		projector.apply(harness("main", { type: "tool_execution_start", toolCallId: "b", toolName: "Read", args: {} }));
		expect(state.agents.get("main")?.runToolCount).toBe(2);

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "idle", changedAt: timestamp(9) });
		expect(state.agents.get("main")?.lastRun).toEqual({ startedAt: timestamp(1), endedAt: timestamp(9), toolCount: 2 });

		projector.apply({ type: "agent_status_changed", agentId: "main", activity: "running", changedAt: timestamp(10) });
		expect(state.agents.get("main")?.runToolCount).toBe(0);
	});

	it("stamps a tool call with when it ran", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		projector.apply(harness("main", { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", args: {} }));
		projector.apply(
			harness("main", { type: "tool_execution_end", toolCallId: "a", toolName: "Bash", result: "ok", isError: false }),
		);

		const tool = state.agents.get("main")?.timeline.find((item) => item.type === "tool-execution");
		expect(tool).toMatchObject({ status: "completed", startedAt: expect.any(String), endedAt: expect.any(String) });
	});

	// The reason a run ended is only on agent_idle; the status event says the
	// run ended and nothing about how.
	it("says who stopped a run", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({
			type: "agent_idle",
			agentId: "main",
			reason: "aborted",
			abortedBy: "human",
			idleAt: timestamp(2),
		});
		expect(state.agents.get("main")?.quip?.transient?.state).toBe("aborted-by-human");

		projector.apply({
			type: "agent_idle",
			agentId: "main",
			reason: "aborted",
			abortedBy: "extension",
			idleAt: timestamp(3),
		});
		expect(state.agents.get("main")?.quip?.transient?.state).toBe("aborted-by-extension");

		projector.apply({ type: "agent_idle", agentId: "main", reason: "aborted", idleAt: timestamp(4) });
		expect(state.agents.get("main")?.quip?.transient?.state).toBe("aborted");

		projector.apply({ type: "agent_idle", agentId: "main", reason: "settled", idleAt: timestamp(5) });
		expect(state.agents.get("main")?.quip?.transient?.state).toBe("done");
	});

	it("keeps quiet about an idle nobody was waiting on", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({ type: "agent_idle", agentId: "main", reason: "ready", idleAt: timestamp(1) });

		expect(state.agents.get("main")?.quip).toBeUndefined();
	});

	it("speaks up only once a run keeps failing", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const fail = (id: string) =>
			projector.apply(
				harness("main", { type: "tool_execution_end", toolCallId: id, toolName: "Bash", result: "no", isError: true }),
			);

		fail("a");
		fail("b");
		expect(state.agents.get("main")?.quip?.transient).toBeUndefined();

		fail("c");
		expect(state.agents.get("main")?.quip?.transient?.state).toBe("error");
	});

	it("forgets the failures once a call succeeds", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const end = (id: string, isError: boolean) =>
			projector.apply(
				harness("main", { type: "tool_execution_end", toolCallId: id, toolName: "Bash", result: "x", isError }),
			);

		end("a", true);
		end("b", true);
		end("c", false);
		end("d", true);

		expect(state.agents.get("main")?.runToolErrorStreak).toBe(1);
		expect(state.agents.get("main")?.quip?.transient).toBeUndefined();
	});
});

function harness(
	agentId: string,
	event: Extract<OrchestratorEvent, { type: "agent_harness_event" }>["event"],
): Extract<OrchestratorEvent, { type: "agent_harness_event" }> {
	return { type: "agent_harness_event", agentId, event };
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.parse(timestamp(1)) };
}

function orchestratorMessage(content: string, details: unknown): CustomMessage {
	return {
		role: "custom",
		customType: ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
		content,
		display: true,
		details,
		timestamp: Date.parse(timestamp(1)),
	};
}

function assistantToolCallMessage(id: string, name: string, args: Record<string, unknown> = {}): AssistantMessage {
	return { ...assistantMessage(""), content: [{ type: "toolCall", id, name, arguments: args }] };
}

function thinkingPartial(thinking: string): AssistantMessage {
	return { ...assistantMessage(""), content: [{ type: "thinking", thinking }] };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
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
		stopReason: "stop",
		timestamp: Date.parse(timestamp(1)),
	};
}

function model(): RuntimeModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function snapshot(agentId: string, path: string, parentSessionPath?: string): AgentSnapshot {
	return {
		agentId,
		generation: 1,
		cwd: "/workspace/project",
		profile: {
			reference: { id: "widi-dev", label: "WIDI Dev" },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		sessionMetadata: { id: agentId, createdAt: new Date(0).toISOString(), cwd: "/workspace", path, parentSessionPath },
		model: model(),
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
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}

describe("per-item tool expansion (parity §4.3-3)", () => {
	it("keeps the per-item expand override across tool execution updates", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "seq 3" },
			}),
		);
		projector.setToolExpanded("main", "tool-1", true);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "1\n2\n3" }] },
				isError: false,
			}),
		);

		const item = state.agents.get("main")?.timeline.find((entry) => entry.type === "tool-execution");
		expect(item).toMatchObject({ type: "tool-execution", status: "completed", expanded: true });

		projector.setToolExpanded("main", "tool-1", undefined);
		expect(item).not.toHaveProperty("expanded");
	});
});
