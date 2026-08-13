import type { FileError, FileInfo, FileSystem, Result } from "@arcadialin/agent-core";
import { err, ok, FileError as PiFileError } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../src/core/agent-profile.ts";
import type { SessionAddress } from "../../src/core/persistence/index.ts";
import { formatSessionKey, PersistenceRegistry, parseSessionOrigin } from "../../src/core/persistence/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

class MemoryFileSystem implements FileSystem {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this.normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this.normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(new PiFileError("not_found", `File not found: ${normalized}`, normalized));
		}
		return ok(content);
	}

	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.dirs.add(this.dirname(normalized));
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized) ?? "";
		const next = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, current + next);
		return ok(undefined);
	}

	async fileInfo(): Promise<Result<FileInfo, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(new PiFileError("not_found", `Directory not found: ${dir}`, dir));
		}

		const entries: FileInfo[] = [];
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			entries.push({
				name: directory.slice(directory.lastIndexOf("/") + 1),
				path: directory,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		for (const [filePath, content] of this.files) {
			if (this.dirname(filePath) !== dir) continue;
			entries.push({
				name: filePath.slice(filePath.lastIndexOf("/") + 1),
				path: filePath,
				kind: "file",
				size: content.length,
				mtimeMs: 0,
			});
		}
		return ok(entries);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (options?.recursive === false && !this.dirs.has(this.dirname(normalized))) {
			return err(new PiFileError("not_found", `Parent not found: ${this.dirname(normalized)}`, normalized));
		}

		let current = "";
		for (const segment of normalized.split("/").filter(Boolean)) {
			current = `${current}/${segment}`;
			this.dirs.add(current);
		}
		return ok(undefined);
	}

	async remove(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.files.delete(normalized);
		this.dirs.delete(normalized);
		if (options?.recursive) {
			const prefix = `${normalized}/`;
			for (const file of this.files.keys()) {
				if (file.startsWith(prefix)) this.files.delete(file);
			}
			for (const dir of this.dirs) {
				if (dir.startsWith(prefix)) this.dirs.delete(dir);
			}
		}
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

const profile: AgentProfile = {
	id: "main",
	label: "Main Agent",
	systemPrompt: "You are WIDI.",
	persist: true,
	skills: ["code"],
};

function requireAddress(manager: SessionManager, agentId: string): SessionAddress {
	const address = manager.getAgentSessionAddress(agentId);
	if (!address) throw new Error(`Expected a persisted session for ${agentId}.`);
	return address;
}

// Writes a session in the on-disk layout: one directory per session, holding
// the conversation history file. Returns the history file path.
function writeSessionFile(
	fs: MemoryFileSystem,
	dirName: string,
	options: { id: string; timestamp: string; cwd?: string; parentSession?: string; profileId?: string },
): string {
	const cwd = options.cwd ?? "/workspace/project";
	const header = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: options.timestamp,
		cwd,
		parentSession: options.parentSession,
		metadata: options.profileId ? { profile: { id: options.profileId } } : undefined,
	};
	const sessionDir = `/sessions/--workspace-project--/${dirName}`;
	fs.dirs.add("/sessions");
	fs.dirs.add("/sessions/--workspace-project--");
	fs.dirs.add(sessionDir);
	const path = `${sessionDir}/session.jsonl`;
	fs.files.set(path, `${JSON.stringify(header)}\n`);
	return path;
}

describe("SessionManager", () => {
	it("stores agent profile references in extended jsonl session headers", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});

		await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		const [listed] = await manager.repo.list({ cwd: "/workspace/project" });
		const profileReference = { id: profile.id, label: profile.label };

		expect(listed?.metadata.metadata?.profile).toEqual(profileReference);
		if (!listed) throw new Error("Expected session metadata.");
		const headerLine = fs.files.get(listed.metadata.path)?.split("\n")[0];
		if (!headerLine) throw new Error("Expected session header line.");
		expect(JSON.parse(headerLine)).toMatchObject({
			type: "session",
			version: 3,
			id: "main",
			metadata: { profile: profileReference },
		});
	});

	it("gives each persistent session a directory of its own", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const session = await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		const metadata = await session.getMetadata();
		if (!("path" in metadata)) throw new Error("Expected persisted metadata.");

		const address = requireAddress(manager, "main");
		expect(address.key).toMatchObject([expect.stringMatching(/^\d{8}T\d{6}Z_main$/)]);
		const sessionDir = `/sessions/--workspace-project--/${address.key[0]}`;
		expect(metadata.path).toBe(`${sessionDir}/session.jsonl`);

		// Artifacts a session owns beyond its history live next to it and must
		// not be mistaken for sessions themselves.
		await fs.writeFile(`${sessionDir}/overrides.json`, "{}");
		await expect(manager.listAgentSessionCandidates()).resolves.toMatchObject([{ id: "main", ref: address.key[0] }]);
	});

	it("reports no session address for ephemeral sessions", async () => {
		const manager = new SessionManager({
			fs: new MemoryFileSystem(),
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		await manager.createAgentSession({ agentId: "scratch", agentProfile: { ...profile, persist: false } });

		expect(manager.getAgentSessionAddress("scratch")).toBeUndefined();
		expect(manager.getAgentSessionRef("scratch")).toBeUndefined();
	});

	it("deletes a session directory with every artifact it owns", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		const address = requireAddress(manager, "main");
		const sessionDir = `/sessions/--workspace-project--/${address.key[0]}`;
		await fs.writeFile(`${sessionDir}/overrides.json`, "{}");

		await manager.repo.delete(address);

		await expect(manager.listAgentSessionCandidates()).resolves.toEqual([]);
		expect(fs.files.has(`${sessionDir}/overrides.json`)).toBe(false);
	});

	it("lists current cwd agent session candidates", async () => {
		const fs = new MemoryFileSystem();
		writeSessionFile(fs, "2026-01-02T00-00-00-000Z_alpha", {
			id: "alpha",
			timestamp: "2026-01-02T00:00:00.000Z",
			profileId: "main",
		});
		writeSessionFile(fs, "2026-01-01T00-00-00-000Z_beta", { id: "beta", timestamp: "2026-01-01T00:00:00.000Z" });
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});

		await expect(manager.listAgentSessionCandidates()).resolves.toEqual([
			{
				id: "alpha",
				ref: "2026-01-02T00-00-00-000Z_alpha",
				createdAt: "2026-01-02T00:00:00.000Z",
				cwd: "/workspace/project",
				profile: { id: "main" },
			},
			{
				id: "beta",
				ref: "2026-01-01T00-00-00-000Z_beta",
				createdAt: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace/project",
			},
		]);
	});

	it("surfaces session name and first user message as candidate display facts", async () => {
		const fs = new MemoryFileSystem();
		const path = writeSessionFile(fs, "2026-01-03T00-00-00-000Z_gamma", {
			id: "gamma",
			timestamp: "2026-01-03T00:00:00.000Z",
		});
		const entries = [
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-03T00:00:01.000Z",
				message: { role: "user", content: "\nFix the flaky auth test\nplease" },
			},
			{
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-01-03T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
			},
			{
				type: "session_info",
				id: "entry-3",
				parentId: "entry-2",
				timestamp: "2026-01-03T00:00:03.000Z",
				name: "auth-fix",
			},
		];
		fs.files.set(path, `${fs.files.get(path)}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});

		const [candidate] = await manager.listAgentSessionCandidates();
		expect(candidate).toMatchObject({ id: "gamma", name: "auth-fix", firstUserMessage: "Fix the flaky auth test" });
	});

	// A directory name and a header id can collide, because the id is the AgentId
	// that created the session and the user is free to name nothing at all.
	it("resolves session references by address before id", async () => {
		const fs = new MemoryFileSystem();
		writeSessionFile(fs, "2026-01-02T00-00-00-000Z_alpha", { id: "same", timestamp: "2026-01-02T00:00:00.000Z" });
		writeSessionFile(fs, "same", { id: "address-target", timestamp: "2026-01-03T00:00:00.000Z" });
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});

		await expect(manager.resolveAgentSessionReference("same")).resolves.toMatchObject({
			metadata: { id: "address-target" },
		});
		await expect(manager.resolveAgentSessionReference("2026-01-02T00-00-00-000Z_alpha")).resolves.toMatchObject({
			metadata: { id: "same" },
		});
		await expect(manager.resolveAgentSessionReference("missing-everywhere")).rejects.toMatchObject({
			reason: "not_found",
		});
	});

	it("rejects ambiguous session ids with candidate facts", async () => {
		const fs = new MemoryFileSystem();
		writeSessionFile(fs, "2026-01-02T00-00-00-000Z_same", { id: "same", timestamp: "2026-01-02T00:00:00.000Z" });
		writeSessionFile(fs, "2026-01-01T00-00-00-000Z_same", { id: "same", timestamp: "2026-01-01T00:00:00.000Z" });
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});

		await expect(manager.resolveAgentSessionReference("same")).rejects.toMatchObject({
			reason: "ambiguous",
			candidates: [expect.objectContaining({ id: "same" }), expect.objectContaining({ id: "same" })],
		});
	});

	it("stores namespaced extension custom entries on the current branch path", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const session = await manager.createAgentSession({ agentId: "main", agentProfile: profile });

		const firstId = await manager.appendExtensionCustomEntry("main", "writer", "state", { value: 1 });
		await manager.appendExtensionCustomEntry("main", "writer", "note", { value: 2 });
		await manager.appendExtensionCustomEntry("main", "other", "state", { value: "other" });
		const secondId = await manager.appendExtensionCustomEntry("main", "writer", "state", { value: 3 });

		await expect(manager.findExtensionCustomEntries<{ value: number }>("main", "writer", "state")).resolves.toEqual([
			expect.objectContaining({ id: firstId, type: "state", data: { value: 1 } }),
			expect.objectContaining({ id: secondId, type: "state", data: { value: 3 } }),
		]);
		await expect(manager.findExtensionCustomEntries("main", "writer")).resolves.toMatchObject([
			{ type: "state", data: { value: 1 } },
			{ type: "note", data: { value: 2 } },
			{ type: "state", data: { value: 3 } },
		]);
		await expect(manager.findExtensionCustomEntries("main", "writer", "missing")).resolves.toEqual([]);

		const storedCustomEntries = (await session.getEntries()).filter((entry) => entry.type === "custom");
		expect(storedCustomEntries.map((entry) => entry.customType)).toEqual([
			"extension:writer:state",
			"extension:writer:note",
			"extension:other:state",
			"extension:writer:state",
		]);

		await session.moveTo(firstId);
		await expect(manager.findExtensionCustomEntries("main", "writer", "state")).resolves.toMatchObject([
			{ id: firstId, type: "state" },
		]);
	});

	it("keeps extension custom entries as branch facts across fork and compaction", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const session = await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		await session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await manager.appendExtensionCustomEntry("main", "writer", "state", { value: 1 });
		const secondUserId = await session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await manager.appendExtensionCustomEntry("main", "writer", "state", { value: 2 });

		// Fork before the second user message: the copied path carries the
		// first entry; the later entry stays on the source branch only.
		await manager.forkAgentSession("main", { sessionId: "forked", entryId: secondUserId });
		await expect(manager.findExtensionCustomEntries("forked", "writer", "state")).resolves.toMatchObject([
			{ data: { value: 1 } },
		]);
		await expect(manager.findExtensionCustomEntries("main", "writer", "state")).resolves.toMatchObject([
			{ data: { value: 1 } },
			{ data: { value: 2 } },
		]);

		// A retained-tail compaction is a model-context checkpoint, not a storage
		// boundary: extension facts behind it stay visible on the active branch.
		await session.appendCompaction("compacted", secondUserId, 100, undefined, false, undefined, [
			{ role: "user", content: "second", timestamp: 2 },
		]);
		await expect(manager.findExtensionCustomEntries("main", "writer", "state")).resolves.toMatchObject([
			{ data: { value: 1 } },
			{ data: { value: 2 } },
		]);
	});

	it("restores runtime state through retained-tail compaction checkpoints", async () => {
		const manager = new SessionManager({
			fs: new MemoryFileSystem(),
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const session = await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		await session.appendModelChange("test", "model-2");
		await session.appendThinkingLevelChange("high");
		await session.appendActiveToolsChange(["read"]);
		const retainedMessage = { role: "user" as const, content: "retained request", timestamp: 1 };
		const retainedId = await session.appendMessage(retainedMessage);
		await session.appendCompaction("Earlier work", retainedId, 1000, undefined, false, undefined, [retainedMessage]);

		await expect(manager.buildAgentSessionContext("main")).resolves.toMatchObject({
			model: { provider: "test", modelId: "model-2" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
			messages: [
				expect.objectContaining({ role: "compactionSummary" }),
				expect.objectContaining({ role: "user", content: "retained request" }),
			],
		});
		await expect(manager.getAgentSessionSnapshot("main")).resolves.toMatchObject({
			pathToRoot: [
				expect.objectContaining({ type: "model_change" }),
				expect.objectContaining({ type: "thinking_level_change" }),
				expect.objectContaining({ type: "active_tools_change" }),
				expect.objectContaining({ id: retainedId, type: "message" }),
				expect.objectContaining({ type: "compaction", retainedTail: [retainedMessage] }),
			],
		});
	});

	it("snapshots, names, and forks persistent agent sessions", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const session = await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		const userEntryId = await session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await manager.setAgentSessionName("main", "Design Thread");

		await expect(manager.getAgentSessionSnapshot("main")).resolves.toMatchObject({
			name: "Design Thread",
			leafId: expect.any(String),
			pathToRoot: [
				expect.objectContaining({ id: userEntryId, type: "message" }),
				expect.objectContaining({ type: "session_info", name: "Design Thread" }),
			],
		});
		await expect(manager.getAgentSessionTree("main")).resolves.toMatchObject({
			entries: [expect.objectContaining({ id: userEntryId }), expect.objectContaining({ type: "session_info" })],
		});

		const forked = await manager.forkAgentSession("main", { sessionId: "forked" });

		// A fork is a new line of work: its own id, its own top-level directory,
		// and the profile the source ran under.
		expect(forked.diagnostics).toEqual([]);
		expect(forked.info.metadata.id).toBe("forked");
		expect(forked.info.address.key).toMatchObject([expect.stringMatching(/^\d{8}T\d{6}Z_forked$/)]);
		expect(forked.info.metadata.metadata?.profile).toEqual({ id: profile.id, label: profile.label });
		await expect(manager.getAgentSessionTree("forked")).resolves.toMatchObject({
			ref: forked.info.address.key[0],
			name: "Design Thread",
			entries: [expect.objectContaining({ id: userEntryId }), expect.objectContaining({ type: "session_info" })],
		});
	});

	// The directory nesting is the only record of the agent tree, so this is
	// where the parent-child relation is asserted: nothing else writes it down.
	it("nests a spawned agent's session under the session that spawned it", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		await manager.createAgentSession({ agentId: "root", agentProfile: profile });
		await manager.createAgentSession({ agentId: "child", agentProfile: profile, parentAgentId: "root" });
		await manager.createAgentSession({ agentId: "grandchild", agentProfile: profile, parentAgentId: "child" });

		const root = requireAddress(manager, "root");
		expect(requireAddress(manager, "child").key).toMatchObject([root.key[0], expect.stringContaining("_child")]);
		expect(requireAddress(manager, "grandchild").key).toHaveLength(3);
		await expect(manager.repo.listChildren(root)).resolves.toMatchObject([{ metadata: { id: "child" } }]);

		// The header says who spawned it, addressed the same way every other
		// reference is, so the relation survives the runtime that created it.
		const [rootCandidate] = await manager.listAgentSessionCandidates();
		expect(rootCandidate?.origin).toBeUndefined();
		const [childInfo] = await manager.repo.listChildren(root);
		expect(parseSessionOrigin(childInfo?.metadata.metadata)).toEqual({ spawnedBy: formatSessionKey(root.key) });

		// Only roots are offered for resume; a child is reached through its root.
		await expect(manager.listAgentSessionCandidates()).resolves.toMatchObject([{ id: "root" }]);
		// A child is still addressable, which is what makes it resumable at all.
		await expect(
			manager.resolveAgentSessionReference(manager.getAgentSessionRef("grandchild") ?? ""),
		).resolves.toMatchObject({ metadata: { id: "grandchild" } });
	});

	// The standard this layer is checked against: after a fork, deleting the
	// source directory must leave the new session completely readable.
	it("forks a session with the sessions nested under it", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		const root = await manager.createAgentSession({ agentId: "root", agentProfile: profile });
		await root.appendMessage({ role: "user", content: "plan it", timestamp: 1 });
		const child = await manager.createAgentSession({ agentId: "child", agentProfile: profile, parentAgentId: "root" });
		await child.appendMessage({ role: "user", content: "do it", timestamp: 2 });

		const sourceRoot = requireAddress(manager, "root");
		const sourceChild = requireAddress(manager, "child");
		const forked = await manager.forkAgentSession("root", { sessionId: "forked" });
		await manager.repo.delete(sourceRoot);

		const [forkedChild] = await manager.repo.listChildren(forked.info.address);
		if (!forkedChild) throw new Error("Expected the child session to be copied.");
		expect(forkedChild.metadata.id).toBe("child");
		// Lineage is recomputed per copied session, never carried over: the copied
		// child was spawned by the *new* root, and its history came from the old
		// child. Copying the source header verbatim would name the source tree.
		expect(parseSessionOrigin(forked.info.metadata.metadata)).toEqual({ forkedFrom: formatSessionKey(sourceRoot.key) });
		expect(parseSessionOrigin(forkedChild.metadata.metadata)).toEqual({
			spawnedBy: formatSessionKey(forked.info.address.key),
			forkedFrom: formatSessionKey(sourceChild.key),
		});
		const opened = await manager.repo.open(forkedChild.address);
		await expect(opened.session.getFullBranch()).resolves.toMatchObject([
			{ type: "message", message: { content: "do it" } },
		]);
		await expect(manager.getAgentSessionTree("forked")).resolves.toMatchObject({
			pathToRoot: [{ type: "message", message: { content: "plan it" } }],
		});
	});

	it("validates extension custom entry type and JSON serializability", async () => {
		const manager = new SessionManager({
			fs: new MemoryFileSystem(),
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		});
		await manager.createAgentSession({ agentId: "main", agentProfile: profile });
		const circular: { self?: unknown } = {};
		circular.self = circular;

		await expect(manager.appendExtensionCustomEntry("main", "writer", " ", {})).rejects.toThrow("must not be empty");
		await expect(manager.appendExtensionCustomEntry("main", "writer", "bad/type", {})).rejects.toThrow(
			"must contain only",
		);
		await expect(manager.appendExtensionCustomEntry("main", "writer", "state", () => {})).rejects.toThrow(
			"JSON serializable",
		);
		await expect(manager.appendExtensionCustomEntry("main", "writer", "state", circular)).rejects.toThrow(
			"JSON serializable",
		);
	});
});
