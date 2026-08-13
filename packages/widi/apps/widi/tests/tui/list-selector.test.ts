import { type SelectItem, setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import type { WidiRuntime } from "../../src/core/runtime-service.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import { ListSelector } from "../../src/tui/selectors/list-selector.ts";
import { ensureAgentProjection } from "../../src/tui/state.ts";
import { AgentStripView } from "../../src/tui/views/agent-strip.ts";
import type { WidiEditor } from "../../src/tui/views/editor.ts";
import { OperationHintView } from "../../src/tui/views/operation-hint.ts";
import type { SelectorDock } from "../../src/tui/views/selector-dock.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ENTER = "\r";
const BACKSPACE = "\u007f";

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

const items: SelectItem[] = [
	{ value: "vllm/qwen3.6", label: "vllm/qwen3.6", description: "local" },
	{ value: "vllm/glm-5", label: "vllm/glm-5", description: "local" },
	{ value: "anthropic/claude", label: "anthropic/claude", description: "api" },
];

function plainRender(selector: ListSelector, width = 80): string {
	return selector.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("ListSelector", () => {
	it("renders rules, title, items and key hints around the list", () => {
		const selector = new ListSelector({
			title: "/model",
			items,
			operation: { description: "Set the current agent or staged session model.", confirmVerb: "apply" },
			onSelect: () => {},
			onClose: () => {},
		});
		selector.focused = true;

		const rendered = plainRender(selector);
		expect(rendered).toContain("─");
		expect(rendered).toContain("/model");
		expect(rendered).toContain("vllm/qwen3.6");
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).toContain("→");
		expect(rendered).toContain("navigate");
		expect(rendered).toContain("Enter select");
		expect(rendered).toContain("Esc cancel");
		expect(selector.hintContext).toEqual({
			title: "/model",
			description: "Set the current agent or staged session model.",
			confirmVerb: "apply",
			itemCount: 3,
		});
	});

	it("filters items with typed characters and restores on backspace", () => {
		const selector = new ListSelector({
			title: "/model",
			items,
			operation: { confirmVerb: "apply" },
			onSelect: () => {},
			onClose: () => {},
		});
		expect(selector.hintContext?.itemCount).toBe(3);

		selector.handleInput("g");
		selector.handleInput("l");
		selector.handleInput("m");
		let rendered = plainRender(selector);
		expect(rendered).toContain("> glm");
		expect(rendered).toContain("vllm/glm-5");
		expect(rendered).not.toContain("anthropic/claude");
		expect(selector.hintContext?.itemCount).toBe(1);

		selector.handleInput(BACKSPACE);
		selector.handleInput(BACKSPACE);
		selector.handleInput(BACKSPACE);
		rendered = plainRender(selector);
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).not.toContain("> glm");
		expect(selector.hintContext?.itemCount).toBe(3);
	});

	it("opens with a pre-filled filter", () => {
		const selector = new ListSelector({
			title: "/model",
			items,
			initialFilter: "claude",
			onSelect: () => {},
			onClose: () => {},
		});

		const rendered = plainRender(selector);
		expect(rendered).toContain("> claude");
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).not.toContain("vllm/glm-5");
	});

	it("routes printable selection keybindings before filter input", () => {
		const keybindings = createWidiKeybindings();
		keybindings.setUserBindings({ "tui.select.down": "j", "tui.select.confirm": "space" });
		setKeybindings(keybindings);
		const selected: string[] = [];
		const selector = new ListSelector({
			title: "/model",
			items,
			onSelect: (item) => selected.push(item.value),
			onClose: () => {},
		});

		selector.handleInput("j");
		selector.handleInput(" ");

		expect(selected).toEqual(["vllm/glm-5"]);
	});

	it("does not expose hint context without an operation", () => {
		const selector = new ListSelector({ title: "/model", items, onSelect: () => {}, onClose: () => {} });

		expect(selector.hintContext).toBeUndefined();
	});

	it("selects the initial index with enter and closes", () => {
		const calls: string[] = [];
		const selector = new ListSelector({
			title: "/model",
			items,
			initialIndex: 1,
			onSelect: (item) => calls.push(`select:${item.value}`),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(ENTER);

		// onClose runs first so a re-opened selector is not torn down by it.
		expect(calls).toEqual(["close", "select:vllm/glm-5"]);
		expect(selector.render(80)).toEqual([]);
		expect(selector.hintContext).toBeUndefined();
	});

	it("cancels with escape", () => {
		const calls: string[] = [];
		const selector = new ListSelector({
			title: "/model",
			items,
			operation: { confirmVerb: "apply" },
			onSelect: () => {},
			onCancel: () => calls.push("cancel"),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(ESCAPE);

		expect(calls).toEqual(["close", "cancel"]);
		expect(selector.hintContext).toBeUndefined();
		expect(selector.render(80)).toEqual([]);
	});

	it("ignores input after closing", () => {
		const selected: string[] = [];
		const selector = new ListSelector({
			title: "/model",
			items,
			onSelect: (item) => selected.push(item.value),
			onClose: () => {},
		});
		selector.handleInput(ENTER);

		selector.handleInput(ENTER);

		expect(selected).toEqual(["vllm/qwen3.6"]);
	});
});

describe("WidiTuiApplication command selector", () => {
	it("opens the selector docked in the editor's place, not as an overlay", async () => {
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({ models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }] }),
		});
		expect(application.tui.hasOverlay()).toBe(false);

		await submit(application, "/model");

		expect(application.state.mode).toBe("selector");
		expect(application.tui.hasOverlay()).toBe(false);
		const dock = requireDock(application);
		expect(dock.current).toBeInstanceOf(ListSelector);
		// The editor leaves the layout while the selector is docked, pi-style.
		const editorSlot = application.layout.component("editor");
		expect(editorSlot?.render(80)).toEqual([]);

		dock.current?.handleInput?.(ESCAPE);

		expect(application.state.mode).toBe("editor");
		expect(editorSlot?.render(80).length).toBeGreaterThan(0);
	});

	it("opens the selector pre-filled with the query when a submitted argument does not resolve", async () => {
		const setAgentModelByReference = vi.fn(async () => undefined);
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({
				models: [
					{ value: "vllm/qwen3.6", label: "Qwen 3.6" },
					{ value: "vllm/glm-5", label: "GLM 5" },
				],
			}),
			setAgentModelByReference,
		});

		await submit(application, "/model gl");

		expect(setAgentModelByReference).not.toHaveBeenCalled();
		expect(application.state.mode).toBe("selector");
		const selector = requireSelector(application);
		const rendered = plainRender(selector);
		expect(rendered).toContain("> gl");
		expect(rendered).toContain("GLM 5");

		selector.handleInput(ESCAPE);
		expect(requireEditor(application).getText()).toBe("/model gl");
		expect(application.state.mode).toBe("editor");
	});

	it("executes a unique argument prefix without opening the selector", async () => {
		const setAgentModelByReference = vi.fn(async () => ({ provider: "vllm", id: "glm-5" }));
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({
				models: [
					{ value: "vllm/qwen3.6", label: "Qwen 3.6" },
					{ value: "vllm/glm-5", label: "GLM 5" },
				],
			}),
			setAgentModelByReference,
		});

		await submit(application, "/model vllm/gl");

		expect(setAgentModelByReference).toHaveBeenCalledWith("agent-1", "vllm/glm-5");
		expect(application.tui.hasOverlay()).toBe(false);
		expect(application.state.mode).toBe("editor");
	});

	it("resubmits the selection and hands focus back to the editor", async () => {
		const setAgentModelByReference = vi.fn(async () => undefined);
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({
				models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6", description: "local" }],
			}),
			setAgentModelByReference,
		});

		await submit(application, "/model");

		const selector = requireSelector(application);
		expect(plainRender(selector)).toContain("Qwen 3.6");
		expect(selector.hintContext).toEqual({
			title: "/model",
			description: "Set the current agent or staged session model.",
			confirmVerb: "apply",
			itemCount: 1,
		});
		expect(setAgentModelByReference).not.toHaveBeenCalled();
		expect(requireEditor(application).focused).toBe(false);

		selector.handleInput(ENTER);
		await flush();

		expect(setAgentModelByReference).toHaveBeenCalledWith("agent-1", "vllm/qwen3.6");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
		expect(requireEditor(application).focused).toBe(true);
	});

	it("feeds the open selector into the operation hint", async () => {
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({ models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }] }),
		});

		await submit(application, "/model");

		const hint = application.layout.component("operationHint");
		if (!(hint instanceof OperationHintView)) throw new Error("Expected the operation hint to be mounted.");
		const rendered = hint.render(120).join("\n").replace(ANSI_SEQUENCE, "");
		expect(rendered).toContain("/model");
		expect(rendered).toContain("apply");
	});

	it("restores the submitted command when the selector is cancelled", async () => {
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({ models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }] }),
		});
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/model");
		requireSelector(application).handleInput(ESCAPE);

		expect(editor.getText()).toBe("/model");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
	});

	it("dismisses the selector on interrupt without restoring the command", async () => {
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({ models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }] }),
		});
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/model");
		(application as unknown as { interrupt(): void }).interrupt();

		expect(application.tui.hasOverlay()).toBe(false);
		expect(application.state.mode).toBe("editor");
		expect(editor.getText()).toBe("");
	});

	it("offers the current position before explicit fork points", async () => {
		const spawnAgent = vi.fn(async (_request: { origin: unknown }) => "agent-2");
		const { application } = await createApplication({
			getAgentSessionTree: async () => ({
				entries: [
					{
						type: "message",
						id: "message-1",
						timestamp: "2026-07-17T00:00:00.000Z",
						message: { role: "user", content: "Earlier user message" },
					},
				],
			}),
			spawnAgent,
			inspectAgent: () => ({ agentId: "agent-2" }),
		});

		await submit(application, "/fork");
		const selector = requireSelector(application);

		expect(plainRender(selector)).toContain("Fork here (current position)");
		selector.handleInput(ENTER);
		await flush();
		// The current position carries no entry id: the fork lands on the leaf.
		expect(spawnAgent).toHaveBeenCalledWith({ origin: { kind: "fork", sourceAgentId: "agent-1" } });
	});

	it("focuses the agent panel from the empty editor with the down key", async () => {
		const { application } = await createApplication();
		ensureAgentProjection(application.state, "agent-2", "idle");
		const editor = requireEditor(application);

		editor.handleInput("\x1b[B");

		expect(application.state.mode).toBe("agent-panel");
		const panel = application.layout.component("agentStrip");
		if (!(panel instanceof AgentStripView)) throw new Error("Expected the agent panel to be mounted.");
		expect(panel.focused).toBe(true);
		expect(panel.cursor).toBe("agent-1");

		panel.handleInput("\x1b[C");
		expect(panel.cursor).toBe("agent-2");

		panel.handleInput("\r");
		expect(application.state.activeAgentId).toBe("agent-2");
		expect(application.state.mode).toBe("editor");
		expect(panel.focused).toBe(false);
	});
});

describe("WidiTuiApplication command submission", () => {
	it("submits an expanded prompt command without leaving a command item", async () => {
		const promptAgent = vi.fn(async (_request: { body: string }) => ({ kind: "accepted" }) as const);
		const { application } = await createApplication({
			getAgentSkill: async (_agentId: string, name: string) => ({
				name,
				description: "Review the current changes.",
				content: "Review the diff carefully.",
				filePath: `/skills/${name}/SKILL.md`,
			}),
			promptAgent,
		});

		await submit(application, "/skill review");

		expect(promptAgent).toHaveBeenCalledOnce();
		expect(promptAgent.mock.calls[0]?.[0]?.body).toContain("Review the diff carefully.");
		expect(application.state.agents.get("agent-1")?.timeline.filter((item) => item.type === "command-result")).toEqual(
			[],
		);
	});

	it("keeps a failed expansion out of the prompt and records the failure", async () => {
		const promptAgent = vi.fn(async () => ({ kind: "accepted" }) as const);
		const { application } = await createApplication({
			getAgentSkill: async () => {
				throw new Error("skill expansion failed");
			},
			promptAgent,
		});

		await submit(application, "/skill broken");

		expect(promptAgent).not.toHaveBeenCalled();
		expect(
			application.state.agents.get("agent-1")?.timeline.filter((item) => item.type === "command-result"),
		).toMatchObject([
			{ name: "skill", argument: "broken", status: "failed", error: { message: "skill expansion failed" } },
		]);
	});

	it("preserves a status-gated line command argument in its failed item", async () => {
		const { application } = await createApplication({ getAgentActivity: () => ({ activity: "running" }) });

		await submit(application, "/resume:some-session");

		expect(
			application.state.agents.get("agent-1")?.timeline.filter((item) => item.type === "command-result"),
		).toMatchObject([
			{
				name: "resume",
				argument: "some-session",
				status: "failed",
				error: { message: "Command /resume is not available while the agent is running." },
			},
		]);
	});
});

async function createApplication(overrides: Record<string, unknown> = {}) {
	const defaultModel = agentSnapshot("default").model;
	const promptAgent = overrides.promptAgent ?? (async () => ({ kind: "accepted" }) as const);
	const sendMessage = overrides.sendMessage ?? (async () => ({ kind: "accepted" }) as const);
	const orchestrator = {
		getAgentStatus: () => "idle",
		getAgentActivity: () => ({ activity: "idle" }),
		getDefaultModel: () => defaultModel,
		getDefaultThinkingLevel: () => "medium",
		sendMessage,
		promptAgent,
		...overrides,
		messageSinkFor: () => ({ send: sendMessage, prompt: promptAgent }),
	} as unknown as AgentOrchestrator;
	const runtime = {
		orchestrator,
		services: {
			cwd: "/repo",
			agentDir: "/repo/.widi-test-missing",
			defaultProfile: { id: "default-agent" },
			settingManager: {
				getTheme: () => undefined,
				setTheme: () => {},
				getTerminalSettings: () => ({ wheelScrollLines: 3 }),
			},
		},
		diagnostics: [],
	} as unknown as WidiRuntime;
	const application = await WidiTuiApplication.create({ cwd: "/repo", runtime });
	application.tui.requestRender = vi.fn();
	const agent = ensureAgentProjection(application.state, "agent-1", "idle");
	agent.snapshot = agentSnapshot("agent-1");
	application.state.activeAgentId = agent.agentId;
	application.state.pendingAgent = undefined;
	return { application, orchestrator };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentSnapshot(agentId: string): AgentSnapshot {
	return {
		agentId,
		generation: 1,
		cwd: "/workspace/project",
		profile: {
			reference: { id: "default-agent", label: agentId },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		model: { provider: "vllm", id: "qwen3.6" } as AgentSnapshot["model"],
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

function requireDock(application: WidiTuiApplication): SelectorDock {
	return (application as unknown as { selectorDock: SelectorDock }).selectorDock;
}

function requireSelector(application: WidiTuiApplication): ListSelector {
	const view = requireDock(application).current;
	if (view instanceof ListSelector) return view;
	throw new Error("Expected a command selector to be docked.");
}

function requireEditor(application: WidiTuiApplication): WidiEditor {
	// The mounted editor is wrapped in a slot visibility gate, so the instance
	// comes from the application's own field rather than the child list.
	return (application as unknown as { editor: WidiEditor }).editor;
}

async function submit(application: WidiTuiApplication, text: string): Promise<void> {
	await (application as unknown as { submit(rawText: string): Promise<void> }).submit(text);
}
