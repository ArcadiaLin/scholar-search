/**
 * What a fork carries, worked out before anything is copied.
 *
 * Exercised through a `test:counter` namespace that owns nothing outside the
 * session, so what is being checked is the framework's walk rather than any
 * namespace's judgement: one copy per shared object, a cycle stopped and named,
 * and a missing or unknown piece degrading instead of taking the fork down.
 */

import { describe, expect, it } from "vitest";
import type {
	CustomStorage,
	NamespaceStorageContext,
	PersistenceNamespaceDefinition,
	SessionKey,
} from "../../src/core/persistence/index.ts";
import {
	JsonlObjectStore,
	PersistenceDiagnostics,
	PersistenceRegistry,
	planForkClosure,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const SOURCE_KEY: SessionKey = ["root"];

/** A minimal namespace storage, so the closure has objects to walk. */
class CounterStorage implements CustomStorage {
	private readonly _objects: JsonlObjectStore;

	constructor(objects: JsonlObjectStore) {
		this._objects = objects;
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
}

function counterNamespace(
	options: { readonly namespace?: string; readonly forkPolicy?: "copy" | "omit" | "degrade" } = {},
): PersistenceNamespaceDefinition {
	const namespace = options.namespace ?? "test:counter";
	return {
		namespace,
		version: 1,
		forkPolicy: options.forkPolicy ?? "copy",
		async openStorage(context: NamespaceStorageContext) {
			return new CounterStorage(
				await JsonlObjectStore.open({
					fs: context.fs as MemoryFileSystem,
					dirPath: context.dirPath,
					filePath: `${context.dirPath}/objects.jsonl`,
					namespace,
					formatVersion: 1,
					sessionKey: context.sessionKey,
					diagnostics: context.diagnostics,
				}),
			);
		},
	};
}

async function openCounterStorage(
	fs: MemoryFileSystem,
	dirPath = "/runs/root/persistence/test__counter",
): Promise<CounterStorage> {
	return new CounterStorage(
		await JsonlObjectStore.open({
			fs,
			dirPath,
			filePath: `${dirPath}/objects.jsonl`,
			namespace: "test:counter",
			formatVersion: 1,
			sessionKey: SOURCE_KEY,
		}),
	);
}

describe("fork closure", () => {
	it("copies a shared dependency once", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openCounterStorage(fs);
		const shared = await storage.putObject({ data: { count: 0 } });
		const left = await storage.putObject({ data: { count: 1 }, dependencies: [shared] });
		const right = await storage.putObject({ data: { count: 2 }, dependencies: [shared] });
		const top = await storage.putObject({ data: { count: 3 }, dependencies: [left, right] });

		const registry = new PersistenceRegistry();
		registry.register(counterNamespace());
		const diagnostics = new PersistenceDiagnostics();
		const plan = await planForkClosure({
			roots: new Map([["test:counter", top]]),
			registry,
			openStorage: async () => storage,
			sourceKey: SOURCE_KEY,
			diagnostics,
		});

		const objects = plan.namespaces[0]?.objects ?? [];
		expect([...objects].sort()).toEqual([shared, left, right, top].sort());
		expect(new Set(objects).size).toBe(objects.length);
		expect(diagnostics.entries).toHaveLength(0);
	});

	it("stops at a dependency cycle and names it", async () => {
		const fs = new MemoryFileSystem();
		const dirPath = "/runs/root/persistence/test__counter";
		// Content addressing cannot produce a cycle, so this is planted by hand:
		// the walk still has to survive a log that somebody else corrupted.
		await fs.writeFile(
			`${dirPath}/objects.jsonl`,
			[
				JSON.stringify({ type: "persistence-objects", version: 1, namespace: "test:counter", formatVersion: 1 }),
				JSON.stringify({ id: "sha256:a", deps: ["sha256:b"], data: {} }),
				JSON.stringify({ id: "sha256:b", deps: ["sha256:a"], data: {} }),
				"",
			].join("\n"),
		);
		const storage = await openCounterStorage(fs, dirPath);

		const registry = new PersistenceRegistry();
		registry.register(counterNamespace());
		const diagnostics = new PersistenceDiagnostics();
		const plan = await planForkClosure({
			roots: new Map([["test:counter", "sha256:a"]]),
			registry,
			openStorage: async () => storage,
			sourceKey: SOURCE_KEY,
			diagnostics,
		});

		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.dependency_cycle"]);
		expect([...(plan.namespaces[0]?.objects ?? [])].sort()).toEqual(["sha256:a", "sha256:b"]);
	});

	it("reports a missing object and keeps the rest of the plan", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openCounterStorage(fs);
		const present = await storage.putObject({ data: { count: 1 } });
		const top = await storage.putObject({ data: { count: 2 }, dependencies: [present, "sha256:gone"] });

		const registry = new PersistenceRegistry();
		registry.register(counterNamespace());
		const diagnostics = new PersistenceDiagnostics();
		const plan = await planForkClosure({
			roots: new Map([["test:counter", top]]),
			registry,
			openStorage: async () => storage,
			sourceKey: SOURCE_KEY,
			diagnostics,
		});

		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.dangling_ref"]);
		expect([...(plan.namespaces[0]?.objects ?? [])].sort()).toEqual([present, top].sort());
	});

	it("leaves an omit namespace out", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openCounterStorage(fs);
		const root = await storage.putObject({ data: { count: 1 } });

		const registry = new PersistenceRegistry();
		registry.register(counterNamespace({ forkPolicy: "omit" }));
		const diagnostics = new PersistenceDiagnostics();
		const plan = await planForkClosure({
			roots: new Map([["test:counter", root]]),
			registry,
			openStorage: async () => storage,
			sourceKey: SOURCE_KEY,
			diagnostics,
		});

		expect(plan.namespaces).toHaveLength(0);
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.fork_omitted"]);
	});

	// An old build reading a session a newer one wrote must still fork it.
	it("skips a namespace nothing is registered for", async () => {
		const diagnostics = new PersistenceDiagnostics();
		const plan = await planForkClosure({
			roots: new Map([["future:thing", "sha256:x"]]),
			registry: new PersistenceRegistry(),
			openStorage: async () => undefined,
			sourceKey: SOURCE_KEY,
			diagnostics,
		});

		expect(plan.namespaces).toHaveLength(0);
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.unknown_namespace"]);
	});
});
