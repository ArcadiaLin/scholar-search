import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";

/** Whether a diagnostic was reported while the application started or while it ran. */
export type DiagnosticPhase = "startup" | "runtime";

export interface DiagnosticRecord {
	/** Short stable handle; this is what `/diagnostics` takes as its argument. */
	readonly id: string;
	readonly phase: DiagnosticPhase;
	readonly diagnostic: OrchestratorDiagnostic;
	readonly firstSeenAt: string;
	lastSeenAt: string;
	/** Repeats of the same diagnostic collapse onto the first record. */
	count: number;
}

/**
 * A failing MCP server reports once per turn, so an uncapped log grows without
 * bound in a long session. Eviction is from the front, which is why repeats
 * collapse instead of appending: otherwise one noisy source would push the
 * startup batch out within minutes.
 */
export const MAX_DIAGNOSTIC_RECORDS = 200;

/**
 * Identity of a reported fact. The message is part of the key so same-code
 * reports about different subjects (e.g. different MCP servers) stay distinct.
 */
export function diagnosticKey(diagnostic: OrchestratorDiagnostic): string {
	return `diagnostic:${diagnostic.code}:${diagnostic.agentId ?? ""}:${diagnostic.extensionId ?? ""}:${diagnostic.message}`;
}

/** Who reported it, in the terms the reader can filter on. */
export function diagnosticSource(diagnostic: OrchestratorDiagnostic): string {
	if (diagnostic.extensionId) return `extension ${diagnostic.extensionId}`;
	if (diagnostic.agentId) return `agent ${diagnostic.agentId}`;
	return diagnostic.code.split(".")[0] ?? diagnostic.code;
}

/** The whole record as text, for the clipboard. */
export function formatDiagnosticRecord(record: DiagnosticRecord): string {
	const header = [
		record.diagnostic.severity,
		record.diagnostic.code,
		diagnosticSource(record.diagnostic),
		record.phase,
		record.lastSeenAt,
	];
	if (record.count > 1) header.push(`×${record.count} since ${record.firstSeenAt}`);
	return `${header.join(" · ")}\n${record.diagnostic.message}`;
}

/**
 * Every diagnostic the TUI has seen this session, kept beyond the notice that
 * announced it: notices expire and transcript items belong to one agent, so
 * without this there is nowhere to go back and read what scrolled past.
 */
export class DiagnosticsLog {
	/** Phase new records are stamped with; the application flips it once the startup batch is projected. */
	phase: DiagnosticPhase = "startup";
	private readonly records: DiagnosticRecord[] = [];
	private readonly byKey = new Map<string, DiagnosticRecord>();
	private nextId = 1;

	record(diagnostic: OrchestratorDiagnostic, at: string): DiagnosticRecord {
		const key = diagnosticKey(diagnostic);
		const existing = this.byKey.get(key);
		if (existing) {
			existing.lastSeenAt = at;
			existing.count += 1;
			return existing;
		}
		const record: DiagnosticRecord = {
			id: `d${this.nextId}`,
			phase: this.phase,
			diagnostic,
			firstSeenAt: at,
			lastSeenAt: at,
			count: 1,
		};
		this.nextId += 1;
		this.records.push(record);
		this.byKey.set(key, record);
		if (this.records.length > MAX_DIAGNOSTIC_RECORDS) {
			const evicted = this.records.shift();
			if (evicted) this.byKey.delete(diagnosticKey(evicted.diagnostic));
		}
		return record;
	}

	/** Newest first: what someone opens this for is usually what just happened. */
	list(): readonly DiagnosticRecord[] {
		return [...this.records].reverse();
	}

	get(id: string): DiagnosticRecord | undefined {
		return this.records.find((record) => record.id === id);
	}
}
