import { bench, describe } from "vitest";
import { ConfigValueResolver } from "../src/core/resolve-config-value.ts";

// ConfigValueResolver only calls executionEnv.exec(), so a minimal stub is
// enough to exercise the parsing and resolution logic without pulling in a real
// runtime. The stub mirrors the success shape the resolver expects.
const executionEnv = {
	cwd: "/workspace",
	exec: async () => ({
		ok: true,
		value: { stdout: "resolved-token\n", stderr: "", exitCode: 0 },
	}),
} as unknown as ConstructorParameters<typeof ConfigValueResolver>[0];

const envValues: Record<string, string> = {
	OPENAI_API_KEY: "sk-openai-secret",
	ANTHROPIC_API_KEY: "sk-anthropic-secret",
	HOST: "api.example.test",
	PORT: "8443",
	TOKEN: "bearer-token",
	REGION: "us-east-1",
};

const resolver = new ConfigValueResolver(executionEnv, {
	getEnv: (name) => envValues[name],
});

// A representative mix of literal, single-env, multi-env, and escape templates.
const templateConfigs = [
	"plain-literal-value",
	"$OPENAI_API_KEY",
	"Bearer $TOKEN",
	"https://${HOST}:${PORT}/v1/${REGION}/chat",
	"key=$OPENAI_API_KEY;fallback=$ANTHROPIC_API_KEY;host=${HOST}",
	"escaped=$$5 literal-bang=$!echo tail=$UNKNOWN_VAR",
];

const headerSet: Record<string, string> = {
	Authorization: "Bearer $TOKEN",
	"X-Api-Key": "$OPENAI_API_KEY",
	"X-Host": "${HOST}:${PORT}",
	"X-Region": "$REGION",
};

describe("ConfigValueResolver", () => {
	bench("resolve template config values", async () => {
		for (const config of templateConfigs) {
			await resolver.resolveConfigValueUncached(config);
		}
	});

	bench("extract referenced env var names", () => {
		for (const config of templateConfigs) {
			resolver.getConfigValueEnvVarNames(config);
			resolver.getConfigValueEnvVarName(config);
		}
	});

	bench("classify command and legacy env-name values", () => {
		for (const config of templateConfigs) {
			resolver.isCommandConfigValue(config);
			resolver.isLegacyEnvVarNameConfigValue(config);
		}
	});

	bench("resolve command config value", async () => {
		await resolver.resolveConfigValueUncached("!echo resolved-token");
	});

	bench("resolve header set", async () => {
		await resolver.resolveHeaders(headerSet);
	});
});
