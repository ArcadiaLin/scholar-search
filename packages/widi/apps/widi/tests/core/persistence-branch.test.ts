/**
 * The recovery rule: what a branch says each namespace's state is.
 *
 * Everything here is pure over session entries, which is the point - rewind,
 * override, clear and rejection all have to be provable without a session file
 * or a runtime.
 */

import type { SessionTreeEntry } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import {
	contentHash,
	createPersistenceRefData,
	isNativeOrigin,
	MAX_PERSISTENCE_REF_BYTES,
	PERSISTENCE_REF_CUSTOM_TYPE,
	parsePersistenceRef,
	projectBranch,
	projectionToForkRoots,
} from "../../src/core/persistence/index.ts";

const ROOT_A = contentHash({ state: "a" });
const ROOT_B = contentHash({ state: "b" });
const ROOT_C = contentHash({ state: "c" });

let nextId = 0;

function refEntry(
	namespace: string,
	stateRoot: string | null,
	parentId: string | null = null,
	origin?: string,
): SessionTreeEntry {
	nextId += 1;
	return {
		type: "custom",
		id: `e${nextId}`,
		parentId,
		timestamp: `2026-08-01T00:00:${String(nextId).padStart(2, "0")}.000Z`,
		customType: PERSISTENCE_REF_CUSTOM_TYPE,
		data: { version: 1, namespace, stateRoot, origin },
	};
}

function customEntry(customType: string, data: unknown): SessionTreeEntry {
	nextId += 1;
	return { type: "custom", id: `e${nextId}`, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", customType, data };
}

describe("persistence ref parsing", () => {
	it("ignores entries that are not refs", () => {
		expect(
			parsePersistenceRef({
				type: "session_info",
				id: "x",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				name: "demo",
			}),
		).toBeUndefined();
		expect(parsePersistenceRef(customEntry("core:extension_message", {}))).toBeUndefined();
	});

	it("accepts a well-formed ref, including a clearing one", () => {
		const parsed = parsePersistenceRef(refEntry("test:counter", ROOT_A));
		expect(parsed?.ok).toBe(true);
		if (parsed?.ok) {
			expect(parsed.ref.namespace).toBe("test:counter");
			expect(parsed.ref.stateRoot).toBe(ROOT_A);
		}
		const cleared = parsePersistenceRef(refEntry("test:counter", null));
		expect(cleared?.ok).toBe(true);
	});

	it("rejects rather than throws on anything malformed", () => {
		const cases: Array<[string, unknown]> = [
			["wrong version", { version: 99, namespace: "n", stateRoot: ROOT_A }],
			["missing namespace", { version: 1, stateRoot: ROOT_A }],
			["state root is not a hash", { version: 1, namespace: "n", stateRoot: "x" }],
			["data is not an object", "nope"],
			["origin is not a string", { version: 1, namespace: "n", stateRoot: ROOT_A, origin: 7 }],
		];
		for (const [, data] of cases) {
			const parsed = parsePersistenceRef(customEntry(PERSISTENCE_REF_CUSTOM_TYPE, data));
			expect(parsed?.ok).toBe(false);
		}
	});

	// Absent, not "current": a ref a session wrote for itself says nothing about
	// origin, which keeps the ordinary case the smallest thing on the branch.
	it("omits an origin unless a fork put one there", () => {
		expect(createPersistenceRefData({ namespace: "n", stateRoot: ROOT_A })).not.toHaveProperty("origin");
		expect(createPersistenceRefData({ namespace: "n", stateRoot: ROOT_A, origin: "fork_degraded" }).origin).toBe(
			"fork_degraded",
		);
	});

	it("refuses to build a ref that is not a pointer", () => {
		expect(() => createPersistenceRefData({ namespace: "n", stateRoot: "not-a-hash" })).toThrow();
		expect(() =>
			createPersistenceRefData({
				namespace: "n",
				stateRoot: ROOT_A,
				anchorEntryId: "x".repeat(MAX_PERSISTENCE_REF_BYTES),
			}),
		).toThrow();
	});
});

describe("branch projection", () => {
	it("takes the last ref of each namespace on the path", () => {
		const branch = [refEntry("test:counter", ROOT_A), refEntry("test:other", ROOT_C), refEntry("test:counter", ROOT_B)];
		const projection = projectBranch(branch);
		expect(projection.namespaces.get("test:counter")?.stateRoot).toBe(ROOT_B);
		expect(projection.namespaces.get("test:other")?.stateRoot).toBe(ROOT_C);
		expect(projection.namespaces.get("test:counter")?.refs).toHaveLength(2);
	});

	// The rewind case, which is the whole reason the state lives on the tree: an
	// older branch never sees a ref written on a newer one.
	it("resolves an older branch to what that branch could see", () => {
		const early = refEntry("test:counter", ROOT_A);
		const late = refEntry("test:counter", ROOT_B, early.id);
		expect(projectBranch([early]).namespaces.get("test:counter")?.stateRoot).toBe(ROOT_A);
		expect(projectBranch([early, late]).namespaces.get("test:counter")?.stateRoot).toBe(ROOT_B);
	});

	it("lets a ref clear its namespace", () => {
		const projection = projectBranch([refEntry("test:counter", ROOT_A), refEntry("test:counter", null)]);
		expect(projection.namespaces.get("test:counter")?.stateRoot).toBeNull();
		expect(projectionToForkRoots(projection).has("test:counter")).toBe(false);
	});

	it("keeps a broken ref from taking anything else down with it", () => {
		const projection = projectBranch([
			refEntry("test:counter", ROOT_A),
			customEntry(PERSISTENCE_REF_CUSTOM_TYPE, { version: 1 }),
			refEntry("test:other", ROOT_C),
		]);
		expect(projection.rejected).toHaveLength(1);
		expect(projection.namespaces.get("test:counter")?.stateRoot).toBe(ROOT_A);
		expect(projection.namespaces.get("test:other")?.stateRoot).toBe(ROOT_C);
	});

	// Provenance is the one thing the caller needs and cannot derive: after a
	// fork the session goes on writing its own refs, so this is per namespace
	// and per ref, never a property of the session.
	it("tells inherited state from state the branch wrote itself", () => {
		const projection = projectBranch([
			refEntry("test:copied", ROOT_A, null, "fork"),
			refEntry("test:degraded", ROOT_B, null, "fork_degraded"),
			refEntry("test:own", ROOT_C),
		]);
		expect(projection.namespaces.get("test:copied")?.provenance).toBe("forked");
		expect(projection.namespaces.get("test:degraded")?.provenance).toBe("degraded");
		expect(projection.namespaces.get("test:own")?.provenance).toBe("current");
	});

	it("lets a session take ownership by writing over an inherited ref", () => {
		const inherited = refEntry("test:counter", ROOT_A, null, "fork");
		const own = refEntry("test:counter", ROOT_B, inherited.id);
		expect(projectBranch([inherited, own]).namespaces.get("test:counter")?.provenance).toBe("current");
	});

	// An origin a newer build invented must not read as native, or a caller
	// would trust handles inside state that was never its own.
	it("treats an origin it does not know as not native", () => {
		expect(isNativeOrigin(undefined)).toBe(true);
		expect(isNativeOrigin("fork")).toBe(false);
		expect(isNativeOrigin("imported-from-somewhere-2027")).toBe(false);
		const projection = projectBranch([refEntry("test:counter", ROOT_A, null, "imported-from-somewhere-2027")]);
		expect(projection.namespaces.get("test:counter")?.provenance).toBe("forked");
		expect(projection.rejected).toHaveLength(0);
	});

	it("carries only the namespaces a fork has to copy", () => {
		const roots = projectionToForkRoots(
			projectBranch([refEntry("test:counter", ROOT_A), refEntry("test:other", null)]),
		);
		expect([...roots]).toEqual([["test:counter", ROOT_A]]);
	});
});
