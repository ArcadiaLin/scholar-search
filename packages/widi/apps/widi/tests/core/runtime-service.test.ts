import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@arcadialin/agent-core";
import { err, ok, ExecutionError as PiExecutionError, FileError as PiFileError } from "@arcadialin/agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, ExtensionModuleImporter } from "../../src/core/extension/index.ts";
import type { HumanRequestEnvelope } from "../../src/core/human-request.ts";
import { createWidiRuntime } from "../../src/core/runtime-service.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace/project";
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
		if (index <= 0) return "/";
		return normalized.slice(0, index);
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

	addFile(path: string, content: string): void {
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

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.addDir(this.dirname(normalized));
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized) ?? "";
		this.addFile(normalized, `${current}${typeof content === "string" ? content : new TextDecoder().decode(content)}`);
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
		return ok("/tmp/widi-runtime-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-runtime-test/file");
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
	private readonly factories = new Map<string, ExtensionFactory | undefined>();

	setFactory(path: string, factory: ExtensionFactory | undefined): void {
		this.factories.set(path, factory);
	}

	async importModule(path: string): Promise<unknown> {
		this.imports.push(path);
		return this.factories.get(path);
	}

	clearCache(): void {}
}

const defaultModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	provider: "test-provider",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const reasoningModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "reasoning-model",
	name: "Reasoning Model",
	reasoning: true,
};

function profileMarkdown(id: string): string {
	return `---
id: ${id}
label: ${id}
persist: true
---
You are ${id}.`;
}

function modelsJson(provider: string, modelId: string): string {
	return JSON.stringify({
		providers: {
			[provider]: {
				api: "openai-completions",
				baseUrl: "https://example.test/v1",
				apiKey: "test-key",
				models: [
					{
						id: modelId,
						name: modelId,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 100,
					},
				],
			},
		},
	});
}

describe("createWidiRuntime", () => {
	it("reports damaged global settings through runtime diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", "{ invalid json");

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "settings.load_failed",
				message: expect.stringContaining("global settings:"),
			}),
		);
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("main");
	});

	it("reports damaged trusted project settings through runtime diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/settings.json", "{ invalid json");

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
		});

		expect(runtime.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "settings.load_failed",
				message: expect.stringContaining("project settings:"),
			}),
		);
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("main");
	});

	it("creates services and an orchestrator without spawning an agent", async () => {
		const env = new MemoryExecutionEnv();
		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.services.cwd).toBe("/workspace/project");
		expect(runtime.services.agentDir).toBe("/home/user/.widi");
		expect(runtime.services.sessionRoot).toBe("/home/user/.widi/runs");
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("main");
		expect(runtime.orchestrator.getDefaultModel()).toBe(defaultModel);
		expect(runtime.orchestrator.listAgents().agents).toHaveLength(0);
		expect(runtime.services.defaultProfile).toMatchObject({
			id: "main",
			source: "builtin_fallback",
			profileSource: { kind: "builtin" },
		});
		expect(runtime.services.defaultModel).toEqual({
			provider: "test-provider",
			modelId: "test-model",
			source: "runtime_override",
		});
		expect(runtime.services.defaultThinkingLevel).toEqual({
			level: "off",
			requestedLevel: "medium",
			source: "builtin_fallback",
			clamped: true,
		});
		expect(runtime.orchestrator.getDefaultThinkingLevel()).toBe("off");
	});

	it("resolves a relative settings sessionDir against the agent dir, not the cwd", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ sessionDir: "sessions" }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		// Against the cwd this would be one store per launch directory, each
		// unable to offer the others' sessions to /resume.
		expect(runtime.services.sessionRoot).toBe("/home/user/.widi/sessions");
	});

	it("keeps an absolute settings sessionDir as written", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ sessionDir: "/var/widi/sessions" }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.services.sessionRoot).toBe("/var/widi/sessions");
	});

	it("resolves an explicit session root against the cwd", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ sessionDir: "sessions" }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			sessionRoot: "runs",
		});

		// A path typed in a shell means what that shell means by it.
		expect(runtime.services.sessionRoot).toBe("/workspace/project/runs");
	});

	it("registers core built-in coding and interaction tools in the tool registry", async () => {
		const env = new MemoryExecutionEnv();
		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		const resolved = runtime.services.toolRegistry.resolve();
		expect(resolved.toolNames).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"ask_human",
			"list_agents",
			"spawn_agent",
			"send_message",
			"watch_agent",
			"dispose_agent",
		]);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_human"]) {
			expect(resolved.getTool(name)?.source).toEqual({ kind: "core", id: "builtin" });
		}
		expect(resolved.diagnostics).toEqual([]);
	});

	it("gates project profiles when project trust is not granted", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));

		await expect(
			createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
				defaultModel,
				defaultProfileId: "project",
			}),
		).rejects.toMatchObject({ code: "profile.default_resolution_failed" });
	});

	it("loads project profiles when trust is granted by override", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "project",
			trustOverride: true,
		});

		expect(runtime.orchestrator.getDefaultProfileId()).toBe("project");
		expect(runtime.services.projectTrust.trusted).toBe(true);
		expect(runtime.services.defaultProfile).toMatchObject({
			id: "project",
			source: "runtime_override",
			profileSource: { kind: "cwd" },
		});
	});

	it("prefers runtime default overrides over settings defaults", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({
				defaultProfile: "project",
				defaultProvider: "settings-provider",
				defaultModel: "settings-model",
			}),
		);
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));
		env.addFile("/home/user/.widi/agent/models.json", modelsJson("settings-provider", "settings-model"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultProfileId: "project",
			defaultModel: reasoningModel,
			defaultThinkingLevel: "high",
			trustOverride: true,
		});

		expect(runtime.services.defaultProfile).toMatchObject({
			id: "project",
			source: "runtime_override",
			profileSource: { kind: "cwd" },
		});
		expect(runtime.services.defaultModel).toEqual({
			provider: "test-provider",
			modelId: "reasoning-model",
			source: "runtime_override",
		});
		expect(runtime.services.defaultThinkingLevel).toEqual({
			level: "high",
			requestedLevel: "high",
			source: "runtime_override",
			clamped: false,
		});
	});

	it("uses stored parent trust decisions", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/trust.json", '{ "/workspace": true }');
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "project",
		});

		expect(runtime.services.projectTrust).toMatchObject({ trusted: true, source: "store" });
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("project");
	});

	it("grants project trust through a confirmed human request", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));
		const requests: HumanRequestEnvelope[] = [];

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "project",
			requestHuman: async (request) => {
				requests.push(request);
				return { kind: "confirm", confirmed: true };
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: "confirm" });
		expect(runtime.services.projectTrust).toMatchObject({ trusted: true, source: "store" });
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("project");
		expect(env.files.get("/home/user/.widi/trust.json")).toContain('"/workspace/project": true');
	});

	it("stays untrusted when the trust human request is declined", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));

		await expect(
			createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
				defaultModel,
				defaultProfileId: "project",
				requestHuman: async () => ({ kind: "confirm", confirmed: false }),
			}),
		).rejects.toMatchObject({ code: "profile.default_resolution_failed" });
		expect(env.files.has("/home/user/.widi/trust.json")).toBe(false);
	});

	it("stays untrusted with a diagnostic when the trust human request fails", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			requestHuman: async () => {
				throw new Error("handler exploded");
			},
		});

		expect(runtime.services.projectTrust).toMatchObject({ trusted: false, source: "settings_default" });
		expect(runtime.diagnostics).toContainEqual(expect.objectContaining({ code: "orchestrator.human_request_failed" }));
		expect(env.files.has("/home/user/.widi/trust.json")).toBe(false);
	});

	it("connects settings resource and extension paths to loaders", async () => {
		const env = new MemoryExecutionEnv();
		env.addDir("/custom/extensions/runtime-smoke");
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({ skills: ["/custom/skills"], prompts: ["/custom/prompts"], extensions: ["/custom/extensions"] }),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.services.resourceLoader.getSkillRoots()).toContainEqual({
			kind: "settings",
			path: "/custom/skills",
		});
		expect(runtime.services.resourceLoader.getPromptTemplateRoots()).toContainEqual({
			kind: "settings",
			path: "/custom/prompts",
		});
		expect(runtime.services.extensionLoader.getRoots()).toContainEqual({
			kind: "settings",
			path: "/custom/extensions",
		});
		expect(runtime.services.extensionDiscovery.candidates).toContainEqual({
			id: "runtime-smoke",
			kind: "directory",
			path: "/custom/extensions/runtime-smoke",
			root: { kind: "settings", path: "/custom/extensions" },
		});
	});

	it("loads settings extension modules during runtime composition", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ extensions: ["/custom/extensions"] }));
		env.addFile(
			"/home/user/.widi/profiles/extension-profile.md",
			`---
id: extension-profile
label: Extension Profile
persist: false
extensions: [runtime-smoke]
---
You are extension-profile.`,
		);
		env.addFile("/custom/extensions/runtime-smoke.ts", "");
		const importer = new FakeModuleImporter();
		importer.setFactory("/custom/extensions/runtime-smoke.ts", () => {});

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "extension-profile",
			extensionModuleImporter: importer,
		});
		const agentId = await runtime.orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(importer.imports).toEqual(["/custom/extensions/runtime-smoke.ts"]);
		expect(runtime.services.extensionLoad.loaded).toEqual([
			{
				id: "runtime-smoke",
				source: {
					kind: "file",
					path: "/custom/extensions/runtime-smoke.ts",
					resolvedPath: "/custom/extensions/runtime-smoke.ts",
					root: { kind: "settings", path: "/custom/extensions" },
				},
				divisions: [],
			},
		]);
		expect(runtime.orchestrator.inspectAgent(agentId)).toMatchObject({
			extensions: { extensionIds: ["runtime-smoke"], extensions: runtime.services.extensionLoad.loaded },
		});
	});

	it("reports missing settings extension roots through runtime diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ extensions: ["/missing/extensions"] }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.diagnostics).toContainEqual(expect.objectContaining({ code: "extension.source_missing" }));
	});

	it("gates project extension discovery on project trust", async () => {
		const env = new MemoryExecutionEnv();
		env.addDir("/workspace/project/.widi/extensions/project-extension");

		const untrustedRuntime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});
		expect(untrustedRuntime.services.extensionDiscovery.candidates).toEqual([]);

		const trustedRuntime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
		});
		expect(trustedRuntime.services.extensionDiscovery.candidates).toContainEqual({
			id: "project-extension",
			kind: "directory",
			path: "/workspace/project/.widi/extensions/project-extension",
			root: { kind: "cwd", path: "/workspace/project/.widi/extensions" },
		});
	});

	// The repo's own dev run points `--agent-dir` at the checkout's config
	// directory, so the project root and the agent dir name the same extensions
	// directory. Discovered twice, every extension in it collides with the copy
	// the first pass registered and is skipped.
	it("discovers an extensions directory once when the agent dir is the project's", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/extensions/project-extension.ts", "");
		const importer = new FakeModuleImporter();
		importer.setFactory("/workspace/project/.widi/extensions/project-extension.ts", () => {});

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/workspace/project/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
			extensionModuleImporter: importer,
		});

		expect(runtime.services.extensionLoader.getRoots()).toEqual([
			{ kind: "cwd", path: "/workspace/project/.widi/extensions" },
		]);
		expect(runtime.services.extensionDiscovery.candidates).toHaveLength(1);
		expect(runtime.services.extensionLoad.loaded).toHaveLength(1);
		expect(runtime.diagnostics).not.toContainEqual(expect.objectContaining({ code: "extension.id_conflict" }));
	});

	it("skips untrusted project extension modules with diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/extensions/project-extension.ts", "");
		const importer = new FakeModuleImporter();
		importer.setFactory("/workspace/project/.widi/extensions/project-extension.ts", () => {});

		const untrustedRuntime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			extensionModuleImporter: importer,
		});

		expect(importer.imports).toEqual([]);
		expect(untrustedRuntime.services.extensionDiscovery.candidates).toEqual([]);
		expect(untrustedRuntime.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				code: "extension.project_untrusted",
				message: `Project extensions were skipped because the project is not trusted: /workspace/project/.widi/extensions`,
			}),
		);

		const trustedRuntime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
			extensionModuleImporter: importer,
		});

		expect(importer.imports).toEqual(["/workspace/project/.widi/extensions/project-extension.ts"]);
		expect(trustedRuntime.services.extensionLoad.loaded).toEqual([
			{
				id: "project-extension",
				source: {
					kind: "file",
					path: "/workspace/project/.widi/extensions/project-extension.ts",
					resolvedPath: "/workspace/project/.widi/extensions/project-extension.ts",
					root: { kind: "cwd", path: "/workspace/project/.widi/extensions" },
				},
				divisions: [],
			},
		]);
	});

	it("combines project, agent dir, and builtin profile sources", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/workspace/project/.widi/profiles/project.md", profileMarkdown("project"));
		env.addFile("/home/user/.widi/profiles/agent.md", profileMarkdown("agent"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
		});

		expect(runtime.services.profileRoots).toEqual([
			expect.objectContaining({ kind: "cwd", path: "/workspace/project/.widi/profiles", priority: 200 }),
			expect.objectContaining({ kind: "agent_dir", path: "/home/user/.widi/profiles", priority: 100 }),
		]);

		await expect(runtime.services.profileRegistry.resolveProfile("project")).resolves.toMatchObject({
			ok: true,
			source: { kind: "cwd" },
		});
		await expect(runtime.services.profileRegistry.resolveProfile("agent")).resolves.toMatchObject({
			ok: true,
			source: { kind: "agent_dir" },
		});
		await expect(runtime.services.profileRegistry.resolveProfile("main")).resolves.toMatchObject({
			ok: true,
			source: { kind: "builtin" },
		});
	});

	it("resolves default model from settings", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({ defaultProvider: "settings-provider", defaultModel: "settings-model" }),
		);
		env.addFile("/home/user/.widi/agent/models.json", modelsJson("settings-provider", "settings-model"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
		});

		expect(runtime.services.defaultModel).toEqual({
			provider: "settings-provider",
			modelId: "settings-model",
			source: "settings",
		});
		expect(runtime.orchestrator.getDefaultModel()).toMatchObject({
			provider: "settings-provider",
			id: "settings-model",
		});
	});

	it("resolves default thinking level from settings", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ defaultThinkingLevel: "high" }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel: reasoningModel,
		});

		expect(runtime.services.defaultThinkingLevel).toEqual({
			level: "high",
			requestedLevel: "high",
			source: "settings",
			clamped: false,
		});
		expect(runtime.orchestrator.getDefaultThinkingLevel()).toBe("high");
	});

	it("passes default thinking level to newly spawned harnesses", async () => {
		const env = new MemoryExecutionEnv();
		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel: reasoningModel,
			defaultThinkingLevel: "medium",
		});

		const agentId = await runtime.orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(runtime.orchestrator.getAgentThinkingLevel(agentId)).toBe("medium");
	});

	it("falls back to the first available model when settings do not specify one", async () => {
		// Built-in providers resolve ambient env credentials (e.g. HF_TOKEN), so
		// scrub the process environment to keep availability deterministic.
		for (const name of Object.keys(process.env)) {
			vi.stubEnv(name, "");
		}
		try {
			const env = new MemoryExecutionEnv();
			env.addFile("/home/user/.widi/agent/models.json", modelsJson("available-provider", "available-model"));

			const runtime = await createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
			});

			expect(runtime.services.defaultModel).toEqual({
				provider: "available-provider",
				modelId: "available-model",
				source: "available_fallback",
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("warns and falls back when the settings default model is unavailable", async () => {
		// Built-in providers resolve ambient env credentials (e.g. HF_TOKEN), so
		// scrub the process environment to keep availability deterministic.
		for (const name of Object.keys(process.env)) {
			vi.stubEnv(name, "");
		}
		try {
			const env = new MemoryExecutionEnv();
			env.addFile(
				"/home/user/.widi/settings.json",
				JSON.stringify({ defaultProvider: "settings-provider", defaultModel: "missing-model" }),
			);
			env.addFile("/home/user/.widi/agent/models.json", modelsJson("settings-provider", "settings-model"));

			const runtime = await createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
			});

			expect(runtime.services.defaultModel).toEqual({
				provider: "settings-provider",
				modelId: "settings-model",
				source: "available_fallback",
			});
			expect(runtime.diagnostics).toContainEqual(
				expect.objectContaining({ severity: "warning", code: "model.default_unavailable" }),
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("starts without a default model when nothing has configured auth", async () => {
		for (const name of Object.keys(process.env)) {
			vi.stubEnv(name, "");
		}
		try {
			const env = new MemoryExecutionEnv();
			// A provider with no apiKey and no auth.json entry is not available.
			env.addFile(
				"/home/user/.widi/agent/models.json",
				JSON.stringify({
					providers: {
						"unauthenticated-provider": {
							api: "openai-completions",
							baseUrl: "https://example.test/v1",
							models: [
								{
									id: "unauthenticated-model",
									name: "unauthenticated-model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 1000,
									maxTokens: 100,
								},
							],
						},
					},
				}),
			);

			const runtime = await createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
			});

			expect(runtime.services.defaultModel).toEqual({ source: "none" });
			expect(runtime.diagnostics).toContainEqual(
				expect.objectContaining({ severity: "warning", code: "model.none_available" }),
			);
			// The refusal lands at the first spawn, not at startup.
			await expect(runtime.orchestrator.spawnAgent({ origin: { kind: "new" } })).rejects.toMatchObject({
				code: "model.none_available",
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("prefers explicit session root over settings and fallback", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/settings.json", JSON.stringify({ sessionDir: "/settings/sessions" }));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			sessionRoot: "/override/sessions",
		});

		expect(runtime.services.sessionRoot).toBe("/override/sessions");
	});
});
