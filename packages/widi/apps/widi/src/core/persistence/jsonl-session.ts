/**
 * WIDI's own JSONL session file.
 *
 * Ported from pi's `JsonlSessionStorage` so the evolution boundary sits here
 * rather than in vendored code. The port stays byte-compatible with the v3
 * header and entry format: an existing session must keep opening, and a session
 * WIDI writes must keep opening in pi.
 *
 * What this file owns beyond the port:
 *
 * - {@link getFullBranch}, the complete root-to-leaf path. pi's public path
 *   stops at a compaction checkpoint because that is what the model gets;
 *   persistence needs the whole branch, since a ref older than the checkpoint
 *   still applies.
 * - {@link getEntriesToFork}, which for the same reason must not hand a fork
 *   the compaction-truncated prefix - the refs above the checkpoint would be
 *   silently dropped and the new session would come back missing state.
 * - Recovery from a torn last line. pi refuses the whole file, which for a log
 *   appended to on every message means a killed run costs the conversation.
 *   The layer's own promise is that recovery always produces a readable
 *   conversation (`utils/diagnostics.ts`), so an unfinished trailing line is
 *   dropped and reported. Damage of any other shape still throws exactly what
 *   pi throws.
 *
 * It knows what a persistence ref *is* only far enough to find one. What a
 * namespace's state means never enters here.
 */

import type {
	JsonlSessionMetadata,
	LeafEntry,
	SessionEntryCursorOptions,
	SessionStats,
	SessionStorage,
	SessionTreeEntry,
} from "@arcadialin/agent-core";
import { getFileSystemResultOrThrow, SessionError, toError, uuidv7 } from "@arcadialin/agent-core";
import type { PersistenceFileSystem } from "./custom-storage.ts";

export const SESSION_FORMAT_VERSION = 3;

export interface SessionHeader {
	readonly type: "session";
	readonly version: typeof SESSION_FORMAT_VERSION;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
	readonly metadata?: Record<string, unknown>;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId);
	}
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session") {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	if (header.version !== SESSION_FORMAT_VERSION) {
		throw invalidSession(filePath, "unsupported session version");
	}
	if (typeof header.id !== "string" || !header.id) {
		throw invalidSession(filePath, "session header is missing id");
	}
	if (typeof header.timestamp !== "string" || !header.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof header.cwd !== "string" || !header.cwd) {
		throw invalidSession(filePath, "session header is missing cwd");
	}
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(filePath, "session header metadata must be an object");
	}
	return {
		type: "session",
		version: SESSION_FORMAT_VERSION,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	}
	const entry = parsed as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown; targetId?: unknown };
	if (typeof entry.type !== "string") {
		throw invalidEntry(filePath, lineNumber, "is missing entry type");
	}
	if (typeof entry.id !== "string" || !entry.id) {
		throw invalidEntry(filePath, lineNumber, "is missing entry id");
	}
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid parentId");
	}
	if (typeof entry.timestamp !== "string" || !entry.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(filePath, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
		metadata: header.metadata,
	};
}

/**
 * A trailing fragment of a line the writer never finished.
 *
 * `content` is the file without it, which is what a later write has to put back
 * on disk: leaving the fragment in place would turn a tear at the end into a
 * hole in the middle, and a hole is not recoverable.
 */
interface TornTail {
	readonly text: string;
	readonly content: string;
}

/**
 * Split off an unterminated final line that is not parseable JSON.
 *
 * This is the exact shape a killed writer leaves: `appendFile` writes
 * `<entry>\n`, so a partial write ends mid-line with no newline after it.
 * Damage that *is* newline-terminated is a hole rather than a tear and still
 * throws, as does an unparseable line anywhere else in the file.
 */
function splitTornTail(content: string): { content: string; tornTail?: TornTail } {
	const lastNewline = content.lastIndexOf("\n");
	const trailing = content.slice(lastNewline + 1);
	if (!trailing.trim()) return { content };
	try {
		JSON.parse(trailing);
		return { content };
	} catch {
		return {
			content: content.slice(0, lastNewline + 1),
			tornTail: { text: trailing, content: content.slice(0, lastNewline + 1) },
		};
	}
}

async function loadJsonlStorage(
	fs: PersistenceFileSystem,
	filePath: string,
): Promise<{ header: SessionHeader; entries: SessionTreeEntry[]; leafId: string | null; tornTail?: TornTail }> {
	const raw = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const { content, tornTail } = splitTornTail(raw);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) {
		throw invalidSession(filePath, "missing session header");
	}

	const header = parseHeaderLine(lines[0] ?? "", filePath);
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i] ?? "", filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	return { header, entries, leafId, ...(tornTail === undefined ? undefined : { tornTail }) };
}

/**
 * The complete path from the root to `leafId`, oldest first.
 *
 * Unlike pi's `getPathToRootOrCompaction` this never stops early. Cycles are a
 * corrupt file rather than a recoverable condition, so they throw.
 */
export function getFullBranch(entries: readonly SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionTreeEntry[] = [];
	const visited = new Set<string>();
	let current = byId.get(leafId);
	if (!current) {
		throw new SessionError("not_found", `Entry ${leafId} not found`);
	}
	while (current) {
		if (visited.has(current.id)) {
			throw new SessionError("invalid_session", `Session has a cycle at entry ${current.id}`);
		}
		visited.add(current.id);
		branch.unshift(current);
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) {
			throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
		}
		current = parent;
	}
	return branch;
}

/**
 * The entries a fork copies.
 *
 * Without a target this is the whole tree, every branch included. With one it
 * is the full branch ending at the effective leaf - full, not
 * compaction-truncated, which is the one behavioural difference from pi's
 * helper and the reason this is not simply re-exported.
 */
export function getEntriesToFork(
	entries: readonly SessionTreeEntry[],
	options: { readonly entryId?: string; readonly position?: "before" | "at" },
): SessionTreeEntry[] {
	if (!options.entryId) return [...entries];
	const target = entries.find((entry) => entry.id === options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	if ((options.position ?? "before") === "at") {
		return getFullBranch(entries, target.id);
	}
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
	}
	return getFullBranch(entries, target.parentId);
}

/**
 * The leaf the forked session ends on, for the same options.
 *
 * Separate from {@link getEntriesToFork} because without a target that returns
 * every branch in file order, and the last line of a file is not the branch a
 * projection may be taken over.
 */
export function getForkLeafId(
	entries: readonly SessionTreeEntry[],
	currentLeafId: string | null,
	options: { readonly entryId?: string; readonly position?: "before" | "at" },
): string | null {
	if (!options.entryId) return currentLeafId;
	const target = entries.find((entry) => entry.id === options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	return (options.position ?? "before") === "at" ? target.id : target.parentId;
}

export async function loadJsonlSessionMetadata(
	fs: PersistenceFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) {
		return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
	}
	throw invalidSession(filePath, "missing session header");
}

export class JsonlSession implements SessionStorage<JsonlSessionMetadata> {
	private readonly _fs: PersistenceFileSystem;
	private readonly _filePath: string;
	private readonly _metadata: JsonlSessionMetadata;
	private _entries: SessionTreeEntry[];
	private _byId: Map<string, SessionTreeEntry>;
	private _labelsById: Map<string, string>;
	private _currentLeafId: string | null;
	private _tornTail: TornTail | undefined;

	private constructor(
		fs: PersistenceFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
		tornTail?: TornTail,
	) {
		this._fs = fs;
		this._filePath = filePath;
		this._metadata = headerToSessionMetadata(header, this._filePath);
		this._entries = entries;
		this._byId = new Map(entries.map((entry) => [entry.id, entry]));
		this._labelsById = buildLabelsById(entries);
		this._currentLeafId = leafId;
		this._tornTail = tornTail;
	}

	static async open(fs: PersistenceFileSystem, filePath: string): Promise<JsonlSession> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSession(fs, filePath, loaded.header, loaded.entries, loaded.leafId, loaded.tornTail);
	}

	static async create(
		fs: PersistenceFileSystem,
		filePath: string,
		options: {
			readonly cwd: string;
			readonly sessionId: string;
			readonly parentSessionPath?: string;
			readonly metadata?: Record<string, unknown>;
		},
	): Promise<JsonlSession> {
		const header: SessionHeader = {
			type: "session",
			version: SESSION_FORMAT_VERSION,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
			metadata: options.metadata,
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSession(fs, filePath, header, [], null);
	}

	/** Header-only read, for listing without parsing whole files. */
	static async loadMetadata(fs: PersistenceFileSystem, filePath: string): Promise<JsonlSessionMetadata> {
		return await loadJsonlSessionMetadata(fs, filePath);
	}

	get filePath(): string {
		return this._filePath;
	}

	/**
	 * The unfinished line this session was opened past, if there was one. The
	 * caller reports it: losing the last thing a killed run was writing is worth
	 * a word, and it is the only sign the file was not intact.
	 */
	get recoveredTornTail(): string | undefined {
		return this._tornTail?.text;
	}

	/**
	 * Drop the torn tail from the file before anything is appended after it.
	 *
	 * Deferred to the first write so that opening a damaged session to read it -
	 * listing, inspecting, forking - never modifies the file.
	 */
	private async _repairTornTail(): Promise<void> {
		const torn = this._tornTail;
		if (!torn) return;
		this._tornTail = undefined;
		getFileSystemResultOrThrow(
			await this._fs.writeFile(this._filePath, torn.content),
			`Failed to repair session ${this._filePath}`,
		);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this._metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this._currentLeafId !== null && !this._byId.has(this._currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this._currentLeafId} not found`);
		}
		return this._currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<LeafEntry> {
		if (leafId !== null && !this._byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this._byId),
			parentId: this._currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		await this._repairTornTail();
		getFileSystemResultOrThrow(
			await this._fs.appendFile(this._filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this._entries.push(entry);
		this._byId.set(entry.id, entry);
		this._currentLeafId = leafId;
		return entry;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this._byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this._repairTornTail();
		getFileSystemResultOrThrow(
			await this._fs.appendFile(this._filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this._entries.push(entry);
		this._byId.set(entry.id, entry);
		updateLabelCache(this._labelsById, entry);
		this._currentLeafId = leafIdAfterEntry(entry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this._byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this._entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this._labelsById.get(id);
	}

	async getSessionName(): Promise<string | undefined> {
		const entries = await this.findEntries("session_info");
		return entries[entries.length - 1]?.name?.trim() || undefined;
	}

	async getSessionStats(): Promise<SessionStats> {
		let messageCount = 0;
		let cachedTokens = 0;
		let uncachedTokens = 0;
		let totalTokens = 0;
		let costTotal = 0;
		for (const entry of this._entries) {
			if (entry.type === "message") {
				messageCount += 1;
			}
			const usage =
				entry.type === "message"
					? entry.message.role === "assistant"
						? entry.message.usage
						: undefined
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined;
			if (
				!usage ||
				typeof usage.input !== "number" ||
				typeof usage.output !== "number" ||
				typeof usage.cacheRead !== "number" ||
				typeof usage.cacheWrite !== "number" ||
				typeof usage.cost?.total !== "number"
			) {
				continue;
			}
			cachedTokens += usage.cacheRead;
			uncachedTokens += usage.input + usage.cacheWrite;
			totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			costTotal += usage.cost.total;
		}
		return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
	}

	async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this._byId.get(leafId);
		if (!current) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		while (current) {
			path.unshift(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this._byId.get(current.parentId);
			if (!parent) {
				throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			}
			current = parent;
		}
		return path;
	}

	async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		const start = options?.afterEntrySeq ?? 0;
		const end = options?.limit === undefined ? undefined : start + options.limit;
		return this._entries.slice(start, end);
	}

	/** The full branch ending at the current leaf. */
	async getFullBranch(): Promise<SessionTreeEntry[]> {
		return getFullBranch(await this.getEntries(), await this.getLeafId());
	}
}
