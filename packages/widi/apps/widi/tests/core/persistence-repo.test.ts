/**
 * The repository, checked against the one property that decides the design:
 * a forked session stands on its own once the source is gone.
 *
 * The namespace used here is a plain object log, which is enough to exercise
 * the closure. Everything the repository does with it, it does by executing
 * what the definition declares - it never learns what a counter is.
 */

import type { SessionTreeEntry } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import type {
	CustomStorage,
	NamespaceStorageContext,
	PersistedSession,
	PersistenceForkPolicy,
	PersistenceNamespaceDefinition,
	SessionAddress,
} from "../../src/core/persistence/index.ts";
import {
	closeStorage,
	JsonlObjectStore,
	JsonlPersistenceRepo,
	PERSISTENCE_REF_CUSTOM_TYPE,
	PersistenceRegistry,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const CWD = "/root/projs/widi";
const ROOT = "/runs";

interface CounterState {
	readonly count: number;
}

function counterNamespace(
	options: {
		readonly namespace?: string;
		readonly forkPolicy?: PersistenceForkPolicy;
		readonly version?: number;
		readonly migrate?: PersistenceNamespaceDefinition["migrate"];
		readonly fork?: PersistenceNamespaceDefinition["fork"];
		readonly locate?: PersistenceNamespaceDefinition["locate"];
		/** Wraps the object log, for the cases that need to watch the handle. */
		readonly wrap?: (storage: JsonlObjectStore) => CustomStorage;
	} = {},
): PersistenceNamespaceDefinition {
	const namespace = options.namespace ?? "test:counter";
	const version = options.version ?? 1;
	return {
		namespace,
		version,
		forkPolicy: options.forkPolicy ?? "copy",
		migrate: options.migrate,
		fork: options.fork,
		locate: options.locate,
		async openStorage(context: NamespaceStorageContext) {
			const objects = await JsonlObjectStore.open({
				fs: context.fs,
				dirPath: context.dirPath,
				filePath: `${context.dirPath}/objects.jsonl`,
				namespace,
				formatVersion: version,
				sessionKey: context.sessionKey,
				diagnostics: context.diagnostics,
			});
			return options.wrap ? options.wrap(objects) : objects;
		},
	};
}

/** A namespace's own storage, wrapping the log only to watch its lifetime. */
class CountingStorage implements CustomStorage {
	private readonly _objects: JsonlObjectStore;
	closes = 0;

	constructor(objects: JsonlObjectStore) {
		this._objects = objects;
	}

	get storedFormatVersion(): number {
		return this._objects.storedFormatVersion;
	}

	async resolveState(stateRoot: string): Promise<unknown | undefined> {
		return await this._objects.resolveState(stateRoot);
	}

	async listDependencies(stateRoot: string): Promise<readonly string[]> {
		return await this._objects.listDependencies(stateRoot);
	}

	async copyReachable(target: CustomStorage, roots: readonly string[]): Promise<void> {
		await this._objects.copyReachable(target, roots);
	}

	async putObject(options: { readonly data: unknown; readonly dependencies?: readonly string[] }): Promise<string> {
		return await this._objects.putObject(options);
	}

	async close(): Promise<void> {
		this.closes += 1;
	}
}

function repoOver(fs: MemoryFileSystem, definitions: readonly PersistenceNamespaceDefinition[]): JsonlPersistenceRepo {
	const registry = new PersistenceRegistry();
	for (const definition of definitions) registry.register(definition);
	return new JsonlPersistenceRepo({ fs, root: ROOT, registry });
}

function makeRepo(definitions: readonly PersistenceNamespaceDefinition[] = [counterNamespace()]): {
	fs: MemoryFileSystem;
	repo: JsonlPersistenceRepo;
} {
	const fs = new MemoryFileSystem();
	return { fs, repo: repoOver(fs, definitions) };
}

/**
 * What the runtime does in two steps: stage the object, then put the ref on the
 * branch through the harness. Tests hold the session directly, so they append
 * it themselves.
 */
async function commitState(
	repo: JsonlPersistenceRepo,
	target: PersistedSession,
	namespace: string,
	data: unknown,
): Promise<void> {
	const ref = await repo.stageState({ address: target.address, namespace, data });
	await target.session.appendEntry({
		type: "custom",
		id: await target.session.createEntryId(),
		parentId: await target.session.getLeafId(),
		timestamp: new Date().toISOString(),
		customType: PERSISTENCE_REF_CUSTOM_TYPE,
		data: ref,
	});
}

async function say(target: PersistedSession, text: string): Promise<string> {
	const id = await target.session.createEntryId();
	const entry: SessionTreeEntry = {
		type: "message",
		id,
		parentId: await target.session.getLeafId(),
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	};
	await target.session.appendEntry(entry);
	return id;
}

function counted(
	states: ReadonlyMap<string, { readonly state: unknown }>,
	namespace = "test:counter",
): number | undefined {
	return (states.get(namespace)?.state as CounterState | undefined)?.count;
}

describe("sessions on disk", () => {
	it("nests a child under its parent and lists only roots", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const child = await repo.create({ cwd: CWD, sessionId: "child", parent: root.address.key });

		expect(child.address.key).toHaveLength(2);
		expect(await repo.sessionFilePath(child.address)).toContain("/agents/");
		expect(child.metadata.parentSessionPath).toBe(await repo.sessionFilePath(root.address));

		const roots = await repo.list({ cwd: CWD });
		expect(roots.map((info) => info.metadata.id)).toEqual(["root"]);
		const children = await repo.listChildren(root.address);
		expect(children.map((info) => info.metadata.id)).toEqual(["child"]);
		expect(await repo.listChildren(child.address)).toEqual([]);
	});

	it("lists newest first and skips a directory with no session", async () => {
		const { fs, repo } = makeRepo();
		await repo.create({ cwd: CWD, sessionId: "first" });
		await new Promise((resolve) => setTimeout(resolve, 2));
		await repo.create({ cwd: CWD, sessionId: "second" });
		await fs.createDir("/runs/--root-projs-widi--/not-a-session");

		const listed = await repo.list({ cwd: CWD });
		expect(listed.map((info) => info.metadata.id)).toEqual(["second", "first"]);
	});

	// Session ids do not repeat in practice - an AgentId carries four random
	// characters - but creating a session writes its header with `writeFile`, so
	// a name already in use would truncate the session that owns it rather than
	// fail. The check is what keeps that impossible instead of unlikely.
	it("never lands a new session on a directory that exists", async () => {
		const { repo } = makeRepo();
		const first = await repo.create({ cwd: CWD, sessionId: "root" });
		await say(first, "the first session");

		const second = await repo.create({ cwd: CWD, sessionId: "root" });

		expect(second.address.key).not.toEqual(first.address.key);
		expect((await (await repo.open(first.address)).session.getEntries()).length).toBe(1);
		expect(await (await repo.open(second.address)).session.getEntries()).toEqual([]);
		expect((await repo.list({ cwd: CWD })).length).toBe(2);
	});

	it("reopens a session and refuses one that is not there", async () => {
		const { repo } = makeRepo();
		const created = await repo.create({ cwd: CWD, sessionId: "root" });
		await say(created, "hello");

		const reopened = await repo.open(created.address);
		expect((await reopened.session.getEntries()).length).toBe(1);
		await expect(repo.open({ cwd: CWD, key: ["nothing"] })).rejects.toMatchObject({ code: "not_found" });
	});

	// The bug nesting exists to fix: the flat layout left a deleted root's
	// children on disk forever, reachable by nothing.
	it("deletes the whole subtree, storage included", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const child = await repo.create({ cwd: CWD, sessionId: "child", parent: root.address.key });
		await commitState(repo, child, "test:counter", { count: 1 });
		expect([...fs.files.keys()].some((p) => p.includes("objects.jsonl"))).toBe(true);

		await repo.delete(root.address);
		const rootDir = `/runs/--root-projs-widi--/${root.address.key[0]}`;
		expect([...fs.files.keys()].filter((p) => p.startsWith(rootDir))).toEqual([]);
		expect([...fs.dirs].filter((p) => p.startsWith(rootDir))).toEqual([]);
	});
});

describe("storage handles", () => {
	// Nothing caches a handle, so ownership is the whole lifetime rule: the
	// repository closes what it opened for itself and never what it handed out.
	it("closes what it opens and leaves the caller's handle alone", async () => {
		const opened: CountingStorage[] = [];
		const { repo } = makeRepo([
			counterNamespace({
				wrap: (objects) => {
					const storage = new CountingStorage(objects);
					opened.push(storage);
					return storage;
				},
			}),
		]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		await repo.resolveState(root.address);
		await repo.fork(root.address, { sessionId: "forked" });

		expect(opened.length).toBeGreaterThan(0);
		expect(opened.map((storage) => storage.closes)).toEqual(opened.map(() => 1));

		const mine = (await repo.openStorage(root.address, "test:counter")) as CountingStorage;
		expect(mine.closes).toBe(0);
		await closeStorage(mine);
		expect(mine.closes).toBe(1);
	});
});

describe("where a namespace lives", () => {
	it("rejects a name that is not of the form owner:name", async () => {
		const registry = new PersistenceRegistry();
		for (const namespace of ["counter", "test:", "Test:Counter", "../escape"]) {
			expect(() => registry.register(counterNamespace({ namespace }))).toThrow(/owner:name/);
		}
		expect(() => registry.register(counterNamespace())).not.toThrow();
	});

	// A namespace may put its directory anywhere; the repository reads and writes
	// where it is told and keeps forking through copyReachable, which never had
	// anything to do with copying a directory.
	it("puts a located namespace outside the session and still forks it", async () => {
		const { fs, repo } = makeRepo([
			counterNamespace({
				locate: ({ address, persistenceRoot }) => `${persistenceRoot}/elsewhere/${address.key.join("-")}`,
			}),
		]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 4 });

		const sessionDir = `/runs/--root-projs-widi--/${root.address.key[0]}`;
		expect([...fs.files.keys()].filter((path) => path.startsWith(sessionDir))).toEqual([`${sessionDir}/session.jsonl`]);
		expect(fs.files.has(`/runs/elsewhere/${root.address.key[0]}/objects.jsonl`)).toBe(true);
		expect(counted((await repo.resolveState(root.address)).states)).toBe(4);

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		expect(forked.diagnostics.entries).toEqual([]);
		expect(counted((await repo.resolveState(forked.session.address)).states)).toBe(4);
	});

	// Deleting a session deletes its directory, and that is all it ever did.
	// Reclaiming a directory the namespace placed is the namespace's problem.
	it("leaves a located directory behind when the session is deleted", async () => {
		const { fs, repo } = makeRepo([
			counterNamespace({ locate: ({ persistenceRoot }) => `${persistenceRoot}/elsewhere` }),
		]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 4 });

		await repo.delete(root.address);
		expect(fs.files.has("/runs/elsewhere/objects.jsonl")).toBe(true);
	});
});

describe("resolving a branch", () => {
	it("returns the state the branch points at, with its provenance", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		await commitState(repo, root, "test:counter", { count: 2 });

		const resolved = await repo.resolveState(root.address);
		expect(counted(resolved.states)).toBe(2);
		expect(resolved.states.get("test:counter")?.provenance).toBe("current");
		expect(resolved.diagnostics).toEqual([]);
	});

	// An extension uninstalled between the write and the read looks, from in
	// here, exactly like one that failed to load. So the ref and the directory
	// are left strictly alone and only the state goes unresolved.
	it("leaves an unregistered namespace alone and keeps reading", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		await say(root, "still here");
		const before = new Map(fs.files);

		const bare = repoOver(fs, []);
		const resolved = await bare.resolveState(root.address);
		expect(resolved.states.size).toBe(0);
		expect(resolved.diagnostics.map((entry) => entry.code)).toEqual(["persistence.unknown_namespace"]);
		expect(resolved.diagnostics.every((entry) => entry.severity !== "error")).toBe(true);
		expect(await (await bare.open(root.address)).session.getEntries()).toHaveLength(2);
		expect(fs.files).toEqual(before);

		// And it is still there once the extension comes back.
		expect(counted((await repo.resolveState(root.address)).states)).toBe(1);
	});

	it("reports an unresolvable namespace without losing the others", async () => {
		const { repo } = makeRepo([counterNamespace(), counterNamespace({ namespace: "test:other" })]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 7 });
		await root.session.appendEntry({
			type: "custom",
			id: await root.session.createEntryId(),
			parentId: await root.session.getLeafId(),
			timestamp: new Date().toISOString(),
			customType: PERSISTENCE_REF_CUSTOM_TYPE,
			data: { version: 1, namespace: "test:other", stateRoot: `sha256:${"0".repeat(64)}` },
		});

		const resolved = await repo.resolveState(root.address);
		expect(counted(resolved.states)).toBe(7);
		expect(resolved.states.has("test:other")).toBe(false);
		expect(resolved.diagnostics.map((entry) => entry.code)).toEqual(["persistence.dangling_ref"]);
	});

	it("migrates an older object and says so", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });

		const registry = new PersistenceRegistry();
		registry.register(
			counterNamespace({
				version: 2,
				async migrate({ stateRoot, storage }) {
					const old = (await storage.resolveState(stateRoot)) as CounterState;
					return await storage.putObject({ data: { count: old.count * 10 } });
				},
			}),
		);
		const upgraded = new JsonlPersistenceRepo({ fs, root: ROOT, registry });

		const resolved = await upgraded.resolveState(root.address);
		expect(counted(resolved.states)).toBe(10);
		expect(resolved.states.get("test:counter")?.provenance).toBe("migrated");
	});

	it("degrades an old object it has no migration for", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });

		const registry = new PersistenceRegistry();
		registry.register(counterNamespace({ version: 2 }));
		const upgraded = new JsonlPersistenceRepo({ fs, root: ROOT, registry });

		const resolved = await upgraded.resolveState(root.address);
		expect(resolved.states.size).toBe(0);
		expect(resolved.diagnostics.map((entry) => entry.code)).toEqual(["persistence.unsupported_version"]);
	});
});

describe("fork", () => {
	// The property the whole design is checked against.
	it("stands on its own after the source directory is deleted", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const child = await repo.create({ cwd: CWD, sessionId: "child", parent: root.address.key });
		await say(child, "child work");
		await commitState(repo, child, "test:counter", { count: 99 });
		await say(root, "root work");
		await commitState(repo, root, "test:counter", { count: 5 });

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		expect(forked.diagnostics.entries).toEqual([]);

		await repo.delete(root.address);
		expect([...fs.files.keys()].some((path) => path.includes(`/${root.address.key[0]}/`))).toBe(false);

		const resolved = await repo.resolveState(forked.session.address);
		expect(counted(resolved.states)).toBe(5);
		expect(resolved.states.get("test:counter")?.provenance).toBe("forked");

		const children = await repo.listChildren(forked.session.address);
		expect(children.map((info) => info.metadata.id)).toEqual(["child"]);
		const childState = await repo.resolveState(children[0]?.address as SessionAddress);
		expect(counted(childState.states)).toBe(99);
	});

	it("copies the conversation and lands at top level by default", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await say(root, "one");
		await say(root, "two");

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		expect(forked.session.address.key).toHaveLength(1);
		const messages = await forked.session.session.findEntries("message");
		expect(messages).toHaveLength(2);
		expect((await repo.list({ cwd: CWD })).length).toBe(2);
	});

	// Forking at an old entry has to see what that entry saw, which is the same
	// rule as rewinding - the fork just makes it permanent.
	it("carries only the state the fork point could see", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		const midpoint = await say(root, "fork here");
		await commitState(repo, root, "test:counter", { count: 2 });

		const forked = await repo.fork(root.address, { sessionId: "forked", entryId: midpoint });
		expect(counted((await repo.resolveState(forked.session.address)).states)).toBe(1);
		expect(counted((await repo.resolveState(root.address)).states)).toBe(2);
	});

	// Without a fork target the copied entries are every branch in file order,
	// and the last line of the file can belong to a branch that was abandoned.
	// Only the leaf's own branch says what the state is.
	it("takes the state from the leaf's branch, not the end of the file", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const start = await say(root, "start");
		await commitState(repo, root, "test:counter", { count: 1 });
		const kept = await root.session.getLeafId();

		await root.session.setLeafId(start);
		await say(root, "a road not taken");
		await commitState(repo, root, "test:counter", { count: 2 });
		await root.session.setLeafId(kept);

		expect(counted((await repo.resolveState(root.address)).states)).toBe(1);
		const forked = await repo.fork(root.address, { sessionId: "forked" });
		expect(counted((await repo.resolveState(forked.session.address)).states)).toBe(1);
		// The abandoned branch still comes along; it is history, not state.
		expect(await forked.session.session.findEntries("message")).toHaveLength(2);
	});

	it("leaves an omit namespace behind and keeps the rest", async () => {
		const { repo } = makeRepo([counterNamespace(), counterNamespace({ namespace: "test:live", forkPolicy: "omit" })]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		await commitState(repo, root, "test:live", { count: 2 });

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		const resolved = await repo.resolveState(forked.session.address);
		expect(counted(resolved.states)).toBe(1);
		expect(resolved.states.has("test:live")).toBe(false);
		expect(forked.diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.fork_omitted"]);
	});

	it("marks what a degrade policy rewrote", async () => {
		const { repo } = makeRepo([
			counterNamespace({
				namespace: "test:notes",
				forkPolicy: "degrade",
				// A live handle cannot survive the copy; the record of it can.
				async fork({ source, target, roots }) {
					const root = roots[0] as string;
					const state = (await source.resolveState(root)) as CounterState;
					return { stateRoot: await target.putObject({ data: { count: state.count, interrupted: true } }) };
				},
			}),
		]);
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:notes", { count: 3 });

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		const resolved = await repo.resolveState(forked.session.address);
		expect(resolved.states.get("test:notes")?.state).toEqual({ count: 3, interrupted: true });
		expect(resolved.states.get("test:notes")?.provenance).toBe("degraded");
		expect(counted((await repo.resolveState(root.address)).states, "test:notes")).toBe(3);
	});

	// Rewinding decides what the conversation and the namespace states say, and
	// nothing else: no record anywhere names a child session, so the directory
	// listing is the only account of which children exist. A child spawned after
	// the fork point comes along, disposed like every other one.
	it("carries every child on disk, fork point or not", async () => {
		const { repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await repo.create({ cwd: CWD, sessionId: "early", parent: root.address.key });
		await commitState(repo, root, "test:counter", { count: 1 });
		const midpoint = await say(root, "fork here");
		await repo.create({ cwd: CWD, sessionId: "late", parent: root.address.key });
		await commitState(repo, root, "test:counter", { count: 2 });

		const forked = await repo.fork(root.address, { sessionId: "forked", entryId: midpoint });
		const children = await repo.listChildren(forked.session.address);
		expect(children.map((info) => info.metadata.id).sort()).toEqual(["early", "late"]);
		expect(counted((await repo.resolveState(forked.session.address)).states)).toBe(1);
	});

	it("writes nothing into the source", async () => {
		const { fs, repo } = makeRepo();
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await commitState(repo, root, "test:counter", { count: 1 });
		const sourcePrefix = `/runs/--root-projs-widi--/${root.address.key[0]}`;
		const before = new Map([...fs.files].filter(([path]) => path.startsWith(sourcePrefix)));

		await repo.fork(root.address, { sessionId: "forked" });

		const after = new Map([...fs.files].filter(([path]) => path.startsWith(sourcePrefix)));
		expect(after).toEqual(before);
	});
});
