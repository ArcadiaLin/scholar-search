import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@arcadialin/agent-core";
import { err, ok, ExecutionError as PiExecutionError, FileError as PiFileError } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import {
	InMemorySettingsStorage,
	SettingManager,
	type SettingsLockResult,
	type SettingsScope,
	type SettingsStorage,
} from "../../src/core/setting-manager.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace/project";
	readonly files = new Map<string, string>();

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
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
		this.files.set(this.normalize(path), typeof content === "string" ? content : new TextDecoder().decode(content));
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

	async listDir(): Promise<Result<FileInfo[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok(this.files.has(this.normalize(path)));
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		this.files.delete(this.normalize(path));
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

class TestSettingsStorage implements SettingsStorage {
	private readonly data: Record<SettingsScope, string | undefined> = { global: undefined, project: undefined };
	readonly readFailures = new Set<SettingsScope>();
	readonly writeFailures = new Set<SettingsScope>();

	constructor(global?: string, project?: string) {
		this.data.global = global;
		this.data.project = project;
	}

	async withLockAsync<T>(
		scope: SettingsScope,
		fn: (current: string | undefined) => Promise<SettingsLockResult<T>>,
	): Promise<T> {
		if (this.readFailures.has(scope)) {
			throw new Error(`${scope} read failed`);
		}
		const { result, next } = await fn(this.data[scope]);
		if (next !== undefined) {
			if (this.writeFailures.has(scope)) {
				throw new Error(`${scope} write failed`);
			}
			this.data[scope] = next;
		}
		return result;
	}
}

describe("SettingManager", () => {
	it("merges project settings over global settings when project is trusted", async () => {
		const storage = new InMemorySettingsStorage(
			{
				defaultProvider: "openai",
				defaultModel: "gpt-5",
				defaultProfile: "main",
				enabledProfiles: ["main", "reviewer"],
				compaction: { enabled: true, reserveTokens: 1000 },
			},
			{
				defaultModel: "gpt-5-mini",
				defaultProfile: "project-main",
				enabledProfiles: ["project-main"],
				compaction: { keepRecentTokens: 2000 },
			},
		);

		const manager = await SettingManager.fromStorage(storage);

		expect(manager.getDefaultProvider()).toBe("openai");
		expect(manager.getDefaultModel()).toBe("gpt-5-mini");
		expect(manager.getDefaultProfile()).toBe("project-main");
		expect(manager.getEnabledProfiles()).toEqual(["project-main"]);
		expect(manager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 });
	});

	// pi-tui moves one line per wheel notch, which in a full-screen transcript
	// reads as a stuck scroll. The default here is what the terminal's own
	// scrollback does.
	it("scrolls three lines a wheel notch unless the settings say otherwise", async () => {
		const byDefault = await SettingManager.fromStorage(new InMemorySettingsStorage({}));
		expect(byDefault.getTerminalSettings().wheelScrollLines).toBe(3);

		const configured = await SettingManager.fromStorage(
			new InMemorySettingsStorage({ terminal: { wheelScrollLines: 8 } }),
		);
		expect(configured.getTerminalSettings().wheelScrollLines).toBe(8);
	});

	it("merges extension division rules per extension id", async () => {
		const storage = new InMemorySettingsStorage(
			{ extensionDivisions: { mcp: { disable: ["tools"] }, plan: { enable: ["experimental"] } } },
			{ extensionDivisions: { mcp: { enable: ["experimental"] } } },
		);

		const manager = await SettingManager.fromStorage(storage);

		// One level of merge: the project entry replaces the global entry for the
		// same extension id, and leaves other extensions alone.
		expect(manager.getExtensionDivisionSelections()).toEqual({
			mcp: { enable: ["experimental"] },
			plan: { enable: ["experimental"] },
		});
	});

	it("ignores and protects project settings when project is not trusted", async () => {
		const storage = new InMemorySettingsStorage({ defaultModel: "global-model" }, { defaultModel: "project-model" });

		const manager = await SettingManager.fromStorage(storage, { projectTrusted: false });

		expect(manager.getDefaultModel()).toBe("global-model");
		expect(() => manager.setProjectExtensionPaths(["./ext.ts"])).toThrow("Project is not trusted");
	});

	it("persists global setters after flush", async () => {
		const env = new MemoryExecutionEnv();
		const manager = await SettingManager.create(env, { agentDir: "/home/user/.widi", cwd: "/workspace/project" });

		manager.setDefaultModelAndProvider("test-provider", "test-model");
		manager.setEnabledProfiles(["main", "main", "reviewer"]);
		manager.setCompactionEnabled(false);
		await manager.flush();

		expect(JSON.parse(env.files.get("/home/user/.widi/settings.json") ?? "{}")).toEqual({
			defaultProvider: "test-provider",
			defaultModel: "test-model",
			enabledProfiles: ["main", "reviewer"],
			compaction: { enabled: false },
		});
	});

	it("preserves unmodified nested settings when writing one nested field", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			"/home/user/.widi/settings.json",
			JSON.stringify({ compaction: { enabled: true, reserveTokens: 1234 } }),
		);
		const manager = await SettingManager.create(env, { agentDir: "/home/user/.widi", cwd: "/workspace/project" });

		manager.setCompactionEnabled(false);
		await manager.flush();

		expect(JSON.parse(env.files.get("/home/user/.widi/settings.json") ?? "{}")).toEqual({
			compaction: { enabled: false, reserveTokens: 1234 },
		});
	});

	it("drains diagnostics for settings load failures while preserving drainErrors", async () => {
		const storage = new TestSettingsStorage();
		storage.readFailures.add("global");

		const manager = await SettingManager.fromStorage(storage);

		expect(manager.drainErrors()).toEqual([
			expect.objectContaining({ scope: "global", error: expect.objectContaining({ message: "global read failed" }) }),
		]);
		expect(manager.drainDiagnostics()).toEqual([
			{ severity: "error", code: "settings.load_failed", message: "global settings: global read failed" },
		]);
	});

	it("drains diagnostics for settings write failures", async () => {
		const storage = new TestSettingsStorage();
		storage.writeFailures.add("global");
		const manager = await SettingManager.fromStorage(storage);

		manager.setDefaultModel("broken-write");
		await manager.flush();

		expect(manager.drainDiagnostics()).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "settings.write_failed",
				message: "global settings: global write failed",
			}),
		);
	});
});
