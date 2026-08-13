import { describe, expect, it } from "vitest";
import { createAgentHarnessToolFromResolvedTool, ToolRegistry } from "../../src/core/tool-registry.ts";
import { createEditToolDefinition, type EditToolInput } from "../../src/core/tools/coding/edit.ts";

class MemoryEditOperations {
	readonly files = new Map<string, string>();

	async access(path: string): Promise<void> {
		if (!this.files.has(path)) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
	}

	async readFile(path: string): Promise<Buffer> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
		return Buffer.from(content, "utf-8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(path, content);
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

function createTool(operations: MemoryEditOperations) {
	return createEditToolDefinition({ operations });
}

describe("core edit tool", () => {
	it("applies a single exact replacement with diff and patch details", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const tool = createTool(operations);

		const result = await tool.execute(
			"call-1",
			{ path: "file.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }] },
			emptyExecutionContext,
		);

		expect(operations.files.get("/workspace/project/file.ts")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in file.ts." }]);
		expect(result.details).toMatchObject({
			path: "file.ts",
			absolutePath: "/workspace/project/file.ts",
			firstChangedLine: 2,
		});
		expect(result.details.diff).toContain("-2 const b = 2;");
		expect(result.details.diff).toContain("+2 const b = 20;");
		expect(result.details.patch).toContain("--- file.ts");
		expect(result.details.patch).toContain("+const b = 20;");
	});

	it("applies multiple disjoint edits matched against the original file", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha\nbeta\ngamma\ndelta\n");
		const tool = createTool(operations);

		const result = await tool.execute(
			"call-1",
			{
				path: "file.txt",
				edits: [
					{ oldText: "delta", newText: "DELTA" },
					{ oldText: "alpha", newText: "ALPHA" },
				],
			},
			emptyExecutionContext,
		);

		expect(operations.files.get("/workspace/project/file.txt")).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 2 block(s) in file.txt." }]);
	});

	it("normalizes legacy oldText/newText arguments into edits", () => {
		const operations = new MemoryEditOperations();
		const tool = createTool(operations);
		if (!tool.prepareArguments) throw new Error("Expected prepareArguments.");

		const prepared = tool.prepareArguments({ path: "file.txt", oldText: "a", newText: "b" }) as EditToolInput;

		expect(prepared).toEqual({ path: "file.txt", edits: [{ oldText: "a", newText: "b" }] });
	});

	it("parses edits sent as a JSON string", () => {
		const operations = new MemoryEditOperations();
		const tool = createTool(operations);
		if (!tool.prepareArguments) throw new Error("Expected prepareArguments.");

		const prepared = tool.prepareArguments({
			path: "file.txt",
			edits: '[{"oldText":"a","newText":"b"}]',
		}) as EditToolInput;

		expect(prepared.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("fuzzy matches smart punctuation while preserving untouched lines", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/doc.md", "first line\t\nsays “hello” here\nlast line\t\n");
		const tool = createTool(operations);

		await tool.execute(
			"call-1",
			{ path: "doc.md", edits: [{ oldText: 'says "hello" here', newText: 'says "goodbye" here' }] },
			emptyExecutionContext,
		);

		// The edited line is rewritten from normalized content; untouched lines
		// keep their original bytes (trailing tabs survive).
		expect(operations.files.get("/workspace/project/doc.md")).toBe('first line\t\nsays "goodbye" here\nlast line\t\n');
	});

	it("preserves CRLF line endings and BOM", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "\uFEFFone\r\ntwo\r\nthree\r\n");
		const tool = createTool(operations);

		await tool.execute(
			"call-1",
			{ path: "file.txt", edits: [{ oldText: "two", newText: "TWO" }] },
			emptyExecutionContext,
		);

		expect(operations.files.get("/workspace/project/file.txt")).toBe("\uFEFFone\r\nTWO\r\nthree\r\n");
	});

	it("rejects text that is not found", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha\n");
		const tool = createTool(operations);

		await expect(
			tool.execute(
				"call-1",
				{ path: "file.txt", edits: [{ oldText: "missing", newText: "x" }] },
				emptyExecutionContext,
			),
		).rejects.toThrow("Could not find the exact text in file.txt.");
	});

	it("rejects ambiguous text with an occurrence count", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "dup\ndup\n");
		const tool = createTool(operations);

		await expect(
			tool.execute("call-1", { path: "file.txt", edits: [{ oldText: "dup", newText: "x" }] }, emptyExecutionContext),
		).rejects.toThrow("Found 2 occurrences of the text in file.txt. The text must be unique.");
	});

	it("rejects overlapping edits", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha beta gamma\n");
		const tool = createTool(operations);

		await expect(
			tool.execute(
				"call-1",
				{
					path: "file.txt",
					edits: [
						{ oldText: "alpha beta", newText: "x" },
						{ oldText: "beta gamma", newText: "y" },
					],
				},
				emptyExecutionContext,
			),
		).rejects.toThrow("edits[0] and edits[1] overlap in file.txt.");
	});

	it("rejects replacements that produce identical content", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "same\n");
		const tool = createTool(operations);

		await expect(
			tool.execute(
				"call-1",
				{ path: "file.txt", edits: [{ oldText: "same", newText: "same" }] },
				emptyExecutionContext,
			),
		).rejects.toThrow("No changes made to file.txt.");
	});

	it("rejects empty edits and missing files with clear diagnostics", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha\n");
		const tool = createTool(operations);

		await expect(tool.execute("call-1", { path: "file.txt", edits: [] }, emptyExecutionContext)).rejects.toThrow(
			"edits must contain at least one replacement",
		);
		await expect(
			tool.execute("call-1", { path: "absent.txt", edits: [{ oldText: "a", newText: "b" }] }, emptyExecutionContext),
		).rejects.toThrow("Could not edit file: absent.txt. Error code: ENOENT.");
	});

	it("does not modify the file when the signal is already aborted", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha\n");
		const controller = new AbortController();
		controller.abort();
		const tool = createTool(operations);

		await expect(
			tool.execute(
				"call-1",
				{ path: "file.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
				{ ...emptyExecutionContext, signal: controller.signal },
			),
		).rejects.toThrow("Operation aborted");
		expect(operations.files.get("/workspace/project/file.txt")).toBe("alpha\n");
	});

	it("executes through the registry adapter with legacy argument preparation", async () => {
		const operations = new MemoryEditOperations();
		operations.files.set("/workspace/project/file.txt", "alpha\n");
		const registry = new ToolRegistry();
		registry.defineTool(createEditToolDefinition({ operations }), { kind: "core", id: "builtin" });
		const resolved = registry.resolve().getTool("edit");
		if (!resolved) throw new Error("Expected edit tool to resolve.");
		const agentTool = createAgentHarnessToolFromResolvedTool(resolved);
		if (!agentTool.prepareArguments) {
			throw new Error("Expected prepareArguments on the adapted tool.");
		}

		// The pi agent loop applies prepareArguments before execute.
		const prepared = agentTool.prepareArguments({ path: "file.txt", oldText: "alpha", newText: "beta" });
		const result = await agentTool.execute("call-1", prepared, undefined, undefined, {
			workspace: { cwd: "/workspace/project" },
		});

		expect(operations.files.get("/workspace/project/file.txt")).toBe("beta\n");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in file.txt." }],
		});
	});
});
