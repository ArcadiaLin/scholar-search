/**
 * What a fork has to copy, worked out before anything is copied.
 *
 * Forking is the operation that decides whether the model is real. A forked
 * session either stands on its own - readable and restorable after the source
 * directory is deleted - or the persistence layer is just a cache of the
 * original. So the closure is computed first, as a plan, and the copy is a
 * mechanical execution of it.
 *
 * The walk lives here and only here. A namespace declares its dependencies and
 * never recurses itself, which is what keeps deduplication and cycle detection
 * to one implementation instead of one per kind of state.
 *
 * The closure is over objects, all of them inside one namespace's storage. The
 * child sessions nested under the source are not part of it: they are copied
 * wholesale by the repository, because nothing on a branch decides which of them
 * belong to it. See `notes/develop/ZH/agent-tree-persistence.md`.
 */

import type { CustomStorage, PersistenceForkPolicy, PersistenceRegistry } from "../custom-storage.ts";
import { closeStorage } from "../custom-storage.ts";
import type { PersistenceDiagnostics } from "./diagnostics.ts";
import { formatSessionKey, type SessionKey } from "./layout.ts";

export interface NamespaceForkPlan {
	readonly namespace: string;
	readonly policy: PersistenceForkPolicy;
	readonly stateRoot: string;
	/** Every object to copy, deduplicated, dependencies included. */
	readonly objects: readonly string[];
}

export interface ForkPlan {
	readonly namespaces: readonly NamespaceForkPlan[];
}

export interface ForkClosureRequest {
	/** State roots visible on the forked branch, from `projectBranch`. */
	readonly roots: ReadonlyMap<string, string>;
	readonly registry: PersistenceRegistry;
	/**
	 * Opens the source session's storage for a namespace.
	 *
	 * The plan holds no handle once it is built, so each storage opened here is
	 * closed here too - the caller injects the opening policy, not the lifetime.
	 */
	openStorage(namespace: string): Promise<CustomStorage | undefined>;
	readonly sourceKey: SessionKey;
	readonly diagnostics: PersistenceDiagnostics;
}

/**
 * Close over everything the forked branch names.
 *
 * Nothing here throws for missing or unknown state. A namespace this build does
 * not know, an object that is not there, a cycle - each is reported and the
 * rest of the plan is still produced, because a fork that carries most of the
 * state is worth more than one that refuses to happen.
 */
export async function planForkClosure(request: ForkClosureRequest): Promise<ForkPlan> {
	const namespaces: NamespaceForkPlan[] = [];

	for (const [namespace, stateRoot] of request.roots) {
		const definition = request.registry.get(namespace);
		if (!definition) {
			request.diagnostics.report({
				severity: "warning",
				code: "persistence.unknown_namespace",
				message: `Nothing is registered for ${namespace}; its state was not carried into the fork.`,
				namespace,
				stateRoot,
				sessionKey: request.sourceKey,
			});
			continue;
		}
		if (definition.forkPolicy === "omit") {
			request.diagnostics.report({
				severity: "warning",
				code: "persistence.fork_omitted",
				message: `${namespace} is not fork-copyable and was left out.`,
				namespace,
				sessionKey: request.sourceKey,
			});
			continue;
		}
		const storage = await request.openStorage(namespace);
		if (!storage) {
			request.diagnostics.report({
				severity: "warning",
				code: "persistence.dangling_ref",
				message: `${namespace} has no storage in ${formatSessionKey(request.sourceKey)}, but a ref names ${stateRoot}.`,
				namespace,
				stateRoot,
				sessionKey: request.sourceKey,
			});
			continue;
		}
		let objects: string[];
		try {
			objects = await walkNamespace({
				namespace,
				stateRoot,
				storage,
				sourceKey: request.sourceKey,
				diagnostics: request.diagnostics,
			});
		} finally {
			await closeStorage(storage);
		}
		namespaces.push({ namespace, policy: definition.forkPolicy, stateRoot, objects });
	}

	return { namespaces };
}

async function walkNamespace(options: {
	readonly namespace: string;
	readonly stateRoot: string;
	readonly storage: CustomStorage;
	readonly sourceKey: SessionKey;
	readonly diagnostics: PersistenceDiagnostics;
}): Promise<string[]> {
	const objects: string[] = [];
	// Visited is keyed by state root within one namespace's storage. Two refs
	// naming one root is the ordinary case, and it must cost one copy.
	const visited = new Set<string>();
	// On the current path, so a cycle is distinguishable from a diamond.
	const onPath = new Set<string>();

	const visit = async (root: string): Promise<void> => {
		if (onPath.has(root)) {
			options.diagnostics.report({
				severity: "error",
				code: "persistence.dependency_cycle",
				message: `${options.namespace} has a dependency cycle at ${root}; the walk stopped there.`,
				namespace: options.namespace,
				stateRoot: root,
				sessionKey: options.sourceKey,
			});
			return;
		}
		if (visited.has(root)) return;
		const state = await options.storage.resolveState(root);
		if (state === undefined) {
			options.diagnostics.report({
				severity: "warning",
				code: "persistence.dangling_ref",
				message: `${options.namespace} has no object ${root}; the fork carries the state without it.`,
				namespace: options.namespace,
				stateRoot: root,
				sessionKey: options.sourceKey,
			});
			return;
		}
		visited.add(root);
		onPath.add(root);
		objects.push(root);
		for (const dependency of await options.storage.listDependencies(root)) {
			await visit(dependency);
		}
		onPath.delete(root);
	};

	await visit(options.stateRoot);
	return objects;
}
