import { access as fsAccess, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_ENTRY_LIMIT = 500;

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of entries to return (default: ${DEFAULT_ENTRY_LIMIT})` }),
	),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
	path: string;
	absolutePath: string;
	entryLimitReached?: number;
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the ls tool. Override these to delegate directory
 * listing to sandboxes, SSH hosts, or remote environments.
 */
export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

export function createLocalLsOperations(): LsOperations {
	return {
		exists: async (absolutePath) => {
			try {
				await fsAccess(absolutePath);
				return true;
			} catch {
				return false;
			}
		},
		stat: (absolutePath) => fsStat(absolutePath),
		readdir: (absolutePath) => fsReaddir(absolutePath),
	};
}

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem. */
	operations?: LsOperations;
}

export function createLsToolDefinition(options: LsToolOptions = {}): ToolDefinition<typeof lsSchema, LsToolDetails> {
	const operations = options.operations ?? createLocalLsOperations();

	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_ENTRY_LIMIT} entries or ${formatSize(DEFAULT_MAX_BYTES)}, whichever is hit first.`,
		promptSnippet: "List directory contents",
		promptGuidelines: ["Use ls to browse a single directory level; use find for recursive path searches."],
		parameters: lsSchema,
		execute: async (_toolCallId, input, context) => {
			validateLsInput(input);
			const inputPath = input.path ?? ".";
			const absolutePath = resolveToCwd(inputPath, context.workspace.cwd);
			const entryLimit = input.limit ?? DEFAULT_ENTRY_LIMIT;
			throwIfAborted(context.signal);

			if (!(await operations.exists(absolutePath))) {
				throw new Error(`Path not found: ${absolutePath}`);
			}
			if (!(await operations.stat(absolutePath)).isDirectory()) {
				throw new Error(`Not a directory: ${absolutePath}`);
			}
			throwIfAborted(context.signal);

			let entries: string[];
			try {
				entries = [...(await operations.readdir(absolutePath))];
			} catch (error) {
				throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
			}
			entries.sort(compareEntryNames);

			const renderedEntries: string[] = [];
			let entryLimitReached = false;
			for (const entry of entries) {
				throwIfAborted(context.signal);
				if (renderedEntries.length >= entryLimit) {
					entryLimitReached = true;
					break;
				}
				let suffix = "";
				try {
					const entryStat = await operations.stat(join(absolutePath, entry));
					if (entryStat.isDirectory()) suffix = "/";
				} catch {
					// Skip entries we cannot stat instead of failing the listing.
					continue;
				}
				renderedEntries.push(entry + suffix);
			}

			const details: LsToolDetails = { path: inputPath, absolutePath };
			if (renderedEntries.length === 0) {
				return { content: [{ type: "text", text: "(empty directory)" }], details };
			}

			// Entry count is already capped, so only the byte limit applies here.
			const truncation = truncateHead(renderedEntries.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const notices: string[] = [];
			if (entryLimitReached) {
				notices.push(`${entryLimit} entries limit reached. Use limit=${entryLimit * 2} for more`);
				details.entryLimitReached = entryLimit;
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

/**
 * Case-insensitive alphabetical order with a codepoint tie-break, so listings
 * are deterministic across platforms and locales.
 */
function compareEntryNames(left: string, right: string): number {
	const leftLower = left.toLowerCase();
	const rightLower = right.toLowerCase();
	if (leftLower < rightLower) return -1;
	if (leftLower > rightLower) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function validateLsInput(input: LsToolInput): void {
	if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
		throw new Error("Ls tool input is invalid. limit must be a positive integer.");
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
