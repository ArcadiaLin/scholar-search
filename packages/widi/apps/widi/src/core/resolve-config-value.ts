import type { ExecutionEnv } from "@arcadialin/agent-core";

export type MaybePromise<T> = T | Promise<T>;
export type GetEnv = (name: string) => MaybePromise<string | undefined>;

export interface ConfigValueResolverOptions {
	/** Timeout in seconds for shell-backed config values such as "!echo token". Defaults to 10. */
	commandTimeoutSeconds?: number;
	/** Optional environment value source used by getEnv(). Defaults to process.env. */
	getEnv?: GetEnv;
}

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 10;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const LEGACY_ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };
type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

/**
 * Resolve configuration values that may be shell commands, environment templates, or literals.
 *
 * Supported syntax:
 * - Values starting with "!" execute the rest as a shell command through ExecutionEnv.exec.
 * - "$ENV_VAR" and "${ENV_VAR}" interpolate values returned by getEnv().
 * - "$$" escapes a literal "$" and "$!" escapes a literal "!" in non-command values.
 * - Other values are treated as literals.
 */
export class ConfigValueResolver {
	private readonly executionEnv: ExecutionEnv;
	private readonly commandTimeoutSeconds: number;
	private readonly commandResultCache: Map<string, string | undefined> = new Map();
	private readonly getEnvValue: GetEnv;

	constructor(executionEnv: ExecutionEnv, options: ConfigValueResolverOptions = {}) {
		this.executionEnv = executionEnv;
		this.commandTimeoutSeconds = options.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
		this.getEnvValue = options.getEnv ?? ((name) => process.env[name]);
	}

	/**
	 * Return a configured environment value by name.
	 *
	 * This method is intentionally public so callers, subclasses, or future runtime adapters can own
	 * environment lookup separately from ExecutionEnv. Empty strings are treated as unconfigured.
	 */
	getEnv(name: string): MaybePromise<string | undefined> {
		const value = this.getEnvValue(name);
		if (typeof value === "string") return value || undefined;
		if (value === undefined) return undefined;
		return value.then((resolvedValue) => resolvedValue || undefined);
	}

	/**
	 * Return the environment variable name when config is exactly one env reference.
	 *
	 * For example, "$OPENAI_API_KEY" returns "OPENAI_API_KEY", while
	 * "Bearer $OPENAI_API_KEY" returns undefined.
	 */
	getConfigValueEnvVarName(config: string): string | undefined {
		const reference = parseConfigValueReference(config);
		if (reference.type !== "template") return undefined;
		return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
	}

	/**
	 * Return all unique environment variable names referenced by a config template.
	 *
	 * Command values such as "!echo token" do not expose environment variable names here because
	 * command parsing belongs to the configured shell runtime.
	 */
	getConfigValueEnvVarNames(config: string): string[] {
		const reference = parseConfigValueReference(config);
		return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
	}

	/**
	 * Return referenced environment variable names whose values are currently unavailable.
	 *
	 * The lookup uses getEnv(), so custom env sources and async runtime adapters are respected.
	 */
	async getMissingConfigValueEnvVarNames(config: string): Promise<string[]> {
		const missingNames: string[] = [];
		for (const name of this.getConfigValueEnvVarNames(config)) {
			const value = await this.getEnv(name);
			if (value === undefined) {
				missingNames.push(name);
			}
		}
		return missingNames;
	}

	isCommandConfigValue(config: string): boolean {
		return parseConfigValueReference(config).type === "command";
	}

	/**
	 * Check whether all environment variables referenced by config are available.
	 *
	 * Literal and command values are considered configured by this check; command execution is only
	 * attempted when resolving the value.
	 */
	async isConfigValueConfigured(config: string): Promise<boolean> {
		return (await this.getMissingConfigValueEnvVarNames(config)).length === 0;
	}

	isLegacyEnvVarNameConfigValue(config: string): boolean {
		return LEGACY_ENV_VAR_NAME_RE.test(config);
	}

	/**
	 * Resolve a config value to its concrete value.
	 *
	 * Command values are cached for the lifetime of this resolver instance. Missing env variables,
	 * failed commands, non-zero command exits, and empty command stdout resolve to undefined.
	 */
	async resolveConfigValue(config: string): Promise<string | undefined> {
		const reference = parseConfigValueReference(config);
		if (reference.type === "command") {
			return await this.executeCommand(reference.config);
		}
		return await this.resolveTemplate(reference.parts);
	}

	/**
	 * Resolve a config value without reading or writing the command result cache.
	 *
	 * Template values are unaffected because environment lookup is delegated to getEnv().
	 */
	async resolveConfigValueUncached(config: string): Promise<string | undefined> {
		const reference = parseConfigValueReference(config);
		if (reference.type === "command") {
			return await this.executeCommandUncached(reference.config);
		}
		return await this.resolveTemplate(reference.parts);
	}

	/**
	 * Resolve a config value or throw an error that identifies the missing source.
	 *
	 * Error messages distinguish shell command failures from one or more missing environment
	 * variables, which lets callers surface actionable auth/config warnings.
	 */
	async resolveConfigValueOrThrow(config: string, description: string): Promise<string> {
		const resolvedValue = await this.resolveConfigValueUncached(config);
		if (resolvedValue !== undefined) {
			return resolvedValue;
		}

		const reference = parseConfigValueReference(config);
		if (reference.type === "command") {
			throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
		}

		const missingEnvVars = await this.getMissingConfigValueEnvVarNames(config);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}

		throw new Error(`Failed to resolve ${description}`);
	}

	/**
	 * Resolve header values using the same rules as API keys and other config values.
	 *
	 * Headers that resolve to undefined or an empty string are omitted. Use resolveHeadersOrThrow()
	 * when every configured header must resolve successfully.
	 */
	async resolveHeaders(headers: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
		if (!headers) return undefined;
		const resolved: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			const resolvedValue = await this.resolveConfigValue(value);
			if (resolvedValue) {
				resolved[key] = resolvedValue;
			}
		}
		return Object.keys(resolved).length > 0 ? resolved : undefined;
	}

	/**
	 * Resolve all configured header values or throw on the first unresolved header.
	 *
	 * The description is included in thrown errors, for example:
	 * provider "openai" header "Authorization".
	 */
	async resolveHeadersOrThrow(
		headers: Record<string, string> | undefined,
		description: string,
	): Promise<Record<string, string> | undefined> {
		if (!headers) return undefined;
		const resolved: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			resolved[key] = await this.resolveConfigValueOrThrow(value, `${description} header "${key}"`);
		}
		return Object.keys(resolved).length > 0 ? resolved : undefined;
	}

	/** Clear cached shell command results for this resolver instance. */
	clearConfigValueCache(): void {
		this.commandResultCache.clear();
	}

	private async resolveTemplate(parts: TemplatePart[]): Promise<string | undefined> {
		let resolved = "";
		for (const part of parts) {
			if (part.type === "literal") {
				resolved += part.value;
				continue;
			}

			const envValue = await this.getEnv(part.name);
			if (envValue === undefined) return undefined;
			resolved += envValue;
		}
		return resolved;
	}

	private async executeCommand(commandConfig: string): Promise<string | undefined> {
		if (this.commandResultCache.has(commandConfig)) {
			return this.commandResultCache.get(commandConfig);
		}

		const result = await this.executeCommandUncached(commandConfig);
		this.commandResultCache.set(commandConfig, result);
		return result;
	}

	private async executeCommandUncached(commandConfig: string): Promise<string | undefined> {
		const command = commandConfig.slice(1);
		const result = await this.executionEnv.exec(command, { timeout: this.commandTimeoutSeconds });
		if (!result.ok || result.value.exitCode !== 0) {
			return undefined;
		}

		return result.value.stdout.trim() || undefined;
	}
}
