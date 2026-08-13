import type { MessageEntry, SessionTreeEntry } from "@arcadialin/agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import type { WidiRuntime } from "../../src/core/runtime-service.ts";
import type { AgentSessionTreeSnapshot } from "../../src/core/session-manager.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import { TreeNavigationSelector } from "../../src/tui/selectors/tree-navigation.ts";
import { TreeSelector } from "../../src/tui/selectors/tree-selector.ts";
import { buildSessionEntryRows, type SessionEntryTreeRow } from "../../src/tui/session-tree.ts";
import { ensureAgentProjection } from "../../src/tui/state.ts";
import type { WidiEditor } from "../../src/tui/views/editor.ts";
import { OperationHintView } from "../../src/tui/views/operation-hint.ts";
import type { SelectorDock } from "../../src/tui/views/selector-dock.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TIMESTAMP = "2026-08-01T00:00:00.000Z";
const NOW = new Date("2026-08-08T00:00:00.000Z");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

afterEach(() => {
	vi.useRealTimers();
});

function userEntry(id: string, parentId: string | null, text: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function assistantEntry(id: string, parentId: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "assistant", content: [] } as unknown as MessageEntry["message"],
	};
}

function snapshot(entries: readonly SessionTreeEntry[], leafId: string | null): AgentSessionTreeSnapshot {
	return { entries, leafId } as unknown as AgentSessionTreeSnapshot;
}

/** u1 → {u2, u3}, leaf under u3: one root, two branch rows, u3 current. */
function branchSnapshot(): AgentSessionTreeSnapshot {
	return snapshot(
		[
			userEntry("u1", null, "first question"),
			assistantEntry("a1", "u1"),
			userEntry("u2", "a1", "follow up"),
			assistantEntry("a2", "u2"),
			userEntry("u3", "a1", "new branch"),
			assistantEntry("a3", "u3"),
		],
		"a3",
	);
}

function branchRows(): SessionEntryTreeRow[] {
	return buildSessionEntryRows(branchSnapshot());
}

function plainRender(selector: TreeSelector | TreeNavigationSelector, width = 80): string {
	return selector.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("TreeSelector", () => {
	it("renders rules, title, branch rows and key hints", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });
		selector.focused = true;

		const rendered = plainRender(selector);
		expect(rendered).toContain("─");
		expect(rendered).toContain("/tree");
		expect(rendered).toContain("user: first question 7d");
		expect(rendered).toContain("assistant: (no content) 7d");
		expect(rendered).toContain("├── user: follow up 7d");
		expect(rendered).toContain("└── user: new branch 7d");
		expect(rendered).toContain("● assistant: (no content) 7d");
		expect(rendered).toContain("(6/6)");
		expect(rendered).toContain("navigate");
		expect(rendered).toContain("Enter switch");
		expect(rendered).toContain("Esc cancel");
		expect(selector.hintContext).toEqual({ title: "/tree", confirmVerb: "switch", itemCount: 6 });
	});

	it("renders a single chain flat, without connectors or drift", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const rows = buildSessionEntryRows(
			snapshot(
				[userEntry("u1", null, "first question"), assistantEntry("a1", "u1"), userEntry("u2", "a1", "follow up")],
				"u2",
			),
		);
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		const rendered = plainRender(selector);
		expect(rendered).toContain("user: first question 7d");
		expect(rendered).toContain("assistant: (no content) 7d");
		expect(rendered).toContain("● user: follow up 7d");
		expect(rendered).toContain("(3/3)");
		expect(rendered).not.toContain("├──");
		expect(rendered).not.toContain("└──");
	});

	it("renders a gutter below a branching row and keeps the chain flat", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const rows = buildSessionEntryRows(
			snapshot(
				[
					userEntry("u1", null, "root"),
					assistantEntry("a1", "u1"),
					userEntry("u2", "a1", "branch one"),
					userEntry("u3", "a1", "branch two"),
					assistantEntry("a2", "u2"),
					userEntry("u4", "a2", "branch one follow up"),
					assistantEntry("a4", "u4"),
					userEntry("u5", "a4", "branch one later"),
				],
				"u3",
			),
		);
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		const rendered = plainRender(selector);
		expect(rendered).toContain("├── user: branch one 7d");
		expect(rendered).toContain("│       assistant: (no content) 7d");
		expect(rendered).toContain("│       user: branch one follow up 7d");
		expect(rendered).toContain("│       user: branch one later 7d");
		expect(rendered).toContain("└── ● user: branch two 7d");
	});

	it("renders tool calls and branch summaries with their own labels", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const entries: SessionTreeEntry[] = [
			userEntry("u1", null, "question"),
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: TIMESTAMP,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
				} as unknown as MessageEntry["message"],
			},
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp: TIMESTAMP,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [],
				} as unknown as MessageEntry["message"],
			},
			{
				type: "branch_summary",
				id: "s1",
				parentId: "t1",
				timestamp: TIMESTAMP,
				fromId: "u1",
				summary: "where the abandoned branch went",
			} as unknown as SessionTreeEntry,
		];
		const rows = buildSessionEntryRows(snapshot(entries, "s1"));
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		const rendered = plainRender(selector);
		expect(rendered).toContain("[read: README.md]");
		expect(rendered).toContain("[branch summary]: where the abandoned branch went");
	});

	it("renders an empty tree as a notice, not a dead list", () => {
		const selector = new TreeSelector({ title: "/tree", rows: [], onSelect: () => {}, onClose: () => {} });

		expect(plainRender(selector)).toContain("No entries in this session tree.");
		expect(selector.cursorEntryId).toBeUndefined();
	});

	it("opens with the cursor on the current row and clamps at both ends", () => {
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });

		// The leaf is the a3 assistant entry, so the cursor starts on its row.
		expect(selector.cursorEntryId).toBe("a3");
		selector.handleInput(DOWN);
		expect(selector.cursorEntryId).toBe("a3");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u3");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("a2");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u2");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("a1");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u1");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u1");
	});

	it("opens on an explicit initial row when one is given", () => {
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			initialEntryId: "u1",
			onSelect: () => {},
			onClose: () => {},
		});

		expect(selector.cursorEntryId).toBe("u1");
	});

	it("confirms the row under the cursor and closes", () => {
		const calls: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: (entryId) => calls.push(`select:${entryId}`),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// onClose runs first so a re-opened selector is not torn down by it.
		expect(calls).toEqual(["close", "select:u3"]);
		expect(selector.render(80)).toEqual([]);
		expect(selector.hintContext).toBeUndefined();
	});

	it("cancels with escape", () => {
		const calls: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: () => {},
			onCancel: () => calls.push("cancel"),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(ESCAPE);

		expect(calls).toEqual(["close", "cancel"]);
		expect(selector.render(80)).toEqual([]);
	});

	it("follows remapped selection keybindings", () => {
		const keybindings = createWidiKeybindings();
		keybindings.setUserBindings({ "tui.select.up": "k" });
		setKeybindings(keybindings);
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });

		selector.handleInput("k");

		expect(selector.cursorEntryId).toBe("u3");
	});

	it("ignores input after closing", () => {
		const selected: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: (entryId) => selected.push(entryId),
			onClose: () => {},
		});
		selector.handleInput(ENTER);

		selector.handleInput(ENTER);

		expect(selected).toEqual(["a3"]);
	});

	it("keeps the cursor position in the counter as the window scrolls", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < 15; index++) {
			entries.push(userEntry(`u${index}`, parentId, `question ${index}`));
			parentId = `u${index}`;
		}
		const rows = buildSessionEntryRows(snapshot(entries, "u0"));
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		for (let index = 0; index < 12; index++) selector.handleInput(DOWN);

		expect(selector.cursorEntryId).toBe("u12");
		const rendered = plainRender(selector);
		expect(rendered).toContain("(13/15)");
		expect(rendered).not.toContain("user: question 2 ");
		expect(rendered).not.toContain("user: question 13");
	});
});

describe("WidiTuiApplication /tree selector", () => {
	it("opens the graph selector docked in the editor's place on a bare /tree", async () => {
		const { application } = await createApplication();

		await submit(application, "/tree");

		expect(application.state.mode).toBe("selector");
		expect(application.tui.hasOverlay()).toBe(false);
		const selector = requireTreeNavigation(application);
		const rendered = plainRender(selector);
		expect(rendered).toContain("├── user: follow up");
		expect(rendered).toContain("└── user: new branch");
		expect(selector.hintContext).toEqual({ title: "/tree", confirmVerb: "switch", itemCount: 6 });
	});

	it("feeds the open graph selector into the operation hint", async () => {
		const { application } = await createApplication();

		await submit(application, "/tree");

		const hint = application.layout.component("operationHint");
		if (!(hint instanceof OperationHintView)) throw new Error("Expected the operation hint to be mounted.");
		const rendered = hint.render(120).join("\n").replace(ANSI_SEQUENCE, "");
		expect(rendered).toContain("/tree");
		expect(rendered).toContain("switch");
	});

	it("navigates in place on confirm: same agent, new leaf", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		// Cursor opens on the leaf row a3: three ups reach u2.
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		// The summarize step opens; the default "No summary" is confirmed.
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u2", undefined);
		// Tree navigation moves the session, not the agent.
		expect(application.state.activeAgentId).toBe("agent-1");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
	});

	it("passes the summarize choice through to the navigation", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false, summaryEntry: { type: "branch_summary" } }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u3", { summarize: true });
	});

	it("collects custom summarization instructions through the input step", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		// Third summary choice: "Summarize with custom prompt".
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		expect(plainRender(selector)).toContain("Custom summarization instructions");

		selector.handleInput("focus on tests");
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u3", {
			summarize: true,
			customInstructions: "focus on tests",
		});
	});

	it("falls back to a plain summary when the custom instructions are blank", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u3", { summarize: true });
	});

	it("returns from the custom input step to the summarize step on escape", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		selector.handleInput(ESCAPE);

		expect(plainRender(selector)).toContain("Summarize branch?");
		expect(navigateAgentTree).not.toHaveBeenCalled();
	});

	it("accepts custom instructions in the typed /tree argument", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree u3 summarize -- focus on tests");
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u3", {
			summarize: true,
			customInstructions: "focus on tests",
		});
	});

	it("returns from the summarize step to the tree with the pending row preselected", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(ESCAPE);

		// Back on the tree step, u3 still under the cursor; confirming it now
		// opens the summarize step again instead of navigating.
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u3", undefined);
	});

	it("puts the un-sent user message back into the editor after navigating to it", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false, editorText: "follow up" }));
		const { application } = await createApplication({ navigateAgentTree });
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/tree");
		const selector = requireTreeNavigation(application);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await flush();

		expect(editor.getText()).toBe("follow up");
	});

	it("opens the tree from app.tree.open without touching the editor draft", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });
		const editor = requireEditor(application);
		editor.setText("draft in progress");

		editor.handleInput("\x07");
		// The direct open fetches the tree first, so the dock appears a tick later.
		await flush();

		expect(application.state.mode).toBe("selector");
		expect(editor.getText()).toBe("draft in progress");

		// Cancelling leaves the draft alone; navigating to a non-user row does too.
		const selector = requireTreeNavigation(application);
		selector.handleInput(ENTER);
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "a3", undefined);
		expect(editor.getText()).toBe("draft in progress");
		expect(application.state.mode).toBe("editor");
	});

	it("passes custom instructions through the direct tree navigation", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });
		const editor = requireEditor(application);
		editor.setText("");

		editor.handleInput("\x07");
		await flush();

		const selector = requireTreeNavigation(application);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		selector.handleInput("keep it short");
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "a3", {
			summarize: true,
			customInstructions: "keep it short",
		});
	});

	it("restores the submitted command when the graph selector is cancelled", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/tree");
		requireTreeNavigation(application).handleInput(ESCAPE);

		expect(navigateAgentTree).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/tree");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
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
		getAgentSessionTree: async () => branchSnapshot(),
		navigateAgentTree: async () => ({ cancelled: false }),
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

function requireTreeNavigation(application: WidiTuiApplication): TreeNavigationSelector {
	const dock = (application as unknown as { selectorDock: SelectorDock }).selectorDock;
	const view = dock.current;
	if (view instanceof TreeNavigationSelector) return view;
	throw new Error("Expected a tree navigation selector to be docked.");
}

function requireEditor(application: WidiTuiApplication): WidiEditor {
	// The mounted editor is wrapped in a slot visibility gate, so the instance
	// comes from the application's own field rather than the child list.
	return (application as unknown as { editor: WidiEditor }).editor;
}

async function submit(application: WidiTuiApplication, text: string): Promise<void> {
	await (application as unknown as { submit(rawText: string): Promise<void> }).submit(text);
}
