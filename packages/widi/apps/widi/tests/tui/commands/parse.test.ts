import { describe, expect, it } from "vitest";
import { parseLineCommand, splitLeadingToken } from "../../../src/tui/commands/parse.ts";

describe("parseLineCommand", () => {
	it("parses a bare command without argument", () => {
		expect(parseLineCommand("/fork")).toEqual({ name: "fork", argument: "", hasArgument: false });
	});

	it("distinguishes explicit empty argument from no argument", () => {
		expect(parseLineCommand("/fork:")).toEqual({ name: "fork", argument: "", hasArgument: true });
	});

	it("parses name and argument", () => {
		expect(parseLineCommand("/model:openai/gpt-5")).toEqual({
			name: "model",
			argument: "openai/gpt-5",
			hasArgument: true,
		});
	});

	it("parses the space argument syntax", () => {
		expect(parseLineCommand("/model openai/gpt-5")).toEqual({
			name: "model",
			argument: "openai/gpt-5",
			hasArgument: true,
		});
	});

	it("skips the separating whitespace run in the space syntax", () => {
		expect(parseLineCommand("/model   openai/gpt-5")?.argument).toBe("openai/gpt-5");
	});

	it("keeps colon arguments verbatim, including spaces", () => {
		expect(parseLineCommand("/model:openai/gpt-5 latest")).toEqual({
			name: "model",
			argument: "openai/gpt-5 latest",
			hasArgument: true,
		});
	});

	it("uses whichever separator comes first", () => {
		expect(parseLineCommand("/name arg:withcolon")?.argument).toBe("arg:withcolon");
		expect(parseLineCommand("/name:arg with space")?.argument).toBe("arg with space");
	});

	it("parses unknown space-separated input as a command", () => {
		expect(parseLineCommand("/random words")).toEqual({ name: "random", argument: "words", hasArgument: true });
	});

	it("rejects non-command text and invalid names", () => {
		expect(parseLineCommand("hello")).toBeUndefined();
		expect(parseLineCommand("/")).toBeUndefined();
		expect(parseLineCommand("//x")).toBeUndefined();
	});

	it("ignores trailing whitespace", () => {
		expect(parseLineCommand("/status  ")?.name).toBe("status");
	});
});

describe("splitLeadingToken", () => {
	it("splits the name token from the remaining text", () => {
		expect(splitLeadingToken("review focus on locking")).toEqual({ token: "review", rest: "focus on locking" });
	});

	it("returns an empty remainder for a bare token", () => {
		expect(splitLeadingToken("review")).toEqual({ token: "review", rest: "" });
	});

	it("keeps the remainder verbatim apart from surrounding whitespace", () => {
		expect(splitLeadingToken('review  "quoted"  text ')).toEqual({ token: "review", rest: '"quoted"  text' });
	});
});
