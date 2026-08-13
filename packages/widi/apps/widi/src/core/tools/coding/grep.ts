import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { createLocalRgRunner, type RgRunner } from "./ripgrep.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const DEFAULT_MATCH_LIMIT = 100;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_MATCH_LIMIT})` }),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	path: string;
	absolutePath: string;
	matchLimitReached?: number;
	truncation?: TruncationResult;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool. Override these to delegate search to
 * sandboxes, SSH hosts, or remote environments.
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if the path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines. */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** Run ripgrep and stream its stdout lines. */
	runRg: RgRunner;
}

export function createLocalGrepOperations(options?: { rgPath?: string }): GrepOperations {
	return {
		isDirectory: async (absolutePath) => (await fsStat(absolutePath)).isDirectory(),
		readFile: (absolutePath) => fsReadFile(absolutePath, "utf-8"),
		runRg: createLocalRgRunner(options?.rgPath),
	};
}

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep. */
	operations?: GrepOperations;
	/** Optional explicit ripgrep executable path from settings. */
	rgPath?: string;
}

interface RgMatch {
	filePath: string;
	lineNumber: number;
	lineText: string | undefined;
}

export function createGrepToolDefinition(
	options: GrepToolOptions = {},
): ToolDefinition<typeof grepSchema, GrepToolDetails> {
	const operations = options.operations ?? createLocalGrepOperations({ rgPath: options.rgPath });

	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_MATCH_LIMIT} matches or ${formatSize(DEFAULT_MAX_BYTES)}, whichever is hit first. Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		promptGuidelines: ["Use grep for content searches; use find for file path searches."],
		parameters: grepSchema,
		execute: async (_toolCallId, input, context) => {
			validateGrepInput(input);
			const inputPath = input.path ?? ".";
			const searchPath = resolveToCwd(inputPath, context.workspace.cwd);
			const contextLines = input.context ?? 0;
			const matchLimit = input.limit ?? DEFAULT_MATCH_LIMIT;
			throwIfAborted(context.signal);

			let searchingDirectory: boolean;
			try {
				searchingDirectory = await operations.isDirectory(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const args = ["--json", "--line-number", "--color=never", "--hidden"];
			if (input.ignoreCase) args.push("--ignore-case");
			if (input.literal) args.push("--fixed-strings");
			if (input.glob) args.push("--glob", input.glob);
			// `--` keeps flag-like patterns from being parsed as rg options.
			args.push("--", input.pattern, searchPath);

			const matches: RgMatch[] = [];
			let matchLimitReached = false;
			const runResult = await operations.runRg(args, {
				signal: context.signal,
				onLine: (line, stop) => {
					const match = parseRgMatchEvent(line);
					if (!match) return;
					matches.push(match);
					if (matches.length >= matchLimit) {
						matchLimitReached = true;
						stop();
					}
				},
			});
			// rg exits 0 on matches and 1 on no matches; anything else is an
			// execution error unless we killed rg at the match limit.
			if (!runResult.stoppedEarly && runResult.exitCode !== 0 && runResult.exitCode !== 1) {
				throw new Error(runResult.stderr.trim() || `ripgrep exited with code ${runResult.exitCode}`);
			}

			const details: GrepToolDetails = { path: inputPath, absolutePath: searchPath };
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details };
			}

			const formatPath = (filePath: string): string => {
				if (searchingDirectory) {
					const relativePath = relative(searchPath, filePath);
					if (relativePath && !relativePath.startsWith("..")) {
						return relativePath.split(sep).join("/");
					}
				}
				return basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = await operations.readFile(filePath);
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			let linesTruncated = false;
			const outputLines: string[] = [];
			for (const match of matches) {
				throwIfAborted(context.signal);
				if (contextLines === 0 && match.lineText !== undefined) {
					const relativePath = formatPath(match.filePath);
					const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
					const { text, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
					continue;
				}

				const relativePath = formatPath(match.filePath);
				const lines = await getFileLines(match.filePath);
				if (lines.length === 0) {
					outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
					continue;
				}
				const start = Math.max(1, match.lineNumber - contextLines);
				const end = Math.min(lines.length, match.lineNumber + contextLines);
				for (let current = start; current <= end; current++) {
					const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
					const { text, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) linesTruncated = true;
					if (current === match.lineNumber) {
						outputLines.push(`${relativePath}:${current}: ${text}`);
					} else {
						outputLines.push(`${relativePath}-${current}- ${text}`);
					}
				}
			}

			// The match limit already caps rows, so only the byte limit applies.
			const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(`${matchLimit} matches limit reached. Use limit=${matchLimit * 2} for more, or refine pattern`);
				details.matchLimitReached = matchLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},
	};
}

function parseRgMatchEvent(line: string): RgMatch | undefined {
	if (!line.trim()) return undefined;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as {
		type?: unknown;
		data?: { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } };
	};
	if (record.type !== "match") return undefined;
	const filePath = record.data?.path?.text;
	const lineNumber = record.data?.line_number;
	if (typeof filePath !== "string" || typeof lineNumber !== "number") {
		return undefined;
	}
	const lineText = record.data?.lines?.text;
	return { filePath, lineNumber, lineText: typeof lineText === "string" ? lineText : undefined };
}

function validateGrepInput(input: GrepToolInput): void {
	if (input.context !== undefined && (!Number.isInteger(input.context) || input.context < 0)) {
		throw new Error("Grep tool input is invalid. context must be a non-negative integer.");
	}
	if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
		throw new Error("Grep tool input is invalid. limit must be a positive integer.");
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
