import { TextDecoder } from "node:util";
import { type Static, Type } from "typebox";
import { detectSupportedImageMimeType, IMAGE_MIME_SNIFF_BYTES } from "../../../utils/image/mime.ts";
import { type ImageProcessor, processImage } from "../../../utils/image/process-image.ts";
import type { ToolDefinition } from "../types.ts";
import { type CodingToolFileOperations, createLocalCodingToolFileOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read, relative to cwd or absolute." }),
	offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from. Text files only." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. Text files only." })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadImageDetails {
	/** MIME type detected from the file content. */
	originalMimeType: string;
	/** Final MIME type sent to the model. Absent when blocked or omitted. */
	mimeType?: string;
	converted: boolean;
	resized: boolean;
	originalWidth?: number;
	originalHeight?: number;
	width?: number;
	height?: number;
	/** True when images.blockImages suppressed the image data. */
	blocked?: boolean;
	/** Set when image processing failed and the image was omitted. */
	omittedReason?: string;
}

export interface ReadToolDetails {
	path: string;
	absolutePath: string;
	mediaKind: "text" | "image" | "binary";
	bytes: number;
	totalLines?: number;
	returnedLineRange?: { start: number; end: number };
	truncation?: TruncationResult;
	unsupported?: { reason: string };
	image?: ReadImageDetails;
}

/**
 * Pluggable image handling for the read tool. Override these to fake image
 * processing in tests or delegate detection to a remote backend.
 */
export interface ReadImageOperations {
	/**
	 * Detect the image MIME type, or return null for non-images. The default
	 * sniffs the leading bytes of the already-read buffer and never trusts
	 * file extensions.
	 */
	detectImageMimeType: (absolutePath: string, buffer: Buffer) => Promise<string | null> | string | null;
	/** Convert and resize image bytes for inline provider delivery. */
	processImage: ImageProcessor;
}

export function createLocalReadImageOperations(): ReadImageOperations {
	return {
		detectImageMimeType: (_absolutePath, buffer) =>
			detectSupportedImageMimeType(buffer.subarray(0, IMAGE_MIME_SNIFF_BYTES)),
		processImage,
	};
}

export interface ReadToolOptions {
	operations?: Pick<CodingToolFileOperations, "access" | "readFile">;
	imageOperations?: ReadImageOperations;
	maxLines?: number;
	maxBytes?: number;
	/** Default: true. Resize images to inline provider limits. */
	autoResizeImages?: boolean;
	/** Default: false. Return a text-only note instead of image data. */
	blockImages?: boolean;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function createReadToolDefinition(
	options: ReadToolOptions = {},
): ToolDefinition<typeof readSchema, ReadToolDetails> {
	const operations = options.operations ?? createLocalCodingToolFileOperations();
	const imageOperations = options.imageOperations ?? createLocalReadImageOperations();
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const autoResizeImages = options.autoResizeImages ?? true;
	const blockImages = options.blockImages ?? false;

	return {
		name: "read",
		label: "read",
		description: `Read a file. Supports UTF-8 text files and images (JPEG, PNG, GIF, WEBP, BMP). Images are returned as inline attachments; BMP is converted to PNG. Text output is truncated to ${maxLines} lines or ${formatSize(maxBytes)}, whichever is hit first; use offset and limit to read large text files in chunks. Other binary files are not supported.`,
		promptSnippet: "Read text file contents or an image",
		promptGuidelines: [
			"Use read instead of bash cat or sed to inspect files.",
			"Use offset and limit when a file is large or the result says more lines remain.",
		],
		parameters: readSchema,
		execute: async (_toolCallId, input, context) => {
			validateReadInput(input);
			const absolutePath = resolveToCwd(input.path, context.workspace.cwd);
			throwIfAborted(context.signal);
			await operations.access(absolutePath, "read");
			throwIfAborted(context.signal);
			const buffer = await operations.readFile(absolutePath);
			throwIfAborted(context.signal);

			const imageMimeType = await imageOperations.detectImageMimeType(absolutePath, buffer);
			throwIfAborted(context.signal);
			if (imageMimeType) {
				if (input.offset !== undefined || input.limit !== undefined) {
					throw new Error("Read tool input is invalid. offset and limit are not supported for image files.");
				}
				return await createImageReadResult({
					path: input.path,
					absolutePath,
					buffer,
					imageMimeType,
					imageOperations,
					autoResizeImages,
					blockImages,
				});
			}

			if (!isUtf8TextBuffer(buffer)) {
				return createUnsupportedResult({
					path: input.path,
					absolutePath,
					bytes: buffer.byteLength,
					reason: "Binary or non-UTF-8 files are not supported by the core read tool.",
				});
			}

			return createTextReadResult({
				path: input.path,
				absolutePath,
				textContent: buffer.toString("utf-8"),
				offset: input.offset,
				limit: input.limit,
				maxLines,
				maxBytes,
			});
		},
	};
}

function validateReadInput(input: ReadToolInput): void {
	if (input.offset !== undefined && (!Number.isFinite(input.offset) || input.offset < 1)) {
		throw new Error("Read tool input is invalid. offset must be a positive 1-indexed line number.");
	}
	if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) {
		throw new Error("Read tool input is invalid. limit must be a positive line count.");
	}
}

async function createImageReadResult(options: {
	path: string;
	absolutePath: string;
	buffer: Buffer;
	imageMimeType: string;
	imageOperations: ReadImageOperations;
	autoResizeImages: boolean;
	blockImages: boolean;
}) {
	const baseDetails: ReadToolDetails = {
		path: options.path,
		absolutePath: options.absolutePath,
		mediaKind: "image",
		bytes: options.buffer.byteLength,
	};

	if (options.blockImages) {
		// No base64 payload is generated at all, so blocked images do not
		// inflate the session transcript.
		return {
			content: [
				{
					type: "text" as const,
					text: `Read image file [${options.imageMimeType}]\n[Image blocked: the images.blockImages setting prevents sending images to model providers.]`,
				},
			],
			details: {
				...baseDetails,
				image: { originalMimeType: options.imageMimeType, converted: false, resized: false, blocked: true },
			},
		};
	}

	const processed = await options.imageOperations.processImage(options.buffer, options.imageMimeType, {
		autoResize: options.autoResizeImages,
	});

	if (!processed.ok) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Read image file [${options.imageMimeType}]\n[Image omitted: ${processed.reason}.]`,
				},
			],
			details: {
				...baseDetails,
				image: {
					originalMimeType: options.imageMimeType,
					converted: false,
					resized: false,
					omittedReason: processed.reason,
				},
			},
		};
	}

	const noteLines = [`Read image file [${processed.mimeType}]`];
	if (processed.convertedFrom) {
		noteLines.push(`[Image converted from ${processed.convertedFrom} to ${processed.mimeType}.]`);
	}
	const dimensions = processed.dimensions;
	if (dimensions?.wasResized) {
		const scale = dimensions.originalWidth / dimensions.width;
		noteLines.push(
			`[Image: original ${dimensions.originalWidth}x${dimensions.originalHeight}, displayed at ${dimensions.width}x${dimensions.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
		);
	}

	return {
		content: [
			{ type: "text" as const, text: noteLines.join("\n") },
			{ type: "image" as const, data: processed.data, mimeType: processed.mimeType },
		],
		details: {
			...baseDetails,
			image: {
				originalMimeType: options.imageMimeType,
				mimeType: processed.mimeType,
				converted: processed.convertedFrom !== undefined,
				resized: dimensions?.wasResized ?? false,
				originalWidth: dimensions?.originalWidth,
				originalHeight: dimensions?.originalHeight,
				width: dimensions?.width,
				height: dimensions?.height,
			},
		},
	};
}

function createUnsupportedResult(options: { path: string; absolutePath: string; bytes: number; reason: string }) {
	return {
		content: [{ type: "text" as const, text: `Cannot read ${options.path}: ${options.reason}` }],
		details: {
			path: options.path,
			absolutePath: options.absolutePath,
			mediaKind: "binary" as const,
			bytes: options.bytes,
			unsupported: { reason: options.reason },
		},
	};
}

function createTextReadResult(options: {
	path: string;
	absolutePath: string;
	textContent: string;
	offset: number | undefined;
	limit: number | undefined;
	maxLines: number;
	maxBytes: number;
}) {
	const allLines = options.textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLineIndex = options.offset === undefined ? 0 : options.offset - 1;
	const startLineDisplay = startLineIndex + 1;
	if (startLineIndex >= totalFileLines) {
		throw new Error(`Offset ${options.offset} is beyond end of file (${totalFileLines} lines total).`);
	}

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (options.limit !== undefined) {
		const endLineIndex = Math.min(startLineIndex + options.limit, totalFileLines);
		selectedContent = allLines.slice(startLineIndex, endLineIndex).join("\n");
		userLimitedLines = endLineIndex - startLineIndex;
	} else {
		selectedContent = allLines.slice(startLineIndex).join("\n");
	}

	const truncation = truncateHead(selectedContent, { maxLines: options.maxLines, maxBytes: options.maxBytes });
	const content = formatReadContent({
		path: options.path,
		allLines,
		startLineIndex,
		startLineDisplay,
		userLimitedLines,
		truncation,
	});
	const endLine = truncation.outputLines > 0 ? startLineDisplay + truncation.outputLines - 1 : startLineDisplay;

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			path: options.path,
			absolutePath: options.absolutePath,
			mediaKind: "text" as const,
			bytes: Buffer.byteLength(options.textContent, "utf-8"),
			totalLines: totalFileLines,
			returnedLineRange: { start: startLineDisplay, end: endLine },
			truncation: truncation.truncated ? truncation : undefined,
		},
	};
}

function formatReadContent(options: {
	path: string;
	allLines: string[];
	startLineIndex: number;
	startLineDisplay: number;
	userLimitedLines: number | undefined;
	truncation: TruncationResult;
}): string {
	if (options.truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(options.allLines[options.startLineIndex], "utf-8"));
		return `[Line ${options.startLineDisplay} in ${options.path} is ${firstLineSize}, exceeding the ${formatSize(options.truncation.maxBytes)} read limit. The core read tool does not return partial lines.]`;
	}

	let outputText = options.truncation.content;
	if (options.truncation.truncated) {
		const endLineDisplay = options.startLineDisplay + options.truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		if (options.truncation.truncatedBy === "lines") {
			return `${outputText}\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.allLines.length}. Use offset=${nextOffset} to continue.]`;
		}
		return `${outputText}\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.allLines.length} (${formatSize(options.truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
	}

	if (
		options.userLimitedLines !== undefined &&
		options.startLineIndex + options.userLimitedLines < options.allLines.length
	) {
		const remaining = options.allLines.length - (options.startLineIndex + options.userLimitedLines);
		const nextOffset = options.startLineIndex + options.userLimitedLines + 1;
		outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}

	return outputText;
}

function isUtf8TextBuffer(buffer: Buffer): boolean {
	if (buffer.includes(0)) {
		return false;
	}
	try {
		utf8Decoder.decode(buffer);
		return true;
	} catch {
		return false;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
