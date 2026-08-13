import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@arcadialin/agent-core";
import { err, ok, ExecutionError as PiExecutionError, FileError as PiFileError } from "@arcadialin/agent-core";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type LockResult,
} from "../../src/core/auth-storage.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly writes: Array<{ path: string; content: string | Uint8Array }> = [];

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
		this.writes.push({ path, content });
		this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
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

class TestAuthStorageBackend implements AuthStorageBackend {
	value: string | undefined;
	failRead = false;
	failWrite = false;

	constructor(value?: string) {
		this.value = value;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		if (this.failRead) {
			throw new Error("auth read failed");
		}
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			if (this.failWrite) {
				throw new Error("auth write failed");
			}
			this.value = next;
		}
		return result;
	}
}

function createConfigValueResolver(env: MemoryExecutionEnv): ConfigValueResolver {
	return new ConfigValueResolver(env, {
		getEnv: (name) => {
			if (name === "TEST_API_KEY") return "from-env";
			return undefined;
		},
	});
}

describe("FileAuthStorageBackend", () => {
	it("creates a missing auth file and exposes current content to the lock callback", async () => {
		const env = new MemoryExecutionEnv();
		const storage = new FileAuthStorageBackend(env, ".widi/auth.json");

		const result = await storage.withLockAsync(async (current): Promise<LockResult<string>> => {
			return { result: current ?? "missing" };
		});

		expect(result).toBe("{}");
		expect(env.files.get(".widi/auth.json")).toBe("{}");
		expect(env.writes).toEqual([{ path: ".widi/auth.json", content: "{}" }]);
	});

	it("writes next content when the callback returns it", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(".widi/auth.json", '{"openai":{"type":"api_key","key":"old"}}');
		const storage = new FileAuthStorageBackend(env, ".widi/auth.json");

		const result = await storage.withLockAsync(async (current): Promise<LockResult<number>> => {
			expect(current).toBe('{"openai":{"type":"api_key","key":"old"}}');
			return { result: 42, next: '{"openai":{"type":"api_key","key":"new"}}' };
		});

		expect(result).toBe(42);
		expect(env.files.get(".widi/auth.json")).toBe('{"openai":{"type":"api_key","key":"new"}}');
	});

	it("serializes overlapping operations within one backend instance", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(".widi/auth.json", "0");
		const storage = new FileAuthStorageBackend(env, ".widi/auth.json");
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});

		const first = storage.withLockAsync(async (current): Promise<LockResult<string>> => {
			order.push(`first:${current}`);
			markFirstStarted?.();
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			return { result: "first", next: "1" };
		});

		const second = storage.withLockAsync(async (current): Promise<LockResult<string>> => {
			order.push(`second:${current}`);
			return { result: "second", next: "2" };
		});

		await firstStarted;
		expect(order).toEqual(["first:0"]);
		releaseFirst?.();

		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		expect(order).toEqual(["first:0", "second:1"]);
		expect(env.files.get(".widi/auth.json")).toBe("2");
	});
});

describe("InMemoryAuthStorageBackend", () => {
	it("stores next content across async lock calls", async () => {
		const storage = new InMemoryAuthStorageBackend();

		await expect(
			storage.withLockAsync(async (current): Promise<LockResult<string | undefined>> => {
				return { result: current, next: "saved" };
			}),
		).resolves.toBeUndefined();

		await expect(
			storage.withLockAsync(async (current): Promise<LockResult<string | undefined>> => {
				return { result: current };
			}),
		).resolves.toBe("saved");
	});

	it("can start from auth storage data", async () => {
		const storage = new InMemoryAuthStorageBackend({ openai: { type: "api_key", key: "secret" } });

		await expect(
			storage.withLockAsync(async (current): Promise<LockResult<string | undefined>> => {
				return { result: current };
			}),
		).resolves.toBe(JSON.stringify({ openai: { type: "api_key", key: "secret" } }, null, 2));
	});
});

describe("AuthStorage", () => {
	it("loads credentials from storage during initialize", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(".widi/auth.json", JSON.stringify({ openai: { type: "api_key", key: "stored" } }));
		const storage = AuthStorage.fromStorage(new FileAuthStorageBackend(env, ".widi/auth.json"), {
			configValueResolver: createConfigValueResolver(env),
		});

		await storage.initialize();

		expect(storage.get("openai")).toEqual({ type: "api_key", key: "stored" });
		expect(storage.has("openai")).toBe(true);
		expect(await storage.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
	});

	it("persists set and remove operations", async () => {
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.fromStorage(new FileAuthStorageBackend(env, ".widi/auth.json"), {
			configValueResolver: createConfigValueResolver(env),
		});
		await storage.initialize();

		await storage.set("openai", { type: "api_key", key: "saved" });
		expect(JSON.parse(env.files.get(".widi/auth.json") ?? "{}")).toEqual({ openai: { type: "api_key", key: "saved" } });

		await storage.remove("openai");
		expect(JSON.parse(env.files.get(".widi/auth.json") ?? "{}")).toEqual({});
	});

	it("resolves stored API key config values through ConfigValueResolver", async () => {
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.inMemory(
			{ configValueResolver: createConfigValueResolver(env) },
			{ openai: { type: "api_key", key: "$TEST_API_KEY" } },
		);
		await storage.initialize();

		await expect(storage.getApiKey("openai")).resolves.toBe("from-env");
		await expect(storage.read("openai")).resolves.toEqual({ type: "api_key", key: "from-env" });
	});

	it("persists CredentialStore modify updates", async () => {
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.inMemory(
			{ configValueResolver: createConfigValueResolver(env) },
			{ test: { type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1 } },
		);
		await storage.initialize();

		await expect(
			storage.modify("test", async (current) =>
				current?.type === "oauth" ? { ...current, access: "new", expires: Date.now() + 1000 } : undefined,
			),
		).resolves.toEqual(expect.objectContaining({ type: "oauth", access: "new" }));
		expect(storage.get("test")).toEqual(expect.objectContaining({ type: "oauth", access: "new" }));
	});

	it("uses runtime API key overrides before stored credentials", async () => {
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.inMemory(
			{ configValueResolver: createConfigValueResolver(env) },
			{ openai: { type: "api_key", key: "stored" } },
		);
		await storage.initialize();
		storage.setRuntimeApiKey("openai", "runtime");

		await expect(storage.getApiKey("openai")).resolves.toBe("runtime");
		expect(storage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
	});

	it("drains diagnostics for auth load failures while preserving drainErrors", async () => {
		const env = new MemoryExecutionEnv();
		const backend = new TestAuthStorageBackend();
		backend.failRead = true;
		const storage = AuthStorage.fromStorage(backend, { configValueResolver: createConfigValueResolver(env) });

		await storage.initialize();

		expect(storage.drainErrors()).toEqual([expect.objectContaining({ message: "auth read failed" })]);
		expect(storage.getLoadDiagnostic()).toEqual(
			expect.objectContaining({ severity: "error", code: "auth.load_failed", message: "auth read failed" }),
		);
		expect(storage.drainDiagnostics()).toEqual([
			expect.objectContaining({ severity: "error", code: "auth.load_failed", message: "auth read failed" }),
		]);
	});

	it("drains diagnostics for auth persist failures", async () => {
		const env = new MemoryExecutionEnv();
		const backend = new TestAuthStorageBackend("{}");
		const storage = AuthStorage.fromStorage(backend, { configValueResolver: createConfigValueResolver(env) });
		await storage.initialize();
		backend.failWrite = true;

		await storage.set("openai", { type: "api_key", key: "saved" });

		expect(storage.drainDiagnostics()).toContainEqual(
			expect.objectContaining({ severity: "error", code: "auth.persist_failed", message: "openai: auth write failed" }),
		);
	});

	it("drains diagnostics for OAuth refresh failures while returning undefined", async () => {
		const providerId = "test-oauth-refresh-failure";
		const oauth: OAuthAuth = {
			name: "Test OAuth",
			login: async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() - 1 }),
			refresh: async () => {
				throw new Error("refresh failed");
			},
			toAuth: async () => ({ apiKey: "oauth-token" }),
		};
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.inMemory(
			{ configValueResolver: createConfigValueResolver(env) },
			{ [providerId]: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() - 1 } },
		);
		storage.setOAuthProvidersSource(() => [{ id: providerId, name: oauth.name, oauth }]);
		await storage.initialize();

		await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
		expect(storage.drainDiagnostics()).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "auth.oauth_refresh_failed",
				message: `${providerId}: refresh failed`,
			}),
		);
	});

	it("records OAuth refresh diagnostics from CredentialStore modify failures", async () => {
		const env = new MemoryExecutionEnv();
		const storage = AuthStorage.inMemory(
			{ configValueResolver: createConfigValueResolver(env) },
			{ test: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() - 1 } },
		);
		await storage.initialize();

		await expect(
			storage.modify("test", async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");
		expect(storage.drainDiagnostics()).toContainEqual(
			expect.objectContaining({
				severity: "error",
				code: "auth.oauth_refresh_failed",
				message: "test: refresh failed",
			}),
		);
	});
});
