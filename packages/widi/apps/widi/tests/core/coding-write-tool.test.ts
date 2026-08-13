import { describe, expect, it } from "vitest";
import { createAgentHarnessToolFromResolvedTool, ToolRegistry } from "../../src/core/tool-registry.ts";
import { createWriteToolDefinition } from "../../src/core/tools/coding/write.ts";

class MemoryWriteOperations {
	readonly files = new Map<string, string>();
	readonly createdDirs: string[] = [];
	readonly writeLog: string[] = [];

	async access(path: string): Promise<void> {
		if (!this.files.has(path)) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
	}

	async mkdir(path: string): Promise<void> {
		this.createdDirs.push(path);
	}

	async writeFile(path: string, content: string): Promise<void> {
		this.writeLog.push(`start:${content}`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		this.files.set(path, content);
		this.writeLog.push(`end:${content}`);
	}

	async realpath(path: string): Promise<string> {
		if (!this.files.has(path)) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
		return path;
	}
}

const emptyExecutionContext = {
	signal: undefined,
	onUpdate: undefined,
	workspace: { cwd: "/workspace/project" },
	extension: undefined,
	human: undefined,
};

describe("core write tool", () => {
	it("creates a new file relative to cwd with parent directories", async () => {
		const operations = new MemoryWriteOperations();
		const tool = createWriteToolDefinition({ operations });

		const result = await tool.execute(
			"call-1",
			{ path: "src/new-file.ts", content: "alpha\nbeta\n" },
			emptyExecutionContext,
		);

		expect(operations.files.get("/workspace/project/src/new-file.ts")).toBe("alpha\nbeta\n");
		expect(operations.createdDirs).toEqual(["/workspace/project/src"]);
		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote 11 bytes to src/new-file.ts" }]);
		expect(result.details).toEqual({
			path: "src/new-file.ts",
			absolutePath: "/workspace/project/src/new-file.ts",
			bytes: 11,
			created: true,
		});
	});

	it("overwrites an existing file and reports created: false", async () => {
		const operations = new MemoryWriteOperations();
		operations.files.set("/workspace/project/file.txt", "old");
		const tool = createWriteToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "file.txt", content: "new content" }, emptyExecutionContext);

		expect(operations.files.get("/workspace/project/file.txt")).toBe("new content");
		expect(result.details).toMatchObject({ created: false });
	});

	it("reports byte count, not character count, for multibyte content", async () => {
		const operations = new MemoryWriteOperations();
		const tool = createWriteToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "file.txt", content: "中文" }, emptyExecutionContext);

		expect(result.details).toMatchObject({ bytes: Buffer.byteLength("中文", "utf-8") });
		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote 6 bytes to file.txt" }]);
	});

	it("serializes concurrent writes to the same resolved path", async () => {
		const operations = new MemoryWriteOperations();
		const tool = createWriteToolDefinition({ operations });

		await Promise.all([
			tool.execute("call-1", { path: "file.txt", content: "first" }, emptyExecutionContext),
			tool.execute("call-2", { path: "file.txt", content: "second" }, emptyExecutionContext),
		]);

		expect(operations.writeLog).toEqual(["start:first", "end:first", "start:second", "end:second"]);
		expect(operations.files.get("/workspace/project/file.txt")).toBe("second");
	});

	it("does not write when the signal is already aborted", async () => {
		const operations = new MemoryWriteOperations();
		const controller = new AbortController();
		controller.abort();
		const tool = createWriteToolDefinition({ operations });

		await expect(
			tool.execute(
				"call-1",
				{ path: "file.txt", content: "data" },
				{ ...emptyExecutionContext, signal: controller.signal },
			),
		).rejects.toThrow("Operation aborted");
		expect(operations.files.size).toBe(0);
		expect(operations.writeLog).toEqual([]);
	});

	it("propagates non-missing-path errors from the existence check", async () => {
		const operations = new MemoryWriteOperations();
		operations.access = async () => {
			throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		};
		const tool = createWriteToolDefinition({ operations });

		await expect(tool.execute("call-1", { path: "file.txt", content: "data" }, emptyExecutionContext)).rejects.toThrow(
			"Permission denied",
		);
	});

	it("executes through the registry adapter with typed details", async () => {
		const operations = new MemoryWriteOperations();
		const registry = new ToolRegistry();
		registry.defineTool(createWriteToolDefinition({ operations }), { kind: "core", id: "builtin" });
		const resolved = registry.resolve().getTool("write");
		if (!resolved) throw new Error("Expected write tool to resolve.");
		const agentTool = createAgentHarnessToolFromResolvedTool(resolved);

		const result = await agentTool.execute("call-1", { path: "file.txt", content: "hello" }, undefined, undefined, {
			workspace: { cwd: "/workspace/project" },
		});

		expect(result).toMatchObject({
			content: [{ type: "text", text: "Successfully wrote 5 bytes to file.txt" }],
			details: { absolutePath: "/workspace/project/file.txt", created: true },
		});
	});
});
