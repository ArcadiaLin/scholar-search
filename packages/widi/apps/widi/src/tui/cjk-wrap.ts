import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Characters that must not start a rendered line (CJK line-start kinsoku).
 * Limited to full-width punctuation so code and ASCII prose never match.
 */
const PROHIBITED_LINE_START = new Set([..."，。！？；：、）》〉】〕」』…‥·—―～"]);

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const LEADING_PREFIX = new RegExp(`^(?:${ESCAPE}\\[[0-9;]*m| )*`);
const TRAILING_ANSI = new RegExp(`(?:${ESCAPE}\\[[0-9;]*m)+$`);
const graphemes = new Intl.Segmenter();

/**
 * Limited CJK kinsoku correction over already wrapped, possibly ANSI-styled
 * lines. When a line starts with prohibited punctuation and the previous line
 * ends with a wide CJK grapheme, the punctuation is pulled up if it fits,
 * otherwise the previous line's last grapheme is pushed down if that fits.
 * Lines that cannot be fixed without cascading reflow are left unchanged.
 */
export function fixCjkLineStarts(lines: string[], width: number): string[] {
	const result = [...lines];
	for (let index = 1; index < result.length; index++) {
		const current = result[index] ?? "";
		const previous = (result[index - 1] ?? "").trimEnd();
		if (!previous) continue;

		const prefix = LEADING_PREFIX.exec(current)?.[0] ?? "";
		const rest = current.slice(prefix.length).trimEnd();
		const punctuation = firstGrapheme(rest);
		if (!punctuation || !PROHIBITED_LINE_START.has(punctuation)) continue;

		const { body, suffix } = splitTrailingAnsi(previous);
		const tail = lastGrapheme(body);
		if (!tail || visibleWidth(tail) < 2 || !isCjkText(tail) || PROHIBITED_LINE_START.has(tail)) {
			continue;
		}

		if (visibleWidth(previous) + visibleWidth(punctuation) <= width) {
			const remainder = rest.slice(punctuation.length);
			if (!stripAnsi(remainder).trim()) continue;
			result[index - 1] = pad(body + punctuation + suffix, width);
			result[index] = pad(prefix + remainder, width);
		} else if (visibleWidth(prefix + rest) + visibleWidth(tail) <= width) {
			result[index - 1] = pad(body.slice(0, body.length - tail.length) + suffix, width);
			result[index] = pad(prefix + tail + rest, width);
		}
	}
	return result;
}

function firstGrapheme(text: string): string | undefined {
	for (const { segment } of graphemes.segment(text)) return segment;
	return undefined;
}

function lastGrapheme(text: string): string | undefined {
	const parts = text.split(ANSI_SEQUENCE);
	const plainTail = parts[parts.length - 1] ?? "";
	let last: string | undefined;
	for (const { segment } of graphemes.segment(plainTail)) last = segment;
	return last;
}

function splitTrailingAnsi(line: string): { body: string; suffix: string } {
	const match = TRAILING_ANSI.exec(line);
	if (!match) return { body: line, suffix: "" };
	return { body: line.slice(0, match.index), suffix: match[0] };
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}

function isCjkText(grapheme: string): boolean {
	return /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u.test(
		grapheme,
	);
}

function pad(line: string, width: number): string {
	const missing = width - visibleWidth(line);
	return missing > 0 ? line + " ".repeat(missing) : line;
}
