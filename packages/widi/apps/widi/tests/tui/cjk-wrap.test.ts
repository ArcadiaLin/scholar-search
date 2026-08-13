import { describe, expect, it } from "vitest";
import { fixCjkLineStarts } from "../../src/tui/cjk-wrap.ts";

const ESCAPE = String.fromCharCode(27);
const DIM = `${ESCAPE}[2m`;
const DIM_OFF = `${ESCAPE}[22m`;

describe("fixCjkLineStarts", () => {
	it("pushes the previous line's last CJK grapheme down before orphan punctuation", () => {
		const lines = ["文字文字", "。下文"];

		expect(fixCjkLineStarts(lines, 8)).toEqual(["文字文  ", "字。下文"]);
	});

	it("keeps ANSI styling on both lines when moving a grapheme", () => {
		const lines = [`${DIM}文字文字${DIM_OFF}`, `${DIM}。下文${DIM_OFF}`];

		const fixed = fixCjkLineStarts(lines, 8);

		expect(fixed[0]).toBe(`${DIM}文字文${DIM_OFF}  `);
		expect(fixed[1]).toBe(`${DIM}字。下文${DIM_OFF}`);
	});

	it("pulls narrow punctuation up when the previous line has room", () => {
		const lines = ["文字文", "…续行"];

		expect(fixCjkLineStarts(lines, 8)).toEqual(["文字文… ", "续行    "]);
	});

	it("leaves lines unchanged when neither line has room", () => {
		const lines = ["文字文字", "。下文字"];

		expect(fixCjkLineStarts(lines, 8)).toEqual(["文字文字", "。下文字"]);
	});

	it("does not move graphemes across blank line boundaries", () => {
		const lines = ["文字文字", "", "。下文"];

		expect(fixCjkLineStarts(lines, 8)).toEqual(["文字文字", "", "。下文"]);
	});

	it("ignores lines whose previous line ends with narrow text", () => {
		const lines = ["ascii tail", "。下文"];

		expect(fixCjkLineStarts(lines, 12)).toEqual(["ascii tail", "。下文"]);
	});

	it("respects leading indentation on the continuation line", () => {
		const lines = [" 文字文字", " 。下文"];

		expect(fixCjkLineStarts(lines, 9)).toEqual([" 文字文  ", " 字。下文"]);
	});
});
