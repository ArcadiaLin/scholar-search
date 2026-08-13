import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@arcadialin/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGrepToolDefinition,
	createLocalGrepOperations,
	type GrepOperations,
	type GrepToolDetails,
} from "../../src/core/tools/coding/grep.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

type GrepResult = AgentToolResult<GrepToolDetails>;

function makeContext(
	cwd: string,
	overrides: Partial<ToolExecutionContext<GrepToolDetails>> = {},
): ToolExecutionContext<GrepToolDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd },
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function textOf(result: GrepResult): string {
	const first = result.content[0];
	if (!first || first.type !== "text") {
		throw new Error("Expected a text content block");
	}
	return first.text;
}

describe("grep tool", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
		tempRoots.length = 0;
	});

	async function tempCwd(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "widi-grep-"));
		tempRoots.push(root);
		return root;
	}

	it("finds regex matches across a directory with relative POSIX paths", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "top.txt"), "alpha one\nbeta two\n");
		await mkdir(join(cwd, "sub"));
		await writeFile(join(cwd, "sub", "deep.txt"), "alpha three\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "alpha \\w+" }, makeContext(cwd));
		const lines = textOf(result).split("\n").sort();
		expect(lines).toEqual(["sub/deep.txt:1: alpha three", "top.txt:1: alpha one"]);
		expect(result.details).toMatchObject({ path: ".", absolutePath: cwd });
	});

	it("shows the basename and line numbers when searching a single file", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, "sub"));
		await writeFile(join(cwd, "sub", "only.txt"), "nope\nneedle here\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "needle", path: "sub/only.txt" }, makeContext(cwd));
		expect(textOf(result)).toBe("only.txt:2: needle here");
	});

	it("treats the pattern literally when literal is set", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "code.txt"), "value = a.b(c)\nvalue = axbxc\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "a.b(c)", literal: true }, makeContext(cwd));
		expect(textOf(result)).toBe("code.txt:1: value = a.b(c)");
	});

	it("matches case-insensitively when ignoreCase is set", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "case.txt"), "Hello World\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "hello", ignoreCase: true }, makeContext(cwd));
		expect(textOf(result)).toBe("case.txt:1: Hello World");
	});

	it("filters files by glob", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "a.ts"), "target\n");
		await writeFile(join(cwd, "a.js"), "target\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "target", glob: "*.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe("a.ts:1: target");
	});

	it("formats context lines around matches", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "ctx.txt"), "line one\nline two\nneedle line\nline four\nline five\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "needle", context: 1 }, makeContext(cwd));
		expect(textOf(result)).toBe("ctx.txt-2- line two\nctx.txt:3: needle line\nctx.txt-4- line four");
	});

	it("stops at the match limit and records matchLimitReached", async () => {
		const cwd = await tempCwd();
		const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`).join("\n");
		await writeFile(join(cwd, "many.txt"), `${lines}\n`);
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "match", limit: 3 }, makeContext(cwd));
		expect(result.details.matchLimitReached).toBe(3);
		const text = textOf(result);
		expect(text).toMatch(/3 matches limit reached/);
		expect(text.split("\n").filter((line) => line.includes("match ")).length).toBe(3);
	});

	it("truncates long match lines to 500 chars", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "long.txt"), `start ${"x".repeat(600)} needle\n`);
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "start" }, makeContext(cwd));
		expect(result.details.linesTruncated).toBe(true);
		const text = textOf(result);
		expect(text).toMatch(/\.\.\. \[truncated\]/);
		expect(text).toMatch(/Some lines truncated to 500 chars/);
		expect(text).not.toContain("needle");
	});

	it("applies the byte limit to large outputs", async () => {
		const cwd = await tempCwd();
		const line = `hit ${"y".repeat(400)}`;
		const lines = Array.from({ length: 200 }, () => line).join("\n");
		await writeFile(join(cwd, "big.txt"), `${lines}\n`);
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "hit", limit: 200 }, makeContext(cwd));
		expect(result.details.truncation?.truncated).toBe(true);
		expect(textOf(result)).toMatch(/50\.0KB limit reached/);
	});

	it("respects .gitignore inside a repository", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, ".git"));
		await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
		await writeFile(join(cwd, "ignored.txt"), "secret\n");
		await writeFile(join(cwd, "kept.txt"), "secret\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "secret" }, makeContext(cwd));
		expect(textOf(result)).toBe("kept.txt:1: secret");
	});

	it("searches hidden files", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, ".hidden.txt"), "needle\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "needle" }, makeContext(cwd));
		expect(textOf(result)).toBe(".hidden.txt:1: needle");
	});

	it("returns No matches found when nothing matches", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "a.txt"), "nothing here\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "zzz-not-there" }, makeContext(cwd));
		expect(textOf(result)).toBe("No matches found");
	});

	it("treats a flag-like pattern as a pattern, not an rg option", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "flags.txt"), "usage: --help prints help\n");
		const tool = createGrepToolDefinition();
		const result = await tool.execute("call-1", { pattern: "--help", literal: true }, makeContext(cwd));
		expect(textOf(result)).toBe("flags.txt:1: usage: --help prints help");
	});

	it("rejects invalid context and limit values", async () => {
		const cwd = await tempCwd();
		const tool = createGrepToolDefinition();
		await expect(tool.execute("call-1", { pattern: "x", context: -1 }, makeContext(cwd))).rejects.toThrow(
			/context must be a non-negative integer/,
		);
		await expect(tool.execute("call-1", { pattern: "x", limit: 0 }, makeContext(cwd))).rejects.toThrow(
			/limit must be a positive integer/,
		);
	});

	it("throws for a missing search path", async () => {
		const cwd = await tempCwd();
		const tool = createGrepToolDefinition();
		await expect(tool.execute("call-1", { pattern: "x", path: "no-such-dir" }, makeContext(cwd))).rejects.toThrow(
			/Path not found/,
		);
	});

	it("throws when the configured ripgrep path is missing", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "a.txt"), "x\n");
		const tool = createGrepToolDefinition({ rgPath: "/no/such/rg" });
		await expect(tool.execute("call-1", { pattern: "x" }, makeContext(cwd))).rejects.toThrow(
			/Custom ripgrep path not found/,
		);
	});

	it("surfaces rg execution errors for invalid regex patterns", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "a.txt"), "x\n");
		const tool = createGrepToolDefinition();
		await expect(tool.execute("call-1", { pattern: "(unclosed" }, makeContext(cwd))).rejects.toThrow(
			/regex parse error|ripgrep exited with code/,
		);
	});

	it("aborts a running search via the signal", async () => {
		const cwd = await tempCwd();
		const operations: GrepOperations = {
			...createLocalGrepOperations(),
			runRg: (_args, { signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
				}),
		};
		const tool = createGrepToolDefinition({ operations });
		const controller = new AbortController();
		const pending = tool.execute("call-1", { pattern: "x" }, makeContext(cwd, { signal: controller.signal }));
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toThrow(/Operation aborted/);
	});
});
