/**
 * Shared diagnostic contract for core modules.
 *
 * A diagnostic is a plain reported fact: who it concerns (agentId/extensionId),
 * a stable code, and human-readable text. There is no domain/disposition/phase
 * metadata - severity plus code is the whole model.
 */

import { utf8ByteLength } from "../utils/text.ts";

export type DiagnosticSeverity = "warning" | "error";

export interface CoreDiagnostic {
	readonly severity: DiagnosticSeverity;
	readonly code: string;
	readonly message: string;
	readonly agentId?: string;
	readonly extensionId?: string;
}

export type OrchestratorDiagnostic = CoreDiagnostic;

/**
 * What an extension reports; core injects `agentId` and `extensionId` and
 * namespaces the code. Beside the diagnostic contract rather than beside the
 * presentation surface: a reported fact joins this pipeline, where severity
 * decides whether execution continues, degrades, or fails.
 */
export interface ExtensionDiagnosticDraft {
	readonly severity: DiagnosticSeverity;
	readonly code: string;
	readonly message: string;
}

export const EXTENSION_DIAGNOSTIC_SEVERITIES = ["warning", "error"] as const satisfies readonly DiagnosticSeverity[];

export const MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES = 128;
export const MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES = 4_096;

const EXTENSION_DIAGNOSTIC_CODE_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function validateExtensionDiagnosticDraft(draft: ExtensionDiagnosticDraft): ExtensionDiagnosticDraft {
	if (typeof draft !== "object" || draft === null) {
		throw new TypeError("Extension diagnostic draft must be an object.");
	}
	if (!(EXTENSION_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(draft.severity)) {
		throw new TypeError(`Extension diagnostic severity must be one of: ${EXTENSION_DIAGNOSTIC_SEVERITIES.join(", ")}.`);
	}
	if (typeof draft.code !== "string" || !EXTENSION_DIAGNOSTIC_CODE_PATTERN.test(draft.code)) {
		throw new TypeError("Extension diagnostic code must contain only letters, numbers, '.', '_', and '-'.");
	}
	if (utf8ByteLength(draft.code) > MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES) {
		throw new RangeError(`Extension diagnostic code exceeds ${MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES} UTF-8 bytes.`);
	}
	if (typeof draft.message !== "string" || draft.message.trim().length === 0) {
		throw new TypeError("Extension diagnostic message must be a non-blank string.");
	}
	if (utf8ByteLength(draft.message) > MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES) {
		throw new RangeError(`Extension diagnostic message exceeds ${MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES} UTF-8 bytes.`);
	}
	return { severity: draft.severity, code: draft.code, message: draft.message };
}

export class OrchestratorError extends Error {
	readonly code: CoreDiagnostic["code"];
	readonly diagnostic: OrchestratorDiagnostic;

	constructor(diagnostic: OrchestratorDiagnostic) {
		super(diagnostic.message);
		this.name = "OrchestratorError";
		this.code = diagnostic.code;
		this.diagnostic = diagnostic;
	}
}

/** Unwrap an OrchestratorError's diagnostic, or build one from the fallback. */
export function toDiagnostic(
	error: unknown,
	fallback: { readonly code: string; readonly message: string; readonly agentId?: string },
): OrchestratorDiagnostic {
	if (error instanceof OrchestratorError) return error.diagnostic;
	return { severity: "error", ...fallback };
}
