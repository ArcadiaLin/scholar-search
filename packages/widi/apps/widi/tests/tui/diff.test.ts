import { describe, expect, it } from "vitest";
import { renderDiffText } from "../../src/tui/diff.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const REMOVED = `${ESCAPE}[38;2;230;126;128m`;
const ADDED = `${ESCAPE}[38;2;131;192;146m`;
const DIM = `${ESCAPE}[2m`;
const INVERSE = `${ESCAPE}[7m`;

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, ""));
}

describe("renderDiffText", () => {
	it("colors removed, added, and context lines", () => {
		const diff = [" 1 unchanged", "-2 old line", "+2 new line"].join("\n");

		const lines = renderDiffText(diff);

		expect(lines[0]).toContain(DIM);
		expect(lines[1]).toContain(REMOVED);
		expect(lines[2]).toContain(ADDED);
		expect(plain(lines)).toEqual([" 1 unchanged", "-2 old line", "+2 new line"]);
	});

	it("highlights changed words inline for single-line modifications", () => {
		const diff = ["-3 const value = 1;", "+3 const value = 2;"].join("\n");

		const lines = renderDiffText(diff);

		expect(lines[0]).toContain(INVERSE);
		expect(lines[1]).toContain(INVERSE);
		expect(plain(lines)).toEqual(["-3 const value = 1;", "+3 const value = 2;"]);
	});

	it("skips intra-line highlighting for multi-line change groups", () => {
		const diff = ["-1 first old", "-2 second old", "+1 replacement"].join("\n");

		const lines = renderDiffText(diff);

		for (const line of lines) {
			expect(line).not.toContain(INVERSE);
		}
		expect(plain(lines)).toEqual(["-1 first old", "-2 second old", "+1 replacement"]);
	});

	it("replaces tabs with spaces", () => {
		const diff = "+1 \tindented";

		expect(plain(renderDiffText(diff))).toEqual(["+1    indented"]);
	});

	it("passes through unparseable lines dimmed", () => {
		const diff = "...";

		const lines = renderDiffText(diff);

		expect(lines[0]).toContain(DIM);
		expect(plain(lines)).toEqual(["..."]);
	});
});
