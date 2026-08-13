import { dirname } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	type CodingToolFileOperations,
	createLocalCodingToolFileOperations,
	isMissingPathError,
} from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write, relative to cwd or absolute." }),
	content: Type.String({ description: "Content to write to the file." }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	path: string;
	absolutePath: string;
	bytes: number;
	created: boolean;
}

export interface WriteToolOptions {
	operations?: Pick<CodingToolFileOperations, "access" | "mkdir" | "writeFile" | "realpath">;
}

export function createWriteToolDefinition(
	options: WriteToolOptions = {},
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const operations = options.operations ?? createLocalCodingToolFileOperations();

	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites; use edit for partial changes."],
		parameters: writeSchema,
		execute: async (_toolCallId, input, context) => {
			const absolutePath = resolveToCwd(input.path, context.workspace.cwd);
			return withFileMutationQueue(
				absolutePath,
				async () => {
					// Do not reject from an abort event listener here: that would release
					// the mutation queue while an in-flight filesystem operation may
					// still finish. Checking signal.aborted after each await observes
					// the same aborts while keeping the queue locked until the current
					// operation has settled.
					throwIfAborted(context.signal);
					const created = !(await pathExists(operations, absolutePath));
					throwIfAborted(context.signal);
					await operations.mkdir(dirname(absolutePath));
					throwIfAborted(context.signal);
					await operations.writeFile(absolutePath, input.content);
					throwIfAborted(context.signal);

					const bytes = Buffer.byteLength(input.content, "utf-8");
					return {
						content: [{ type: "text" as const, text: `Successfully wrote ${bytes} bytes to ${input.path}` }],
						details: { path: input.path, absolutePath, bytes, created },
					};
				},
				{ operations },
			);
		},
	};
}

async function pathExists(
	operations: Pick<CodingToolFileOperations, "access">,
	absolutePath: string,
): Promise<boolean> {
	try {
		await operations.access(absolutePath, "exists");
		return true;
	} catch (error) {
		if (isMissingPathError(error)) {
			return false;
		}
		throw error;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
