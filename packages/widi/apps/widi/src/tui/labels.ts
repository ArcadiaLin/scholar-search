import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type { AgentMaintenanceKind } from "../core/types.ts";
import { singleLine } from "./format.ts";
import type { AgentViewState } from "./state.ts";

/** Display word for maintenance work, e.g. "Compacting" in "Compacting…". */
export function maintenanceLabel(kind: AgentMaintenanceKind): string {
	return kind === "compaction" ? "Compacting" : "Navigating";
}

export function agentLabel(agent: AgentViewState): string {
	return singleLine(
		agent.display.sessionName ??
			agent.snapshot?.profile.reference.label ??
			agent.snapshot?.profile.reference.id ??
			agent.agentId,
		80,
	);
}

export function diagnosticGlyph(diagnostic: OrchestratorDiagnostic): string {
	switch (diagnostic.severity) {
		case "error":
			return "✕";
		case "warning":
			return "▲";
	}
}
