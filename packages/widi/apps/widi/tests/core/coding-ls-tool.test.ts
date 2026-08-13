import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@arcadialin/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createLsToolDefinition, type LsToolDetails } from "../../src/core/tools/coding/ls.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

type LsResult = AgentToolResult<LsToolDetails>;

function makeContext(
	cwd: string,
	overrides: Partial<ToolExecutionContext<LsToolDetails>> = {},
): ToolExecutionContext<LsToolDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd },
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function textOf(result: LsResult): string {
	const first = result.content[0];
	if (!first || first.type !== "text") {
		throw new Error("Expected a text content block");
	}
	return first.text;
}

describe("ls tool", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
		tempRoots.length = 0;
	});

	async function tempCwd(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "widi-ls-"));
		tempRoots.push(root);
		return root;
	}

	it("lists entries sorted case-insensitively with directory suffixes", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "Beta.txt"), "b");
		await writeFile(join(cwd, "alpha.txt"), "a");
		await mkdir(join(cwd, "charlie"));
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", {}, makeContext(cwd));
		expect(textOf(result)).toBe("alpha.txt\nBeta.txt\ncharlie/");
		expect(result.details).toMatchObject({ path: ".", absolutePath: cwd });
	});

	it("includes dotfiles", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, ".hidden"), "h");
		await writeFile(join(cwd, "visible.txt"), "v");
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", {}, makeContext(cwd));
		expect(textOf(result)).toBe(".hidden\nvisible.txt");
	});

	it("lists a relative subdirectory of cwd", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, "sub"));
		await writeFile(join(cwd, "sub", "inner.txt"), "i");
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", { path: "sub" }, makeContext(cwd));
		expect(textOf(result)).toBe("inner.txt");
		expect(result.details).toMatchObject({ path: "sub", absolutePath: join(cwd, "sub") });
	});

	it("returns (empty directory) for an empty directory", async () => {
		const cwd = await tempCwd();
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", {}, makeContext(cwd));
		expect(textOf(result)).toBe("(empty directory)");
	});

	it("caps entries at the limit and records entryLimitReached", async () => {
		const cwd = await tempCwd();
		for (let i = 0; i < 5; i++) {
			await writeFile(join(cwd, `file-${i}.txt`), String(i));
		}
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", { limit: 3 }, makeContext(cwd));
		expect(textOf(result)).toBe(
			"file-0.txt\nfile-1.txt\nfile-2.txt\n\n[3 entries limit reached. Use limit=6 for more]",
		);
		expect(result.details.entryLimitReached).toBe(3);
	});

	it("applies the byte limit and records truncation", async () => {
		const cwd = await tempCwd();
		const longName = "n".repeat(200);
		for (let i = 0; i < 300; i++) {
			await writeFile(join(cwd, `${longName}-${String(i).padStart(3, "0")}`), "");
		}
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", {}, makeContext(cwd));
		expect(result.details.truncation?.truncated).toBe(true);
		expect(textOf(result)).toMatch(/\[50\.0KB limit reached\]/);
	});

	it("skips entries that cannot be stat-ed", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "good.txt"), "g");
		await symlink(join(cwd, "missing-target"), join(cwd, "broken-link"));
		const tool = createLsToolDefinition();
		const result = await tool.execute("call-1", {}, makeContext(cwd));
		expect(textOf(result)).toBe("good.txt");
	});

	it("rejects an invalid limit", async () => {
		const cwd = await tempCwd();
		const tool = createLsToolDefinition();
		await expect(tool.execute("call-1", { limit: 0 }, makeContext(cwd))).rejects.toThrow(
			/limit must be a positive integer/,
		);
		await expect(tool.execute("call-1", { limit: 1.5 }, makeContext(cwd))).rejects.toThrow(
			/limit must be a positive integer/,
		);
	});

	it("throws distinct errors for missing paths and non-directories", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "file.txt"), "f");
		const tool = createLsToolDefinition();
		await expect(tool.execute("call-1", { path: "no-such-dir" }, makeContext(cwd))).rejects.toThrow(/Path not found/);
		await expect(tool.execute("call-1", { path: "file.txt" }, makeContext(cwd))).rejects.toThrow(/Not a directory/);
	});

	it("aborts when the signal is already aborted", async () => {
		const cwd = await tempCwd();
		const tool = createLsToolDefinition();
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("call-1", {}, makeContext(cwd, { signal: controller.signal }))).rejects.toThrow(
			/Operation aborted/,
		);
	});
});
