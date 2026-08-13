import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCommandPresenter, unregisterCommandPresenter } from "../../../src/tui/command-presenter.ts";
import {
	type CommandResultItem,
	createTuiApplicationState,
	type ExtensionOutputItem,
	setActiveAgent,
	type TimelineItem,
	type ToolExecutionItem,
} from "../../../src/tui/state.ts";
import { loadThemes, resetThemes, setTheme, type ThemePalette } from "../../../src/tui/theme/theme.ts";
import { registerToolPresenter, unregisterToolPresenter } from "../../../src/tui/tool-presenter.ts";
import { ChatView } from "../../../src/tui/views/chat.ts";

const ALT_PALETTE: ThemePalette = {
	accent: "#ff0000",
	ok: "#00ff00",
	warn: "#ffff00",
	error: "#ff00ff",
	info: "#00ffff",
	muted: "#888888",
	faint: "#444444",
	rule: "#00ff00",
	surface: "#101010",
};

function stateWithUserMessage() {
	const state = createTuiApplicationState();
	const agent = setActiveAgent(state, "agent-1");
	agent.timeline.push({
		type: "user-message",
		id: "m1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		text: "hello",
	});
	return state;
}

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trimEnd());
}

describe("ChatView render cache", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "widi-chat-view-"));
		await mkdir(join(agentDir, "themes"), { recursive: true });
		await writeFile(join(agentDir, "themes", "alt.json"), JSON.stringify(ALT_PALETTE));
		loadThemes(agentDir);
	});

	afterEach(async () => {
		resetThemes();
		await rm(agentDir, { recursive: true, force: true });
	});

	it("serves cached lines while the theme is unchanged and repaints on a switch", () => {
		const view = new ChatView(stateWithUserMessage());
		const first = view.render(40);
		const second = view.render(40);
		expect(second).toEqual(first);

		expect(setTheme("alt")).toBe(true);
		const repainted = view.render(40);

		// The user row carries the surface background; the two palettes paint it
		// differently, so a stale cache would fail this byte comparison.
		expect(repainted).not.toEqual(first);
		expect(stripAnsi(repainted)).toEqual(stripAnsi(first));
	});
});

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "bash",
		args: { command: "seq 3" },
		status: "completed",
		isError: false,
		...overrides,
	};
}

function stateWithTimeline(items: readonly TimelineItem[], agentId = "agent-1") {
	const state = createTuiApplicationState();
	const agent = setActiveAgent(state, agentId);
	agent.timeline.push(...items);
	return state;
}

describe("ChatView component presenters (parity §4.3-2)", () => {
	afterEach(() => {
		unregisterToolPresenter("bash");
	});

	it("creates one instance per toolCallId, feeds updates, disposes on trim", () => {
		const calls: string[] = [];
		let current: ToolExecutionItem | undefined;
		let currentExpanded = false;
		registerToolPresenter("bash", {
			kind: "component",
			factory: (item, context) => {
				calls.push("factory");
				current = item;
				currentExpanded = context.expanded;
				return {
					render: () => [`row:${current?.args ? JSON.stringify(current.args) : ""}:${currentExpanded}`],
					invalidate: () => {},
					update: (next, nextContext) => {
						calls.push("update");
						current = next;
						currentExpanded = nextContext.expanded;
					},
					dispose: () => {
						calls.push("dispose");
					},
				};
			},
		});
		const item = toolItem({});
		const state = stateWithTimeline([item]);
		const view = new ChatView(state);

		const first = view.render(60);
		expect(calls).toEqual(["factory"]);
		expect(first.some((line) => line.includes('row:{"command":"seq 3"}:false'))).toBe(true);

		// A same-toolCallId replacement (what the projector does on stream
		// transitions) reuses the instance through update(); the per-item flag
		// wins over the global toggle.
		const replacement = toolItem({ args: { command: "seq 9" }, expanded: true });
		state.agents.get("agent-1")?.timeline.splice(0, 1, replacement);
		const second = view.render(60);
		expect(calls).toEqual(["factory", "update"]);
		expect(second.some((line) => line.includes('row:{"command":"seq 9"}:true'))).toBe(true);

		// The row left the timeline (windowing): the instance is disposed.
		state.agents.get("agent-1")?.timeline.splice(0, 1);
		view.render(60);
		expect(calls).toEqual(["factory", "update", "dispose"]);
	});

	it("degrades to the generic lines when the factory or the render throws", () => {
		registerToolPresenter("bash", {
			kind: "component",
			factory: () => {
				throw new Error("factory boom");
			},
		});
		const state = stateWithTimeline([toolItem({})]);
		const view = new ChatView(state);

		const lines = stripAnsi(view.render(60));
		expect(lines.some((line) => line.includes("bash command: seq 3"))).toBe(true);
	});
});

function commandResultItem(overrides: Partial<CommandResultItem>): CommandResultItem {
	return {
		type: "command-result",
		id: "command-item-1",
		commandId: "cmd-1",
		durability: "ephemeral",
		createdAt: "2026-01-01T00:00:00.000Z",
		name: "demo",
		argument: "",
		status: "completed",
		...overrides,
	};
}

describe("ChatView command component presenters", () => {
	afterEach(() => {
		unregisterCommandPresenter("demo");
	});

	it("creates one instance per commandId, feeds updates, disposes on trim", () => {
		const calls: string[] = [];
		let current: CommandResultItem | undefined;
		registerCommandPresenter("demo", {
			kind: "component",
			factory: (item) => {
				calls.push("factory");
				current = item;
				return {
					render: () => [`row:${typeof current?.result === "string" ? current.result : ""}`],
					invalidate: () => {},
					update: (next) => {
						calls.push("update");
						current = next;
					},
					dispose: () => {
						calls.push("dispose");
					},
				};
			},
		});
		const state = stateWithTimeline([commandResultItem({ result: "first" })]);
		const view = new ChatView(state);

		const first = view.render(60);
		expect(calls).toEqual(["factory"]);
		expect(first.some((line) => line.includes("row:first"))).toBe(true);

		// A same-commandId replacement reuses the instance through update().
		state.agents.get("agent-1")?.timeline.splice(0, 1, commandResultItem({ result: "second" }));
		const second = view.render(60);
		expect(calls).toEqual(["factory", "update"]);
		expect(second.some((line) => line.includes("row:second"))).toBe(true);

		// The row left the timeline: the instance is disposed.
		state.agents.get("agent-1")?.timeline.splice(0, 1);
		view.render(60);
		expect(calls).toEqual(["factory", "update", "dispose"]);
	});

	it("keeps running and failed rows on the shared frame, never the presenter", () => {
		let factoryCalls = 0;
		registerCommandPresenter("demo", {
			kind: "component",
			factory: () => {
				factoryCalls += 1;
				return { render: () => ["component row"], invalidate: () => {} };
			},
		});
		const state = stateWithTimeline([commandResultItem({ status: "running" })]);
		const view = new ChatView(state);

		const lines = stripAnsi(view.render(60));
		expect(factoryCalls).toBe(0);
		expect(lines.some((line) => line.includes("/demo …"))).toBe(true);
	});
});

describe("ChatView timeline rendering", () => {
	it("shows only one thinking indicator while an assistant message streams", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push(
			{
				type: "assistant-message",
				id: "live-1",
				durability: "durable",
				createdAt: timestamp(1),
				text: "",
				streaming: true,
			},
			{
				type: "thinking-status",
				id: "live-1:thinking",
				durability: "ephemeral",
				createdAt: timestamp(2),
				status: "thinking",
			},
		);

		const output = new ChatView(state).render(80).join("\n");

		expect(output.match(/Thinking…/g)).toHaveLength(1);
	});

	it("replaces the generic thinking indicator with a preparing tool", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push(
			{
				type: "assistant-message",
				id: "live-1",
				durability: "durable",
				createdAt: timestamp(1),
				text: "",
				streaming: true,
			},
			{
				type: "tool-execution",
				id: "preparing-tool:live-1:0",
				toolCallId: "tool-1",
				durability: "durable",
				createdAt: timestamp(2),
				sourceAssistantId: "live-1",
				toolName: "read",
				status: "preparing",
			},
		);

		const output = new ChatView(state).render(80).join("\n");

		expect(output).not.toContain("Thinking…");
		expect(output.match(/preparing…/g)).toHaveLength(1);
	});

	it("closes a painted block with painted edge rows and one plain line between blocks", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push(
			{ type: "user-message", id: "m1", durability: "durable", createdAt: timestamp(1), text: "hello" },
			toolItem({ result: { content: [{ type: "text", text: "one" }] } }),
		);

		const lines = new ChatView(state).render(40);

		const background = (line: string) => line.includes(`${String.fromCharCode(27)}[48;2;`);
		expect(lines.map(background)).toEqual([true, true, true, false, true, true, true, true]);
		// The edge rows carry the color and nothing else, so the block reads as a
		// card rather than a clipped row.
		expect(stripAnsi([lines[0] ?? "", lines[2] ?? ""])).toEqual(["", ""]);
		expect(stripAnsi(lines)[1]).toBe(" ❯ hello");
		expect(stripAnsi(lines)[3]).toBe("");
	});

	it("renders tool executions through the presentation registry", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push({
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "tool-1",
			durability: "durable",
			createdAt: timestamp(1),
			toolName: "ls",
			args: { path: "src" },
			result: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
			isError: false,
			status: "completed",
		});

		const output = new ChatView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(output).toContain("✓ List src · 2 entries");
		expect(output).not.toContain('{ "path": "src" }');
	});

	it("re-renders cached tool output when the expand toggle flips", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push({
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "tool-1",
			durability: "durable",
			createdAt: timestamp(1),
			toolName: "bash",
			args: { command: "ls" },
			result: { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
			isError: false,
			status: "completed",
		});
		const view = new ChatView(state);

		const collapsed = view.render(80).join("\n").replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("… +2 lines");
		expect(collapsed).not.toContain("six");

		state.toolOutputExpanded = true;
		const expanded = view.render(80).join("\n").replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("six");
		expect(expanded).not.toContain("… +2 lines");
	});

	// An extension row is written and rewritten under one id, so its cache has to
	// expire on the text; nothing else about the row ever changes.
	it("re-renders an extension row when its text or expansion changes", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		const row: ExtensionOutputItem = {
			type: "extension-output",
			id: "ext:drill:step",
			presentationId: "ext:drill:step",
			durability: "ephemeral",
			createdAt: timestamp(1),
			extensionId: "drill",
			text: "chapter one",
		};
		agent.timeline.push(row);
		const view = new ChatView(state);
		const plain = () => view.render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(plain()).toContain("chapter one");

		agent.timeline[0] = { ...row, text: "chapter one, revised" };
		expect(plain()).toContain("chapter one, revised");

		const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		agent.timeline[0] = { ...row, text: long };
		expect(plain()).toContain("… [truncated]");
		expect(plain()).not.toContain("line 20");

		agent.timeline[0] = { ...row, text: long, expanded: true };
		expect(plain()).toContain("line 20");
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
