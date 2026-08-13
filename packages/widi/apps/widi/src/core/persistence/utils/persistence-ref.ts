/**
 * The pointer from a conversation branch to a custom storage state.
 *
 * A ref is an ordinary custom entry, so it is an ordinary node of the session
 * tree: it has an id, a parent, a timestamp, and it is visible exactly on the
 * branches that descend from it. That visibility is the whole mechanism -
 * rewinding past a ref makes the state it named stop applying, and forking a
 * branch carries the refs the branch could see. No kind of persisted state
 * needs its own rule for either.
 *
 * A ref is a pointer and never a payload. Dependencies live in the object it
 * names, not here: keeping them in both places guarantees they drift, and the
 * fork walk has to open the storage anyway.
 *
 * Refs are written after the object they name is durable. During a turn the
 * harness buffers session writes and reports no entry id, so a ref cannot be
 * written first and back-filled; an object, being content addressed, can be
 * written first and leaves only collectable garbage if the ref never lands.
 */

import type { SessionTreeEntry } from "@arcadialin/agent-core";
import { isContentHash } from "./content-hash.ts";

export const PERSISTENCE_REF_CUSTOM_TYPE = "widi:persistence-ref";

export const PERSISTENCE_REF_VERSION = 1;

/**
 * A ref carries a pointer and nothing else, so this bound exists to catch a
 * caller treating it as storage, not to size real data.
 */
export const MAX_PERSISTENCE_REF_BYTES = 2048;

/**
 * How a ref came to be on this branch, when it was not written by the session
 * living its own life.
 *
 * A fork is the only operation that puts somebody else's state on a branch, so
 * it is the only thing that sets this. Downstream reads it to decide whether
 * the state's contents can still be trusted: a record copied out of another
 * session may name things that were never this session's.
 *
 * This records what happened, not what to do about it. The decision belongs to
 * whoever activates the state - see the module doc of `custom-storage.ts`.
 */
export type PersistenceRefOrigin = "fork" | "fork_degraded";

export interface PersistenceRefData {
	readonly version: number;
	readonly namespace: string;
	/**
	 * The state this namespace takes on from here down the branch, or null to
	 * clear it - the shape a disposal takes, and the reason resolution cannot
	 * just take the last non-empty ref.
	 */
	readonly stateRoot: string | null;
	/**
	 * The entry whose effect this ref records, when it is known.
	 *
	 * Diagnostic only. A ref written during a turn lands wherever the branch
	 * leaf is when the harness flushes, not next to the entry that caused it, so
	 * nothing may depend on adjacency.
	 */
	readonly anchorEntryId?: string;
	/**
	 * Absent means the branch wrote this itself.
	 *
	 * Typed as a bare string on purpose. Writers are closed - only
	 * {@link PersistenceRefOrigin} can be produced - but readers are open, so a
	 * value a newer build invented survives the round trip instead of making an
	 * otherwise valid pointer unreadable. Readers classify it with
	 * {@link isNativeOrigin}, which answers no to anything it does not know.
	 */
	readonly origin?: string;
}

/** A validated ref, paired with the entry it was read from. */
export interface PersistenceRef extends PersistenceRefData {
	readonly entryId: string;
	readonly timestamp: string;
}

export type PersistenceRefProblem =
	| "not_a_ref"
	| "malformed"
	| "unsupported_version"
	| "invalid_state_root"
	| "too_large";

export interface PersistenceRefRejection {
	readonly entryId: string;
	readonly problem: PersistenceRefProblem;
	readonly detail: string;
}

export type PersistenceRefResult =
	| { readonly ok: true; readonly ref: PersistenceRef }
	| { readonly ok: false; readonly rejection: PersistenceRefRejection };

/**
 * Read a ref out of a session entry.
 *
 * A rejection is never fatal. An entry this build cannot interpret leaves its
 * namespace unrestored and produces a diagnostic; it must never make the
 * conversation itself unreadable, which is the one thing the session file is
 * for.
 */
export function parsePersistenceRef(entry: SessionTreeEntry): PersistenceRefResult | undefined {
	if (entry.type !== "custom") return undefined;
	if (entry.customType !== PERSISTENCE_REF_CUSTOM_TYPE) return undefined;
	const reject = (problem: PersistenceRefProblem, detail: string): PersistenceRefResult => ({
		ok: false,
		rejection: { entryId: entry.id, problem, detail },
	});

	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return reject("malformed", "ref data is not an object");
	}
	const candidate = data as Partial<PersistenceRefData>;
	if (candidate.version !== PERSISTENCE_REF_VERSION) {
		return reject("unsupported_version", `ref version ${String(candidate.version)} is not supported`);
	}
	if (typeof candidate.namespace !== "string" || !candidate.namespace) {
		return reject("malformed", "ref is missing a namespace");
	}
	if (candidate.stateRoot !== null && typeof candidate.stateRoot !== "string") {
		return reject("malformed", "ref stateRoot must be a string or null");
	}
	if (typeof candidate.stateRoot === "string" && !isContentHash(candidate.stateRoot)) {
		return reject("invalid_state_root", `ref stateRoot ${candidate.stateRoot} is not a content hash`);
	}
	if (candidate.anchorEntryId !== undefined && typeof candidate.anchorEntryId !== "string") {
		return reject("malformed", "ref anchorEntryId must be a string");
	}
	if (candidate.origin !== undefined && typeof candidate.origin !== "string") {
		return reject("malformed", "ref origin must be a string");
	}
	return {
		ok: true,
		ref: {
			version: candidate.version,
			namespace: candidate.namespace,
			stateRoot: candidate.stateRoot,
			anchorEntryId: candidate.anchorEntryId,
			origin: candidate.origin,
			entryId: entry.id,
			timestamp: entry.timestamp,
		},
	};
}

/**
 * Whether a branch wrote this state itself, as opposed to inheriting it.
 *
 * Unknown to this build counts as not native. The two answers are not
 * symmetric: mistaking inherited state for native lets a caller act on a handle
 * that belongs to another session, while the reverse only costs it a
 * reconstruction it could have skipped.
 */
export function isNativeOrigin(origin: string | undefined): boolean {
	return origin === undefined;
}

/**
 * Build the data of a ref about to be appended.
 *
 * Throws rather than degrading: this runs before the write, where the caller
 * can still decide not to make the branch carry a fact it cannot represent.
 */
export function createPersistenceRefData(options: {
	readonly namespace: string;
	readonly stateRoot: string | null;
	readonly anchorEntryId?: string;
	/** Set by a fork. A session writing its own state leaves it out. */
	readonly origin?: PersistenceRefOrigin;
}): PersistenceRefData {
	if (options.stateRoot !== null && !isContentHash(options.stateRoot)) {
		throw new Error(`A persistence ref must name a content hash, got ${options.stateRoot}.`);
	}
	const data: PersistenceRefData = {
		version: PERSISTENCE_REF_VERSION,
		namespace: options.namespace,
		stateRoot: options.stateRoot,
		...(options.anchorEntryId === undefined ? undefined : { anchorEntryId: options.anchorEntryId }),
		...(options.origin === undefined ? undefined : { origin: options.origin }),
	};
	const size = Buffer.byteLength(JSON.stringify(data), "utf-8");
	if (size > MAX_PERSISTENCE_REF_BYTES) {
		throw new Error(`A persistence ref must stay under ${MAX_PERSISTENCE_REF_BYTES} bytes, got ${size}.`);
	}
	return data;
}
