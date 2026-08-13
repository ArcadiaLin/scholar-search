import { describe, expect, it } from "vitest";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
import {
	DiagnosticsLog,
	diagnosticSource,
	formatDiagnosticRecord,
	MAX_DIAGNOSTIC_RECORDS,
} from "../../src/tui/diagnostics-log.ts";
import { EventProjector } from "../../src/tui/event-projector.ts";
import { createTuiApplicationState } from "../../src/tui/state.ts";

const NOW = "2026-08-09T10:00:00.000Z";
const LATER = "2026-08-09T10:05:00.000Z";

function warning(code: string, message = code): OrchestratorDiagnostic {
	return { severity: "warning", code, message };
}

describe("DiagnosticsLog", () => {
	it("keeps what the phase was when the diagnostic arrived", () => {
		const log = new DiagnosticsLog();
		log.record(warning("theme.unreadable"), NOW);
		log.phase = "runtime";
		log.record(warning("mcp.connect_failed"), LATER);

		expect(log.list().map((record) => [record.id, record.phase])).toEqual([
			["d2", "runtime"],
			["d1", "startup"],
		]);
	});

	it("collapses a repeat onto the first record instead of appending", () => {
		const log = new DiagnosticsLog();
		const first = log.record(warning("mcp.connect_failed", "docs server"), NOW);
		const second = log.record(warning("mcp.connect_failed", "docs server"), LATER);

		expect(second).toBe(first);
		expect(log.list()).toHaveLength(1);
		expect(first.count).toBe(2);
		expect(first.firstSeenAt).toBe(NOW);
		expect(first.lastSeenAt).toBe(LATER);
	});

	it("keeps same-code reports about different subjects apart", () => {
		const log = new DiagnosticsLog();
		log.record(warning("mcp.connect_failed", "docs server"), NOW);
		log.record(warning("mcp.connect_failed", "search server"), NOW);

		expect(log.list()).toHaveLength(2);
	});

	it("evicts the oldest past the cap and stops answering for it", () => {
		const log = new DiagnosticsLog();
		for (let i = 0; i < MAX_DIAGNOSTIC_RECORDS + 2; i++) log.record(warning("mcp.connect_failed", `server ${i}`), NOW);

		expect(log.list()).toHaveLength(MAX_DIAGNOSTIC_RECORDS);
		expect(log.get("d1")).toBeUndefined();
		expect(log.get("d3")?.diagnostic.message).toBe("server 2");
	});

	it("re-records an evicted diagnostic as a new entry", () => {
		const log = new DiagnosticsLog();
		for (let i = 0; i < MAX_DIAGNOSTIC_RECORDS + 1; i++) log.record(warning("mcp.connect_failed", `server ${i}`), NOW);
		const reported = log.record(warning("mcp.connect_failed", "server 0"), LATER);

		expect(reported.id).toBe(`d${MAX_DIAGNOSTIC_RECORDS + 2}`);
		expect(reported.count).toBe(1);
	});
});

describe("diagnosticSource", () => {
	it("names the extension first, then the agent, then the code namespace", () => {
		expect(diagnosticSource({ ...warning("mcp.connect_failed"), extensionId: "mcp", agentId: "agent-1" })).toBe(
			"extension mcp",
		);
		expect(diagnosticSource({ ...warning("tool.failed"), agentId: "agent-1" })).toBe("agent agent-1");
		expect(diagnosticSource(warning("keybindings.renamed_action"))).toBe("keybindings");
		expect(diagnosticSource(warning("standalone"))).toBe("standalone");
	});
});

describe("formatDiagnosticRecord", () => {
	it("carries everything the row abbreviated", () => {
		const log = new DiagnosticsLog();
		log.phase = "runtime";
		const record = log.record(
			{ severity: "error", code: "mcp.connect_failed", message: "docs server\nrefused", extensionId: "mcp" },
			NOW,
		);

		expect(formatDiagnosticRecord(record)).toBe(
			`error · mcp.connect_failed · extension mcp · runtime · ${NOW}\ndocs server\nrefused`,
		);
	});

	it("reports the repeat count and when the repeats started", () => {
		const log = new DiagnosticsLog();
		log.record(warning("theme.unreadable", "theme.json"), NOW);
		const record = log.record(warning("theme.unreadable", "theme.json"), LATER);

		expect(formatDiagnosticRecord(record)).toContain(`×2 since ${NOW}`);
	});
});

describe("the projector's diagnostic funnel", () => {
	it("records both agent-scoped and global diagnostics", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({ type: "diagnostic", diagnostic: warning("theme.unreadable"), createdAt: NOW });
		projector.apply({
			type: "diagnostic",
			diagnostic: { ...warning("tool.failed"), agentId: "agent-1" },
			createdAt: NOW,
		});

		expect(state.diagnostics.list().map((record) => record.diagnostic.code)).toEqual([
			"tool.failed",
			"theme.unreadable",
		]);
	});

	it("still records a global diagnostic whose notice was already posted", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({ type: "diagnostic", diagnostic: warning("theme.unreadable"), createdAt: NOW });
		projector.apply({ type: "diagnostic", diagnostic: warning("theme.unreadable"), createdAt: LATER });

		expect(state.globalNotices).toHaveLength(1);
		expect(state.diagnostics.list()[0]?.count).toBe(2);
	});
});
