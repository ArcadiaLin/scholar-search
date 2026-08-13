import { describe, expect, it } from "vitest";
import { boundedText, sanitizeTerminalText, singleLine } from "../../src/tui/format.ts";

describe("terminal text sanitizing", () => {
	it("removes terminal control sequences from externally supplied text", () => {
		const malicious = "safe\u001b[2J text\u001b]0;owned\u0007\nnext\u0000line";

		expect(sanitizeTerminalText(malicious)).toBe("safe text\nnextline");
		expect(singleLine(malicious)).toBe("safe text nextline");
		expect(boundedText(malicious)).toBe("safe text\nnextline");
	});
});
