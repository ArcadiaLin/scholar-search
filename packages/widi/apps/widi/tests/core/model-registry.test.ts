import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@arcadialin/agent-core";
import { err, ok, ExecutionError as PiExecutionError, FileError as PiFileError } from "@arcadialin/agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry, parseThinkingLevel, THINKING_LEVELS } from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly executedCommands: string[] = [];

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok(this.files.has(path));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const content = this.files.get(path);
		if (content === undefined) {
			return err(new PiFileError("not_found", `File not found: ${path}`, path));
		}
		return ok(content);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async exec(
		command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.executedCommands.push(command);
		if (command === "token-command") {
			return ok({ stdout: "command-token\n", stderr: "", exitCode: 0 });
		}
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(path.startsWith("/") ? path : `${this.cwd}/${path}`);
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(parts.join("/").replace(/\/+/g, "/"));
	}

	async readTextLines(): Promise<Result<string[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async appendFile(): Promise<Result<void, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async fileInfo(): Promise<Result<FileInfo, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async listDir(): Promise<Result<FileInfo[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(path);
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		this.files.delete(path);
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

function createResolver(env: MemoryExecutionEnv): ConfigValueResolver {
	return new ConfigValueResolver(env, {
		getEnv: (name) => {
			if (name === "CUSTOM_API_KEY") return "env-token";
			if (name === "CUSTOM_HEADER") return "env-header";
			return undefined;
		},
	});
}

async function createRegistry(env: MemoryExecutionEnv, modelsJsonPath?: string): Promise<ModelRegistry> {
	const configValueResolver = createResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	return await ModelRegistry.create({ executionEnv: env, authStorage, configValueResolver, modelsJsonPath });
}

describe("ModelRegistry", () => {
	it("loads built-in models without models.json", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);

		expect(registry.getAll().length).toBeGreaterThan(0);
		expect(registry.getError()).toBeUndefined();
	});

	it("uses Pi canonical thinking levels", () => {
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(parseThinkingLevel("max")).toBe("max");
	});

	it("loads custom models and resolves provider request auth through shared ExecutionEnv resolver", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					custom: {
						name: "Custom",
						baseUrl: "https://example.test/v1",
						apiKey: "$CUSTOM_API_KEY",
						api: "openai-completions",
						headers: { "X-Custom": "$CUSTOM_HEADER" },
						authHeader: true,
						models: [
							{
								id: "custom-model",
								name: "Custom Model",
								reasoning: true,
								thinkingLevelMap: { xhigh: "max" },
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);

		const registry = await createRegistry(env, ".widi/models.json");
		const model = registry.find("custom", "custom-model");

		expect(model).toMatchObject({
			id: "custom-model",
			provider: "custom",
			baseUrl: "https://example.test/v1",
			thinkingLevelMap: { xhigh: "max" },
		});
		if (!model) throw new Error("Expected custom model to resolve.");
		await expect(registry.getAvailable()).resolves.toContain(model);
		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: true,
			apiKey: "env-token",
			headers: { "X-Custom": "env-header", Authorization: "Bearer env-token" },
		});
	});

	it("supports command-backed provider api keys", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					commanded: {
						baseUrl: "https://example.test/v1",
						apiKey: "!token-command",
						api: "openai-completions",
						models: [
							{
								id: "model",
								name: "Model",
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

		const registry = await createRegistry(env, ".widi/models.json");
		const model = registry.find("commanded", "model");
		if (!model) throw new Error("Expected commanded model to resolve.");

		await expect(registry.getAvailable()).resolves.toContain(model);
		expect(env.executedCommands).toEqual([]);
		await expect(registry.getProviderAuthStatus("commanded")).resolves.toEqual({
			configured: true,
			source: "models_json_command",
		});
		expect(env.executedCommands).toEqual([]);
		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: true,
			apiKey: "command-token",
			headers: undefined,
		});
		expect(env.executedCommands).toEqual(["token-command"]);
	});

	it("passes stored OAuth credentials through Pi Models so provider toAuth can override request baseUrl", async () => {
		const env = new MemoryExecutionEnv();
		const configValueResolver = createResolver(env);
		const authStorage = AuthStorage.inMemory(
			{ configValueResolver },
			{
				"github-copilot": {
					type: "oauth",
					access: "proxy-ep=proxy.enterprise.example;",
					refresh: "refresh",
					// Pi refreshes any token that expires within five minutes, so stay
					// clear of that window to exercise the stored credential path.
					expires: Date.now() + 60 * 60_000,
				},
			},
		);
		const registry = await ModelRegistry.create({ executionEnv: env, authStorage, configValueResolver });
		const model = registry.getAll().find((candidate) => candidate.provider === "github-copilot");
		if (!model) throw new Error("Expected GitHub Copilot model to resolve.");

		await expect(registry.getRuntime().getAuth(model)).resolves.toEqual(
			expect.objectContaining({
				auth: expect.objectContaining({
					apiKey: "proxy-ep=proxy.enterprise.example;",
					baseUrl: "https://api.enterprise.example",
				}),
				source: "OAuth",
			}),
		);
	});

	it("keeps built-in models and records load errors for invalid models.json", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(".widi/models.json", "{ invalid");

		const registry = await createRegistry(env, ".widi/models.json");

		expect(registry.getAll().length).toBeGreaterThan(0);
		expect(registry.getError()).toContain("Failed to parse models.json");
		expect(registry.getLoadDiagnostic()).toEqual(
			expect.objectContaining({
				severity: "error",
				code: "model.load_failed",
				message: expect.stringContaining("Failed to parse models.json"),
			}),
		);
		expect(registry.getLoadDiagnostic()?.message).toContain("(.widi/models.json)");
		expect(registry.drainDiagnostics()).toContainEqual(expect.objectContaining({ code: "model.load_failed" }));
	});

	it("records diagnostics for authHeader models without API keys", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);
		const model = createTestModel("missing-auth");
		registry.registerProvider("missing-auth", { authHeader: true });

		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: false,
			error: 'No API key found for "missing-auth"',
		});
		expect(registry.drainDiagnostics()).toContainEqual({
			severity: "error",
			code: "model.auth_missing",
			message: 'missing-auth/test-model: No API key found for "missing-auth"',
		});
	});

	it("records diagnostics for request auth resolution failures", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);
		const model = createTestModel("missing-env");
		registry.registerProvider("missing-env", { apiKey: "$MISSING_MODEL_API_KEY" });

		const result = await registry.getApiKeyAndHeaders(model);

		expect(result).toEqual({
			ok: false,
			error: 'Failed to resolve API key for provider "missing-env" from environment variable: MISSING_MODEL_API_KEY',
		});
		expect(registry.drainDiagnostics()).toContainEqual({
			severity: "error",
			code: "model.auth_resolution_failed",
			message:
				'missing-env/test-model: Failed to resolve API key for provider "missing-env" from environment variable: MISSING_MODEL_API_KEY',
		});
	});
});

function createTestModel(provider: string): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as Api,
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

function extensionProviderConfig(baseUrl = "https://gateway.test/v1") {
	return {
		baseUrl,
		apiKey: "gateway-key",
		api: "openai-completions" as Api,
		models: [
			{
				id: "gateway-model",
				name: "Gateway Model",
				reasoning: false,
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 4096,
			},
		],
	};
}

describe("ModelRegistry extension providers", () => {
	it("registers with provenance and rejects conflicting or incomplete registrations", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://example.test/v1",
						apiKey: "user-key",
						api: "openai-completions",
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);
		const registry = await createRegistry(env, ".widi/models.json");
		registry.registerProvider("dyn", { baseUrl: "https://dyn.test/v1" });

		expect(
			registry.registerExtensionProvider("gateway", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: true });
		expect(registry.find("gateway", "gateway-model")).toBeDefined();
		expect(registry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "alpha", agentIds: ["agent-1"] },
		]);

		expect(
			registry.registerExtensionProvider("anthropic", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: false, reason: "conflict", conflictWith: "builtin" });
		expect(
			registry.registerExtensionProvider("custom", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: false, reason: "conflict", conflictWith: "models_json" });
		expect(
			registry.registerExtensionProvider("dyn", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: false, reason: "conflict", conflictWith: "runtime" });
		expect(
			registry.registerExtensionProvider("gateway", extensionProviderConfig(), {
				extensionId: "beta",
				agentId: "agent-2",
			}),
		).toEqual({ ok: false, reason: "conflict", conflictWith: "extension", ownerExtensionId: "alpha" });
		expect(
			registry.registerExtensionProvider(
				"no-models",
				{ baseUrl: "https://gateway.test/v1", apiKey: "key" },
				{ extensionId: "alpha", agentId: "agent-1" },
			),
		).toEqual({
			ok: false,
			reason: "invalid",
			message: 'Provider no-models: extension providers must define "models".',
		});
	});

	it("upserts same-extension registrations across agents and removes by refcount", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);

		expect(
			registry.registerExtensionProvider("gateway", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: true });
		expect(
			registry.registerExtensionProvider("gateway", extensionProviderConfig("https://gateway-v2.test/v1"), {
				extensionId: "alpha",
				agentId: "agent-2",
			}),
		).toEqual({ ok: true });
		expect(registry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "alpha", agentIds: ["agent-1", "agent-2"] },
		]);
		expect(registry.find("gateway", "gateway-model")).toMatchObject({ baseUrl: "https://gateway-v2.test/v1" });

		await expect(registry.unregisterExtensionProviders("agent-1")).resolves.toEqual([]);
		expect(registry.find("gateway", "gateway-model")).toBeDefined();
		await expect(registry.unregisterExtensionProviders("agent-2")).resolves.toEqual(["gateway"]);
		expect(registry.find("gateway", "gateway-model")).toBe(undefined);
		expect(registry.getExtensionProviderRegistrations()).toEqual([]);
	});

	it("replays extension providers across refresh and drops newly conflicting names with a diagnostic", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env, ".widi/models.json");
		expect(
			registry.registerExtensionProvider("gateway", extensionProviderConfig(), {
				extensionId: "alpha",
				agentId: "agent-1",
			}),
		).toEqual({ ok: true });

		await registry.refresh();
		expect(registry.find("gateway", "gateway-model")).toBeDefined();

		// models.json claims the name: first-registration-wins re-runs on
		// refresh and the extension provider drops with a diagnostic.
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://user-owned.test/v1",
						apiKey: "user-key",
						api: "openai-completions",
						models: [{ id: "user-model", name: "User Model" }],
					},
				},
			}),
		);
		await registry.refresh();

		expect(registry.getExtensionProviderRegistrations()).toEqual([]);
		expect(registry.find("gateway", "gateway-model")).toBe(undefined);
		expect(registry.find("gateway", "user-model")).toBeDefined();
		expect(registry.drainDiagnostics()).toContainEqual({
			severity: "warning",
			code: "extension.provider_conflict",
			message: "Extension 'alpha' provider 'gateway' conflicts with a models_json provider and was dropped on refresh.",
			extensionId: "alpha",
		});
	});
});
