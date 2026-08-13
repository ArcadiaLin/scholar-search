/**
 * The default custom storage: an append-only log of immutable, content
 * addressed objects.
 *
 * Most namespaces want the same thing - "remember this value, let a branch name
 * it later, copy it when the branch is forked" - and this is that thing, so a
 * namespace only writes its own storage when it genuinely needs another shape.
 *
 * The log is append-only and never rewritten. Nothing here is a snapshot of
 * current state: an object is written once and stays readable for every branch
 * that ever named it, which is what lets a rewound branch resolve to what it
 * saw rather than to what happened afterwards.
 *
 * Layout: `<session>/persistence/<namespace>/objects.jsonl`, a header line and
 * then one object per line. Created lazily, so a session that never uses a
 * namespace never grows its directory.
 *
 * The header also names the owner, and a log whose owner does not match the
 * code opening it is sealed rather than read. Namespace names are unique but
 * not reserved, so an extension can be uninstalled and its name claimed by
 * something else, which would otherwise inherit a directory of objects and
 * interpret them against a schema they were never written for.
 */

import type { CustomStorage, PersistenceFileSystem } from "./custom-storage.ts";
import { contentHash } from "./utils/content-hash.ts";
import type { PersistenceDiagnosticCode, PersistenceDiagnostics } from "./utils/diagnostics.ts";
import type { SessionKey } from "./utils/layout.ts";

export const OBJECT_LOG_HEADER_TYPE = "persistence-objects";

/** Version of the log envelope, not of the namespace's own data. */
export const OBJECT_LOG_VERSION = 1;

interface ObjectLogHeader {
	readonly type: typeof OBJECT_LOG_HEADER_TYPE;
	readonly version: number;
	readonly namespace: string;
	/** The owning namespace's format version, for its own migrations. */
	readonly formatVersion: number;
	/** {@link PersistenceNamespaceDefinition.owner} at the time of the write. */
	readonly owner?: string;
}

interface PersistedObject {
	readonly id: string;
	readonly deps: readonly string[];
	readonly data: unknown;
}

export interface JsonlObjectStoreOptions {
	readonly fs: PersistenceFileSystem;
	/** Directory this namespace owns. Created on first write, not on open. */
	readonly dirPath: string;
	readonly filePath: string;
	readonly namespace: string;
	readonly formatVersion: number;
	readonly sessionKey: SessionKey;
	readonly diagnostics?: PersistenceDiagnostics;
	/**
	 * Who this log belongs to. Checked against the header on open, so a
	 * namespace name reclaimed by different code cannot inherit the objects the
	 * previous owner wrote.
	 */
	readonly owner?: string;
}

export class JsonlObjectStore implements CustomStorage {
	private readonly _fs: PersistenceFileSystem;
	private readonly _dirPath: string;
	private readonly _filePath: string;
	private readonly _namespace: string;
	private readonly _formatVersion: number;
	private readonly _sessionKey: SessionKey;
	private readonly _diagnostics: PersistenceDiagnostics | undefined;
	private readonly _owner: string | undefined;
	private readonly _objects = new Map<string, PersistedObject>();
	// Appends are serialized so two writes in the same tick cannot interleave
	// their lines, and so a caller awaiting one object knows every earlier one
	// already landed.
	private _writes: Promise<void> = Promise.resolve();
	private _fileReady = false;
	/** Format version actually found on disk, once the log exists. */
	private _storedFormatVersion: number | undefined;
	// Set when the log on disk exists but this build must not touch it. Reads
	// degrade to empty; writes have to fail loudly, because a caller told an
	// object was stored will go on to put a ref on the branch naming it.
	private _sealed: string | undefined;

	private constructor(options: JsonlObjectStoreOptions) {
		this._fs = options.fs;
		this._dirPath = options.dirPath;
		this._filePath = options.filePath;
		this._namespace = options.namespace;
		this._formatVersion = options.formatVersion;
		this._sessionKey = options.sessionKey;
		this._diagnostics = options.diagnostics;
		this._owner = options.owner;
	}

	static async open(options: JsonlObjectStoreOptions): Promise<JsonlObjectStore> {
		const store = new JsonlObjectStore(options);
		await store._replay();
		return store;
	}

	get namespace(): string {
		return this._namespace;
	}

	/**
	 * The format version the objects on disk were written with, or this build's
	 * when the log does not exist yet. A namespace compares it against its own
	 * to decide whether it has to migrate.
	 */
	get storedFormatVersion(): number {
		return this._storedFormatVersion ?? this._formatVersion;
	}

	async resolveState(stateRoot: string): Promise<unknown | undefined> {
		return this._objects.get(stateRoot)?.data;
	}

	async listDependencies(stateRoot: string): Promise<readonly string[]> {
		return this._objects.get(stateRoot)?.deps ?? [];
	}

	has(stateRoot: string): boolean {
		return this._objects.has(stateRoot);
	}

	/**
	 * Write an object and return its state root.
	 *
	 * Idempotent by content: the same body written twice produces one line and
	 * one root. That is what makes a fork safe to retry and several refs able to
	 * share a root without any coordination between their writers.
	 */
	async putObject(options: { readonly data: unknown; readonly dependencies?: readonly string[] }): Promise<string> {
		if (this._sealed !== undefined) {
			throw new Error(`Refusing to write ${this._filePath}: ${this._sealed}`);
		}
		const deps = [...new Set(options.dependencies ?? [])].sort();
		const body = { deps, data: options.data };
		const id = contentHash(body);
		if (this._objects.has(id)) return id;
		const object: PersistedObject = { id, deps, data: options.data };
		const write = this._writes.then(() => this._appendLine(object));
		// Keep the chain alive for the next write even when this one rejects, and
		// do not turn a handled rejection into an unhandled one.
		this._writes = write.catch(() => {});
		await write;
		this._objects.set(id, object);
		return id;
	}

	/**
	 * Copy the given roots into another store of the same namespace.
	 *
	 * The repository has already closed over dependencies, so this copies the
	 * set it is handed. Objects the target already has cost nothing, which is
	 * how a fork of a branch that names one root from three places still writes
	 * it once.
	 */
	async copyReachable(target: CustomStorage, roots: readonly string[]): Promise<void> {
		for (const root of roots) {
			const object = this._objects.get(root);
			if (!object) continue;
			await target.putObject({ data: object.data, dependencies: object.deps });
		}
	}

	private async _replay(): Promise<void> {
		const exists = await this._fs.exists(this._filePath);
		if (!exists.ok || !exists.value) return;
		const read = await this._fs.readTextFile(this._filePath);
		if (!read.ok) {
			// The log exists and its contents are unknown, which is the one state
			// a write must not act on: appending would start by rewriting the
			// header over objects that are still there.
			this._seal("error", "persistence.corrupt_log", `Failed to read ${this._filePath}: ${read.error.message}`);
			return;
		}
		this._fileReady = true;
		const lines = read.value.split("\n");
		let header: ObjectLogHeader | undefined;
		for (const [index, line] of lines.entries()) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// A torn last line is the expected shape of a killed runtime.
				// Anywhere else it means the log has a hole, and a hole nobody can
				// size is worth reporting rather than reading past.
				if (index < lines.length - 1) {
					this._report("error", "persistence.corrupt_log", `Line ${index + 1} of ${this._filePath} is not valid JSON.`);
				}
				continue;
			}
			if (header === undefined) {
				header = toObjectLogHeader(parsed);
				if (!header) {
					// Without a readable header nothing that follows can be trusted,
					// and appending to it would hide the new objects too: the next
					// open stops here again and never reaches them, leaving the refs
					// that name them dangling.
					this._seal("error", "persistence.corrupt_log", `${this._filePath} does not start with an object log header.`);
					return;
				}
				this._storedFormatVersion = header.formatVersion;
				if (header.version > OBJECT_LOG_VERSION) {
					this._seal(
						"warning",
						"persistence.unsupported_version",
						`${this._filePath} was written by a newer build (envelope v${header.version}).`,
					);
					return;
				}
				if (header.owner !== this._owner) {
					this._seal(
						"error",
						"persistence.owner_mismatch",
						`${this._filePath} belongs to ${header.owner ?? "no owner"}, but ${this._owner ?? "no owner"} opened it.`,
					);
					return;
				}
				continue;
			}
			const object = toPersistedObject(parsed);
			// An object this build cannot read is skipped without claiming
			// corruption: an unreadable fact is not a broken file. It surfaces
			// later as a dangling ref if anything actually names it.
			if (object) this._objects.set(object.id, object);
		}
	}

	private async _appendLine(object: PersistedObject): Promise<void> {
		if (!this._fileReady) {
			const created = await this._fs.createDir(this._dirPath, { recursive: true });
			if (!created.ok) throw new Error(created.error.message);
			const header: ObjectLogHeader = {
				type: OBJECT_LOG_HEADER_TYPE,
				version: OBJECT_LOG_VERSION,
				namespace: this._namespace,
				formatVersion: this._formatVersion,
				...(this._owner === undefined ? undefined : { owner: this._owner }),
			};
			const wrote = await this._fs.writeFile(this._filePath, `${JSON.stringify(header)}\n`);
			if (!wrote.ok) throw new Error(wrote.error.message);
			this._fileReady = true;
			this._storedFormatVersion ??= this._formatVersion;
		}
		const appended = await this._fs.appendFile(this._filePath, `${JSON.stringify(object)}\n`);
		if (!appended.ok) throw new Error(appended.error.message);
	}

	private _seal(severity: "warning" | "error", code: PersistenceDiagnosticCode, message: string): void {
		this._sealed = message;
		this._report(severity, code, message);
	}

	private _report(severity: "warning" | "error", code: PersistenceDiagnosticCode, message: string): void {
		this._diagnostics?.report({ severity, code, message, namespace: this._namespace, sessionKey: this._sessionKey });
	}
}

function toObjectLogHeader(value: unknown): ObjectLogHeader | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const header = value as Partial<ObjectLogHeader>;
	if (header.type !== OBJECT_LOG_HEADER_TYPE) return undefined;
	if (typeof header.version !== "number") return undefined;
	if (typeof header.namespace !== "string" || !header.namespace) {
		return undefined;
	}
	if (typeof header.formatVersion !== "number") return undefined;
	return {
		type: OBJECT_LOG_HEADER_TYPE,
		version: header.version,
		namespace: header.namespace,
		formatVersion: header.formatVersion,
		owner: typeof header.owner === "string" ? header.owner : undefined,
	};
}

function toPersistedObject(value: unknown): PersistedObject | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const object = value as Partial<PersistedObject>;
	if (typeof object.id !== "string" || !object.id) return undefined;
	if (!Array.isArray(object.deps)) return undefined;
	if (object.deps.some((dep) => typeof dep !== "string")) return undefined;
	return { id: object.id, deps: object.deps, data: object.data };
}
