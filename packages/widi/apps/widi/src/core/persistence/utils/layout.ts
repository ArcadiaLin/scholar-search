/**
 * Where a session's files live, and how one session addresses another.
 *
 * Two rules are owned here and nowhere else:
 *
 * 1. A session directory owns its history, its custom storage, and the
 *    directories of the sessions it spawned. Ownership, lifetime and
 *    copyability all follow the directory: deleting a root deletes its subtree,
 *    forking a root copies one, and no child is reachable except through its
 *    parent.
 * 2. Child directories sit under {@link AGENTS_DIR_NAME} rather than beside
 *    `session.jsonl`, so listing a session directory never has to decide
 *    whether a child directory is a session or a reserved one. A session id
 *    that happens to read like a reserved name costs nothing.
 *
 * Both rules exist for the session layer. A custom storage owns its own shape
 * under {@link PERSISTENCE_DIR_NAME} and is bound by neither: the framework
 * only promises it a directory of its own.
 *
 * Paths are produced as segments and joined by the caller. Joining is an async
 * FileSystem operation, and keeping the layout rules pure keeps them testable
 * without one.
 */

/** History file inside a session directory. */
export const SESSION_FILE_NAME = "session.jsonl";

/** Container for the sessions a session spawned. */
export const AGENTS_DIR_NAME = "agents";

/** Container for every registered custom storage of a session. */
export const PERSISTENCE_DIR_NAME = "persistence";

/** Append-only object log inside one namespace directory. */
export const OBJECTS_FILE_NAME = "objects.jsonl";

/**
 * Nesting is bounded because the path grows by two segments per level and
 * Windows still enforces a 260 character path limit. A spawn deeper than this
 * is persisted as a top-level session with a diagnostic rather than silently
 * producing a path nobody can open.
 */
export const MAX_SESSION_DEPTH = 8;

/** Directories a session directory owns that are never child sessions. */
const RESERVED_SESSION_DIR_NAMES: ReadonlySet<string> = new Set([AGENTS_DIR_NAME, PERSISTENCE_DIR_NAME]);

/**
 * A session's logical address inside one cwd group: the root directory name,
 * then one directory name per descendant.
 *
 * Addresses are built and passed around, never persisted: no record anywhere
 * names another session, so the `agents/` segments between levels stay a layout
 * detail of this module and the on-disk shape can change without a migration.
 */
export type SessionKey = readonly string[];

/** A session directory, fully identified: which project, which session. */
export interface SessionAddress {
	readonly cwd: string;
	readonly key: SessionKey;
}

// Sessions are grouped per project, and a cwd is not a legal path segment.
export function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Directory name for a new session.
 *
 * The timestamp prefix orders a container chronologically, which is what makes
 * an `agents/` directory readable to a human without opening anything. It is not
 * what makes the name unique - a session id carries four random characters for
 * that, because a session id equals the AgentId that created it and a counter
 * would restart in every runtime. The compact, second-resolution form keeps the
 * segment short enough for deep nesting; the repository checks for a name
 * already in use before it creates one.
 */
export function createSessionDirName(sessionId: string, timestamp: string): string {
	return `${compactTimestamp(timestamp)}_${sessionId}`;
}

/** `2026-08-01T12:03:45.678Z` becomes `20260801T120345Z`. */
export function compactTimestamp(timestamp: string): string {
	return timestamp.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/** Path segments of a session directory, relative to its cwd group. */
export function sessionDirSegments(key: SessionKey): string[] {
	const segments: string[] = [];
	for (const [index, dirName] of key.entries()) {
		if (index > 0) segments.push(AGENTS_DIR_NAME);
		segments.push(dirName);
	}
	return segments;
}

/** Path segments of a session's history file, relative to its cwd group. */
export function sessionFileSegments(key: SessionKey): string[] {
	return [...sessionDirSegments(key), SESSION_FILE_NAME];
}

/** Path segments of one namespace's directory, relative to its cwd group. */
export function namespaceDirSegments(key: SessionKey, namespace: string): string[] {
	return [...sessionDirSegments(key), PERSISTENCE_DIR_NAME, encodeNamespaceDirName(namespace)];
}

/** Path segments of one namespace's object log, relative to its cwd group. */
export function namespaceObjectsSegments(key: SessionKey, namespace: string): string[] {
	return [...namespaceDirSegments(key, namespace), OBJECTS_FILE_NAME];
}

/**
 * Directory name for a namespace.
 *
 * Namespaces read as `core:notes`, and `:` is not a legal Windows path
 * character. The separator is doubled rather than replaced by `-` so
 * `core:notes` and a hypothetical `core-notes` cannot collide.
 */
export function encodeNamespaceDirName(namespace: string): string {
	return namespace.replace(/:/g, "__");
}

export function childSessionKey(parent: SessionKey, dirName: string): SessionKey {
	return [...parent, dirName];
}

export function parentSessionKey(key: SessionKey): SessionKey | undefined {
	return key.length > 1 ? key.slice(0, -1) : undefined;
}

export function rootSessionKey(key: SessionKey): SessionKey {
	return key.slice(0, 1);
}

export function isRootSessionKey(key: SessionKey): boolean {
	return key.length === 1;
}

/** Text form used inside persisted records and diagnostics. */
export function formatSessionKey(key: SessionKey): string {
	return key.join("/");
}

export function parseSessionKey(text: string): SessionKey | undefined {
	const key = text.split("/").filter((segment) => segment.length > 0);
	if (key.length === 0 || key.length > MAX_SESSION_DEPTH) return undefined;
	if (key.some((segment) => isReservedSessionDirName(segment))) return undefined;
	return key;
}

export function sessionKeysEqual(left: SessionKey, right: SessionKey): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * Read a session key back out of a directory path relative to the cwd group.
 *
 * Segments must alternate `<session>/agents/<session>`; anything else is not a
 * session directory, which is how a listing walk stops at `persistence/` and at
 * whatever a custom storage created beneath it.
 */
export function sessionKeyFromDirSegments(segments: readonly string[]): SessionKey | undefined {
	const key: string[] = [];
	for (const [index, segment] of segments.entries()) {
		const expectsConnector = index % 2 === 1;
		if (expectsConnector) {
			if (segment !== AGENTS_DIR_NAME) return undefined;
			continue;
		}
		if (isReservedSessionDirName(segment)) return undefined;
		key.push(segment);
	}
	return key.length > 0 && segments.length % 2 === 1 ? key : undefined;
}

export function isReservedSessionDirName(name: string): boolean {
	return RESERVED_SESSION_DIR_NAMES.has(name);
}

/**
 * Whether a spawn at this depth can still be persisted under its parent.
 *
 * The caller degrades to a top-level session rather than failing the spawn: an
 * agent that runs but is restored detached beats an agent that does not run.
 */
export function canNestUnder(parent: SessionKey): boolean {
	return parent.length < MAX_SESSION_DEPTH;
}
