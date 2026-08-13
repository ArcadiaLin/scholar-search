import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import { WidiCommandAutocompleteProvider } from "../../../src/tui/autocomplete.ts";
import { widiCommands } from "../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../src/tui/commands/engine.ts";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import { theme } from "../../../src/tui/theme/theme.ts";
import { WidiEditor } from "../../../src/tui/views/editor.ts";
import { stubCommandHost } from "../../helpers/command-host.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (line: string) => line.replace(ANSI_SEQUENCE, "");

/** Expected SGR truecolor open sequence for a palette hex value. */
function paletteSgr(hex: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function createEditor() {
	const tui = { terminal: { rows: 40, cols: 80 }, requestRender: () => {} } as unknown as TUI;
	return new WidiEditor(tui, theme.editorTheme, {});
}

beforeAll(() => {
	setKeybindings(createWidiKeybindings());
});

describe("WidiEditor chrome", () => {
	it("draws pi-style horizontal rules without side borders or a prompt symbol", () => {
		const editor = createEditor();
		editor.setText("hello");
		const lines = editor.render(60).map(strip);
		expect(lines[0]).toMatch(/^─+$/u);
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines[1]).toMatch(/^hello\s+$/u);
		expect(lines[1]).not.toContain(">");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("keeps the rules when the editor is empty", () => {
		const editor = createEditor();
		const lines = editor.render(40).map(strip);
		expect(lines[0]).toMatch(/^─+$/u);
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines.some((line) => line.includes("│") || line.includes(">"))).toBe(false);
	});

	it("paints the rules with the accent color in slash-command context", () => {
		const editor = createEditor();
		editor.setText("/model");
		const top = editor.render(60)[0] ?? "";
		expect(top).toContain(paletteSgr(theme.palette.accent));
		expect(top).not.toContain(paletteSgr(theme.palette.rule));
	});

	it("uses the subdued rule color for plain text", () => {
		const editor = createEditor();
		editor.setText("hello");
		const top = editor.render(60)[0] ?? "";
		expect(top).toContain(paletteSgr(theme.palette.rule));
	});

	it("paints a recognized command token and leaves an unknown one plain", () => {
		const editor = createEditor();
		editor.setCommandRecognizer((name) => name === "model");
		const commandHue = paletteSgr(theme.palette.command ?? theme.palette.accent);

		editor.setText("/model gpt");
		expect(editor.render(60)[1]).toContain(commandHue);
		expect(strip(editor.render(60)[1] ?? "")).toMatch(/^\/model gpt\s+$/u);

		editor.setText("/mode gpt");
		expect(editor.render(60)[1]).not.toContain(commandHue);

		editor.setText("model gpt");
		expect(editor.render(60)[1]).not.toContain(commandHue);
	});
});

describe("WidiEditor argument completion", () => {
	function createEditorWithProvider(orchestrator: Record<string, unknown>) {
		const editor = createEditor();
		editor.setAutocompleteProvider(
			new WidiCommandAutocompleteProvider({
				engine: new CommandEngine(widiCommands(stubCommandHost())),
				agentId: "main",
				orchestrator: orchestrator as unknown as AgentOrchestrator,
				getActivity: () => ({ activity: "idle" }),
			}),
		);
		return editor;
	}

	it("submits the completed command when enter accepts a terminal argument candidate", async () => {
		const editor = createEditorWithProvider({
			listAvailableModelCandidates: async () => ({ models: [{ value: "anthropic/claude", label: "Claude" }] }),
		});
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/model an");
		editor.handleInput("t");
		await vi.waitFor(() => {
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		editor.handleInput("\r");

		// pi-tui's fall-through: the "/" prefixed completion applies and the
		// same Enter goes on to submit the now-complete command line.
		expect(submitted).toBe("/model anthropic/claude");
		expect(editor.getText()).toBe("");
	});

	it("only inserts the candidate for a free-text argument command", async () => {
		const editor = createEditorWithProvider({
			listAgentSkillCandidates: async () => ({ skills: [{ value: "self-check", label: "self-check" }] }),
		});
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/skill se");
		editor.handleInput("l");
		await vi.waitFor(() => {
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		editor.handleInput("\r");

		expect(submitted).toBeUndefined();
		expect(editor.getText()).toBe("/skill self-check");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});
});

describe("WidiEditor agent panel key", () => {
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";

	it("opens the agent panel with down at the end of a non-empty draft", () => {
		const editor = createEditor();
		let opened = 0;
		editor.onOpenAgents = () => opened++;
		editor.setText("hello");

		editor.handleInput(DOWN);

		expect(opened).toBe(1);
	});

	it("moves the cursor instead when it is not at the draft end", () => {
		const editor = createEditor();
		let opened = 0;
		editor.onOpenAgents = () => opened++;
		editor.setText("ab\ncd");
		editor.handleInput(UP);
		expect(editor.getCursor().line).toBe(0);

		editor.handleInput(DOWN);

		expect(opened).toBe(0);
		expect(editor.getCursor().line).toBe(1);
	});

	it("keeps down on history navigation while browsing, then opens the panel", () => {
		const editor = createEditor();
		let opened = 0;
		editor.onOpenAgents = () => opened++;
		editor.addToHistory("previous prompt");
		editor.setText("");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("previous prompt");

		editor.handleInput(DOWN);

		// Down recalled the newer position (the empty draft), not the panel.
		expect(opened).toBe(0);
		expect(editor.getText()).toBe("");

		editor.handleInput(DOWN);
		expect(opened).toBe(1);
	});
});
