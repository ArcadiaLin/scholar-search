import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import { compileFindPattern } from "./glob-match.ts";
import { resolveToCwd } from "./path-utils.ts";
import { createLocalRgRunner, type RgRunner } from "./ripgrep.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_RESULT_LIMIT = 1000;

const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum number of results (default: ${DEFAULT_RESULT_LIMIT})` })),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	path: string;
	absolutePath: string;
	resultLimitReached?: number;
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the find tool. Override these to delegate file
 * search to sandboxes, SSH hosts, or remote environments.
 */
export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Run ripgrep and stream its stdout lines. */
	runRg: RgRunner;
}

export function createLocalFindOperations(options?: { rgPath?: string }): FindOperations {
	return {
		exists: async (absolutePath) => {
			try {
				await fsAccess(absolutePath);
				return true;
			} catch {
				return false;
			}
		},
		isDirectory: async (absolutePath) => (await fsStat(absolutePath)).isDirectory(),
		runRg: createLocalRgRunner(options?.rgPath),
	};
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus ripgrep. */
	operations?: FindOperations;
	/** Optional explicit ripgrep executable path from settings. */
	rgPath?: string;
}

export function createFindToolDefinition(
	options: FindToolOptions = {},
): ToolDefinition<typeof findSchema, FindToolDetails> {
	const operations = options.operations ?? createLocalFindOperations({ rgPath: options.rgPath });

	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. A pattern without '/' matches file names at any depth; a pattern with '/' matches paths relative to the search directory. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_RESULT_LIMIT} results or ${formatSize(DEFAULT_MAX_BYTES)}, whichever is hit first.`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		promptGuidelines: ["Use find to locate files by name or path pattern; use grep for content searches."],
		parameters: findSchema,
		execute: async (_toolCallId, input, context) => {
			validateFindInput(input);
			const inputPath = input.path ?? ".";
			const searchPath = resolveToCwd(inputPath, context.workspace.cwd);
			const resultLimit = input.limit ?? DEFAULT_RESULT_LIMIT;
			// WIDI matches the pattern itself: a positive `rg --glob` overrides
			// ignore rules and would resurface gitignored files.
			const matchesPattern = compileFindPattern(input.pattern);
			throwIfAborted(context.signal);

			if (!(await operations.exists(searchPath))) {
				throw new Error(`Path not found: ${searchPath}`);
			}
			if (!(await operations.isDirectory(searchPath))) {
				throw new Error(`Not a directory: ${searchPath}`);
			}

			const args = [
				"--files",
				"--hidden",
				// Deterministic output order; an early stop at the result limit
				// then yields a deterministic prefix.
				"--sort",
				"path",
				"--glob",
				"!.git",
				"--glob",
				"!node_modules",
			];
			// Inside a repository rg's git-aware defaults stop parent .gitignore
			// rules at nested repository boundaries. --no-require-git would apply
			// them across boundaries, so only pass it outside repositories, where
			// it is required for .gitignore files to be honored at all.
			if (!(await isInsideGitRepository(searchPath, operations))) {
				args.push("--no-require-git");
			}
			args.push("--", searchPath);

			const results: string[] = [];
			let resultLimitReached = false;
			const runResult = await operations.runRg(args, {
				signal: context.signal,
				onLine: (line, stop) => {
					const cleaned = line.replace(/\r$/, "");
					if (!cleaned) return;
					const relativePath = relative(searchPath, cleaned).split(sep).join("/");
					if (!relativePath || relativePath.startsWith("..")) return;
					if (!matchesPattern(relativePath)) return;
					results.push(relativePath);
					if (results.length >= resultLimit) {
						resultLimitReached = true;
						stop();
					}
				},
			});
			// rg --files exits 0 when it lists files and 1 when nothing is listed;
			// anything else is an execution error unless we stopped rg early.
			if (!runResult.stoppedEarly && runResult.exitCode !== 0 && runResult.exitCode !== 1) {
				throw new Error(runResult.stderr.trim() || `ripgrep exited with code ${runResult.exitCode}`);
			}

			const details: FindToolDetails = { path: inputPath, absolutePath: searchPath };
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No files found matching pattern" }], details };
			}

			// The result limit already caps rows, so only the byte limit applies.
			const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const notices: string[] = [];
			if (resultLimitReached) {
				notices.push(`${resultLimit} results limit reached. Use limit=${resultLimit * 2} for more, or refine pattern`);
				details.resultLimitReached = resultLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},
	};
}

async function isInsideGitRepository(searchPath: string, operations: Pick<FindOperations, "exists">): Promise<boolean> {
	for (let current = searchPath; ; ) {
		if (await operations.exists(join(current, ".git"))) {
			return true;
		}
		const parent = dirname(current);
		if (parent === current) {
			return false;
		}
		current = parent;
	}
}

function validateFindInput(input: FindToolInput): void {
	if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
		throw new Error("Find tool input is invalid. limit must be a positive integer.");
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
