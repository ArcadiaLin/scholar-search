import { diagnosticSource, formatDiagnosticRecord } from "../../diagnostics-log.ts";
import { singleLine } from "../../format.ts";
import { diagnosticGlyph } from "../../labels.ts";
import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

export function diagnosticsCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "diagnostics",
		description: "Browse the warnings and errors reported this session.",
		argumentHint: "[entry]",
		argumentCompletes: true,
		// Severity, code, source and phase all live in the label because the
		// selector filters on label and value only: "extension" narrows to
		// what the extensions reported, "startup" to the boot batch.
		complete: async () =>
			host.diagnostics
				.list()
				.map((record) => ({
					value: record.id,
					label: `${diagnosticGlyph(record.diagnostic)} ${record.diagnostic.code}${
						record.count > 1 ? ` ×${record.count}` : ""
					} · ${diagnosticSource(record.diagnostic)} · ${record.phase}`,
					description: singleLine(record.diagnostic.message, 200),
				})),
		// Reached with an empty argument only when there is nothing to pick
		// from: with candidates the engine opens the selector instead.
		execute: async (_context, argument) => {
			const id = argument.trim();
			if (!id) return "No diagnostics reported this session.";
			const record = host.diagnostics.get(id);
			if (!record) throw new Error(`No diagnostic ${id} was reported this session.`);
			await host.copyText(formatDiagnosticRecord(record));
			return `Copied ${record.diagnostic.code} to the clipboard.`;
		},
	};
}
