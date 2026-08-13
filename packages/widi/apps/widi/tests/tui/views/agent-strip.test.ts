import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../../src/core/agent-types.ts";
import { buildAgentTree } from "../../../src/tui/agent-tree.ts";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
	type PendingAgentViewState,
	setActiveAgent,
	type TuiApplicationState,
} from "../../../src/tui/state.ts";
import { AgentStripView, moveAgentCursor } from "../../../src/tui/views/agent-strip.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESCAPE = "\x1b";

beforeAll(() => {
	setKeybindings(createWidiKeybindings());
});

function renderPlain(state: TuiApplicationState, width = 160, panel?: AgentStripView): string[] {
	return (panel ?? new AgentStripView(state)).render(width).map((line) => line.replace(ANSI_SEQUENCE, ""));
}

function createPanel(state: TuiApplicationState) {
	const events: string[] = [];
	const selected: string[] = [];
	const panel = new AgentStripView(
		state,
		{
			setFocus: (component) => {
				panel.focused = component === panel;
				events.push(component === panel ? "panel" : "other");
			},
			requestRender: () => {},
		},
		(agentId) => selected.push(agentId),
		() => {
			// The real host returns focus to the editor, which clears `focused`.
			panel.focused = false;
			events.push("closed");
		},
	);
	return { panel, events, selected };
}

describe("AgentStripView tree rendering", () => {
	it("keeps top-level insertion order instead of forcing the active agent first", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "main").status = "idle";

		const [top] = renderPlain(state);

		expect(top.indexOf("other")).toBeLessThan(top.indexOf("main"));
		expect(top.startsWith("○ other")).toBe(true);
		expect(top).toContain("● main");
	});

	it("names maintenance work instead of a plain running status", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "running";
		main.maintenance = "compaction";

		const [top] = renderPlain(state);

		expect(top).toContain("compacting");
		expect(top).not.toContain("running");
	});

	it("hangs children under their parent with aligned tree lines", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const childA = ensureAgentProjection(state, "child-a", "running");
		childA.spawnedBy = "main";
		const childB = ensureAgentProjection(state, "child-b", "idle");
		childB.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(3);
		expect(lines[0].startsWith("● main")).toBe(true);
		expect(lines[1].trimStart().startsWith("├── ○ child-a")).toBe(true);
		expect(lines[2].trimStart().startsWith("└── ○ child-b")).toBe(true);
		// The tree lines align with the parent's glyph column in the top row.
		expect(lines[1].indexOf("├")).toBe(lines[0].indexOf("●"));
		expect(lines[2].indexOf("└")).toBe(lines[0].indexOf("●"));
	});

	it("aligns tree lines under a parent that is not the first top-level agent", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "main").status = "idle";
		const child = ensureAgentProjection(state, "child", "idle");
		child.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(2);
		expect(lines[1].indexOf("└")).toBe(lines[0].indexOf("●"));
		expect(lines[1].trimStart().startsWith("└── ○ child")).toBe(true);
	});

	it("renders a child whose spawner is gone as top-level", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const orphan = ensureAgentProjection(state, "orphan", "idle");
		orphan.spawnedBy = "disposed-parent";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("main");
		expect(lines[0]).toContain("orphan");
	});

	it("overrides the glyph with ! for attention states", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		// Not disposed: the strip hides those entirely, so attention would have
		// nothing to override.
		const failed = ensureAgentProjection(state, "failed", "idle");
		failed.attention = "error";
		const waiting = ensureAgentProjection(state, "waiting", "idle");
		waiting.attention = "human-request";

		const [top] = renderPlain(state);

		expect(top).toContain("! failed");
		expect(top).toContain("! waiting");
		expect(top).toContain("needs input");
		expect(top).not.toContain("○ failed");
		expect(top).not.toContain("○ waiting");
	});

	it("marks the active child with ● inside the tree", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "main", "idle");
		const child = setActiveAgent(state, "child");
		child.status = "running";
		child.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines[0].startsWith("○ main")).toBe(true);
		expect(lines[1].trimStart().startsWith("└── ● child")).toBe(true);
	});

	it("hangs every column's subtree directly beneath its parent, row-aligned", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "alpha-main-0ovu").status = "idle";
		const alphaOne = ensureAgentProjection(state, "alpha-1234", "idle");
		alphaOne.spawnedBy = "alpha-main-0ovu";
		const alphaTwo = ensureAgentProjection(state, "alpha-5678", "idle");
		alphaTwo.spawnedBy = "alpha-main-0ovu";
		ensureAgentProjection(state, "beta-main-3c8o", "idle");
		const betaOne = ensureAgentProjection(state, "beta-9abc", "idle");
		betaOne.spawnedBy = "beta-main-3c8o";

		const lines = renderPlain(state);

		// beta's only child sits on the first subtree row right under its
		// parent, not pushed below alpha's taller subtree.
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("alpha-1234");
		expect(lines[1]).toContain("beta-9abc");
		const betaColumn = lines[0].indexOf("○ beta-main-3c8o");
		expect(lines[1].indexOf("└── ○ beta-9abc")).toBe(betaColumn);
		expect(lines[2]).toContain("alpha-5678");
		expect(lines[2]).not.toContain("beta");
	});
});

describe("AgentStripView column layout", () => {
	it("gives every column on the page an equal share of the width", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "alpha-0ovu").status = "idle";
		ensureAgentProjection(state, "beta-3c8o", "idle");

		const [top] = renderPlain(state, 80);

		// Two agents, so the second starts at the halfway mark rather than
		// wherever the first one's label happened to end.
		expect(top.indexOf("○ beta-3c8o")).toBe(40);
	});

	it("keeps a column in place when a neighbour's label grows", () => {
		const state = createTuiApplicationState();
		const alpha = setActiveAgent(state, "alpha-0ovu");
		alpha.status = "idle";
		ensureAgentProjection(state, "beta-3c8o", "idle");
		const before = renderPlain(state, 80)[0].indexOf("○ beta-3c8o");

		alpha.status = "running";
		alpha.runToolCount = 15;

		expect(renderPlain(state, 80)[0]).toContain("running · 15 tool_use");
		expect(renderPlain(state, 80)[0].indexOf("○ beta-3c8o")).toBe(before);
	});

	it("shows three descendants and counts the rest", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main-0ovu").status = "idle";
		for (let index = 1; index <= 6; index++) {
			ensureAgentProjection(state, `explore-c${index}`, "idle").spawnedBy = "main-0ovu";
		}

		const lines = renderPlain(state, 80);

		expect(lines).toHaveLength(5);
		expect(lines[1]).toContain("explore-c1");
		expect(lines[3]).toContain("explore-c3");
		expect(lines[4]).toContain("… +3");
		expect(lines.join("\n")).not.toContain("explore-c4");
	});

	it("scrolls the descendant window down with the cursor", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main-0ovu").status = "idle";
		for (let index = 1; index <= 6; index++) {
			ensureAgentProjection(state, `explore-c${index}`, "idle").spawnedBy = "main-0ovu";
		}
		const { panel } = createPanel(state);
		panel.open();
		for (let step = 0; step < 4; step++) panel.handleInput(DOWN);
		expect(panel.cursor).toBe("explore-c4");

		const lines = renderPlain(state, 80, panel);

		expect(lines.join("\n")).toContain("explore-c4");
		expect(lines.join("\n")).not.toContain("explore-c1");
		// Three rows plus the marker, however far down the cursor goes.
		expect(lines).toHaveLength(5);
	});
});

describe("AgentStripView width adaptation", () => {
	it("truncates long labels per agent instead of hiding whole agents", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main-with-a-rather-long-name").status = "idle";
		ensureAgentProjection(state, "another-agent-with-a-long-name", "idle");
		ensureAgentProjection(state, "third-agent-also-long", "idle");

		const [top] = renderPlain(state, 50);

		expect(top.length).toBeLessThanOrEqual(50);
		expect(top).toContain("…");
		// All three agents stay on the row in truncated form.
		expect((top.match(/○|●/g) ?? []).length).toBe(3);
	});

	it("counts the agents left on the next page", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main-agent-number-one").status = "idle";
		for (let index = 2; index <= 6; index++) {
			ensureAgentProjection(state, `main-agent-number-${index}`, "idle");
		}

		const [top] = renderPlain(state, 80);

		// Four to a page, the other two counted on the right edge.
		expect((top.match(/○|●/g) ?? []).length).toBe(4);
		expect(top.trimEnd().endsWith("2›")).toBe(true);
	});

	it("keeps every column on the top row when the cursor sits in a subtree", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "alpha-main").status = "idle";
		const alphaChild = ensureAgentProjection(state, "alpha-child", "idle");
		alphaChild.spawnedBy = "alpha-main";
		ensureAgentProjection(state, "beta-main", "idle");
		const betaChild = ensureAgentProjection(state, "beta-child", "idle");
		betaChild.spawnedBy = "beta-main";
		const { panel } = createPanel(state);
		panel.open();
		panel.handleInput(RIGHT);
		panel.handleInput(DOWN);
		expect(panel.cursor).toBe("beta-child");

		const lines = renderPlain(state, 160, panel);

		// The cursor's column resolves to its top-level ancestor: both main
		// agents and both subtree rows stay on screen.
		expect(lines[0]).toContain("alpha-main");
		expect(lines[0]).toContain("beta-main");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("alpha-child");
		expect(lines[1]).toContain("beta-child");
	});

	it("keeps the unfocused layout when focus opens and everything fits", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "main-agent-number-one", "idle");
		setActiveAgent(state, "main-agent-number-6").status = "idle";
		const { panel } = createPanel(state);
		const before = renderPlain(state, 160, panel);

		panel.open();
		const after = renderPlain(state, 160, panel);

		// Only the cursor highlight (stripped here) may differ; nothing hides.
		expect(after).toEqual(before);
		expect(after[0].startsWith("‹")).toBe(false);
	});

	it("keeps the cursor visible with side counts while focused", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "main-agent-number-one", "idle");
		for (let index = 2; index <= 6; index++) {
			ensureAgentProjection(state, `main-agent-number-${index}`, "idle");
		}
		setActiveAgent(state, "main-agent-number-6").status = "idle";
		const { panel } = createPanel(state);
		panel.open();

		const [top] = renderPlain(state, 80, panel);

		// The cursor sits on the sixth agent, which is on the second page:
		// the first four are counted on the left and the page holds the rest.
		expect(top.startsWith("‹4 ")).toBe(true);
		expect((top.match(/○|●/g) ?? []).length).toBe(2);
		expect(panel.cursor).toBe("main-agent-number-6");
	});

	it("keeps a deeply nested cursor visible in a narrow column", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "a").status = "idle";
		const a1 = ensureAgentProjection(state, "a1", "idle");
		a1.spawnedBy = "a";
		const a2 = ensureAgentProjection(state, "a2", "idle");
		a2.spawnedBy = "a1";
		const a3 = ensureAgentProjection(state, "a3", "idle");
		a3.spawnedBy = "a2";
		ensureAgentProjection(state, "b", "idle");
		const b1 = ensureAgentProjection(state, "b1", "idle");
		b1.spawnedBy = "b";
		const b2 = ensureAgentProjection(state, "b2", "idle");
		b2.spawnedBy = "b1";
		const b3 = ensureAgentProjection(state, "b3", "idle");
		b3.spawnedBy = "b2";
		const { panel } = createPanel(state);
		panel.open();
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		expect(panel.cursor).toBe("a3");

		for (const width of [24, 40]) {
			const rendered = panel.render(width).join("\n");
			expect(rendered).toContain("\x1b[7m");
			expect(rendered.replace(ANSI_SEQUENCE, "")).toContain("a3");
		}
	});
});

describe("AgentStripView focus and navigation", () => {
	it("focuses the panel on the active agent", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "main").status = "idle";
		const { panel, events } = createPanel(state);

		panel.open();

		expect(panel.focused).toBe(true);
		expect(panel.cursor).toBe("main");
		expect(state.mode).toBe("agent-panel");
		expect(events).toEqual(["panel"]);
	});

	it("resets the cursor to the active agent each time it opens", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		ensureAgentProjection(state, "other", "idle");
		const { panel } = createPanel(state);
		panel.open();
		panel.handleInput(RIGHT);
		expect(panel.cursor).toBe("other");
		panel.handleInput(ESCAPE);

		panel.open();

		expect(panel.cursor).toBe("main");
	});

	it("does not open without agents", () => {
		const state = createTuiApplicationState();
		const { panel, events } = createPanel(state);

		panel.open();

		expect(panel.focused).toBe(false);
		expect(state.mode).toBe("editor");
		expect(events).toEqual([]);
	});

	it("moves down into the subtree and back up to the top row", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const child = ensureAgentProjection(state, "child", "idle");
		child.spawnedBy = "main";
		const { panel } = createPanel(state);
		panel.open();

		panel.handleInput(DOWN);
		expect(panel.cursor).toBe("child");

		panel.handleInput(UP);
		expect(panel.cursor).toBe("main");
	});

	it("moves horizontally between top-level agents, resetting to the top row", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const child = ensureAgentProjection(state, "child", "idle");
		child.spawnedBy = "main";
		ensureAgentProjection(state, "other", "idle");
		const { panel } = createPanel(state);
		panel.open();

		panel.handleInput(DOWN);
		panel.handleInput(RIGHT);
		expect(panel.cursor).toBe("other");

		panel.handleInput(LEFT);
		expect(panel.cursor).toBe("main");
	});

	it("returns to the editor with up from the top row or escape", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const { panel, events } = createPanel(state);
		panel.open();

		panel.handleInput(UP);
		expect(events).toEqual(["panel", "closed"]);
		expect(state.mode).toBe("editor");

		panel.handleInput(ESCAPE);
		expect(events).toEqual(["panel", "closed"]);

		panel.open();
		panel.handleInput(ESCAPE);
		expect(events).toEqual(["panel", "closed", "panel", "closed"]);
	});

	it("selects the cursor agent with enter", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		ensureAgentProjection(state, "other", "idle");
		const { panel, selected } = createPanel(state);
		panel.open();

		panel.handleInput(RIGHT);
		panel.handleInput(ENTER);

		expect(selected).toEqual(["other"]);
	});

	it("falls back to the active agent when the cursor agent disappears", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const other = ensureAgentProjection(state, "other", "idle");
		const { panel } = createPanel(state);
		panel.open();
		panel.handleInput(RIGHT);
		expect(panel.cursor).toBe("other");

		other.status = "disposed";
		panel.handleInput(LEFT);

		expect(panel.cursor).toBe("main");
	});

	it("marks an agent publishing an agent-strip status with its icon", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "idle";
		main.extensionStatuses.set("indexer build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Building index", region: "agent-strip", icon: "✦", tone: "warning" },
			updatedAt: new Date(0).toISOString(),
		});
		main.extensionStatuses.set("watcher files", {
			agentId: "main",
			extensionId: "watcher",
			key: "files",
			// No region: the default "panel" keeps it out of the strip.
			status: { text: "Watching files" },
			updatedAt: new Date(0).toISOString(),
		});

		const [top] = renderPlain(state);

		expect(top).toContain("✦");
		expect(top).not.toContain("✻");
		expect(top).not.toContain("Watching files");
	});
});

describe("moveAgentCursor", () => {
	it("walks the flattened subtree vertically within one column", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "main", "idle");
		const child = ensureAgentProjection(state, "child", "idle");
		child.spawnedBy = "main";
		const grandchild = ensureAgentProjection(state, "grandchild", "idle");
		grandchild.spawnedBy = "child";
		ensureAgentProjection(state, "other", "idle");
		const tree = buildAgentTree(state);

		expect(moveAgentCursor(tree, "main", "down")).toBe("child");
		expect(moveAgentCursor(tree, "child", "down")).toBe("grandchild");
		// Down from the last subtree entry does not cross into the next column.
		expect(moveAgentCursor(tree, "grandchild", "down")).toBe("grandchild");
		expect(moveAgentCursor(tree, "grandchild", "up")).toBe("child");
		// Up from the top row leaves the panel.
		expect(moveAgentCursor(tree, "main", "up")).toBeUndefined();
	});
});

// A staged session has no id and nothing to switch to, so the strip is the
// only place it can be seen at all.
describe("AgentStripView staged session", () => {
	it("shows the staged profile alone before any agent exists", () => {
		const state = createTuiApplicationState();
		state.pendingAgent = pendingAgent("widi-dev");

		expect(renderPlain(state)).toEqual(["● widi-dev not started"]);
	});

	it("puts the staged profile beside the agents already running", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		state.pendingAgent = pendingAgent("explore");

		const line = renderPlain(state)[0];

		expect(line).toContain("○ widi-dev-0ovu");
		expect(line.indexOf("● explore not started")).toBeGreaterThan(line.indexOf("widi-dev-0ovu"));
	});

	it("never lets the cursor land on it", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "widi-dev-0ovu");
		agent.status = "idle";
		state.pendingAgent = pendingAgent("explore");
		const panel = new AgentStripView(state);
		panel.open();

		panel.handleInput(RIGHT);

		expect(panel.cursor).toBe("widi-dev-0ovu");
	});
});

describe("AgentStripView identity and activity", () => {
	it("distinguishes source and fork labels in the agent strip", () => {
		const state = createTuiApplicationState();
		const source = setActiveAgent(state, "widi-dev-0ovu");
		source.status = "idle";
		source.snapshot = snapshot("widi-dev-0ovu", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(state, "widi-dev-3c8o", "idle");
		fork.snapshot = snapshot(fork.agentId, "/sessions/fork.jsonl", "/sessions/source.jsonl");
		fork.display.forkedFromAgentId = source.agentId;

		const output = new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "");

		expect(output).toContain("widi-dev-0ovu");
		expect(output).toContain("widi-dev-3c8o ← widi-dev-0ovu");
	});

	it("shows how far into its run a running agent is", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "widi-dev");
		agent.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		agent.status = "running";
		agent.runToolCount = 15;

		expect(new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "")).toContain(
			"running · 15 tool_use",
		);

		// A count left over from a finished run would read as one still going.
		agent.status = "idle";
		expect(new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "")).not.toContain("tool_use");
	});

	it("keeps terminal control sequences out of the panel and selects by raw value", () => {
		const state = createTuiApplicationState();
		const sanitizedAgentId = `${"a".repeat(260)}tail-123`;
		const agentId = `\u001b]0;owned\u0007${sanitizedAgentId}\u001b[2J`;
		const agent = ensureAgentProjection(state, agentId, "idle");
		agent.snapshot = snapshot(agentId, "/sessions/agent.jsonl");
		state.activeAgentId = agentId;
		let selectedAgentId: string | undefined;
		const panel = new AgentStripView(
			state,
			{
				setFocus: (component) => {
					panel.focused = component === panel;
				},
				requestRender: () => {},
			},
			(selected) => {
				selectedAgentId = selected;
			},
		);

		panel.open();
		const output = panel.render(500).join("\n").replace(ANSI_SEQUENCE, "");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0007");

		panel.handleInput("\r");

		expect(selectedAgentId).toBe(agentId);
	});
});

function pendingAgent(profileId: string): PendingAgentViewState {
	return {
		start: { kind: "default", cwd: "/workspace/project" },
		timeline: [],
		draft: "",
		display: { profileId, profileLabel: profileId, cwd: "/workspace/project", model: snapshot("x", "/x").model },
		nextLiveItemId: 1,
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
		model: {
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
		},
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
