/**
 * The default custom storage: immutable objects, addressed by content.
 *
 * Two properties matter more than the rest. Writing the same object twice costs
 * one line, which is what lets several refs share a root and a fork be safe to
 * retry. And a log damaged by a killed process still yields everything before
 * the damage, because losing a conversation to a half-written state object is
 * exactly the failure this layer exists to prevent.
 */

import type { FileError, Result } from "@arcadialin/agent-core";
import { err, FileError as PiFileError } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import { contentHash, JsonlObjectStore, PersistenceDiagnostics } from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const DIR = "/runs/--w--/root/persistence/test__counter";
const LOG = `${DIR}/objects.jsonl`;

/** A file system whose reads fail the way an EMFILE or EACCES burst does. */
class UnreadableFileSystem extends MemoryFileSystem {
	failReads = false;

	override async readTextFile(path: string): Promise<Result<string, FileError>> {
		if (this.failReads) return err(new PiFileError("unknown", `Could not read ${path}`, path));
		return await super.readTextFile(path);
	}
}

async function openStore(
	fs: MemoryFileSystem,
	options: { formatVersion?: number; diagnostics?: PersistenceDiagnostics; dir?: string; owner?: string } = {},
): Promise<JsonlObjectStore> {
	const dirPath = options.dir ?? DIR;
	return await JsonlObjectStore.open({
		fs,
		dirPath,
		filePath: `${dirPath}/objects.jsonl`,
		namespace: "test:counter",
		formatVersion: options.formatVersion ?? 1,
		sessionKey: ["root"],
		diagnostics: options.diagnostics,
		owner: options.owner,
	});
}

function logLines(fs: MemoryFileSystem, path = LOG): string[] {
	return (fs.files.get(path) ?? "").split("\n").filter((line) => line.trim());
}

describe("JsonlObjectStore", () => {
	it("creates nothing until something is stored", async () => {
		const fs = new MemoryFileSystem();
		await openStore(fs);
		expect(fs.files.has(LOG)).toBe(false);
	});

	it("writes a header once, then one line per object", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		await store.putObject({ data: { count: 1 } });
		await store.putObject({ data: { count: 2 } });
		const lines = logLines(fs);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			type: "persistence-objects",
			namespace: "test:counter",
			formatVersion: 1,
		});
	});

	it("gives the same content the same root and stores it once", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const first = await store.putObject({ data: { count: 1 } });
		const second = await store.putObject({ data: { count: 1 } });
		expect(second).toBe(first);
		expect(logLines(fs)).toHaveLength(2);
	});

	it("ignores dependency order when addressing an object", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const a = await store.putObject({ data: { n: 1 } });
		const b = await store.putObject({ data: { n: 2 } });
		const left = await store.putObject({ data: {}, dependencies: [a, b] });
		const right = await store.putObject({ data: {}, dependencies: [b, a, a] });
		expect(right).toBe(left);
	});

	it("resolves state and dependencies after reopening", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const base = await store.putObject({ data: { count: 1 } });
		const derived = await store.putObject({ data: { count: 2 }, dependencies: [base] });

		const reopened = await openStore(fs);
		expect(await reopened.resolveState(derived)).toEqual({ count: 2 });
		expect(await reopened.listDependencies(derived)).toEqual([base]);
		expect(reopened.has(base)).toBe(true);
	});

	it("reports a missing object as undefined rather than throwing", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		expect(await store.resolveState(contentHash({ nope: true }))).toBeUndefined();
		expect(await store.listDependencies("sha256:missing")).toEqual([]);
	});

	// A killed runtime tears the line it was writing. Everything before it is
	// still true, and refusing to read the file would lose all of it.
	it("tolerates a torn last line", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const root = await store.putObject({ data: { count: 1 } });
		await fs.appendFile(LOG, '{"id":"sha256:hal');

		const diagnostics = new PersistenceDiagnostics();
		const reopened = await openStore(fs, { diagnostics });
		expect(await reopened.resolveState(root)).toEqual({ count: 1 });
		expect(diagnostics.entries).toHaveLength(0);
	});

	it("reports damage that is not at the end", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		await store.putObject({ data: { count: 1 } });
		const lines = logLines(fs);
		await fs.writeFile(LOG, `${lines[0]}\nbroken\n${lines[1]}\n`);

		const diagnostics = new PersistenceDiagnostics();
		await openStore(fs, { diagnostics });
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.corrupt_log"]);
		expect(diagnostics.hasErrors).toBe(true);
	});

	// A log that exists but could not be read is the most dangerous state there
	// is: the first write would take the "no file yet" path and rewrite the
	// header over everything the namespace ever stored.
	it("refuses to write a log it could not read", async () => {
		const fs = new UnreadableFileSystem();
		const store = await openStore(fs);
		const root = await store.putObject({ data: { count: 1 } });
		const before = fs.files.get(LOG);

		fs.failReads = true;
		const diagnostics = new PersistenceDiagnostics();
		const reopened = await openStore(fs, { diagnostics });
		fs.failReads = false;

		await expect(reopened.putObject({ data: { count: 2 } })).rejects.toThrow();
		expect(fs.files.get(LOG)).toBe(before);
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.corrupt_log"]);

		// The seal is this handle's, not the log's: the next open reads it fine.
		const later = await openStore(fs);
		expect(later.has(root)).toBe(true);
	});

	// Appending under an unreadable header would write objects no later open can
	// reach, and the refs naming them go on the branch regardless.
	it("refuses to write a log whose header is torn", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		await store.putObject({ data: { count: 1 } });
		const lines = logLines(fs);
		await fs.writeFile(LOG, `{"type":"persistence-obje\n${lines[1]}\n`);
		const before = fs.files.get(LOG);

		const diagnostics = new PersistenceDiagnostics();
		const reopened = await openStore(fs, { diagnostics });
		await expect(reopened.putObject({ data: { count: 2 } })).rejects.toThrow();
		expect(fs.files.get(LOG)).toBe(before);
		expect(new Set(diagnostics.entries.map((entry) => entry.code))).toEqual(new Set(["persistence.corrupt_log"]));
	});

	it("stops at a log written by a newer build instead of guessing", async () => {
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			LOG,
			`${JSON.stringify({
				type: "persistence-objects",
				version: 99,
				namespace: "test:counter",
				formatVersion: 1,
			})}\n${JSON.stringify({ id: "sha256:x", deps: [], data: {} })}\n`,
		);
		const diagnostics = new PersistenceDiagnostics();
		const store = await openStore(fs, { diagnostics });
		expect(store.has("sha256:x")).toBe(false);
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.unsupported_version"]);
	});

	// Reading a log this build must not touch is survivable; appending to it is
	// not, because the caller would then put a ref on the branch naming an
	// object nobody can find.
	it("refuses to write a log it declined to read", async () => {
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			LOG,
			`${JSON.stringify({ type: "persistence-objects", version: 99, namespace: "test:counter", formatVersion: 1 })}\n`,
		);
		const store = await openStore(fs);
		await expect(store.putObject({ data: { count: 1 } })).rejects.toThrow();
	});
});

describe("JsonlObjectStore ownership", () => {
	it("stamps the owner into the header and reopens under it", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs, { owner: "ext:notes" });
		const root = await store.putObject({ data: { count: 1 } });
		expect(JSON.parse(logLines(fs)[0] ?? "{}")).toMatchObject({ owner: "ext:notes" });

		const reopened = await openStore(fs, { owner: "ext:notes" });
		expect(await reopened.resolveState(root)).toEqual({ count: 1 });
	});

	// A namespace name is unique but not reserved: uninstall an extension and
	// another one can claim the name, then read objects written against a schema
	// it has never seen.
	it("seals a directory claimed by different code", async () => {
		const fs = new MemoryFileSystem();
		const first = await openStore(fs, { owner: "ext:notes" });
		const root = await first.putObject({ data: { count: 1 } });

		const diagnostics = new PersistenceDiagnostics();
		const impostor = await openStore(fs, { owner: "ext:other", diagnostics });
		expect(await impostor.resolveState(root)).toBeUndefined();
		await expect(impostor.putObject({ data: {} })).rejects.toThrow();
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual(["persistence.owner_mismatch"]);
		expect(diagnostics.hasErrors).toBe(true);
	});

	it("treats owned and unowned as different owners in both directions", async () => {
		const fs = new MemoryFileSystem();
		const owned = await openStore(fs, { owner: "ext:notes" });
		await owned.putObject({ data: { count: 1 } });
		const unowned = new PersistenceDiagnostics();
		await openStore(fs, { diagnostics: unowned });
		expect(unowned.entries.map((entry) => entry.code)).toEqual(["persistence.owner_mismatch"]);

		const otherFs = new MemoryFileSystem();
		const core = await openStore(otherFs);
		await core.putObject({ data: { count: 1 } });
		const claimed = new PersistenceDiagnostics();
		await openStore(otherFs, { owner: "ext:notes", diagnostics: claimed });
		expect(claimed.entries.map((entry) => entry.code)).toEqual(["persistence.owner_mismatch"]);
	});

	// The owner is an identity, not a build stamp: an extension upgrade bumps
	// formatVersion, and locking it out of its own state would be worse than
	// anything the check prevents.
	it("keeps the owner stable across a format version bump", async () => {
		const fs = new MemoryFileSystem();
		const before = await openStore(fs, { owner: "ext:notes", formatVersion: 1 });
		const root = await before.putObject({ data: { count: 1 } });

		const diagnostics = new PersistenceDiagnostics();
		const after = await openStore(fs, { owner: "ext:notes", formatVersion: 2, diagnostics });
		expect(await after.resolveState(root)).toEqual({ count: 1 });
		expect(after.storedFormatVersion).toBe(1);
		expect(diagnostics.entries).toHaveLength(0);
	});

	it("reports the format version the objects were written with", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs, { formatVersion: 1 });
		await store.putObject({ data: { count: 1 } });
		const reopened = await openStore(fs, { formatVersion: 2 });
		expect(reopened.storedFormatVersion).toBe(1);
	});

	it("copies objects into another store without duplicating them", async () => {
		const fs = new MemoryFileSystem();
		const source = await openStore(fs);
		const base = await source.putObject({ data: { count: 1 } });
		const derived = await source.putObject({ data: { count: 2 }, dependencies: [base] });

		const targetDir = "/runs/--w--/fork/persistence/test__counter";
		const target = await openStore(fs, { dir: targetDir });
		await source.copyReachable(target, [base, derived]);
		await source.copyReachable(target, [base, derived]);

		expect(logLines(fs, `${targetDir}/objects.jsonl`)).toHaveLength(3);
		expect(await target.resolveState(derived)).toEqual({ count: 2 });
		expect(await target.listDependencies(derived)).toEqual([base]);
	});
});
