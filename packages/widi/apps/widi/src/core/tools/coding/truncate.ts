export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		outputLines.push(line);
		outputBytes += lineBytes;
	}

	if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLines.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 *
 * Suitable for command output where the end matters most (errors, final
 * results). May return a partial first line when the last line of the original
 * content on its own exceeds the byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// No line has fit yet and this one alone exceeds the limit: keep its tail.
			if (outputLines.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLines.unshift(truncatedLine);
				outputBytes = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}
		outputLines.unshift(line);
		outputBytes += lineBytes;
	}

	if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLines.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a single line to a maximum character count, appending a
 * `... [truncated]` suffix when it is shortened. Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

/**
 * Truncate a string to fit within a byte limit, keeping the end. Advances past
 * UTF-8 continuation bytes so the slice starts on a codepoint boundary.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}
	return buf.subarray(start).toString("utf-8");
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}
