/**
 * What the persistence layer reports when it cannot do what was asked.
 *
 * The layer degrades rather than throws for anything that is not a programming
 * error: a missing object, an unknown namespace, an incompatible version, a
 * torn last line. Recovery must always produce a readable conversation, and the
 * cost of that promise is that a caller has to be told precisely what it did
 * not get.
 *
 * These stay local to persistence and are mapped onto the runtime's diagnostic
 * channel by the caller, so the model here does not depend on the runtime's.
 */

import type { SessionKey } from "./layout.ts";

export type PersistenceDiagnosticCode =
	/** A ref named a state root no object log contains. */
	| "persistence.dangling_ref"
	/** A ref this build cannot interpret. */
	| "persistence.invalid_ref"
	/** A ref named a namespace nothing registered. */
	| "persistence.unknown_namespace"
	/** An object log was written by a newer format than this build reads. */
	| "persistence.unsupported_version"
	/** A namespace directory belongs to code other than what opened it. */
	| "persistence.owner_mismatch"
	/** A JSONL log was damaged somewhere other than its last line. */
	| "persistence.corrupt_log"
	/** Dependencies formed a cycle; the walk stopped and reported it. */
	| "persistence.dependency_cycle"
	/** A namespace could not be copied and was carried over degraded. */
	| "persistence.fork_degraded"
	/** A namespace was left out of a fork by its own policy. */
	| "persistence.fork_omitted"
	/** A child session directory could not be copied. */
	| "persistence.child_not_copied"
	/** A spawn was too deep to nest and was persisted detached. */
	| "persistence.nesting_limit"
	/** An object could not be committed; the state was not recorded. */
	| "persistence.object_write_failed";

export interface PersistenceDiagnostic {
	readonly severity: "warning" | "error";
	readonly code: PersistenceDiagnosticCode;
	readonly message: string;
	readonly sessionKey?: SessionKey;
	readonly namespace?: string;
	readonly stateRoot?: string;
	readonly entryId?: string;
}

/**
 * Collector passed down a recovery or fork walk.
 *
 * A walk reports everything it found and returns what it could build; it does
 * not stop at the first problem, because a partially restored session is the
 * outcome the whole design is trying to make survivable.
 */
export class PersistenceDiagnostics {
	private readonly _entries: PersistenceDiagnostic[] = [];

	report(diagnostic: PersistenceDiagnostic): void {
		this._entries.push(diagnostic);
	}

	get entries(): readonly PersistenceDiagnostic[] {
		return this._entries;
	}

	get hasErrors(): boolean {
		return this._entries.some((entry) => entry.severity === "error");
	}
}
