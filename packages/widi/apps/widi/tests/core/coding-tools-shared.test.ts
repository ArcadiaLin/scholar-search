import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../../src/core/tools/coding/file-mutation-queue.ts";
import { createLocalCodingToolFileOperations, isMissingPathError } from "../../src/core/tools/coding/operations.ts";
import { OutputAccumulator } from "../../src/core/tools/coding/output-accumulator.ts";
import { resolveToCwd } from "../../src/core/tools/coding/path-utils.ts";
import { formatSize, truncateHead, truncateLine, truncateTail } from "../../src/core/tools/coding/truncate.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe("coding tool shared primitives", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
		tempRoots.length = 0;
	});

	it("resolves relative paths against cwd and normalizes absolute paths", () => {
		expect(resolveToCwd("src/../README.md", "/workspace/project")).toBe("/workspace/project/README.md");
		expect(resolveToCwd("/tmp/../var/file.txt", "/workspace/project")).toBe("/var/file.txt");
	});

	it("provides local file operations without exposing ExecutionEnv", async () => {
		const root = await mkdtemp(join(tmpdir(), "widi-coding-"));
		tempRoots.push(root);
		const operations = createLocalCodingToolFileOperations();
		const filePath = join(root, "nested", "file.txt");

		await operations.mkdir(dirname(filePath));
		await operations.writeFile(filePath, "hello");

		await expect(operations.access(filePath, "read")).resolves.toBeUndefined();
		await expect(operations.readFile(filePath)).resolves.toEqual(Buffer.from("hello"));
		await expect(operations.realpath(filePath)).resolves.toBe(filePath);
	});

	it("detects missing path errors by node-style error code", () => {
		expect(isMissingPathError({ code: "ENOENT" })).toBe(true);
		expect(isMissingPathError({ code: "ENOTDIR" })).toBe(true);
		expect(isMissingPathError({ code: "EACCES" })).toBe(false);
		expect(isMissingPathError(new Error("missing"))).toBe(false);
	});

	it("serializes mutations that resolve to the same file key", async () => {
		const firstStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		const events: string[] = [];
		const operations = { realpath: async (path: string) => path.replace("/link", "/target") };

		const first = withFileMutationQueue(
			"/workspace/link",
			async () => {
				events.push("first:start");
				firstStarted.resolve();
				await releaseFirst.promise;
				events.push("first:end");
				return "first";
			},
			{ operations },
		);
		const second = withFileMutationQueue(
			"/workspace/target",
			async () => {
				events.push("second:start");
				return "second";
			},
			{ operations },
		);

		await firstStarted.promise;
		await Promise.resolve();
		expect(events).toEqual(["first:start"]);

		releaseFirst.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("releases the mutation queue when a mutation fails", async () => {
		const operations = { realpath: async (path: string) => path };
		const events: string[] = [];

		const first = withFileMutationQueue(
			"/workspace/file.txt",
			async () => {
				events.push("first");
				throw new Error("boom");
			},
			{ operations },
		);
		const second = withFileMutationQueue(
			"/workspace/file.txt",
			async () => {
				events.push("second");
				return "ok";
			},
			{ operations },
		);

		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toBe("ok");
		expect(events).toEqual(["first", "second"]);
	});

	it("truncates file reads by line and byte limits without partial lines", () => {
		const byLines = truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
		expect(byLines).toMatchObject({
			content: "one\ntwo",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3,
			outputLines: 2,
		});

		const byBytes = truncateHead("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 9 });
		expect(byBytes).toMatchObject({
			content: "alpha",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			firstLineExceedsLimit: false,
		});

		const firstLineTooLarge = truncateHead("123456\nok", { maxLines: 10, maxBytes: 4 });
		expect(firstLineTooLarge).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			firstLineExceedsLimit: true,
		});
	});

	it("formats byte sizes for tool notices", () => {
		expect(formatSize(512)).toBe("512B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});

	it("truncates command output from the tail by line and byte limits", () => {
		const byLines = truncateTail("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
		expect(byLines).toMatchObject({
			content: "two\nthree",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3,
			outputLines: 2,
			lastLinePartial: false,
		});

		const byBytes = truncateTail("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 9 });
		expect(byBytes).toMatchObject({
			content: "gamma",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			lastLinePartial: false,
		});
	});

	it("returns untruncated tail results for empty or in-limit content", () => {
		expect(truncateTail("", { maxLines: 10, maxBytes: 100 })).toMatchObject({
			content: "",
			truncated: false,
			totalLines: 0,
		});
		expect(truncateTail("only line\n", { maxLines: 10, maxBytes: 100 })).toMatchObject({
			content: "only line\n",
			truncated: false,
			totalLines: 1,
		});
	});

	it("keeps a partial tail of a single oversized line on a codepoint boundary", () => {
		// "é" is two UTF-8 bytes; the byte limit must not split it mid-codepoint.
		const line = `${"é".repeat(6)}`;
		const result = truncateTail(line, { maxLines: 10, maxBytes: 5 });
		expect(result.truncated).toBe(true);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(5);
		// Two "é" (4 bytes) fit under the 5-byte limit; a third would be 6.
		expect(result.content).toBe("éé");
	});

	it("truncates long single lines with a suffix", () => {
		expect(truncateLine("short", 10)).toEqual({ text: "short", wasTruncated: false });
		expect(truncateLine("0123456789abc", 10)).toEqual({ text: "0123456789... [truncated]", wasTruncated: true });
	});

	it("accumulates output with line-limited tail snapshots", () => {
		const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 1000 });
		acc.append(Buffer.from("one\ntwo\nthree\nfour\n"));
		acc.finish();
		const snapshot = acc.snapshot();
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.truncation.truncatedBy).toBe("lines");
		expect(snapshot.truncation.totalLines).toBe(4);
		expect(snapshot.content).toBe("three\nfour");
	});

	it("accumulates output with byte-limited tail snapshots", () => {
		const acc = new OutputAccumulator({ maxLines: 1000, maxBytes: 6 });
		acc.append(Buffer.from("alpha\nbeta\ngamma\n"));
		acc.finish();
		const snapshot = acc.snapshot();
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.truncation.truncatedBy).toBe("bytes");
		expect(Buffer.byteLength(snapshot.content, "utf-8")).toBeLessThanOrEqual(6);
		expect(snapshot.content).toBe("gamma");
	});

	it("decodes multi-byte UTF-8 characters split across chunks", () => {
		const acc = new OutputAccumulator();
		const euro = Buffer.from("€", "utf-8"); // 0xE2 0x82 0xAC
		acc.append(Buffer.concat([Buffer.from("price "), euro.subarray(0, 1)]));
		acc.append(Buffer.concat([euro.subarray(1), Buffer.from("5")]));
		acc.finish();
		expect(acc.snapshot().content).toBe("price €5");
	});

	it("throws when appending after finish", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("data"));
		acc.finish();
		expect(() => acc.append(Buffer.from("more"))).toThrow("Cannot append to a finished output accumulator");
	});

	it("degrades to the in-memory tail when the temp file cannot be opened", async () => {
		const acc = new OutputAccumulator({ maxLines: 1, maxBytes: 1000, tempFilePrefix: "no-such-dir/widi-output" });
		acc.append(Buffer.from("first line is long\n"));
		acc.append(Buffer.from("second line is also long\n"));
		acc.finish();

		// The open failure surfaces as a stream 'error' on a later tick; an
		// unlistened one would take the whole process down.
		while (!acc.getTempFileError()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const snapshot = acc.snapshot({ persistIfTruncated: true });
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.content).toBe("second line is also long");
		await expect(acc.closeTempFile()).resolves.toBeUndefined();
	});

	it("spills the full raw output to a temp file without loss", async () => {
		const acc = new OutputAccumulator({ maxLines: 1, maxBytes: 8 });
		const chunk1 = Buffer.from("first line is long\n");
		const chunk2 = Buffer.from("second line is also long\n");
		acc.append(chunk1);
		acc.append(chunk2);
		acc.finish();
		const snapshot = acc.snapshot({ persistIfTruncated: true });
		expect(snapshot.fullOutputPath).toBeDefined();
		if (snapshot.fullOutputPath) {
			tempRoots.push(snapshot.fullOutputPath);
			await acc.closeTempFile();
			const persisted = await readFile(snapshot.fullOutputPath);
			expect(persisted).toEqual(Buffer.concat([chunk1, chunk2]));
		}
	});
});
