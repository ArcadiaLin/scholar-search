import type { AgentToolResult } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import { createAgentHarnessToolFromResolvedTool, ToolRegistry } from "../../src/core/tool-registry.ts";
import {
	createLocalReadImageOperations,
	createReadToolDefinition,
	type ReadImageOperations,
	type ReadToolDetails,
} from "../../src/core/tools/coding/read.ts";
import type { ImageProcessor, ProcessImageResult } from "../../src/utils/image/process-image.ts";

class MemoryReadOperations {
	readonly files = new Map<string, Buffer>();

	set(path: string, content: string | Buffer): void {
		this.files.set(path, typeof content === "string" ? Buffer.from(content, "utf-8") : content);
	}

	async access(path: string): Promise<void> {
		if (!this.files.has(path)) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
	}

	async readFile(path: string): Promise<Buffer> {
		const content = this.files.get(path);
		if (!content) {
			throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		}
		return content;
	}
}

const emptyExecutionContext = {
	signal: undefined,
	onUpdate: undefined,
	workspace: { cwd: "/workspace/project" },
	extension: undefined,
	human: undefined,
};

/** Valid PNG header: signature plus a minimal IHDR chunk. */
const PNG_FILE = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from([0, 0, 0, 13]),
	Buffer.from("IHDR", "ascii"),
	Buffer.alloc(13 + 4),
]);

function makeImageOperations(processImage: ImageProcessor): ReadImageOperations {
	return { detectImageMimeType: createLocalReadImageOperations().detectImageMimeType, processImage };
}

function successProcessor(overrides: Partial<Extract<ProcessImageResult, { ok: true }>> = {}): ImageProcessor {
	return async () => ({ ok: true, data: "cHJvY2Vzc2Vk", mimeType: "image/png", ...overrides });
}

function getTextContent(result: AgentToolResult<ReadToolDetails>): string {
	const [content] = result.content;
	if (content?.type !== "text") {
		throw new Error("Expected text content.");
	}
	return content.text;
}

describe("core read tool", () => {
	it("reads UTF-8 text files relative to cwd", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/src/file.ts", "alpha\nbeta\n");
		const tool = createReadToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "src/file.ts" }, emptyExecutionContext);

		expect(result.content).toEqual([{ type: "text", text: "alpha\nbeta\n" }]);
		expect(result.details).toMatchObject({
			path: "src/file.ts",
			absolutePath: "/workspace/project/src/file.ts",
			mediaKind: "text",
			bytes: Buffer.byteLength("alpha\nbeta\n", "utf-8"),
			totalLines: 3,
			returnedLineRange: { start: 1, end: 2 },
			truncation: undefined,
		});
	});

	it("honors offset and limit with continuation notice", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/file.txt", "one\ntwo\nthree\nfour");
		const tool = createReadToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "file.txt", offset: 2, limit: 2 }, emptyExecutionContext);

		expect(result.content).toEqual([
			{ type: "text", text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]" },
		]);
		expect(result.details.returnedLineRange).toEqual({ start: 2, end: 3 });
	});

	it("reports truncation by line limit with typed details", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/file.txt", "one\ntwo\nthree");
		const tool = createReadToolDefinition({ operations, maxLines: 2, maxBytes: 100 });

		const result = await tool.execute("call-1", { path: "file.txt" }, emptyExecutionContext);

		expect(result.content).toEqual([
			{ type: "text", text: "one\ntwo\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]" },
		]);
		expect(result.details.truncation).toMatchObject({ truncated: true, truncatedBy: "lines", outputLines: 2 });
	});

	it("does not return partial lines when byte limit cuts the first line", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/file.txt", "123456\nok");
		const tool = createReadToolDefinition({ operations, maxLines: 10, maxBytes: 4 });

		const result = await tool.execute("call-1", { path: "file.txt" }, emptyExecutionContext);

		expect(getTextContent(result)).toBe(
			"[Line 1 in file.txt is 6B, exceeding the 4B read limit. The core read tool does not return partial lines.]",
		);
		expect(result.details.truncation).toMatchObject({ firstLineExceedsLimit: true, outputLines: 0 });
	});

	it("treats files that only spoof an image signature as binary", async () => {
		const operations = new MemoryReadOperations();
		// PNG signature without an IHDR chunk fails image detection.
		operations.set("/workspace/project/image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const tool = createReadToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "image.png" }, emptyExecutionContext);

		expect(getTextContent(result)).toBe(
			"Cannot read image.png: Binary or non-UTF-8 files are not supported by the core read tool.",
		);
		expect(result.details.mediaKind).toBe("binary");
	});

	it("reports binary files as unsupported structured results", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/blob.bin", Buffer.from([0x66, 0x00, 0x67]));
		const tool = createReadToolDefinition({ operations });

		const result = await tool.execute("call-1", { path: "blob.bin" }, emptyExecutionContext);

		expect(getTextContent(result)).toBe(
			"Cannot read blob.bin: Binary or non-UTF-8 files are not supported by the core read tool.",
		);
		expect(result.details).toMatchObject({
			mediaKind: "binary",
			unsupported: { reason: "Binary or non-UTF-8 files are not supported by the core read tool." },
		});
	});

	it("rejects invalid line windows", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/file.txt", "one\ntwo");
		const tool = createReadToolDefinition({ operations });

		await expect(tool.execute("call-1", { path: "file.txt", offset: 3 }, emptyExecutionContext)).rejects.toThrow(
			"Offset 3 is beyond end of file (2 lines total).",
		);
		await expect(tool.execute("call-1", { path: "file.txt", limit: 0 }, emptyExecutionContext)).rejects.toThrow(
			"limit must be a positive line count",
		);
	});

	it("returns a text note and an image block for image files", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		const seenCalls: Array<{ mimeType: string; autoResize: boolean | undefined }> = [];
		const imageOperations = makeImageOperations(async (bytes, mimeType, options) => {
			seenCalls.push({ mimeType, autoResize: options?.autoResize });
			expect(Buffer.from(bytes).equals(PNG_FILE)).toBe(true);
			return { ok: true, data: "cHJvY2Vzc2Vk", mimeType: "image/png" };
		});
		const tool = createReadToolDefinition({ operations, imageOperations });

		const result = await tool.execute("call-1", { path: "image.png" }, emptyExecutionContext);

		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "cHJvY2Vzc2Vk", mimeType: "image/png" },
		]);
		expect(result.details).toMatchObject({
			mediaKind: "image",
			bytes: PNG_FILE.byteLength,
			image: { originalMimeType: "image/png", mimeType: "image/png", converted: false, resized: false },
		});
		expect(seenCalls).toEqual([{ mimeType: "image/png", autoResize: true }]);
	});

	it("notes conversion and resize hints with dimension details", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/photo.png", PNG_FILE);
		const tool = createReadToolDefinition({
			operations,
			imageOperations: makeImageOperations(
				successProcessor({
					mimeType: "image/jpeg",
					convertedFrom: "image/png",
					dimensions: { originalWidth: 4000, originalHeight: 3000, width: 2000, height: 1500, wasResized: true },
				}),
			),
		});

		const result = await tool.execute("call-1", { path: "photo.png" }, emptyExecutionContext);

		expect(getTextContent(result)).toBe(
			[
				"Read image file [image/jpeg]",
				"[Image converted from image/png to image/jpeg.]",
				"[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
			].join("\n"),
		);
		expect(result.details.image).toMatchObject({
			originalMimeType: "image/png",
			mimeType: "image/jpeg",
			converted: true,
			resized: true,
			originalWidth: 4000,
			originalHeight: 3000,
			width: 2000,
			height: 1500,
		});
	});

	it("passes autoResizeImages=false through to the processor", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		let seenAutoResize: boolean | undefined;
		const tool = createReadToolDefinition({
			operations,
			autoResizeImages: false,
			imageOperations: makeImageOperations(async (_bytes, _mime, options) => {
				seenAutoResize = options?.autoResize;
				return { ok: true, data: "cHJvY2Vzc2Vk", mimeType: "image/png" };
			}),
		});

		await tool.execute("call-1", { path: "image.png" }, emptyExecutionContext);

		expect(seenAutoResize).toBe(false);
	});

	it("returns a text-only blocked note when blockImages is enabled", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		let processorCalled = false;
		const tool = createReadToolDefinition({
			operations,
			blockImages: true,
			imageOperations: makeImageOperations(async () => {
				processorCalled = true;
				return { ok: true, data: "cHJvY2Vzc2Vk", mimeType: "image/png" };
			}),
		});

		const result = await tool.execute("call-1", { path: "image.png" }, emptyExecutionContext);

		expect(processorCalled).toBe(false);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Read image file [image/png]\n[Image blocked: the images.blockImages setting prevents sending images to model providers.]",
			},
		]);
		expect(result.details.image).toMatchObject({ originalMimeType: "image/png", blocked: true });
	});

	it("returns a text-only omitted note when image processing fails", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		const tool = createReadToolDefinition({
			operations,
			imageOperations: makeImageOperations(async () => ({
				ok: false,
				reason: "could not be resized below the inline image size limit",
			})),
		});

		const result = await tool.execute("call-1", { path: "image.png" }, emptyExecutionContext);

		expect(result.content).toEqual([
			{
				type: "text",
				text: "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
			},
		]);
		expect(result.details.image).toMatchObject({
			originalMimeType: "image/png",
			omittedReason: "could not be resized below the inline image size limit",
		});
	});

	it("rejects offset and limit for image files", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		const tool = createReadToolDefinition({ operations, imageOperations: makeImageOperations(successProcessor()) });

		await expect(tool.execute("call-1", { path: "image.png", offset: 1 }, emptyExecutionContext)).rejects.toThrow(
			"offset and limit are not supported for image files",
		);
		await expect(tool.execute("call-1", { path: "image.png", limit: 5 }, emptyExecutionContext)).rejects.toThrow(
			"offset and limit are not supported for image files",
		);
	});

	it("keeps image content through the registry adapter", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/image.png", PNG_FILE);
		const registry = new ToolRegistry();
		registry.defineTool(
			createReadToolDefinition({ operations, imageOperations: makeImageOperations(successProcessor()) }),
			{ kind: "core", id: "builtin" },
		);
		const resolved = registry.resolve().getTool("read");
		if (!resolved) throw new Error("Expected read tool to resolve.");
		const agentTool = createAgentHarnessToolFromResolvedTool(resolved);

		const result = await agentTool.execute("call-1", { path: "image.png" }, undefined, undefined, {
			workspace: { cwd: "/workspace/project" },
		});

		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "cHJvY2Vzc2Vk", mimeType: "image/png" },
		]);
	});

	it("returns structured execution results through the registry adapter", async () => {
		const operations = new MemoryReadOperations();
		operations.set("/workspace/project/file.txt", "hello");
		const registry = new ToolRegistry();
		registry.defineTool(createReadToolDefinition({ operations }), { kind: "core", id: "builtin" });
		const resolved = registry.resolve().getTool("read");
		if (!resolved) throw new Error("Expected read tool to resolve.");
		const agentTool = createAgentHarnessToolFromResolvedTool(resolved);

		const result = await agentTool.execute("call-1", { path: "file.txt" }, undefined, undefined, {
			workspace: { cwd: "/workspace/project" },
		});

		expect(result).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			details: { absolutePath: "/workspace/project/file.txt", mediaKind: "text" },
		});
	});
});
