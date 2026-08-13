import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createAgentHarnessToolsFromResolvedTools,
	type ResolvedAgentHarnessTool,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import { registerCoreCodingTools } from "../../src/core/tools/coding/builtin.ts";

/**
 * End-to-end smoke test: the seven core coding tools resolved through the
 * ToolRegistry adapter against a real temporary directory, without any TUI
 * or orchestrator involvement.
 */
describe("core coding tools smoke", () => {
	let cwd: string;
	let tools: Map<string, ResolvedAgentHarnessTool>;

	function tool(name: string): ResolvedAgentHarnessTool {
		const found = tools.get(name);
		if (!found) throw new Error(`Expected tool ${name} to resolve.`);
		return found;
	}

	async function execute(name: string, toolCallId: string, params: unknown) {
		return await tool(name).execute(toolCallId, params, undefined, undefined, { workspace: { cwd } });
	}

	function textOf(result: { content: { type: string; text?: string }[] }): string {
		const first = result.content[0];
		if (first?.type !== "text" || first.text === undefined) {
			throw new Error("Expected a text content block.");
		}
		return first.text;
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "widi-smoke-"));
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry);
		const resolved = registry.resolve();
		expect(resolved.diagnostics).toEqual([]);
		tools = new Map(
			createAgentHarnessToolsFromResolvedTools(resolved.tools).map((agentTool) => [agentTool.name, agentTool]),
		);
	});

	afterAll(async () => {
		await rm(cwd, { force: true, recursive: true });
	});

	it("resolves the seven core tools in fixed order when no profile allowlist is set", () => {
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry);
		const resolved = registry.resolve();
		expect(resolved.toolNames).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		// No allowlist means every resolved tool is visible and active.
		expect(resolved.activeToolNames).toEqual(resolved.toolNames);
	});

	it("validates resumed active tool names against the registry without aliases", () => {
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry);
		const resolved = registry.resolve({ activeToolNames: ["read", "run_shell", "grep"] });
		expect(resolved.activeToolNames).toEqual(["read", "grep"]);
		expect(resolved.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["tool.active_missing"]);
	});

	it("runs a write-read-edit-bash-grep-find-ls round trip", async () => {
		await execute("write", "call-write", { path: "src/app.txt", content: "alpha needle one\nbeta line two\n" });
		expect(await readFile(join(cwd, "src", "app.txt"), "utf-8")).toBe("alpha needle one\nbeta line two\n");

		const readResult = await execute("read", "call-read", { path: "src/app.txt" });
		expect(textOf(readResult)).toBe("alpha needle one\nbeta line two\n");

		await execute("edit", "call-edit", {
			path: "src/app.txt",
			edits: [{ oldText: "beta line two", newText: "gamma line two" }],
		});
		expect(await readFile(join(cwd, "src", "app.txt"), "utf-8")).toBe("alpha needle one\ngamma line two\n");

		const bashResult = await execute("bash", "call-bash", { command: "wc -l < src/app.txt" });
		expect(textOf(bashResult).trim()).toBe("2");

		const grepResult = await execute("grep", "call-grep", { pattern: "needle" });
		expect(textOf(grepResult)).toBe("src/app.txt:1: alpha needle one");

		const findResult = await execute("find", "call-find", { pattern: "*.txt" });
		expect(textOf(findResult)).toBe("src/app.txt");

		const lsResult = await execute("ls", "call-ls", {});
		expect(textOf(lsResult)).toBe("src/");
	});
});
