import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { type CodingToolFileOperations, createLocalCodingToolFileOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit, relative to cwd or absolute." }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
	path: string;
	absolutePath: string;
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export interface EditToolOptions {
	operations?: Pick<CodingToolFileOperations, "access" | "readFile" | "writeFile" | "realpath">;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	options: EditToolOptions = {},
): ToolDefinition<typeof editSchema, EditToolDetails> {
	const operations = options.operations ?? createLocalCodingToolFileOperations();

	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		execute: async (_toolCallId, input, context) => {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, context.workspace.cwd);

			return withFileMutationQueue(
				absolutePath,
				async () => {
					// Do not reject from an abort event listener here: that would release
					// the mutation queue while an in-flight filesystem operation may
					// still finish. Checking signal.aborted after each await observes
					// the same aborts while keeping the queue locked until the current
					// operation has settled.
					throwIfAborted(context.signal);

					try {
						await operations.access(absolutePath, "readwrite");
					} catch (error: unknown) {
						throwIfAborted(context.signal);
						const errorMessage =
							error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
						throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
					}
					throwIfAborted(context.signal);

					const buffer = await operations.readFile(absolutePath);
					const rawContent = buffer.toString("utf-8");
					throwIfAborted(context.signal);

					// Strip BOM before matching. The model will not include an invisible
					// BOM in oldText.
					const { bom, text: content } = stripBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					throwIfAborted(context.signal);

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await operations.writeFile(absolutePath, finalContent);
					throwIfAborted(context.signal);

					const diffResult = generateDiffString(baseContent, newContent);
					const patch = generateUnifiedPatch(path, baseContent, newContent);
					return {
						content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
						details: {
							path,
							absolutePath,
							diff: diffResult.diff,
							patch,
							firstChangedLine: diffResult.firstChangedLine,
						},
					};
				},
				{ operations },
			);
		},
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
