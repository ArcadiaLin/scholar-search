/**
 * Where a session came from, written into its header on the line that creates
 * it.
 *
 * Two different relations, and conflating them is how the previous shape went
 * wrong. `spawnedBy` is a *tree* fact: this session's directory sits inside
 * that one's, and every agent an agent spawns has it. `forkedFrom` is a
 * *content* fact: this session's history was copied from that one, and only a
 * fork has it. A session can have both - a child copied along with its parent's
 * fork was spawned by the new parent and copied from the old child.
 *
 * Sessions are named by address, never by path: a path stops being true the
 * moment the layout changes, and an address is what every other reference in
 * the runtime already carries. The addresses recorded here are best effort
 * provenance - the session they name may be deleted, and a reader has to
 * tolerate an address that no longer resolves.
 *
 * The repository owns this record rather than its callers, because it is the
 * only place that can keep it true through a fork: a copied child's `spawnedBy`
 * has to be recomputed against the *new* parent, and copying the source's
 * header verbatim would leave it pointing into the tree that was copied from.
 */

import { formatSessionKey, type SessionKey } from "./layout.ts";

/** Reserved key in the session header's metadata object. */
export const SESSION_ORIGIN_METADATA_KEY = "origin";

export interface SessionOrigin {
	/** Address of the session whose directory holds this one. */
	readonly spawnedBy?: string;
	/** Address of the session this one's history was copied from. */
	readonly forkedFrom?: string;
	/** Entry on the source the fork was taken at; absent means the whole session. */
	readonly forkEntryId?: string;
}

export function createSessionOrigin(source: {
	readonly spawnedBy?: SessionKey;
	readonly forkedFrom?: SessionKey;
	readonly forkEntryId?: string;
}): SessionOrigin | undefined {
	const origin: SessionOrigin = {
		...(source.spawnedBy === undefined ? undefined : { spawnedBy: formatSessionKey(source.spawnedBy) }),
		...(source.forkedFrom === undefined ? undefined : { forkedFrom: formatSessionKey(source.forkedFrom) }),
		...(source.forkedFrom !== undefined && source.forkEntryId !== undefined
			? { forkEntryId: source.forkEntryId }
			: undefined),
	};
	return Object.keys(origin).length === 0 ? undefined : origin;
}

/**
 * Put the origin into a header metadata object, replacing any it already
 * carries.
 *
 * Replacing rather than merging is the point: the metadata handed in may be a
 * source session's, copied whole by a fork, and its origin describes where
 * *that* session came from.
 */
export function withSessionOrigin(
	metadata: Record<string, unknown> | undefined,
	origin: SessionOrigin | undefined,
): Record<string, unknown> | undefined {
	if (metadata === undefined) return origin === undefined ? undefined : { [SESSION_ORIGIN_METADATA_KEY]: origin };
	const { [SESSION_ORIGIN_METADATA_KEY]: _replaced, ...rest } = metadata;
	if (origin === undefined) return Object.keys(rest).length === 0 ? undefined : rest;
	return { ...rest, [SESSION_ORIGIN_METADATA_KEY]: origin };
}

/**
 * Read the origin back out of header metadata.
 *
 * Anything that is not the shape written here is treated as absent. A header is
 * a file another build may have written, and provenance is never worth failing
 * a session open over.
 */
export function parseSessionOrigin(metadata: Record<string, unknown> | undefined): SessionOrigin | undefined {
	const raw = metadata?.[SESSION_ORIGIN_METADATA_KEY];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const candidate = raw as Record<string, unknown>;
	const origin: SessionOrigin = {
		...(typeof candidate.spawnedBy === "string" && candidate.spawnedBy
			? { spawnedBy: candidate.spawnedBy }
			: undefined),
		...(typeof candidate.forkedFrom === "string" && candidate.forkedFrom
			? { forkedFrom: candidate.forkedFrom }
			: undefined),
		...(typeof candidate.forkEntryId === "string" && candidate.forkEntryId
			? { forkEntryId: candidate.forkEntryId }
			: undefined),
	};
	if (origin.forkedFrom === undefined && origin.forkEntryId !== undefined) {
		return origin.spawnedBy === undefined ? undefined : { spawnedBy: origin.spawnedBy };
	}
	return Object.keys(origin).length === 0 ? undefined : origin;
}
