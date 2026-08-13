import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { FatalErrorView } from "../../src/tui/fatal-error.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("FatalErrorView", () => {
	it("renders horizontal rules without side borders", () => {
		const view = new FatalErrorView({
			code: "orchestrator.startup_failed",
			message: "No usable agent.",
			onQuit: () => {},
			onViewDiagnostics: () => {},
		});

		const lines = view.render(60).map((line) => line.replace(ANSI_SEQUENCE, ""));
		const joined = lines.join("\n");

		expect(lines[0]).toMatch(/^─+$/u);
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines.some((line) => line.includes("│") || line.includes("┌") || line.includes("└"))).toBe(false);
		expect(joined).toContain("✕ WIDI cannot continue");
		expect(joined).toContain("orchestrator.startup_failed");
		expect(joined).toContain("Quit");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});
