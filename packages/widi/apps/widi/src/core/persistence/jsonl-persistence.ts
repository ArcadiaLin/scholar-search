/**
 * The session directory repository: one entry point for a session's history,
 * its custom storage, and the sessions it owns.
 *
 * It does the directory-level job the old session repository did and adds the
 * two things that job was missing - the custom storages registered against a
 * session, and the child sessions nested inside it. Nothing here interprets a
 * namespace: the repository executes what a registered namespace declares, and
 * a child session is a directory it copies or deletes without asking what the
 * agent inside it was.
 *
 * One asymmetry runs through this file. The repository *reads* the session tree
 * and *writes* custom storage, but it never writes to a live session branch:
 * that belongs to `AgentHarness`, which serializes writes and buffers them
 * during a turn. So committing state is two steps by construction -
 * {@link JsonlPersistenceRepo.stageState} writes the object and hands back ref
 * data, and the caller appends that ref through the harness. Object first is
 * also the safe order: a crash between the two leaves a collectable orphan
 * instead of a ref pointing at nothing.
 *
 * A fork is the exception, and only because the session it writes to is one
 * nobody has open yet.
 */

import type { FileInfo, JsonlSessionMetadata, SessionTreeEntry } from "@arcadialin/agent-core";
import { createTimestamp, getFileSystemResultOrThrow, SessionError, toError } from "@arcadialin/agent-core";
import type {
	CustomStorage,
	PersistenceFileSystem,
	PersistenceNamespaceDefinition,
	PersistenceRegistry,
} from "./custom-storage.ts";
import { closeStorage } from "./custom-storage.ts";
import {
	getEntriesToFork,
	getForkLeafId,
	getFullBranch,
	JsonlSession,
	loadJsonlSessionMetadata,
} from "./jsonl-session.ts";
import { JsonlObjectStore } from "./object-store.ts";
import type { PersistenceDiagnostic } from "./utils/diagnostics.ts";
import { PersistenceDiagnostics } from "./utils/diagnostics.ts";
import type { ForkPlan, NamespaceForkPlan } from "./utils/fork-closure.ts";
import { planForkClosure } from "./utils/fork-closure.ts";
import {
	AGENTS_DIR_NAME,
	canNestUnder,
	childSessionKey,
	createSessionDirName,
	encodeCwd,
	formatSessionKey,
	namespaceDirSegments,
	OBJECTS_FILE_NAME,
	type SessionAddress,
	type SessionKey,
	sessionDirSegments,
	sessionFileSegments,
} from "./utils/layout.ts";
import type { PersistenceRefData, PersistenceRefOrigin } from "./utils/persistence-ref.ts";
import { createPersistenceRefData, PERSISTENCE_REF_CUSTOM_TYPE } from "./utils/persistence-ref.ts";
import { createSessionOrigin, withSessionOrigin } from "./utils/session-origin.ts";
import type { BranchProjection, StateProvenance } from "./utils/state-projection.ts";
import { projectBranch, projectionToForkRoots } from "./utils/state-projection.ts";

/** An open session and the address that identifies its directory. */
export interface PersistedSession {
	readonly address: SessionAddress;
	readonly metadata: JsonlSessionMetadata;
	readonly session: JsonlSession;
}

/** Header facts plus the address, for listing without opening. */
export interface PersistedSessionInfo {
	readonly address: SessionAddress;
	readonly metadata: JsonlSessionMetadata;
}

export interface CreateSessionOptions {
	readonly cwd: string;
	readonly sessionId: string;
	/**
	 * The session spawning this one. Omitted for a top-level session, which is
	 * exactly the set `/resume` lists.
	 */
	readonly parent?: SessionKey;
	readonly metadata?: Record<string, unknown>;
	readonly diagnostics?: PersistenceDiagnostics;
}

export interface ForkSessionOptions {
	/** Id of the new session: its directory name and its header both carry it. */
	readonly sessionId: string;
	readonly entryId?: string;
	readonly position?: "before" | "at";
	/**
	 * Where the fork lands. A fork of a child defaults to a top-level session:
	 * it is a new line of work, not a new member of the source's tree.
	 */
	readonly parent?: SessionKey;
	readonly metadata?: Record<string, unknown>;
}

export interface ForkResult {
	readonly session: PersistedSession;
	readonly plan: ForkPlan;
	readonly diagnostics: PersistenceDiagnostics;
}

export interface ResolvedNamespaceState {
	readonly namespace: string;
	readonly stateRoot: string;
	readonly state: unknown;
	/**
	 * Where this came from, which the caller needs and cannot work out.
	 *
	 * Persistence reports it and stops; deciding what a `forked` or `degraded`
	 * state means for a relaunch is the caller's, per "What persistence does not
	 * decide" in `custom-storage.ts`.
	 */
	readonly provenance: StateProvenance;
}

export interface ResolvedPersistence {
	readonly projection: BranchProjection;
	/** Resolved state per namespace; a namespace missing here did not resolve. */
	readonly states: ReadonlyMap<string, ResolvedNamespaceState>;
	readonly diagnostics: readonly PersistenceDiagnostic[];
}

export class JsonlPersistenceRepo {
	private readonly _fs: PersistenceFileSystem;
	private readonly _rootInput: string;
	private readonly _registry: PersistenceRegistry;
	private _root: string | undefined;

	constructor(options: {
		readonly fs: PersistenceFileSystem;
		/** Persistence root, e.g. `.widi/runs`. */
		readonly root: string;
		readonly registry: PersistenceRegistry;
	}) {
		this._fs = options.fs;
		this._rootInput = options.root;
		this._registry = options.registry;
	}

	// ---------------------------------------------------------------------
	// Sessions
	// ---------------------------------------------------------------------

	/**
	 * Create a session, nested under its parent when it has one.
	 *
	 * A parent that is itself unpersisted has no directory to nest under, and
	 * the caller is expected not to ask: persistence follows the directory, so
	 * the child of an ephemeral agent is ephemeral too. A parent too deep to
	 * nest under degrades to a top-level session with a diagnostic rather than
	 * producing a path that cannot be opened.
	 */
	async create(options: CreateSessionOptions): Promise<PersistedSession> {
		const key = await this._newSessionKey(
			options.cwd,
			options.parent,
			options.sessionId,
			createTimestamp(),
			options.diagnostics,
		);
		const address: SessionAddress = { cwd: options.cwd, key };
		return await this._createAt(address, {
			sessionId: options.sessionId,
			parent: options.parent,
			metadata: options.metadata,
		});
	}

	async open(
		address: SessionAddress,
		options?: { readonly diagnostics?: PersistenceDiagnostics },
	): Promise<PersistedSession> {
		const filePath = await this.sessionFilePath(address);
		if (!getFileSystemResultOrThrow(await this._fs.exists(filePath), `Failed to check session ${filePath}`)) {
			throw new SessionError("not_found", `Session not found: ${filePath}`);
		}
		const session = await JsonlSession.open(this._fs, filePath);
		const torn = session.recoveredTornTail;
		if (torn !== undefined) {
			options?.diagnostics?.report({
				severity: "warning",
				code: "persistence.corrupt_log",
				message: `${filePath} ended with an unfinished line (${torn.length} bytes); it was dropped so the session could be opened.`,
				sessionKey: address.key,
			});
		}
		return { address, metadata: await session.getMetadata(), session };
	}

	/**
	 * Top-level sessions of one project, newest first.
	 *
	 * Only top-level: a child is part of its root's tree and is restored through
	 * it, so listing them alongside their roots would offer the user a session
	 * that opens the same conversation twice.
	 */
	async list(options: { readonly cwd: string }): Promise<PersistedSessionInfo[]> {
		return await this._listContainer(options.cwd, await this._cwdDirPath(options.cwd), (name) => [name]);
	}

	/** The sessions nested directly under one session. */
	async listChildren(address: SessionAddress): Promise<PersistedSessionInfo[]> {
		return await this._listContainer(
			address.cwd,
			await this._join(await this._sessionDirPath(address), [AGENTS_DIR_NAME]),
			(name) => childSessionKey(address.key, name),
		);
	}

	/**
	 * Delete a session, its custom storage, and every session it owns.
	 *
	 * The subtree goes with it by construction, which is the point of nesting:
	 * the old layout left a deleted root's children on disk forever, reachable
	 * by nothing.
	 */
	async delete(address: SessionAddress): Promise<void> {
		const dirPath = await this._sessionDirPath(address);
		getFileSystemResultOrThrow(
			await this._fs.remove(dirPath, { recursive: true, force: true }),
			`Failed to delete session ${dirPath}`,
		);
	}

	// ---------------------------------------------------------------------
	// Recovery
	// ---------------------------------------------------------------------

	/**
	 * The state every namespace has at a session's current leaf.
	 *
	 * Reads the complete branch, not the compaction-truncated one, and degrades
	 * per namespace: an unresolvable state leaves that namespace out and a
	 * diagnostic in. The conversation stays readable no matter what is broken
	 * below it - that is the invariant the whole layer exists to keep.
	 */
	async resolveState(address: SessionAddress): Promise<ResolvedPersistence> {
		const diagnostics = new PersistenceDiagnostics();
		const { session } = await this.open(address);
		const projection = projectBranch(await session.getFullBranch());
		for (const rejection of projection.rejected) {
			diagnostics.report({
				severity: "warning",
				code: "persistence.invalid_ref",
				message: `Ignoring ref ${rejection.entryId}: ${rejection.detail}.`,
				sessionKey: address.key,
				entryId: rejection.entryId,
			});
		}

		const states = new Map<string, ResolvedNamespaceState>();
		for (const [namespace, entry] of projection.namespaces) {
			if (entry.stateRoot === null) continue;
			const resolved = await this._resolveNamespace(address, namespace, entry.stateRoot, entry.provenance, diagnostics);
			if (resolved) states.set(namespace, resolved);
		}
		return { projection, states, diagnostics: diagnostics.entries };
	}

	private async _resolveNamespace(
		address: SessionAddress,
		namespace: string,
		stateRoot: string,
		provenance: StateProvenance,
		diagnostics: PersistenceDiagnostics,
	): Promise<ResolvedNamespaceState | undefined> {
		const definition = this._registry.get(namespace);
		if (!definition) {
			diagnostics.report({
				severity: "warning",
				code: "persistence.unknown_namespace",
				message: `Nothing is registered for ${namespace}; its state was left as it is.`,
				sessionKey: address.key,
				namespace,
				stateRoot,
			});
			return undefined;
		}
		const storage = await this.openStorage(address, namespace, diagnostics);
		if (!storage) return undefined;
		try {
			return await this._readState(address, definition, storage, stateRoot, provenance, diagnostics);
		} finally {
			await closeStorage(storage);
		}
	}

	private async _readState(
		address: SessionAddress,
		definition: PersistenceNamespaceDefinition,
		storage: CustomStorage,
		stateRoot: string,
		provenance: StateProvenance,
		diagnostics: PersistenceDiagnostics,
	): Promise<ResolvedNamespaceState | undefined> {
		const namespace = definition.namespace;
		const state = await storage.resolveState(stateRoot);
		if (state === undefined) {
			diagnostics.report({
				severity: "warning",
				code: "persistence.dangling_ref",
				message: `${namespace} has no object ${stateRoot} in ${formatSessionKey(address.key)}.`,
				sessionKey: address.key,
				namespace,
				stateRoot,
			});
			return undefined;
		}

		const stored = storage.storedFormatVersion;
		if (stored === undefined || stored >= definition.version) {
			return { namespace, stateRoot, state, provenance };
		}
		if (!definition.migrate) {
			diagnostics.report({
				severity: "warning",
				code: "persistence.unsupported_version",
				message: `${namespace} stored v${stored} and this build reads v${definition.version}, with no migration.`,
				sessionKey: address.key,
				namespace,
				stateRoot,
			});
			return undefined;
		}
		const migrated = await definition.migrate({ fromVersion: stored, stateRoot, storage });
		if (migrated === undefined) {
			diagnostics.report({
				severity: "warning",
				code: "persistence.unsupported_version",
				message: `${namespace} could not migrate ${stateRoot} from v${stored}.`,
				sessionKey: address.key,
				namespace,
				stateRoot,
			});
			return undefined;
		}
		const migratedState = await storage.resolveState(migrated);
		if (migratedState === undefined) {
			diagnostics.report({
				severity: "error",
				code: "persistence.dangling_ref",
				message: `${namespace} migrated ${stateRoot} to ${migrated}, which is not in the log.`,
				sessionKey: address.key,
				namespace,
				stateRoot: migrated,
			});
			return undefined;
		}
		return { namespace, stateRoot: migrated, state: migratedState, provenance: "migrated" };
	}

	// ---------------------------------------------------------------------
	// Writing state
	// ---------------------------------------------------------------------

	/**
	 * Commit an object and return the ref that names it.
	 *
	 * The caller appends the returned data through `AgentHarness`; the
	 * repository deliberately cannot. During a turn that append is buffered and
	 * reports no entry id, so a design where the ref goes first and the object
	 * follows could never work - and an object written first is content
	 * addressed, so the worst a crash leaves behind is an unreferenced line.
	 */
	async stageState(options: {
		readonly address: SessionAddress;
		readonly namespace: string;
		readonly data: unknown;
		readonly dependencies?: readonly string[];
		readonly anchorEntryId?: string;
	}): Promise<PersistenceRefData> {
		const storage = await this.openStorage(options.address, options.namespace);
		if (!storage) {
			throw new Error(`Persistence namespace ${options.namespace} is not registered.`);
		}
		try {
			const stateRoot = await storage.putObject({ data: options.data, dependencies: options.dependencies });
			return createPersistenceRefData({
				namespace: options.namespace,
				stateRoot,
				anchorEntryId: options.anchorEntryId,
			});
		} finally {
			await closeStorage(storage);
		}
	}

	/** Ref data that clears a namespace from here down the branch. */
	clearState(namespace: string, anchorEntryId?: string): PersistenceRefData {
		return createPersistenceRefData({ namespace, stateRoot: null, anchorEntryId });
	}

	/**
	 * Open one namespace's storage for a session.
	 *
	 * Returns undefined when nothing is registered for the namespace. That is
	 * how an older build reads a session written by a newer one, and equally how
	 * a session survives an extension being uninstalled: the ref stays on the
	 * branch and the directory stays on disk, both untouched, so reinstalling
	 * restores the state. Nothing here ever deletes on the strength of an empty
	 * registry - a failed extension load looks exactly the same from in here.
	 *
	 * A namespace that brings its own storage gets its directory and decides the
	 * rest; {@link JsonlObjectStore} is only the default. Which directory that is
	 * comes from {@link PersistenceNamespaceDefinition.locate} when the namespace
	 * supplies one, so a namespace can also step outside the session subtree - on
	 * its own terms, documented there.
	 *
	 * Each call opens a fresh handle and the caller owns it, closing it with
	 * {@link closeStorage} when done. Nothing is cached: a handle replays a log
	 * on open, so sharing one would mean deciding when it goes stale, and the
	 * repository has no way to know.
	 */
	async openStorage(
		address: SessionAddress,
		namespace: string,
		diagnostics?: PersistenceDiagnostics,
	): Promise<CustomStorage | undefined> {
		const definition = this._registry.get(namespace);
		if (!definition) return undefined;
		const dirPath = await this._namespaceDirPath(address, definition);
		return await definition.openStorage({
			fs: this._fs,
			dirPath,
			sessionKey: address.key,
			diagnostics,
			owner: definition.owner,
		});
	}

	/**
	 * The default storage a namespace gets when it does not bring its own.
	 *
	 * The directory comes from the registered definition's `locate`, so a
	 * namespace calling this from inside its own `openStorage` lands where it
	 * asked to. A namespace that is not registered gets the default layout, which
	 * is the only answer available without a definition to ask.
	 */
	async openDefaultStorage(options: {
		readonly address: SessionAddress;
		readonly namespace: string;
		readonly formatVersion: number;
		readonly diagnostics?: PersistenceDiagnostics;
		readonly owner?: string;
	}): Promise<JsonlObjectStore> {
		const definition = this._registry.get(options.namespace);
		const dirPath = definition
			? await this._namespaceDirPath(options.address, definition)
			: await this._join(
					await this._cwdDirPath(options.address.cwd),
					namespaceDirSegments(options.address.key, options.namespace),
				);
		return await JsonlObjectStore.open({
			fs: this._fs,
			dirPath,
			filePath: await this._join(dirPath, [OBJECTS_FILE_NAME]),
			namespace: options.namespace,
			formatVersion: options.formatVersion,
			sessionKey: options.address.key,
			diagnostics: options.diagnostics,
			owner: options.owner,
		});
	}

	// ---------------------------------------------------------------------
	// Fork
	// ---------------------------------------------------------------------

	/**
	 * Fork a session at a point on its tree, carrying everything that point can
	 * see.
	 *
	 * Order matters and is not an implementation detail:
	 *
	 * 1. copy the conversation entries;
	 * 2. project the *source's* full branch to per-namespace state roots - not
	 *    the copied entries, which without a target are every branch in file
	 *    order rather than a path;
	 * 3. plan the object closure per namespace;
	 * 4. copy objects, apply each namespace's policy, and recursively fork every
	 *    child session nested under the source;
	 * 5. append one fresh ref per surviving namespace to the new session, since
	 *    the source's ref entries may not be among the copied ones. Each carries
	 *    an `origin`, so the new session can tell state it inherited from state
	 *    it later wrote itself.
	 *
	 * Afterwards the new session reads nothing from the source directory, which
	 * is the property the whole design is checked against.
	 */
	async fork(source: SessionAddress, options: ForkSessionOptions): Promise<ForkResult> {
		const diagnostics = new PersistenceDiagnostics();
		const key = await this._newSessionKey(
			source.cwd,
			options.parent,
			options.sessionId,
			createTimestamp(),
			diagnostics,
		);
		const forked = await this._forkInto({
			source,
			target: { cwd: source.cwd, key },
			sessionId: options.sessionId,
			options,
			parent: options.parent,
			metadata: options.metadata,
			diagnostics,
			forking: new Set<string>(),
		});
		return { ...forked, diagnostics };
	}

	private async _forkInto(request: {
		readonly source: SessionAddress;
		readonly target: SessionAddress;
		/**
		 * Header id of the new session. The fork target gets one because its
		 * directory name is built from it; a copied child keeps its own directory
		 * name and therefore keeps its own id.
		 */
		readonly sessionId: string | undefined;
		readonly options: { readonly entryId?: string; readonly position?: "before" | "at" };
		readonly parent: SessionKey | undefined;
		readonly metadata: Record<string, unknown> | undefined;
		readonly diagnostics: PersistenceDiagnostics;
		readonly forking: Set<string>;
	}): Promise<{ session: PersistedSession; plan: ForkPlan }> {
		const source = await this.open(request.source);
		const entries = await source.session.getEntries();
		const forkedEntries = getEntriesToFork(entries, request.options);
		const leafId = getForkLeafId(entries, await source.session.getLeafId(), request.options);
		const projection = projectBranch(getFullBranch(entries, leafId));

		const plan = await planForkClosure({
			roots: projectionToForkRoots(projection),
			registry: this._registry,
			openStorage: async (namespace) => await this.openStorage(request.source, namespace, request.diagnostics),
			sourceKey: request.source.key,
			diagnostics: request.diagnostics,
		});

		const target = await this._createAt(request.target, {
			sessionId: request.sessionId ?? source.metadata.id,
			parent: request.parent,
			metadata: request.metadata ?? source.metadata.metadata,
			forkedFrom: {
				key: request.source.key,
				...(request.options.entryId === undefined ? undefined : { entryId: request.options.entryId }),
			},
		});
		for (const entry of forkedEntries) {
			await target.session.appendEntry(entry);
		}

		for (const namespace of plan.namespaces) {
			const ref = await this._forkNamespace(request.source, request.target, namespace, request.diagnostics);
			if (ref) await target.session.appendEntry(await this._refEntry(target, ref));
		}
		await this._forkChildren(request);
		return { session: target, plan };
	}

	private async _forkNamespace(
		source: SessionAddress,
		target: SessionAddress,
		plan: NamespaceForkPlan,
		diagnostics: PersistenceDiagnostics,
	): Promise<PersistenceRefData | undefined> {
		const definition = this._registry.get(plan.namespace);
		if (!definition) return undefined;
		const sourceStorage = await this.openStorage(source, plan.namespace, diagnostics);
		const targetStorage = await this.openStorage(target, plan.namespace, diagnostics);
		try {
			if (!sourceStorage || !targetStorage) return undefined;
			await sourceStorage.copyReachable(targetStorage, plan.objects);
			const result = definition.fork
				? await definition.fork({ source: sourceStorage, target: targetStorage, roots: plan.objects, diagnostics })
				: { stateRoot: plan.stateRoot };
			if (result.stateRoot === null) return undefined;
			return createPersistenceRefData({
				namespace: plan.namespace,
				stateRoot: result.stateRoot,
				origin: result.origin ?? defaultForkOrigin(definition),
			});
		} catch (error) {
			diagnostics.report({
				severity: "error",
				code: "persistence.fork_degraded",
				message: `${plan.namespace} could not be copied into ${formatSessionKey(target.key)}: ${toError(error).message}`,
				sessionKey: target.key,
				namespace: plan.namespace,
				stateRoot: plan.stateRoot,
			});
			return undefined;
		} finally {
			await closeStorage(sourceStorage);
			await closeStorage(targetStorage);
		}
	}

	/**
	 * Fork every child session nested under the source, keeping their directory
	 * names.
	 *
	 * All of them, not a subset the branch selected: nothing on a branch records
	 * which children belong to it, so the directory listing is the only answer
	 * available. Each child is copied whole, at its own current leaf, for the
	 * same reason - no ref ever pinned a child to a point in the parent's
	 * history. See `notes/develop/ZH/agent-tree-persistence.md`.
	 */
	private async _forkChildren(request: {
		readonly source: SessionAddress;
		readonly target: SessionAddress;
		readonly diagnostics: PersistenceDiagnostics;
		readonly forking: Set<string>;
	}): Promise<void> {
		const sourcePath = formatSessionKey(request.source.key);
		request.forking.add(sourcePath);
		for (const child of await this.listChildren(request.source)) {
			const childKey = child.address.key;
			const name = childKey[childKey.length - 1];
			if (name === undefined) continue;
			if (request.forking.has(formatSessionKey(childKey))) {
				request.diagnostics.report({
					severity: "error",
					code: "persistence.dependency_cycle",
					message: `${formatSessionKey(childKey)} is already being forked; it cannot also be its own descendant.`,
					sessionKey: childKey,
				});
				continue;
			}
			if (!canNestUnder(request.target.key)) {
				request.diagnostics.report({
					severity: "warning",
					code: "persistence.nesting_limit",
					message: `${formatSessionKey(request.target.key)} is too deep to nest ${name}; the child was not copied.`,
					sessionKey: request.target.key,
				});
				continue;
			}
			try {
				await this._forkInto({
					source: { cwd: request.source.cwd, key: childKey },
					target: { cwd: request.target.cwd, key: childSessionKey(request.target.key, name) },
					sessionId: undefined,
					options: {},
					parent: request.target.key,
					metadata: undefined,
					diagnostics: request.diagnostics,
					forking: request.forking,
				});
			} catch (error) {
				request.diagnostics.report({
					severity: "error",
					code: "persistence.child_not_copied",
					message: `Failed to fork ${formatSessionKey(childKey)}: ${toError(error).message}`,
					sessionKey: childKey,
				});
			}
		}
		request.forking.delete(sourcePath);
	}

	// ---------------------------------------------------------------------
	// Low-level session tree access
	//
	// Reads only. Writes to a live branch go through AgentHarness; these exist
	// for fork, hydration and offline inspection of a session nobody has open.
	// ---------------------------------------------------------------------

	async getEntries(address: SessionAddress): Promise<SessionTreeEntry[]> {
		return await (await this.open(address)).session.getEntries();
	}

	async getFullBranch(address: SessionAddress): Promise<SessionTreeEntry[]> {
		return await (await this.open(address)).session.getFullBranch();
	}

	// ---------------------------------------------------------------------
	// Paths
	// ---------------------------------------------------------------------

	async sessionFilePath(address: SessionAddress): Promise<string> {
		return await this._join(await this._cwdDirPath(address.cwd), sessionFileSegments(address.key));
	}

	// ---------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------

	private async _newSessionKey(
		cwd: string,
		parent: SessionKey | undefined,
		sessionId: string,
		timestamp: string,
		diagnostics?: PersistenceDiagnostics,
	): Promise<SessionKey> {
		const name = createSessionDirName(sessionId, timestamp);
		if (parent === undefined) return await this._vacantSessionKey(cwd, [], name);
		if (canNestUnder(parent)) return await this._vacantSessionKey(cwd, parent, name);
		diagnostics?.report({
			severity: "warning",
			code: "persistence.nesting_limit",
			message: `${formatSessionKey(parent)} is too deep to nest ${sessionId}; it was persisted as a top-level session.`,
			sessionKey: parent,
		});
		return await this._vacantSessionKey(cwd, [], name);
	}

	/**
	 * The first directory name in this container that no session already owns.
	 *
	 * Session ids carry four random characters, so a repeat needs the same
	 * profile, the same draw, and the same second; this loop is the backstop for
	 * that, not the naming scheme. It has to exist all the same: `_createAt`
	 * writes the header with `writeFile`, so a name already in use does not fail
	 * the create, it truncates another session's history.
	 */
	private async _vacantSessionKey(cwd: string, parent: SessionKey, name: string): Promise<SessionKey> {
		for (let attempt = 1; ; attempt += 1) {
			const key = childSessionKey(parent, attempt === 1 ? name : `${name}-${attempt}`);
			const dirPath = await this._sessionDirPath({ cwd, key });
			const taken = getFileSystemResultOrThrow(
				await this._fs.exists(dirPath),
				`Failed to check session directory ${dirPath}`,
			);
			if (!taken) return key;
		}
	}

	/**
	 * Write the session file, with the two lineage facts its header owes a
	 * reader: which session's directory holds it, and which session's history it
	 * was copied from. Both are recomputed here rather than carried over in
	 * `metadata`, which for a copied child is the source's and names the tree it
	 * was copied out of. See `utils/session-origin.ts`.
	 */
	private async _createAt(
		address: SessionAddress,
		options: {
			readonly sessionId: string;
			readonly parent: SessionKey | undefined;
			readonly metadata: Record<string, unknown> | undefined;
			readonly forkedFrom?: { readonly key: SessionKey; readonly entryId?: string };
		},
	): Promise<PersistedSession> {
		const dirPath = await this._sessionDirPath(address);
		getFileSystemResultOrThrow(
			await this._fs.createDir(dirPath, { recursive: true }),
			`Failed to create session directory ${dirPath}`,
		);
		const origin = createSessionOrigin({
			...(options.parent === undefined ? undefined : { spawnedBy: options.parent }),
			...(options.forkedFrom === undefined ? undefined : { forkedFrom: options.forkedFrom.key }),
			...(options.forkedFrom?.entryId === undefined ? undefined : { forkEntryId: options.forkedFrom.entryId }),
		});
		const session = await JsonlSession.create(this._fs, await this.sessionFilePath(address), {
			cwd: address.cwd,
			sessionId: options.sessionId,
			parentSessionPath: options.parent
				? await this.sessionFilePath({ cwd: address.cwd, key: options.parent })
				: undefined,
			metadata: withSessionOrigin(options.metadata, origin),
		});
		return { address, metadata: await session.getMetadata(), session };
	}

	private async _listContainer(
		cwd: string,
		containerPath: string,
		keyOf: (name: string) => SessionKey,
	): Promise<PersistedSessionInfo[]> {
		if (!getFileSystemResultOrThrow(await this._fs.exists(containerPath), `Failed to check ${containerPath}`)) {
			return [];
		}
		const dirs = getFileSystemResultOrThrow(
			await this._fs.listDir(containerPath),
			`Failed to list ${containerPath}`,
		).filter((entry: FileInfo) => entry.kind === "directory");

		const sessions: PersistedSessionInfo[] = [];
		for (const dir of dirs) {
			const address: SessionAddress = { cwd, key: keyOf(dir.name) };
			const filePath = await this.sessionFilePath(address);
			if (!getFileSystemResultOrThrow(await this._fs.exists(filePath), `Failed to check session ${filePath}`)) {
				continue;
			}
			try {
				sessions.push({ address, metadata: await loadJsonlSessionMetadata(this._fs, filePath) });
			} catch (error) {
				const cause = toError(error);
				if (!(cause instanceof SessionError) || cause.code !== "invalid_session") {
					throw cause;
				}
			}
		}
		sessions.sort((a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime());
		return sessions;
	}

	private async _refEntry(target: PersistedSession, data: PersistenceRefData): Promise<SessionTreeEntry> {
		return {
			type: "custom",
			id: await target.session.createEntryId(),
			parentId: await target.session.getLeafId(),
			timestamp: createTimestamp(),
			customType: PERSISTENCE_REF_CUSTOM_TYPE,
			data,
		};
	}

	/**
	 * Where one namespace's directory is for one session.
	 *
	 * The default is computed either way, so a `locate` is handed the path it is
	 * overriding rather than the pieces to rebuild it.
	 */
	private async _namespaceDirPath(
		address: SessionAddress,
		definition: PersistenceNamespaceDefinition,
	): Promise<string> {
		const defaultDirPath = await this._join(
			await this._cwdDirPath(address.cwd),
			namespaceDirSegments(address.key, definition.namespace),
		);
		if (!definition.locate) return defaultDirPath;
		return await definition.locate({ address, defaultDirPath, persistenceRoot: await this._rootPath() });
	}

	private async _sessionDirPath(address: SessionAddress): Promise<string> {
		return await this._join(await this._cwdDirPath(address.cwd), sessionDirSegments(address.key));
	}

	private async _cwdDirPath(cwd: string): Promise<string> {
		return await this._join(await this._rootPath(), [encodeCwd(cwd)]);
	}

	private async _rootPath(): Promise<string> {
		if (this._root === undefined) {
			this._root = getFileSystemResultOrThrow(
				await this._fs.absolutePath(this._rootInput),
				`Failed to resolve persistence root ${this._rootInput}`,
			);
		}
		return this._root;
	}

	private async _join(base: string, segments: string[]): Promise<string> {
		return getFileSystemResultOrThrow(
			await this._fs.joinPath([base, ...segments]),
			`Failed to resolve ${segments.join("/")} under ${base}`,
		);
	}
}

function defaultForkOrigin(definition: PersistenceNamespaceDefinition): PersistenceRefOrigin {
	return definition.forkPolicy === "degrade" ? "fork_degraded" : "fork";
}
