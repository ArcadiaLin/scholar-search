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
	EXTENSION_API_VERSION,
	ExtensionLoader,
	type ExtensionModuleImporter,
} from "../../src/core/extension/index.ts";
import type { ExtensionFactory } from "../../src/core/extension/types.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	private basename(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		return index === -1 ? normalized : normalized.slice(index + 1);
	}

	addDir(path: string): void {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			this.dirs.add("/");
			return;
		}
		this.addDir(this.dirname(normalized));
		this.dirs.add(normalized);
	}

	addFile(path: string, content = ""): void {
		const normalized = this.normalize(path);
		this.addDir(this.dirname(normalized));
		this.files.set(normalized, content);
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

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		return ok(result.value.split("\n"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async appendFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: "file",
				size: this.files.get(normalized)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		if (this.dirs.has(normalized)) {
			return ok({ name: this.basename(normalized), path: normalized, kind: "directory", size: 0, mtimeMs: 0 });
		}
		return err(new PiFileError("not_found", `File not found: ${normalized}`, normalized));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(new PiFileError("not_found", `Directory not found: ${dir}`, dir));
		}

		const result: FileInfo[] = [];
		for (const filePath of this.files.keys()) {
			if (this.dirname(filePath) !== dir) continue;
			result.push({
				name: this.basename(filePath),
				path: filePath,
				kind: "file",
				size: this.files.get(filePath)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			result.push({ name: this.basename(directory), path: directory, kind: "directory", size: 0, mtimeMs: 0 });
		}
		return ok(result.sort((left, right) => left.path.localeCompare(right.path)));
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string): Promise<Result<void, FileError>> {
		this.addDir(path);
		return ok(undefined);
	}

	async remove(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-extension-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-extension-test/file");
	}

	async cleanup(): Promise<void> {}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}
}

class FakeModuleImporter implements ExtensionModuleImporter {
	readonly imports: string[] = [];
	private readonly modules = new Map<string, unknown>();
	clearCalls = 0;

	setFactory(path: string, factory: ExtensionFactory | undefined): void {
		this.modules.set(path, factory);
	}

	setModule(path: string, module: unknown): void {
		this.modules.set(path, module);
	}

	async importModule(path: string): Promise<unknown> {
		this.imports.push(path);
		return this.modules.get(path);
	}

	clearCache(): void {
		this.clearCalls++;
	}
}

describe("ExtensionLoader file/module loading", () => {
	it("loads direct file factories and exposes source facts", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activationCount = 0;
		importer.setFactory("/extensions/sample.ts", () => {
			activationCount++;
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);
		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });

		expect(result.loaded).toEqual([
			{
				id: "sample",
				source: {
					kind: "file",
					path: "/extensions/sample.ts",
					resolvedPath: "/extensions/sample.ts",
					root: { kind: "settings", path: "/extensions" },
				},
				divisions: [],
			},
		]);
		expect(scope.extensions).toEqual(result.loaded);
		expect(activationCount).toBe(1);
	});

	it("loads the first package manifest entry and warns about extras", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/extensions/package-extension/package.json",
			JSON.stringify({ widi: { extensions: ["./main.ts", "./extra.ts"] } }),
		);
		env.addFile("/extensions/package-extension/main.ts");
		env.addFile("/extensions/package-extension/extra.ts");
		const importer = new FakeModuleImporter();
		importer.setFactory("/extensions/package-extension/main.ts", () => {});
		importer.setFactory("/extensions/package-extension/extra.ts", () => {});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);

		expect(importer.imports).toEqual(["/extensions/package-extension/main.ts"]);
		expect(result.loaded).toEqual([
			{
				id: "package-extension",
				source: {
					kind: "package",
					path: "/extensions/package-extension",
					resolvedPath: "/extensions/package-extension/package.json",
					entryPath: "/extensions/package-extension/main.ts",
					root: { kind: "settings", path: "/extensions" },
				},
				divisions: [],
			},
		]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.extra_entries_ignored", extensionId: "package-extension" }),
		);
	});

	it("does not overwrite existing factory ids with module factories", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activationSource = "";
		importer.setFactory("/extensions/sample.ts", () => {
			activationSource = "module";
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});
		loader.registerExtension("sample", () => {
			activationSource = "memory";
		});

		const result = await loader.loadAvailableExtensions(env);
		await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });

		expect(result.loaded).toEqual([]);
		expect(importer.imports).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.id_conflict", extensionId: "sample" }),
		);
		expect(activationSource).toBe("memory");
	});

	it("clears the module cache before reloading available extensions", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		importer.setFactory("/extensions/sample.ts", () => {});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		await loader.loadAvailableExtensions(env);
		await loader.reloadAvailableExtensions(env);

		expect(importer.clearCalls).toBe(1);
		expect(importer.imports).toEqual(["/extensions/sample.ts", "/extensions/sample.ts"]);
	});
});

describe("ExtensionLoader api version gate", () => {
	it("activates a versioned module definition targeting the current version", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activated = false;
		importer.setModule("/extensions/sample.ts", {
			apiVersion: EXTENSION_API_VERSION,
			activate: () => {
				activated = true;
			},
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);
		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });

		expect(result.loaded).toHaveLength(1);
		expect(result.diagnostics).toEqual([]);
		expect(scope.diagnostics).toEqual([]);
		expect(activated).toBe(true);
	});

	it("refuses a module declaring an unsupported api version at load and resolve", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activated = false;
		importer.setModule("/extensions/sample.ts", {
			apiVersion: EXTENSION_API_VERSION + 1,
			activate: () => {
				activated = true;
			},
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);
		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });

		expect(result.loaded).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "extension.version_incompatible",
				extensionId: "sample",
				severity: "error",
				message: `Extension 'sample' from /extensions/sample.ts targets extension API version ${EXTENSION_API_VERSION + 1}; this runtime supports version ${EXTENSION_API_VERSION}.`,
			}),
		);
		expect(activated).toBe(false);
		expect(scope.extensions).toEqual([]);
		// The requesting agent sees the true reason, not a missing factory.
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.version_incompatible", extensionId: "sample", severity: "error" }),
		);
		expect(scope.diagnostics).not.toContainEqual(expect.objectContaining({ code: "extension.factory_missing" }));
	});

	it("rejects an in-memory definition with an unsupported version per agent", async () => {
		const loader = new ExtensionLoader();
		let activated = false;
		const dispose = loader.registerExtension("sample", {
			apiVersion: 0,
			activate: () => {
				activated = true;
			},
		});

		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });

		expect(activated).toBe(false);
		expect(scope.extensions).toEqual([]);
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.version_incompatible", extensionId: "sample" }),
		);

		// Withdrawing the incompatible registration returns the id to missing.
		dispose();
		const after = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["sample"] });
		expect(after.diagnostics).toContainEqual(expect.objectContaining({ code: "extension.factory_missing" }));
	});

	// It is absent from the available ids, so nothing names it and no id can carry
	// the report. Without this it would vanish in complete silence, because unlike
	// a file it was never read and so never had a load-time diagnostic.
	it("still reports an incompatible registration that no id named", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtension("sample", { apiVersion: EXTENSION_API_VERSION + 1, activate: () => {} });

		expect(loader.listAvailableExtensionIds()).toEqual([]);

		const scope = await loader.loadForAgent({
			agentId: "agent",
			profileId: "profile",
			extensionIds: loader.listAvailableExtensionIds(),
		});

		expect(scope.extensions).toEqual([]);
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.version_incompatible", severity: "warning", extensionId: "sample" }),
		);
	});

	// Root order is activation order once every available extension loads, and
	// activation order decides which interceptor or tool patch applies first.
	it("keeps roots in their own order instead of sorting across them", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/z-root/second.ts");
		env.addFile("/a-root/first.ts");
		const importer = new FakeModuleImporter();
		importer.setFactory("/z-root/second.ts", () => {});
		importer.setFactory("/a-root/first.ts", () => {});
		const loader = new ExtensionLoader({
			roots: [
				{ kind: "settings", path: "/z-root" },
				{ kind: "agent_dir", path: "/a-root" },
			],
			moduleImporter: importer,
		});

		await loader.loadAvailableExtensions(env);

		expect(loader.listAvailableExtensionIds()).toEqual(["second", "first"]);
	});

	it("rejects a module whose default export is neither factory nor definition", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		importer.setModule("/extensions/sample.ts", { apiVersion: 1 });
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);

		expect(result.loaded).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.factory_invalid", extensionId: "sample" }),
		);
	});
});
