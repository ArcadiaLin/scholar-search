/**
 * Session persistence.
 *
 * The conversation tree in `session.jsonl` is the authority on which persisted
 * state is in force at any point: a state is named by a ref on the branch, so
 * rewinding drops it and forking carries it, and no kind of state defines its
 * own rule for either. Everything else here serves that one idea - the
 * directory layout that makes a session's subtree copyable, the content
 * addressed object log that makes copying cheap, and the namespace contract
 * that lets a new kind of state join without the repository learning about it.
 *
 * `utils/` holds the parts that are pure: layout arithmetic, hashing, the ref
 * schema, the branch projection, the fork walk, the diagnostic vocabulary. None
 * of them touch a FileSystem, so every rewind, override, cycle and rejection
 * case is testable without one. The modules beside this file are the ones that
 * hold state or do IO.
 */

export type {
	CustomStorage,
	NamespaceForkRequest,
	NamespaceForkResult,
	NamespaceLocateRequest,
	NamespaceStorageContext,
	PersistenceFileSystem,
	PersistenceForkPolicy,
	PersistenceNamespaceDefinition,
} from "./custom-storage.ts";
export { closeStorage, PersistenceRegistry } from "./custom-storage.ts";
export type {
	CreateSessionOptions,
	ForkResult,
	ForkSessionOptions,
	PersistedSession,
	PersistedSessionInfo,
	ResolvedNamespaceState,
	ResolvedPersistence,
} from "./jsonl-persistence.ts";
export { JsonlPersistenceRepo } from "./jsonl-persistence.ts";
export type { SessionHeader } from "./jsonl-session.ts";
export {
	getEntriesToFork,
	getForkLeafId,
	getFullBranch,
	JsonlSession,
	loadJsonlSessionMetadata,
	SESSION_FORMAT_VERSION,
} from "./jsonl-session.ts";
export { JsonlObjectStore } from "./object-store.ts";
export {
	canonicalJson,
	contentHash,
	isContentHash,
} from "./utils/content-hash.ts";
export type {
	PersistenceDiagnostic,
	PersistenceDiagnosticCode,
} from "./utils/diagnostics.ts";
export { PersistenceDiagnostics } from "./utils/diagnostics.ts";
export type {
	ForkClosureRequest,
	ForkPlan,
	NamespaceForkPlan,
} from "./utils/fork-closure.ts";
export { planForkClosure } from "./utils/fork-closure.ts";
export type { SessionAddress, SessionKey } from "./utils/layout.ts";
export {
	AGENTS_DIR_NAME,
	canNestUnder,
	childSessionKey,
	createSessionDirName,
	encodeCwd,
	encodeNamespaceDirName,
	formatSessionKey,
	isReservedSessionDirName,
	isRootSessionKey,
	MAX_SESSION_DEPTH,
	namespaceDirSegments,
	namespaceObjectsSegments,
	OBJECTS_FILE_NAME,
	PERSISTENCE_DIR_NAME,
	parentSessionKey,
	parseSessionKey,
	rootSessionKey,
	SESSION_FILE_NAME,
	sessionDirSegments,
	sessionFileSegments,
	sessionKeyFromDirSegments,
	sessionKeysEqual,
} from "./utils/layout.ts";
export type {
	PersistenceRef,
	PersistenceRefData,
	PersistenceRefOrigin,
	PersistenceRefRejection,
} from "./utils/persistence-ref.ts";
export {
	createPersistenceRefData,
	isNativeOrigin,
	MAX_PERSISTENCE_REF_BYTES,
	PERSISTENCE_REF_CUSTOM_TYPE,
	PERSISTENCE_REF_VERSION,
	parsePersistenceRef,
} from "./utils/persistence-ref.ts";
export type { SessionOrigin } from "./utils/session-origin.ts";
export {
	createSessionOrigin,
	parseSessionOrigin,
	SESSION_ORIGIN_METADATA_KEY,
	withSessionOrigin,
} from "./utils/session-origin.ts";
export type {
	BranchProjection,
	NamespaceProjection,
	StateProvenance,
} from "./utils/state-projection.ts";
export {
	projectBranch,
	projectionToForkRoots,
} from "./utils/state-projection.ts";
