import { afterEach, describe, expect, it } from "vitest";
import { SPINNER_FRAMES } from "../../src/tui/format.ts";
import type { ToolExecutionItem } from "../../src/tui/state.ts";
import { presentToolExecution, registerToolPresenter, unregisterToolPresenter } from "../../src/tui/tool-presenter.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "ls",
		status: "completed",
		isError: false,
		...overrides,
	};
}

function textResult(text: string): unknown {
	return { content: [{ type: "text", text }] };
}

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trimEnd());
}

describe("presentToolExecution", () => {
	it("summarizes ls calls without dumping raw JSON or entries", () => {
		const item = toolItem({ toolName: "ls", args: { path: "src" }, result: textResult("a.ts\nb.ts\ncore/\n") });

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✓ List src · 3 entries"]);
	});

	it("shows read ranges and line counts without file content", () => {
		const item = toolItem({
			toolName: "read",
			args: { path: "notes.txt", offset: 1, limit: 2000 },
			result: textResult("line\n".repeat(100).trimEnd()),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✓ Read notes.txt 1–2000 · 100 lines"]);
	});

	it("previews a few bash output lines and reports the rest", () => {
		const item = toolItem({
			toolName: "bash",
			args: { command: "ls -la" },
			result: textResult("one\ntwo\nthree\nfour\nfive\nsix"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines[0]).toBe("✓ Bash ls -la");
		expect(lines.slice(1)).toEqual(["one", "two", "three", "four", "… +2 lines"]);
	});

	it("marks running calls distinctly", () => {
		const item = toolItem({ toolName: "bash", status: "running", args: { command: "sleep 5" } });

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["● Bash sleep 5"]);
	});

	it("shows no raw JSON for a running call without output yet", () => {
		const item = toolItem({
			toolName: "bash",
			status: "running",
			args: { command: "npm run test | tail -60" },
			partialResult: { content: [], details: undefined },
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["● Bash npm run test | tail -60"]);
	});

	it("keeps more detail for errors", () => {
		const item = toolItem({
			toolName: "ls",
			args: { path: "missing" },
			isError: true,
			result: textResult("Path not found: /repo/missing"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✕ List missing", "Path not found: /repo/missing"]);
	});

	it("renders unknown tools with compact key-value arguments", () => {
		const item = toolItem({ toolName: "deploy", args: { target: "staging", dryRun: true }, result: textResult("ok") });

		const lines = plain(presentToolExecution(item, 80));

		expect(lines[0]).toBe("✓ deploy target: staging, dryRun: true");
	});

	it("shows full output when expanded", () => {
		const item = toolItem({
			toolName: "bash",
			args: { command: "ls -la" },
			result: textResult("one\ntwo\nthree\nfour\nfive\nsix"),
		});

		const lines = plain(presentToolExecution(item, 80, { expanded: true }));

		expect(lines.slice(1)).toEqual(["one", "two", "three", "four", "five", "six"]);
	});

	it("expands count-suffix tools to their content", () => {
		const item = toolItem({ toolName: "ls", args: { path: "src" }, result: textResult("a.ts\nb.ts") });

		const lines = plain(presentToolExecution(item, 80, { expanded: true }));

		expect(lines[0]).toBe("✓ List src · 2 entries");
		expect(lines.slice(1)).toEqual(["a.ts", "b.ts"]);
	});

	it("renders edit results as a bounded diff", () => {
		const diff = Array.from({ length: 10 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");
		const item = toolItem({
			toolName: "edit",
			args: { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] },
			result: { content: [{ type: "text", text: "Edited src/app.ts" }], details: { diff } },
		});

		const collapsed = plain(presentToolExecution(item, 80));
		expect(collapsed[0]).toBe("✓ Edit src/app.ts (1 edit)");
		expect(collapsed.slice(1, 9)).toEqual(Array.from({ length: 8 }, (_, i) => `+${i + 1} line ${i + 1}`));
		expect(collapsed[9]).toBe("… +2 lines");

		const expanded = plain(presentToolExecution(item, 80, { expanded: true }));
		expect(expanded).toHaveLength(11);
		expect(expanded[10]).toBe("+10 line 10");
	});

	it("summarizes write calls and expands to the written content", () => {
		const item = toolItem({
			toolName: "write",
			args: { path: "notes.txt", content: "alpha\nbeta\ngamma" },
			result: textResult("Successfully wrote 16 bytes to notes.txt"),
		});

		expect(plain(presentToolExecution(item, 80))).toEqual(["✓ Write notes.txt · 3 lines"]);
		expect(plain(presentToolExecution(item, 80, { expanded: true }))).toEqual([
			"✓ Write notes.txt · 3 lines",
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("truncates every line to the available width", () => {
		const item = toolItem({
			toolName: "bash",
			args: { command: "x".repeat(300) },
			result: textResult(`${"y".repeat(300)}\nsecond`),
		});

		for (const line of presentToolExecution(item, 40)) {
			expect(line.replace(ANSI_SEQUENCE, "").length).toBeLessThanOrEqual(40);
		}
	});

	it("renders a streamed call as preparing, with the verb in the activity hue", () => {
		const item = toolItem({ toolName: "read", status: "preparing", args: { path: "notes.txt" } });

		const lines = presentToolExecution(item, 80);

		// The preparing glyph is the animated braille spinner.
		const rendered = plain(lines);
		expect(rendered).toHaveLength(1);
		expect(SPINNER_FRAMES).toContain(rendered[0]?.[0]);
		expect(rendered[0]?.slice(1)).toBe(" Read notes.txt preparing…");
		// #7ab9cd info on the verb, no preview lines.
		expect(lines[0]).toContain("38;2;122;185;205");
	});

	it("renders a cancelled call dimmed without a preview", () => {
		const item = toolItem({ toolName: "read", status: "cancelled", args: { path: "notes.txt" } });

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["⊘ Read notes.txt"]);
	});
});

describe("tool presenter registry", () => {
	afterEach(() => {
		unregisterToolPresenter("deploy");
		unregisterToolPresenter("ls");
	});

	it("renders a registered lines presenter for its tool", () => {
		const diagnostic = registerToolPresenter("deploy", { kind: "lines", present: () => ["custom deploy row"] });

		expect(diagnostic).toBeUndefined();
		const item = toolItem({ toolName: "deploy", args: { target: "staging" }, result: textResult("ok") });
		expect(presentToolExecution(item, 80)).toEqual(["custom deploy row"]);
	});

	it("reports overriding a built-in presenter instead of replacing it silently", () => {
		const diagnostic = registerToolPresenter("ls", { kind: "lines", present: () => ["custom ls row"] });

		expect(diagnostic).toMatchObject({ severity: "warning", code: "tool_presenter.overridden" });
		const item = toolItem({ toolName: "ls", args: { path: "src" }, result: textResult("a.ts") });
		expect(presentToolExecution(item, 80)).toEqual(["custom ls row"]);

		// The built-in presenter is visible again once the override is gone.
		unregisterToolPresenter("ls");
		expect(plain(presentToolExecution(item, 80))).toEqual(["✓ List src · 1 entries"]);
	});

	it("reports how long a call took", () => {
		const item = toolItem({
			toolName: "deploy",
			args: {},
			result: textResult("ok"),
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:01:12.000Z",
		});

		expect(plain(presentToolExecution(item, 80))[0]).toContain("· 1m12s");
	});

	it("leaves the duration off a call that returned at once", () => {
		const item = toolItem({
			toolName: "deploy",
			args: {},
			result: textResult("ok"),
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:00.400Z",
		});

		expect(plain(presentToolExecution(item, 80))[0]).not.toContain("·");
	});

	it("counts up while the call is still running", () => {
		const item = toolItem({
			toolName: "deploy",
			args: {},
			status: "running",
			startedAt: new Date(Date.now() - 5_000).toISOString(),
		});

		expect(plain(presentToolExecution(item, 80))[0]).toContain("· 5s");
	});

	it("keeps the generic fallback for unregistered tools", () => {
		const item = toolItem({ toolName: "deploy", args: { target: "staging", dryRun: true }, result: textResult("ok") });

		expect(plain(presentToolExecution(item, 80))[0]).toBe("✓ deploy target: staging, dryRun: true");
	});

	it("renders a registered component presenter as the generic fallback for now", () => {
		registerToolPresenter("deploy", {
			kind: "component",
			factory: () => {
				throw new Error("component presenters are not instantiated yet");
			},
		});

		const item = toolItem({ toolName: "deploy", args: { target: "staging" }, result: textResult("ok") });
		expect(plain(presentToolExecution(item, 80))[0]).toBe("✓ deploy target: staging");
	});
});
