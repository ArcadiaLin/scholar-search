/**
 * The layout rules that everything else assumes: a session owns its children as
 * directories, and a session key survives the round trip through a path.
 */

import { describe, expect, it } from "vitest";
import {
	canNestUnder,
	canonicalJson,
	childSessionKey,
	contentHash,
	createSessionDirName,
	encodeCwd,
	isContentHash,
	MAX_SESSION_DEPTH,
	namespaceDirSegments,
	namespaceObjectsSegments,
	parentSessionKey,
	parseSessionKey,
	sessionDirSegments,
	sessionFileSegments,
	sessionKeyFromDirSegments,
	sessionKeysEqual,
} from "../../src/core/persistence/index.ts";

describe("session layout", () => {
	it("nests every level under an agents container", () => {
		expect(sessionDirSegments(["root"])).toEqual(["root"]);
		expect(sessionDirSegments(["root", "child", "grandchild"])).toEqual([
			"root",
			"agents",
			"child",
			"agents",
			"grandchild",
		]);
		expect(sessionFileSegments(["root", "child"])).toEqual(["root", "agents", "child", "session.jsonl"]);
	});

	it("round trips a key through its directory segments", () => {
		const key = ["root", "child", "grandchild"];
		const back = sessionKeyFromDirSegments(sessionDirSegments(key));
		expect(back).toBeDefined();
		expect(sessionKeysEqual(back ?? [], key)).toBe(true);
	});

	// The container is what makes this decidable: without it, walking into a
	// session directory could not tell a child session from persistence/.
	it("refuses directory segments that are not a session path", () => {
		expect(sessionKeyFromDirSegments(["root", "persistence"])).toBeUndefined();
		expect(sessionKeyFromDirSegments(["root", "persistence", "x"])).toBeUndefined();
		expect(sessionKeyFromDirSegments(["root", "agents"])).toBeUndefined();
		expect(sessionKeyFromDirSegments([])).toBeUndefined();
		expect(sessionKeyFromDirSegments(["agents", "agents", "x"])).toBeUndefined();
	});

	it("keeps a timestamp prefix so a reused agent id cannot collide", () => {
		const first = createSessionDirName("coder-1", "2026-08-01T12:03:45.678Z");
		const second = createSessionDirName("coder-1", "2026-08-02T09:00:00.000Z");
		expect(first).toBe("20260801T120345Z_coder-1");
		expect(first).not.toBe(second);
	});

	it("walks up and down the tree", () => {
		const root = ["a"];
		const child = childSessionKey(root, "b");
		expect(child).toEqual(["a", "b"]);
		expect(parentSessionKey(child)).toEqual(["a"]);
		expect(parentSessionKey(root)).toBeUndefined();
	});

	it("stops nesting at the depth limit", () => {
		const deep = Array.from({ length: MAX_SESSION_DEPTH }, (_, i) => `s${i}`);
		expect(canNestUnder(deep.slice(0, -1))).toBe(true);
		expect(canNestUnder(deep)).toBe(false);
	});

	it("rejects a parsed key that names a reserved directory or is too deep", () => {
		expect(parseSessionKey("root/child")).toEqual(["root", "child"]);
		expect(parseSessionKey("root/persistence")).toBeUndefined();
		expect(parseSessionKey("")).toBeUndefined();
		expect(parseSessionKey(Array.from({ length: MAX_SESSION_DEPTH + 1 }, (_, i) => `s${i}`).join("/"))).toBeUndefined();
	});

	// ':' is not a legal Windows path character, and collapsing it to '-' would
	// let core:notes and a hypothetical core-notes share a directory.
	it("encodes a namespace into a portable directory name", () => {
		expect(namespaceDirSegments(["root"], "core:notes")).toEqual(["root", "persistence", "core__notes"]);
		expect(namespaceDirSegments(["root"], "core-notes")).not.toEqual(namespaceDirSegments(["root"], "core:notes"));
		expect(namespaceObjectsSegments(["root"], "core:notes")).toEqual([
			"root",
			"persistence",
			"core__notes",
			"objects.jsonl",
		]);
	});

	it("turns a cwd into one path segment", () => {
		expect(encodeCwd("/home/me/projects/widi")).toBe("--home-me-projects-widi--");
	});
});

describe("content addressing", () => {
	it("hashes independently of key order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1 }));
	});

	it("keeps array order significant", () => {
		expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
	});

	// JSON.stringify would drop these silently, which would let two different
	// states share one immutable identity.
	it("refuses values it cannot represent", () => {
		expect(() => canonicalJson(undefined)).toThrow();
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson({ fn: () => 1 })).toThrow();
	});

	it("drops undefined properties rather than encoding a hole", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	it("recognizes its own hashes only", () => {
		expect(isContentHash(contentHash({}))).toBe(true);
		expect(isContentHash("sha256:zz")).toBe(false);
		expect(isContentHash("deadbeef")).toBe(false);
	});
});
