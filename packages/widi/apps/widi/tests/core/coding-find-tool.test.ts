import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@arcadialin/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	createFindToolDefinition,
	createLocalFindOperations,
	type FindOperations,
	type FindToolDetails,
} from "../../src/core/tools/coding/find.ts";
import { compileFindPattern } from "../../src/core/tools/coding/glob-match.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

type FindResult = AgentToolResult<FindToolDetails>;

function makeContext(
	cwd: string,
	overrides: Partial<ToolExecutionContext<FindToolDetails>> = {},
): ToolExecutionContext<FindToolDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd },
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function textOf(result: FindResult): string {
	const first = result.content[0];
	if (!first || first.type !== "text") {
		throw new Error("Expected a text content block");
	}
	return first.text;
}

describe("find glob matching", () => {
	it("matches basenames at any depth for patterns without a slash", () => {
		const matches = compileFindPattern("*.ts");
		expect(matches("a.ts")).toBe(true);
		expect(matches("src/deep/b.ts")).toBe(true);
		expect(matches("a.tsx")).toBe(false);
	});

	it("matches relative paths at any depth for patterns with a slash", () => {
		const matches = compileFindPattern("src/**/*.spec.ts");
		expect(matches("src/a.spec.ts")).toBe(true);
		expect(matches("src/deep/b.spec.ts")).toBe(true);
		expect(matches("packages/x/src/deep/c.spec.ts")).toBe(true);
		expect(matches("src/a.ts")).toBe(false);
	});

	it("anchors patterns starting with a slash to the search root", () => {
		const matches = compileFindPattern("/src/*.ts");
		expect(matches("src/a.ts")).toBe(true);
		expect(matches("nested/src/a.ts")).toBe(false);
	});

	it("supports alternation, character classes, and single-char wildcards", () => {
		const matches = compileFindPattern("file-[0-9].{ts,js}");
		expect(matches("dir/file-1.ts")).toBe(true);
		expect(matches("file-2.js")).toBe(true);
		expect(matches("file-x.ts")).toBe(false);
		expect(matches("file-1.tsx")).toBe(false);
		const single = compileFindPattern("a?c.txt");
		expect(single("abc.txt")).toBe(true);
		expect(single("a/c.txt")).toBe(false);
	});

	it("rejects invalid patterns", () => {
		expect(() => compileFindPattern("[")).toThrow(/Invalid glob pattern/);
		expect(() => compileFindPattern("{a,b")).toThrow(/Invalid glob pattern/);
		expect(() => compileFindPattern("")).toThrow(/Invalid glob pattern/);
	});
});

describe("find tool", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
		tempRoots.length = 0;
	});

	async function tempCwd(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "widi-find-"));
		tempRoots.push(root);
		return root;
	}

	it("finds files by basename pattern in deterministic sorted order", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, "src", "deep"), { recursive: true });
		await writeFile(join(cwd, "b.ts"), "");
		await writeFile(join(cwd, "src", "a.ts"), "");
		await writeFile(join(cwd, "src", "deep", "c.ts"), "");
		await writeFile(join(cwd, "readme.md"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe("b.ts\nsrc/a.ts\nsrc/deep/c.ts");
		expect(result.details).toMatchObject({ path: ".", absolutePath: cwd });
	});

	it("matches path-containing globs against relative paths", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, "src", "deep"), { recursive: true });
		await mkdir(join(cwd, "other"));
		await writeFile(join(cwd, "src", "a.spec.ts"), "");
		await writeFile(join(cwd, "src", "deep", "b.spec.ts"), "");
		await writeFile(join(cwd, "other", "c.spec.ts"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "src/**/*.spec.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe("src/a.spec.ts\nsrc/deep/b.spec.ts");
	});

	it("includes hidden files", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, ".hidden.ts"), "");
		await writeFile(join(cwd, "visible.ts"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe(".hidden.ts\nvisible.ts");
	});

	it("always excludes .git and node_modules", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, ".git", "refs"), { recursive: true });
		await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(cwd, ".git", "refs", "x.ts"), "");
		await writeFile(join(cwd, "node_modules", "pkg", "mod.ts"), "");
		await writeFile(join(cwd, "app.ts"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe("app.ts");
	});

	it("respects .gitignore inside a repository even with a matching pattern", async () => {
		const cwd = await tempCwd();
		await mkdir(join(cwd, ".git"));
		await mkdir(join(cwd, "dist"));
		await writeFile(join(cwd, ".gitignore"), "dist\n");
		await writeFile(join(cwd, "dist", "out.ts"), "");
		await writeFile(join(cwd, "in.ts"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd));
		expect(textOf(result)).toBe("in.ts");
	});

	it("respects .gitignore outside a repository via --no-require-git", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
		await writeFile(join(cwd, "ignored.txt"), "");
		await writeFile(join(cwd, "kept.txt"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.txt" }, makeContext(cwd));
		expect(textOf(result)).toBe("kept.txt");
	});

	it("stops parent .gitignore rules at nested repository boundaries", async () => {
		// Characterization: inside a repository, rg's git-aware defaults do not
		// apply the parent repository's .gitignore inside a nested repository.
		const cwd = await tempCwd();
		await mkdir(join(cwd, ".git"));
		await mkdir(join(cwd, "nested", ".git"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "shared-name.txt\n");
		await writeFile(join(cwd, "shared-name.txt"), "");
		await writeFile(join(cwd, "nested", "shared-name.txt"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.txt" }, makeContext(cwd));
		expect(textOf(result)).toBe("nested/shared-name.txt");
	});

	it("stops at the result limit with a deterministic prefix", async () => {
		const cwd = await tempCwd();
		for (let i = 0; i < 6; i++) {
			await writeFile(join(cwd, `file-${i}.txt`), "");
		}
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.txt", limit: 3 }, makeContext(cwd));
		expect(result.details.resultLimitReached).toBe(3);
		expect(textOf(result)).toBe(
			"file-0.txt\nfile-1.txt\nfile-2.txt\n\n[3 results limit reached. Use limit=6 for more, or refine pattern]",
		);
	});

	it("returns No files found matching pattern when nothing matches", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "a.txt"), "");
		const tool = createFindToolDefinition();
		const result = await tool.execute("call-1", { pattern: "*.zzz" }, makeContext(cwd));
		expect(textOf(result)).toBe("No files found matching pattern");
	});

	it("rejects invalid glob patterns before spawning rg", async () => {
		const cwd = await tempCwd();
		const tool = createFindToolDefinition({ rgPath: "/no/such/rg" });
		await expect(tool.execute("call-1", { pattern: "[" }, makeContext(cwd))).rejects.toThrow(/Invalid glob pattern/);
	});

	it("rejects an invalid limit", async () => {
		const cwd = await tempCwd();
		const tool = createFindToolDefinition();
		await expect(tool.execute("call-1", { pattern: "*.ts", limit: 0 }, makeContext(cwd))).rejects.toThrow(
			/limit must be a positive integer/,
		);
	});

	it("throws distinct errors for missing paths and non-directories", async () => {
		const cwd = await tempCwd();
		await writeFile(join(cwd, "file.txt"), "");
		const tool = createFindToolDefinition();
		await expect(tool.execute("call-1", { pattern: "*.ts", path: "no-such-dir" }, makeContext(cwd))).rejects.toThrow(
			/Path not found/,
		);
		await expect(tool.execute("call-1", { pattern: "*.ts", path: "file.txt" }, makeContext(cwd))).rejects.toThrow(
			/Not a directory/,
		);
	});

	it("throws when the configured ripgrep path is missing", async () => {
		const cwd = await tempCwd();
		const tool = createFindToolDefinition({ rgPath: "/no/such/rg" });
		await expect(tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd))).rejects.toThrow(
			/Custom ripgrep path not found/,
		);
	});

	it("aborts a running search via the signal", async () => {
		const cwd = await tempCwd();
		const operations: FindOperations = {
			...createLocalFindOperations(),
			runRg: (_args, { signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
				}),
		};
		const tool = createFindToolDefinition({ operations });
		const controller = new AbortController();
		const pending = tool.execute("call-1", { pattern: "*.ts" }, makeContext(cwd, { signal: controller.signal }));
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toThrow(/Operation aborted/);
	});
});
