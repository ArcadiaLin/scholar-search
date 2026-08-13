/**
 * SessionManager owns the session repository used by AgentOrchestrator.
 *
 * Persistent sessions live in `JsonlPersistenceRepo`: one directory per
 * session, holding its history, the custom storage of every persistence
 * namespace, and the directories of the sessions it spawned. WIDI stores
 * profile references in the JSONL session header metadata so resume can rebuild
 * harness context.
 *
 * A session is addressed by its {@link SessionAddress} - the cwd group plus the
 * chain of directory names down to it - never by the path of its history file.
 * The text form of that address is what a `/resume` argument, an extension
 * session handle, and every other reference carry. Paths stay inside the
 * repository, which is what lets the layout change without a migration.
 */

import { randomUUID } from "node:crypto";
import type {
	AgentMessage,
	FileSystem,
	JsonlSessionMetadata,
	Session,
	SessionContext,
	SessionForkOptions,
	SessionMetadata,
	SessionTreeEntry,
} from "@arcadialin/agent-core";
import {
	buildSessionContext,
	getFileSystemResultOrThrow,
	InMemorySessionStore,
	toSession,
} from "@arcadialin/agent-core";
import { formatError } from "../utils/errors.ts";
import type { AgentProfile, AgentProfileReference } from "./agent-profile.js";
import { parseAgentProfileReference, toAgentProfileReference } from "./agent-profile.js";
import type { ExtensionMessage } from "./extension/types.ts";
import type {
	PersistedSessionInfo,
	PersistenceDiagnostic,
	PersistenceRegistry,
	SessionAddress,
	SessionOrigin,
} from "./persistence/index.ts";
import {
	formatSessionKey,
	JsonlPersistenceRepo,
	loadJsonlSessionMetadata,
	type PersistenceDiagnostics,
	parseSessionKey,
	parseSessionOrigin,
	sessionKeysEqual,
} from "./persistence/index.ts";
import type { AgentId } from "./types.ts";

export type AgentSessionMetadata = SessionMetadata | JsonlSessionMetadata;

export interface AgentExtensionCustomEntry<T = unknown> {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	data?: T;
}

// Core-owned custom entry recording an extension input rewrite (ME slice 7).
// The session only carries the rewritten text the model saw, so the human's
// original input must stay recoverable after resume. Blocked input writes
// nothing - it never reached the model and left no session state to explain.
export const INPUT_TRANSFORM_CUSTOM_TYPE = "core:input_transform";

export interface InputTransformEntryData {
	readonly inputId: string;
	readonly originalText: string;
	readonly text: string;
	readonly transformedBy: readonly string[];
}

// Core-owned custom entry persisting an extension's published presentation
// message. It never becomes model context; the entry id is the stable
// identity consumers dedupe on between live events and hydration.
export const EXTENSION_MESSAGE_CUSTOM_TYPE = "core:extension_message";

export interface ExtensionMessageEntryData {
	readonly extensionId: string;
	readonly message: ExtensionMessage;
}

/**
 * Core-owned type for every message the runtime puts into a model's context on
 * someone else's behalf: another agent, an extension, or the runtime itself.
 *
 * One type rather than one per source, because the dispatch key is
 * `details.source.kind` and that is open - a holder names its own source, so a
 * reader has to tolerate kinds it has never seen. Minting a custom type per
 * kind would put those names into the type space and still need the same
 * fallback.
 *
 * Input the shell submits as the human is the deliberate exception: it stays a
 * plain `role:"user"` entry with no type at all, and carrying none is what says
 * the user typed it.
 */
export const ORCHESTRATOR_MESSAGE_CUSTOM_TYPE = "core:orchestrator_message";

export interface AgentSessionCandidate {
	/** Text form of the session address; how every consumer names this session. */
	readonly ref: string;
	/** The header id, which equals the AgentId that created it and repeats across runs. */
	readonly id: string;
	readonly createdAt: string;
	readonly cwd: string;
	/** Where this session came from: which session spawned it, which it was forked from. */
	readonly origin?: SessionOrigin;
	readonly profile?: AgentProfileReference;
	/** Latest session_info name, when the user named the session. */
	readonly name?: string;
	/** First non-empty line of the first user message. */
	readonly firstUserMessage?: string;
}

export interface AgentSessionTreeNode extends AgentSessionCandidate {
	/** The sessions nested directly under this one, oldest first. */
	readonly children: readonly AgentSessionTreeNode[];
}

export interface AgentSessionSnapshot {
	/** Absent for an ephemeral session, which owns no directory to address. */
	readonly ref?: string;
	readonly metadata: AgentSessionMetadata;
	readonly name?: string;
	readonly leafId: string | null;
	readonly pathToRoot: readonly SessionTreeEntry[];
}

export interface AgentSessionTreeSnapshot extends AgentSessionSnapshot {
	readonly entries: readonly SessionTreeEntry[];
}

export interface ForkAgentSessionOptions {
	/** Id of the new session. The caller owns AgentId allocation, so it picks. */
	readonly sessionId: string;
	readonly entryId?: string;
	readonly position?: SessionForkOptions["position"];
}

export interface AgentSessionForkResult {
	readonly info: PersistedSessionInfo;
	/** Namespaces that could not be carried over, per session copied. */
	readonly diagnostics: readonly PersistenceDiagnostic[];
}

export type AgentSessionResolutionFailureReason = "not_found" | "ambiguous";

export class AgentSessionResolutionError extends Error {
	readonly reason: AgentSessionResolutionFailureReason;
	readonly reference: string;
	readonly candidates: readonly AgentSessionCandidate[];

	constructor(options: {
		readonly reason: AgentSessionResolutionFailureReason;
		readonly reference: string;
		readonly candidates: readonly AgentSessionCandidate[];
	}) {
		const message =
			options.reason === "ambiguous"
				? `Ambiguous agent session reference: ${options.reference}`
				: `Agent session not found: ${options.reference}`;
		super(message);
		this.name = "AgentSessionResolutionError";
		this.reason = options.reason;
		this.reference = options.reference;
		this.candidates = [...options.candidates];
	}
}

export interface SessionManagerConfigs {
	fs: FileSystem;
	cwd: string;
	sessionsRoot: string;
	registry: PersistenceRegistry;
}

type CreateAgentSessionOptions = {
	agentId: AgentId;
	agentProfile: AgentProfile;
	/** Workspace the agent runs in. Defaults to the one the process started in. */
	cwd?: string;
	/** The agent that spawned this one; its session directory holds the new one. */
	parentAgentId?: AgentId;
	diagnostics?: PersistenceDiagnostics;
};

type ResumeAgentSessionOptions = { agentId: AgentId; info: PersistedSessionInfo; diagnostics?: PersistenceDiagnostics };

export class SessionManager {
	readonly repo: JsonlPersistenceRepo;
	private readonly _fs: FileSystem;
	/**
	 * The workspace the process started in. Only a default now: an agent may run
	 * in another directory, and its session is stored under that one instead. A
	 * whole agent tree shares one cwd, so a group still holds exactly one tree.
	 */
	private readonly _cwd: string;
	private readonly _agentSessions: Map<AgentId, Session<AgentSessionMetadata>> = new Map();
	/** Runtime AgentId to the session directory it is bound to; ephemeral agents have none. */
	private readonly _agentAddresses = new Map<AgentId, SessionAddress>();
	// Held as a store rather than through pi's SessionRepo: the repo now hands
	// back a snapshot-backed Session that reloads the whole session on every
	// read. Sessions here are long-lived handles, so they stay bound to the
	// stateful storage the store already keeps.
	private readonly _memorySessionStore: InMemorySessionStore = new InMemorySessionStore();
	// Opaque session handles for consumers that must not see the layout at all.
	private readonly _sessionHandlesByRef: Map<string, string> = new Map();
	private readonly _sessionRefsByHandle: Map<string, string> = new Map();

	constructor(config: SessionManagerConfigs) {
		this._fs = config.fs;
		this._cwd = config.cwd;
		this.repo = new JsonlPersistenceRepo({ fs: config.fs, root: config.sessionsRoot, registry: config.registry });
	}

	/**
	 * Top-level sessions of this project, newest first.
	 *
	 * Child sessions are deliberately absent: a spawned agent's session belongs
	 * to the tree of the session that spawned it and is restored - or, today, not
	 * restored - through it. Offering one in a resume picker would open the same
	 * conversation twice.
	 */
	async listAgentSessionCandidates(cwd: string = this._cwd): Promise<AgentSessionCandidate[]> {
		const sessions = await this.repo.list({ cwd });
		return await Promise.all(
			sessions.map(async (info) => ({
				...toAgentSessionCandidate(info),
				...(await this._loadSessionDisplayFacts(info.metadata.path)),
			})),
		);
	}

	// Resume pickers need more than header metadata to make a session
	// recognizable: the latest session_info name and the first user message.
	// Unreadable files or lines degrade to header-only facts.
	private async _loadSessionDisplayFacts(path: string): Promise<{ name?: string; firstUserMessage?: string }> {
		const read = await this._fs.readTextFile(path);
		if (!read.ok) return {};
		const facts: { name?: string; firstUserMessage?: string } = {};
		for (const line of read.value.split("\n")) {
			// Cheap substring gate so only relevant lines pay for JSON.parse.
			const wantsMessage = facts.firstUserMessage === undefined && line.includes('"message"');
			const wantsName = line.includes('"session_info"');
			if (!wantsMessage && !wantsName) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry !== "object" || entry === null) continue;
			const typed = entry as { type?: unknown; name?: unknown; message?: { role?: unknown; content?: unknown } };
			if (typed.type === "session_info" && typeof typed.name === "string") {
				facts.name = typed.name.trim() || undefined;
				continue;
			}
			if (wantsMessage && typed.type === "message" && typed.message?.role === "user") {
				facts.firstUserMessage = userMessageHeadline(typed.message.content);
			}
		}
		return facts;
	}

	/**
	 * One session directory and, recursively, every session nested under it.
	 *
	 * This is the agent tree as it exists on disk, and the only record of it:
	 * nothing writes the parent relation down, because the directory already is
	 * that relation. The caller merges it with the runtime's live agents to tell
	 * which of these sessions is currently running.
	 *
	 * Header lines only. The display facts a resume picker loads cost a full read
	 * of every session file, and a tree with dozens of entries would pay that per
	 * entry to show something this listing does not use.
	 *
	 * Depth needs no guard: a key cannot grow past `MAX_SESSION_DEPTH`, so the
	 * recursion is bounded by the layout itself.
	 */
	async listAgentSessionTree(address: SessionAddress): Promise<AgentSessionTreeNode | undefined> {
		const info = await this._readSessionInfo(address);
		return info === undefined ? undefined : await this._toAgentSessionTreeNode(info);
	}

	private async _toAgentSessionTreeNode(info: PersistedSessionInfo): Promise<AgentSessionTreeNode> {
		// `listChildren` answers newest first, which is what a picker wants. A tree
		// reads the other way: siblings in the order they were spawned. Sorted
		// rather than reversed, so sessions created in the same millisecond keep
		// the order the directory listing gave them instead of having it flipped.
		const children = (await this.repo.listChildren(info.address)).sort(
			(left, right) => new Date(left.metadata.createdAt).getTime() - new Date(right.metadata.createdAt).getTime(),
		);
		return {
			...toAgentSessionCandidate(info),
			children: await Promise.all(children.map(async (child) => await this._toAgentSessionTreeNode(child))),
		};
	}

	/**
	 * Resolve a reference to one session of this project.
	 *
	 * An address is tried first and answers for any depth, so a child session can
	 * be named even though nothing lists one. A header id is the fallback for
	 * people typing what they see: it equals the AgentId that created the session
	 * and repeats across runs, so it can be ambiguous, and an ambiguous one fails
	 * loudly rather than picking a session.
	 */
	async resolveAgentSessionReference(reference: string, cwd: string = this._cwd): Promise<PersistedSessionInfo> {
		const normalized = reference.trim();
		if (!normalized) {
			throw new AgentSessionResolutionError({ reason: "not_found", reference, candidates: [] });
		}

		const key = parseSessionKey(normalized);
		const addressed = key === undefined ? undefined : await this._readSessionInfo({ cwd, key });
		if (addressed) return addressed;

		const sessions = await this.repo.list({ cwd });
		const idMatches = sessions.filter((session) => session.metadata.id === normalized);
		if (idMatches.length === 1) return idMatches[0];
		if (idMatches.length > 1) {
			throw new AgentSessionResolutionError({
				reason: "ambiguous",
				reference: normalized,
				candidates: idMatches.map(toAgentSessionCandidate),
			});
		}

		throw new AgentSessionResolutionError({ reason: "not_found", reference: normalized, candidates: [] });
	}

	/** Header facts of one session directory, or undefined when there is none. */
	private async _readSessionInfo(address: SessionAddress): Promise<PersistedSessionInfo | undefined> {
		const filePath = await this.repo.sessionFilePath(address);
		const exists = getFileSystemResultOrThrow(
			await this._fs.exists(filePath),
			`Failed to check session ${formatSessionKey(address.key)}`,
		);
		if (!exists) return undefined;
		return { address, metadata: await loadJsonlSessionMetadata(this._fs, filePath) };
	}

	async createAgentSession(options: CreateAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}

		const session = options.agentProfile.persist
			? await this._createPersistentAgentSession(options)
			: await this._createEphemeralAgentSession(options.agentId);
		this._agentSessions.set(options.agentId, session);
		return session;
	}

	async resumeAgentSession(options: ResumeAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}
		const persisted = await this.repo.open(options.info.address, {
			...(options.diagnostics === undefined ? undefined : { diagnostics: options.diagnostics }),
		});
		const session = toSession(persisted.session);
		this._agentSessions.set(options.agentId, session);
		this._agentAddresses.set(options.agentId, options.info.address);
		return session;
	}

	async getAgentSessionSnapshot(agentId: AgentId): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		return await this._snapshotSession(session, this.getAgentSessionRef(agentId));
	}

	async getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot> {
		const session = this._requireAgentSession(agentId);
		return {
			...(await this._snapshotSession(session, this.getAgentSessionRef(agentId))),
			entries: await session.getEntries(),
		};
	}

	async buildAgentSessionContext(agentId: AgentId): Promise<SessionContext> {
		const session = this._requireAgentSession(agentId);
		return buildSessionContext(await this._getFullBranch(session));
	}

	/**
	 * The branch as far back as the model can still see it: pi-agent-core's own
	 * compaction-aware path, which stops at the last compaction or its retained
	 * tail.
	 *
	 * Every other reader here wants `pathToRoot` instead, because hydration,
	 * extension state and durable configuration are about what the session holds.
	 * This one is for the readers whose question is what the model believes, and
	 * a fact compaction dropped is one it no longer believes.
	 */
	async getAgentSessionContextBranch(agentId: AgentId): Promise<readonly SessionTreeEntry[]> {
		return await this._requireAgentSession(agentId).getBranch();
	}

	async setAgentSessionName(agentId: AgentId, name: string): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		await session.appendSessionName(name);
		return await this._snapshotSession(session, this.getAgentSessionRef(agentId));
	}

	/**
	 * Fork a persisted agent session, with everything its directory holds.
	 *
	 * The copy carries the branch's persisted state and every child session
	 * nested under the source, so the new session stands on its own the moment it
	 * exists: deleting the source directory afterwards leaves it fully readable.
	 *
	 * A fork lands as a top-level session even when the source is a child. It is
	 * a new line of work, not a new member of the source's tree.
	 */
	async forkAgentSession(agentId: AgentId, options: ForkAgentSessionOptions): Promise<AgentSessionForkResult> {
		this._requireAgentSession(agentId);
		const source = this._agentAddresses.get(agentId);
		if (!source) {
			throw new Error(`Cannot fork ephemeral agent session: ${agentId}`);
		}
		const forked = await this.repo.fork(source, {
			sessionId: options.sessionId,
			entryId: options.entryId,
			position: options.position,
		});
		this._agentSessions.set(options.sessionId, toSession(forked.session.session));
		this._agentAddresses.set(options.sessionId, forked.session.address);
		return {
			info: { address: forked.session.address, metadata: forked.session.metadata },
			diagnostics: forked.diagnostics.entries,
		};
	}

	async getAgentSessionLeafId(agentId: AgentId): Promise<string | null> {
		return await this._requireAgentSession(agentId).getLeafId();
	}

	/**
	 * Resolve the entry written by the harness for a live message event.
	 *
	 * Session append keeps the message object on the in-process entry. Matching
	 * that identity is stable even when the event bridge handles multiple
	 * message_end events concurrently; reading the current leaf is not.
	 */
	async findAgentMessageEntryId(agentId: AgentId, message: AgentMessage): Promise<string | null> {
		const entries = await this._requireAgentSession(agentId).getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry?.type === "message" && entry.message === message) {
				return entry.id;
			}
		}
		return null;
	}

	/**
	 * The directory an agent's persisted session owns, as an address.
	 *
	 * This is the handle every session-owned artifact is reached through -
	 * persistence namespaces, child sessions, deletion. An ephemeral agent has
	 * none, and consumers read that as "this agent persists nothing".
	 */
	getAgentSessionAddress(agentId: AgentId): SessionAddress | undefined {
		return this._agentAddresses.get(agentId);
	}

	/** Text form of {@link getAgentSessionAddress}, for consumers that pass refs around. */
	getAgentSessionRef(agentId: AgentId): string | undefined {
		const address = this._agentAddresses.get(agentId);
		return address === undefined ? undefined : formatSessionKey(address.key);
	}

	/**
	 * Snapshot any session of the current project, live or historical.
	 *
	 * A reference is a session address or header id, resolved by
	 * {@link resolveAgentSessionReference} so an ambiguous id fails loudly
	 * instead of silently picking one. When the reference names a session this
	 * runtime already has open, that live handle answers - opening a second
	 * handle to the same file would read around its unflushed writes.
	 */
	async readSessionSnapshot(reference: string): Promise<AgentSessionTreeSnapshot> {
		const info = await this.resolveAgentSessionReference(reference);
		const ref = formatSessionKey(info.address.key);
		const live = this._findOpenSession(info.address);
		const session = live ?? toSession((await this.repo.open(info.address)).session);
		return { ...(await this._snapshotSession(session, ref)), entries: await session.getEntries() };
	}

	/**
	 * Mint an opaque handle for a session ref, or resolve one back.
	 *
	 * Consumers that must not learn the storage layout - extensions - address
	 * sessions through these instead of refs. The mapping is runtime-local and
	 * grows only as sessions are listed, so a handle cannot be guessed or
	 * constructed to reach a session the caller was never shown.
	 */
	toSessionHandle(ref: string): string {
		const existing = this._sessionHandlesByRef.get(ref);
		if (existing) return existing;
		const handle = `session-${randomUUID()}`;
		this._sessionHandlesByRef.set(ref, handle);
		this._sessionRefsByHandle.set(handle, ref);
		return handle;
	}

	resolveSessionHandle(handle: string): string {
		const ref = this._sessionRefsByHandle.get(handle);
		if (!ref) {
			throw new Error(`Unknown session handle: ${handle}. Handles come from listing sessions.`);
		}
		return ref;
	}

	private _findOpenSession(address: SessionAddress): Session<AgentSessionMetadata> | undefined {
		for (const [agentId, candidate] of this._agentAddresses) {
			if (sessionKeysEqual(candidate.key, address.key)) return this._agentSessions.get(agentId);
		}
		return undefined;
	}

	async appendExtensionCustomEntry<T = unknown>(
		agentId: AgentId,
		extensionId: string,
		type: string,
		data?: T,
	): Promise<string> {
		const localType = normalizeExtensionCustomType(type);
		assertJsonSerializable(data);
		return await this._requireAgentSession(agentId).appendCustomEntry(
			toPersistedExtensionCustomType(extensionId, localType),
			data,
		);
	}

	async findExtensionCustomEntries<T = unknown>(
		agentId: AgentId,
		extensionId: string,
		type?: string,
	): Promise<AgentExtensionCustomEntry<T>[]> {
		const localType = type === undefined ? undefined : normalizeExtensionCustomType(type);
		const session = this._requireAgentSession(agentId);
		const entries = await this._getFullBranch(session);
		const prefix = toPersistedExtensionCustomTypePrefix(extensionId);
		const result: AgentExtensionCustomEntry<T>[] = [];

		for (const entry of entries) {
			const customEntry = toExtensionCustomEntry<T>(entry, prefix);
			if (!customEntry) continue;
			if (localType !== undefined && customEntry.type !== localType) continue;
			result.push(customEntry);
		}

		return result;
	}

	/**
	 * Create the directory a persistent agent owns, nested under its spawner's.
	 *
	 * Nesting is how the agent tree is recorded: nothing else writes the parent
	 * relation down, and nothing has to, because ownership, deletion and forking
	 * all follow the directory. A spawner with no directory of its own - an
	 * ephemeral agent - has nothing to nest under, so its children are top-level
	 * sessions.
	 */
	private async _createPersistentAgentSession(
		options: CreateAgentSessionOptions,
	): Promise<Session<AgentSessionMetadata>> {
		// Persistent JSONL sessions currently follow the M2 single-process storage
		// boundary. Without an ExecutionEnv lock/transaction primitive, multiple
		// WIDI processes writing the same sessions root are unsupported.
		// The session id deliberately equals the creating agent's id: resume
		// restores the agent under it (_resumeAgentHarness). An AgentId carries
		// four random characters so it does not repeat across runs, which is what
		// keeps a new session off an existing directory; it is still only an id,
		// and consumers address a session by ref.
		const parent = options.parentAgentId === undefined ? undefined : this._agentAddresses.get(options.parentAgentId);
		const persisted = await this.repo.create({
			cwd: options.cwd ?? this._cwd,
			sessionId: options.agentId,
			...(parent === undefined ? undefined : { parent: parent.key }),
			metadata: { profile: toAgentProfileReference(options.agentProfile) },
			...(options.diagnostics === undefined ? undefined : { diagnostics: options.diagnostics }),
		});
		this._agentAddresses.set(options.agentId, persisted.address);
		return toSession(persisted.session);
	}

	private async _createEphemeralAgentSession(agentId: AgentId): Promise<Session<SessionMetadata>> {
		const metadata = await this._memorySessionStore.create({ id: agentId });
		return toSession(await this._memorySessionStore.open(metadata));
	}

	private _requireAgentSession(agentId: AgentId): Session<AgentSessionMetadata> {
		const session = this._agentSessions.get(agentId);
		if (!session) {
			throw new Error(`Unknown agent session: ${agentId}`);
		}
		return session;
	}

	// pi-agent-core's public branch is compaction-aware and may start at a
	// retained-tail checkpoint. WIDI still needs the complete active path for
	// timeline hydration, extension state, and durable runtime configuration.
	private async _getFullBranch(session: Session<AgentSessionMetadata>): Promise<SessionTreeEntry[]> {
		const entries: SessionTreeEntry[] = [];
		const visited = new Set<string>();
		let entryId = await session.getLeafId();
		while (entryId !== null) {
			if (visited.has(entryId)) {
				throw new Error(`Invalid agent session: cycle at entry ${entryId}.`);
			}
			visited.add(entryId);
			const entry = await session.getEntry(entryId);
			if (!entry) {
				throw new Error(`Invalid agent session: entry ${entryId} not found.`);
			}
			entries.unshift(entry);
			entryId = entry.parentId;
		}
		return entries;
	}

	private async _snapshotSession(
		session: Session<AgentSessionMetadata>,
		ref: string | undefined,
	): Promise<AgentSessionSnapshot> {
		return {
			...(ref === undefined ? undefined : { ref }),
			metadata: await session.getMetadata(),
			name: await session.getSessionName(),
			leafId: await session.getLeafId(),
			pathToRoot: await this._getFullBranch(session),
		};
	}
}

function toAgentSessionCandidate(info: PersistedSessionInfo): AgentSessionCandidate {
	return {
		ref: formatSessionKey(info.address.key),
		id: info.metadata.id,
		createdAt: info.metadata.createdAt,
		cwd: info.metadata.cwd,
		origin: parseSessionOrigin(info.metadata.metadata),
		profile: parseAgentProfileReference(info.metadata.metadata?.profile),
	};
}

// The first non-empty line of a user message, bounded for list display.
function userMessageHeadline(content: unknown): string | undefined {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(part): part is { type: "text"; text: string } =>
								typeof part === "object" &&
								part !== null &&
								"type" in part &&
								part.type === "text" &&
								"text" in part &&
								typeof part.text === "string",
						)
						.map((part) => part.text)
						.join(" ")
				: "";
	const line = text
		.split("\n")
		.find((candidate) => candidate.trim() !== "")
		?.trim();
	if (!line) return undefined;
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const EXTENSION_CUSTOM_TYPE_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function normalizeExtensionCustomType(type: string): string {
	const normalized = type.trim();
	if (!normalized) {
		throw new Error("Extension custom entry type must not be empty.");
	}
	if (!EXTENSION_CUSTOM_TYPE_PATTERN.test(normalized)) {
		throw new Error("Extension custom entry type must contain only letters, numbers, '.', '_', ':', and '-'.");
	}
	return normalized;
}

/**
 * The persisted custom type for one extension's namespaced entry.
 *
 * Exported because the write itself belongs to the harness - it owns the live
 * branch - while the naming rule has to stay here, next to the reader that
 * matches on it.
 */
export function toExtensionCustomType(extensionId: string, type: string, data?: unknown): string {
	assertJsonSerializable(data);
	return toPersistedExtensionCustomType(extensionId, normalizeExtensionCustomType(type));
}

/**
 * Whether a persisted custom type names an entry some extension authored.
 *
 * The namespace doubles as a provenance mark, and it is the only one that
 * survives the trip: it travels on the write itself, so a reader can still tell
 * an extension's entry from a core one after the harness buffered the write
 * behind a running turn and flushed it on an unrelated call stack.
 */
export function isExtensionCustomType(customType: string): boolean {
	return customType.startsWith(EXTENSION_CUSTOM_TYPE_NAMESPACE);
}

/** Shared so the writer's prefix and the reader's test cannot drift apart. */
const EXTENSION_CUSTOM_TYPE_NAMESPACE = "extension:";

function toPersistedExtensionCustomType(extensionId: string, localType: string): string {
	return `${toPersistedExtensionCustomTypePrefix(extensionId)}${localType}`;
}

function toPersistedExtensionCustomTypePrefix(extensionId: string): string {
	return `${EXTENSION_CUSTOM_TYPE_NAMESPACE}${extensionId}:`;
}

function assertJsonSerializable(data: unknown): void {
	if (data === undefined) return;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(data);
	} catch (error) {
		throw new Error(`Extension custom entry data must be JSON serializable: ${formatError(error)}`);
	}
	if (serialized === undefined) {
		throw new Error("Extension custom entry data must be JSON serializable.");
	}
}

function toExtensionCustomEntry<T>(entry: SessionTreeEntry, prefix: string): AgentExtensionCustomEntry<T> | undefined {
	if (entry.type !== "custom") return undefined;
	if (!entry.customType.startsWith(prefix)) return undefined;
	const customEntry: AgentExtensionCustomEntry<T> = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		type: entry.customType.slice(prefix.length),
	};
	if (Object.hasOwn(entry, "data")) {
		customEntry.data = entry.data as T;
	}
	return customEntry;
}
