import { describe, expect, it } from "vitest";
import { createTuiApplicationState, setActiveAgent } from "../../../src/tui/state.ts";
import { theme } from "../../../src/tui/theme/theme.ts";
import { StatusView } from "../../../src/tui/views/status.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("StatusView", () => {
	it("shows only panel-region statuses in the status view, with icon and tone", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "idle";
		main.extensionStatuses.set("indexer build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Building index", region: "panel", icon: "◆", tone: "success" },
			updatedAt: timestamp(4),
		});
		// No region: the default is "panel".
		main.extensionStatuses.set("linter scan", {
			agentId: "main",
			extensionId: "linter",
			key: "scan",
			status: { text: "Scanning sources" },
			updatedAt: timestamp(5),
		});
		main.extensionStatuses.set("watcher files", {
			agentId: "main",
			extensionId: "watcher",
			key: "files",
			status: { text: "Watching files", region: "footer" },
			updatedAt: timestamp(6),
		});

		const raw = new StatusView(state).render(80).join("\n");
		const output = raw.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("◆");
		expect(output).toContain("Building index");
		expect(output).toContain("Scanning sources");
		expect(output).not.toContain("Watching files");
		expect(raw).toContain(theme.ok("x").split("x")[0]);
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
