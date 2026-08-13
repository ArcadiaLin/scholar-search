const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie)/i;

/** Braille spinner frames shared by every animated indicator in the TUI. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

/** Spinner frame for a point in time; advances every 160ms. */
export function spinnerFrame(now: number = Date.now()): string {
	return SPINNER_FRAMES[Math.floor(now / 160) % SPINNER_FRAMES.length] ?? "⠋";
}

export interface FormatUnknownOptions {
	readonly maxDepth?: number;
	readonly maxLines?: number;
	readonly maxCharacters?: number;
}

export function singleLine(text: string, maxCharacters = 240): string {
	const folded = sanitizeTerminalText(text)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return truncateCharacters(folded, maxCharacters);
}

/** Relative age for status/processing displays: seconds under a minute, whole minutes above. */
export function formatRelativeAge(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m`;
}

/**
 * How long something took, to the second. Unlike formatRelativeAge this keeps
 * the smaller unit: a run reported as "1m" would look frozen for the minute it
 * takes to reach "2m", which is the opposite of what a live duration is for.
 */
export function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function boundedText(text: string, options: { maxLines?: number; maxCharacters?: number } = {}): string {
	const maxLines = options.maxLines ?? 16;
	const maxCharacters = options.maxCharacters ?? 4_000;
	const boundedCharacters = truncateCharacters(sanitizeTerminalText(text), maxCharacters);
	const lines = boundedCharacters.split("\n");
	if (lines.length <= maxLines) return boundedCharacters;
	return `${lines.slice(0, maxLines).join("\n")}\n… [truncated]`;
}

export function sanitizeTerminalText(text: string): string {
	const escapeCharacter = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	const oscSequence = new RegExp(`${escapeCharacter}\\][\\s\\S]*?(?:${bell}|${escapeCharacter}\\\\)`, "g");
	const csiSequence = new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g");
	const stripped = text.replace(oscSequence, "").replace(csiSequence, "").replace(/\r\n?/g, "\n");
	return [...stripped]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || code > 159 || (code >= 32 && code < 127);
		})
		.join("");
}

export function formatUnknown(value: unknown, options: FormatUnknownOptions = {}): string {
	const maxDepth = options.maxDepth ?? 4;
	const maxLines = options.maxLines ?? 16;
	const maxCharacters = options.maxCharacters ?? 4_000;
	const seen = new WeakSet<object>();

	const normalize = (input: unknown, depth: number, key?: string): unknown => {
		if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
		if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
			return input;
		}
		if (typeof input === "undefined") return "[undefined]";
		if (typeof input === "bigint") return `${input}n`;
		if (typeof input === "symbol" || typeof input === "function") {
			return `[${typeof input}]`;
		}
		if (depth >= maxDepth) return "[…]";
		if (seen.has(input)) return "[circular]";
		seen.add(input);
		if (Array.isArray(input)) {
			return input.slice(0, 50).map((entry) => normalize(entry, depth + 1));
		}
		const output: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(input).slice(0, 80)) {
			output[entryKey] = normalize(entryValue, depth + 1, entryKey);
		}
		return output;
	};

	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(normalize(value, 0), null, 2);
		} catch {
			text = String(value);
		}
	}
	return boundedText(text, { maxLines, maxCharacters });
}

export function messageText(message: { readonly content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: "text"; text: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
}

export function assistantText(message: { readonly content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: "text"; text: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n\n");
}

export function thinkingText(message: { readonly content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "thinking" &&
				"thinking" in item &&
				typeof item.thinking === "string",
		)
		.map((item) => item.thinking)
		.join("\n");
}

function truncateCharacters(text: string, maxCharacters: number): string {
	const characters = [...text];
	if (characters.length <= maxCharacters) return text;
	return `${characters.slice(0, maxCharacters).join("")}…`;
}
