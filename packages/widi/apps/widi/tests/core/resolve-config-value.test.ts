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
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";

interface ExecCall {
	command: string;
	options?: ShellExecOptions;
}

class FakeExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly execCalls: ExecCall[] = [];
	private readonly commandResults = new Map<
		string,
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	>();

	setCommandResult(
		command: string,
		result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>,
	): void {
		this.commandResults.set(command, result);
	}

	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.execCalls.push({ command, options });
		return this.commandResults.get(command) ?? err(new PiExecutionError("unknown", `Unexpected command: ${command}`));
	}

	async absolutePath(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async joinPath(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async readTextFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async readTextLines(): Promise<Result<string[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(): Promise<Result<void, FileError>> {
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

	async canonicalPath(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async exists(): Promise<Result<boolean, FileError>> {
		return ok(false);
	}

	async createDir(): Promise<Result<void, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async remove(): Promise<Result<void, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

function createResolver(envValues: Record<string, string | undefined> = {}): {
	env: FakeExecutionEnv;
	resolver: ConfigValueResolver;
} {
	const env = new FakeExecutionEnv();
	const resolver = new ConfigValueResolver(env, { getEnv: (name) => envValues[name] });
	return { env, resolver };
}

describe("ConfigValueResolver", () => {
	it("resolves literals, env templates, and escapes", async () => {
		const { resolver } = createResolver({ API_KEY: "secret", HOST: "example.test" });

		await expect(resolver.resolveConfigValue("literal")).resolves.toBe("literal");
		await expect(resolver.resolveConfigValue("$API_KEY")).resolves.toBe("secret");
		await expect(resolver.resolveConfigValue(`https://$${"{HOST}"}/$API_KEY`)).resolves.toBe(
			"https://example.test/secret",
		);
		await expect(resolver.resolveConfigValue("cost=$$5 command=$!echo")).resolves.toBe("cost=$5 command=!echo");
	});

	it("reports env var names and treats empty env values as missing", async () => {
		const { resolver } = createResolver({ EMPTY: "", PRESENT: "value" });

		expect(resolver.getConfigValueEnvVarName("$PRESENT")).toBe("PRESENT");
		expect(resolver.getConfigValueEnvVarName("x-$PRESENT")).toBeUndefined();
		expect(resolver.getConfigValueEnvVarNames("$PRESENT:$EMPTY:$PRESENT")).toEqual(["PRESENT", "EMPTY"]);
		await expect(resolver.getMissingConfigValueEnvVarNames("$PRESENT:$EMPTY:$MISSING")).resolves.toEqual([
			"EMPTY",
			"MISSING",
		]);
		await expect(resolver.isConfigValueConfigured("$PRESENT")).resolves.toBe(true);
		await expect(resolver.isConfigValueConfigured("$EMPTY")).resolves.toBe(false);
	});

	it("keeps invalid env syntax as literal text", async () => {
		const { resolver } = createResolver({ VALID: "ok" });

		await expect(resolver.resolveConfigValue(`$${"{NOT-VALID}"}-$-tail-$VALID`)).resolves.toBe(
			`$${"{NOT-VALID}"}-$-tail-ok`,
		);
	});

	it("executes command config values through ExecutionEnv with cache", async () => {
		const { env, resolver } = createResolver();
		env.setCommandResult("token", ok({ stdout: " first \n", stderr: "", exitCode: 0 }));

		await expect(resolver.resolveConfigValue("!token")).resolves.toBe("first");
		env.setCommandResult("token", ok({ stdout: " second \n", stderr: "", exitCode: 0 }));
		await expect(resolver.resolveConfigValue("!token")).resolves.toBe("first");
		await expect(resolver.resolveConfigValueUncached("!token")).resolves.toBe("second");

		expect(env.execCalls).toEqual([
			{ command: "token", options: { timeout: 10 } },
			{ command: "token", options: { timeout: 10 } },
		]);
	});

	it("resolves failed, non-zero, and empty command outputs to undefined", async () => {
		const { env, resolver } = createResolver();
		env.setCommandResult("fail", err(new PiExecutionError("spawn_error", "failed")));
		env.setCommandResult("nonzero", ok({ stdout: "value", stderr: "", exitCode: 1 }));
		env.setCommandResult("empty", ok({ stdout: " \n", stderr: "", exitCode: 0 }));

		await expect(resolver.resolveConfigValue("!fail")).resolves.toBeUndefined();
		await expect(resolver.resolveConfigValue("!nonzero")).resolves.toBeUndefined();
		await expect(resolver.resolveConfigValue("!empty")).resolves.toBeUndefined();
	});

	it("throws useful errors for unresolved config values", async () => {
		const { env, resolver } = createResolver({ ONE: undefined, TWO: undefined });
		env.setCommandResult("missing-token", ok({ stdout: "", stderr: "", exitCode: 0 }));

		await expect(resolver.resolveConfigValueOrThrow("!missing-token", "API key")).rejects.toThrow(
			"Failed to resolve API key from shell command: missing-token",
		);
		await expect(resolver.resolveConfigValueOrThrow("$ONE", "API key")).rejects.toThrow(
			"Failed to resolve API key from environment variable: ONE",
		);
		await expect(resolver.resolveConfigValueOrThrow("$ONE:$TWO", "API key")).rejects.toThrow(
			"Failed to resolve API key from environment variables: ONE, TWO",
		);
	});

	it("resolves headers and omits unresolved optional header values", async () => {
		const { resolver } = createResolver({ TOKEN: "secret", MISSING: undefined });

		await expect(resolver.resolveHeaders({ Authorization: "Bearer $TOKEN", "X-Missing": "$MISSING" })).resolves.toEqual(
			{ Authorization: "Bearer secret" },
		);

		await expect(resolver.resolveHeadersOrThrow({ Authorization: "Bearer $TOKEN" }, "provider")).resolves.toEqual({
			Authorization: "Bearer secret",
		});

		await expect(resolver.resolveHeadersOrThrow({ "X-Missing": "$MISSING" }, "provider")).rejects.toThrow(
			'Failed to resolve provider header "X-Missing" from environment variable: MISSING',
		);
	});

	it("uses custom command timeouts and can clear command cache", async () => {
		const { env } = createResolver();
		const resolver = new ConfigValueResolver(env, { commandTimeoutSeconds: 3 });
		env.setCommandResult("token", ok({ stdout: "one", stderr: "", exitCode: 0 }));

		await expect(resolver.resolveConfigValue("!token")).resolves.toBe("one");
		env.setCommandResult("token", ok({ stdout: "two", stderr: "", exitCode: 0 }));
		resolver.clearConfigValueCache();
		await expect(resolver.resolveConfigValue("!token")).resolves.toBe("two");

		expect(env.execCalls).toEqual([
			{ command: "token", options: { timeout: 3 } },
			{ command: "token", options: { timeout: 3 } },
		]);
	});

	it("detects command and legacy env-name config values", () => {
		const { resolver } = createResolver();

		expect(resolver.isCommandConfigValue("!echo token")).toBe(true);
		expect(resolver.isCommandConfigValue("$TOKEN")).toBe(false);
		expect(resolver.isLegacyEnvVarNameConfigValue("OPENAI_API_KEY")).toBe(true);
		expect(resolver.isLegacyEnvVarNameConfigValue("OpenaiApiKey")).toBe(false);
	});
});
