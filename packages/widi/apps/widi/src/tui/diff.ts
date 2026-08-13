import { diffWords } from "diff";
import { theme } from "./theme/theme.ts";

/**
 * Render a display-oriented diff string (the `+123 content` format produced
 * by the edit tool's generateDiffString) into styled terminal lines: removed
 * lines red, added lines green, context lines dim. Single-line modifications
 * additionally get word-level inverse highlighting on the changed tokens.
 */
export function renderDiffText(diffText: string): string[] {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i] ?? "");
		if (!parsed) {
			result.push(theme.dim(lines[i] ?? ""));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removed: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const line = parseDiffLine(lines[i] ?? "");
				if (!line || line.prefix !== "-") break;
				removed.push(line);
				i++;
			}
			const added: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const line = parseDiffLine(lines[i] ?? "");
				if (!line || line.prefix !== "+") break;
				added.push(line);
				i++;
			}

			// Word-level highlighting only helps when exactly one line changed
			// into exactly one line; larger groups read better without it.
			if (removed.length === 1 && added.length === 1) {
				const [removedLine, addedLine] = [removed[0], added[0]];
				if (removedLine && addedLine) {
					const highlighted = renderIntraLineDiff(replaceTabs(removedLine.content), replaceTabs(addedLine.content));
					result.push(
						theme.error(`-${removedLine.lineNum} ${highlighted.removedLine}`),
						theme.ok(`+${addedLine.lineNum} ${highlighted.addedLine}`),
					);
				}
			} else {
				for (const line of removed) {
					result.push(theme.error(`-${line.lineNum} ${replaceTabs(line.content)}`));
				}
				for (const line of added) {
					result.push(theme.ok(`+${line.lineNum} ${replaceTabs(line.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(theme.ok(`+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			result.push(theme.dim(` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result;
}

interface ParsedDiffLine {
	prefix: string;
	lineNum: string;
	content: string;
}

function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1] ?? " ", lineNum: match[2] ?? "", content: match[3] ?? "" };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Word-level diff with inverse on changed tokens. Leading whitespace of the
 * first changed token stays unstyled so indentation is never highlighted.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leading = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leading.length);
				removedLine += leading;
				isFirstRemoved = false;
			}
			if (value) removedLine += theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leading = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leading.length);
				addedLine += leading;
				isFirstAdded = false;
			}
			if (value) addedLine += theme.inverse(value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}
