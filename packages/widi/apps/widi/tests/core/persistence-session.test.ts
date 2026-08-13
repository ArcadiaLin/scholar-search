/**
 * The port of pi's session storage, checked against pi's session storage.
 *
 * A fixture assertion would only prove the port matches what this file expects.
 * Running both implementations over the same bytes proves the thing that
 * matters - an existing session keeps opening, and what WIDI writes keeps
 * opening upstream - and it keeps proving it when upstream moves.
 *
 * The two intended divergences get their own tests at the bottom.
 */

import { JsonlSessionStorage, type SessionTreeEntry } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import {
	contentHash,
	getEntriesToFork,
	getFullBranch,
	JsonlSession,
	PERSISTENCE_REF_CUSTOM_TYPE,
	projectBranch,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const PATH = "/runs/--w--/20260801T000000Z_widi-dev/session.jsonl";

const ROOT_EARLY = contentHash({ state: "early" });
const ROOT_LATE = contentHash({ state: "late" });

const HEADER = {
	type: "session",
	version: 3,
	id: "widi-dev",
	timestamp: "2026-08-01T00:00:00.000Z",
	cwd: "/root/projs/widi",
	metadata: { profile: { id: "widi-dev", label: "WIDI Dev" } },
};

function usage(input: number, output: number) {
	return {
		input,
		output,
		cacheRead: 2,
		cacheWrite: 3,
		reasoning: 0,
		totalTokens: input + output + 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	};
}

/**
 * Every entry type a real session carries, arranged so the compaction sits
 * above one persistence ref and below another.
 */
const ENTRIES: unknown[] = [
	{
		type: "message",
		id: "u1000000",
		parentId: null,
		timestamp: "2026-08-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1785204441457 },
	},
	{
		type: "message",
		id: "a1000000",
		parentId: "u1000000",
		timestamp: "2026-08-01T00:00:02.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: usage(100, 10) },
	},
	{
		type: "custom",
		id: "r1000000",
		parentId: "a1000000",
		timestamp: "2026-08-01T00:00:03.000Z",
		customType: PERSISTENCE_REF_CUSTOM_TYPE,
		data: { version: 1, namespace: "test:early", stateRoot: ROOT_EARLY },
	},
	{
		type: "label",
		id: "l1000000",
		parentId: "r1000000",
		timestamp: "2026-08-01T00:00:04.000Z",
		targetId: "a1000000",
		label: "  first answer  ",
	},
	{
		type: "session_info",
		id: "s1000000",
		parentId: "l1000000",
		timestamp: "2026-08-01T00:00:05.000Z",
		name: "  ported session  ",
	},
	{
		type: "model_change",
		id: "m1000000",
		parentId: "s1000000",
		timestamp: "2026-08-01T00:00:06.000Z",
		provider: "kimi-coding",
		modelId: "k3",
	},
	{
		type: "compaction",
		id: "c1000000",
		parentId: "m1000000",
		timestamp: "2026-08-01T00:00:07.000Z",
		firstKeptEntryId: "s1000000",
		tokensBefore: 12056,
		usage: usage(200, 20),
	},
	{
		type: "message",
		id: "u2000000",
		parentId: "c1000000",
		timestamp: "2026-08-01T00:00:08.000Z",
		message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 1785204441458 },
	},
	{
		type: "message",
		id: "a2000000",
		parentId: "u2000000",
		timestamp: "2026-08-01T00:00:09.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "sure" }], usage: usage(300, 30) },
	},
	{
		type: "custom",
		id: "r2000000",
		parentId: "a2000000",
		timestamp: "2026-08-01T00:00:10.000Z",
		customType: PERSISTENCE_REF_CUSTOM_TYPE,
		data: { version: 1, namespace: "test:late", stateRoot: ROOT_LATE },
	},
	{ type: "leaf", id: "f1000000", parentId: "r2000000", timestamp: "2026-08-01T00:00:11.000Z", targetId: "a1000000" },
];

function fixture(lines: readonly unknown[] = [HEADER, ...ENTRIES]): MemoryFileSystem {
	const fs = new MemoryFileSystem();
	fs.files.set(PATH, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return fs;
}

async function bothOpen(fs: MemoryFileSystem): Promise<[JsonlSession, JsonlSessionStorage]> {
	return [await JsonlSession.open(fs, PATH), await JsonlSessionStorage.open(fs, PATH)];
}

async function errorCodes(fs: MemoryFileSystem): Promise<[string | undefined, string | undefined]> {
	const codeOf = async (open: () => Promise<unknown>) => {
		try {
			await open();
			return undefined;
		} catch (error) {
			return (error as { code?: string }).code;
		}
	};
	return [await codeOf(() => JsonlSession.open(fs, PATH)), await codeOf(() => JsonlSessionStorage.open(fs, PATH))];
}

describe("JsonlSession against pi's storage", () => {
	it("reads the same metadata, entries, leaf and stats", async () => {
		const [widi, pi] = await bothOpen(fixture());
		expect(await widi.getMetadata()).toEqual(await pi.getMetadata());
		expect(await widi.getEntries()).toEqual(await pi.getEntries());
		expect(await widi.getLeafId()).toEqual(await pi.getLeafId());
		expect(await widi.getSessionStats()).toEqual(await pi.getSessionStats());
		expect(await widi.getSessionName()).toEqual(await pi.getSessionName());
		expect(await widi.getLabel("a1000000")).toEqual(await pi.getLabel("a1000000"));
	});

	it("resolves the same entry lookups and cursors", async () => {
		const [widi, pi] = await bothOpen(fixture());
		expect(await widi.getEntry("c1000000")).toEqual(await pi.getEntry("c1000000"));
		expect(await widi.getEntry("nothing")).toBeUndefined();
		expect(await widi.findEntries("message")).toEqual(await pi.findEntries("message"));
		expect(await widi.findEntries("custom")).toEqual(await pi.findEntries("custom"));
		expect(await widi.getEntries({ afterEntrySeq: 3, limit: 2 })).toEqual(
			await pi.getEntries({ afterEntrySeq: 3, limit: 2 }),
		);
	});

	it("truncates at a compaction the same way", async () => {
		const [widi, pi] = await bothOpen(fixture());
		for (const leaf of ["a2000000", "a1000000", null]) {
			expect(await widi.getPathToRootOrCompaction(leaf)).toEqual(await pi.getPathToRootOrCompaction(leaf));
		}
	});

	it("writes a header pi opens, and appends pi reads back", async () => {
		const fs = new MemoryFileSystem();
		const created = await JsonlSession.create(fs, PATH, {
			cwd: "/root/projs/widi",
			sessionId: "widi-dev",
			parentSessionPath: "/runs/--w--/parent/session.jsonl",
			metadata: { profile: "dev" },
		});
		const entry: SessionTreeEntry = {
			type: "message",
			id: await created.createEntryId(),
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1785204441457 },
		};
		await created.appendEntry(entry);
		await created.setLeafId(entry.id);

		const pi = await JsonlSessionStorage.open(fs, PATH);
		expect(await pi.getMetadata()).toEqual(await created.getMetadata());
		expect(await pi.getEntries()).toEqual(await created.getEntries());
		expect(await pi.getLeafId()).toBe(entry.id);
	});

	it("reads a session pi wrote", async () => {
		const fs = new MemoryFileSystem();
		const pi = await JsonlSessionStorage.create(fs, PATH, { cwd: "/root/projs/widi", sessionId: "widi-dev" });
		const id = await pi.createEntryId();
		await pi.appendEntry({
			type: "session_info",
			id,
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			name: "from pi",
		});

		const widi = await JsonlSession.open(fs, PATH);
		expect(await widi.getSessionName()).toBe("from pi");
		expect(await widi.getLeafId()).toBe(id);
		expect(await widi.getMetadata()).toEqual(await pi.getMetadata());
	});

	it("rejects the same damage with the same code", async () => {
		expect(await errorCodes(fixture([]))).toEqual(["invalid_session", "invalid_session"]);
		expect(await errorCodes(fixture(["not json at all"]))).toEqual(["invalid_session", "invalid_session"]);
		expect(await errorCodes(fixture([{ ...HEADER, version: 2 }]))).toEqual(["invalid_session", "invalid_session"]);
		expect(await errorCodes(fixture([{ ...HEADER, cwd: "" }]))).toEqual(["invalid_session", "invalid_session"]);
		expect(await errorCodes(fixture([HEADER, { type: "message", id: "x" }]))).toEqual([
			"invalid_entry",
			"invalid_entry",
		]);
	});

	it("generates entry ids that avoid the ones already used", async () => {
		const [widi] = await bothOpen(fixture());
		const existing = new Set((await widi.getEntries()).map((entry) => entry.id));
		for (let i = 0; i < 50; i++) {
			expect(existing.has(await widi.createEntryId())).toBe(false);
		}
	});
});

describe("what the port deliberately does not inherit", () => {
	// The reason this file exists. A ref above a compaction checkpoint is still
	// in force, so persistence walking pi's path would restore a session to a
	// state it left behind.
	it("keeps refs pi's path drops at the checkpoint", async () => {
		const [widi, pi] = await bothOpen(fixture());
		const entries = await widi.getEntries();

		const truncated = projectBranch(await pi.getPathToRootOrCompaction("r2000000"));
		expect([...truncated.namespaces.keys()]).toEqual(["test:late"]);

		const full = projectBranch(getFullBranch(entries, "r2000000"));
		expect(full.namespaces.get("test:early")?.stateRoot).toBe(ROOT_EARLY);
		expect(full.namespaces.get("test:late")?.stateRoot).toBe(ROOT_LATE);
	});

	// pi refuses the whole file. This log is appended to on every message, so a
	// killed run would cost the conversation - and the layer promises recovery
	// always produces a readable one.
	it("opens past a torn last line pi refuses", async () => {
		const fs = fixture();
		fs.files.set(PATH, `${fs.files.get(PATH) ?? ""}{"type":"message","id":"u3000`);

		const widi = await JsonlSession.open(fs, PATH);
		expect((await widi.getEntries()).map((entry) => entry.id)).toEqual(
			ENTRIES.map((entry) => (entry as { id: string }).id),
		);
		expect(widi.recoveredTornTail).toBe('{"type":"message","id":"u3000');
		expect((await errorCodes(fs))[1]).toBe("invalid_entry");
	});

	// Appending after the fragment would move the damage into the middle of the
	// file, where nothing can recover from it.
	it("drops the torn tail before writing after it", async () => {
		const fs = fixture();
		const intact = fs.files.get(PATH) ?? "";
		fs.files.set(PATH, `${intact}{"type":"message","id":"u3000`);

		const widi = await JsonlSession.open(fs, PATH);
		await widi.appendEntry({
			type: "session_info",
			id: "s2000000",
			parentId: "f1000000",
			timestamp: "2026-08-01T00:00:12.000Z",
			name: "after recovery",
		});

		expect(fs.files.get(PATH)?.startsWith(intact)).toBe(true);
		expect(widi.recoveredTornTail).toBeUndefined();
		const [reopened, pi] = await bothOpen(fs);
		expect(await reopened.getSessionName()).toBe("after recovery");
		expect(await pi.getSessionName()).toBe("after recovery");
	});

	// Damage that is not a tear stays fatal: a newline-terminated bad line is a
	// hole, and a hole cannot be sized.
	it("still refuses damage that is not an unfinished line", async () => {
		const fs = fixture();
		fs.files.set(PATH, `${fs.files.get(PATH) ?? ""}{"type":"message","id":"u3000\n`);
		expect(await errorCodes(fs)).toEqual(["invalid_entry", "invalid_entry"]);

		const middle = fixture();
		const lines = (middle.files.get(PATH) ?? "").split("\n");
		lines.splice(2, 0, "{ torn");
		middle.files.set(PATH, lines.join("\n"));
		expect(await errorCodes(middle)).toEqual(["invalid_entry", "invalid_entry"]);
	});

	it("throws on a cycle rather than walking it", async () => {
		const entries: SessionTreeEntry[] = [
			{ type: "session_info", id: "a", parentId: "b", timestamp: "2026-08-01T00:00:01.000Z", name: "a" },
			{ type: "session_info", id: "b", parentId: "a", timestamp: "2026-08-01T00:00:02.000Z", name: "b" },
		];
		expect(() => getFullBranch(entries, "a")).toThrow(/cycle/);
	});

	it("forks the full branch, not the truncated one", async () => {
		const [widi] = await bothOpen(fixture());
		const entries = await widi.getEntries();

		expect(getEntriesToFork(entries, {})).toEqual(entries);
		expect(getEntriesToFork(entries, { entryId: "r2000000", position: "at" }).map((entry) => entry.id)).toEqual([
			"u1000000",
			"a1000000",
			"r1000000",
			"l1000000",
			"s1000000",
			"m1000000",
			"c1000000",
			"u2000000",
			"a2000000",
			"r2000000",
		]);
		expect(getEntriesToFork(entries, { entryId: "u2000000" }).map((entry) => entry.id)).toEqual([
			"u1000000",
			"a1000000",
			"r1000000",
			"l1000000",
			"s1000000",
			"m1000000",
			"c1000000",
		]);
		expect(() => getEntriesToFork(entries, { entryId: "a2000000" })).toThrow(/not a user message/);
		expect(() => getEntriesToFork(entries, { entryId: "gone" })).toThrow(/not found/);
	});
});
