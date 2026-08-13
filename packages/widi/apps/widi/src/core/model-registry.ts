/**
 * Model registry - manages built-in and custom models, resolves request auth.
 */

import type { ExecutionEnv, ThinkingLevel } from "@arcadialin/agent-core";
import {
	type AnthropicMessagesCompat,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	createModels,
	createProvider,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelThinkingLevel,
	type MutableModels,
	type OAuthAuth,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	type Provider,
	type ProviderAuth,
	type ProviderHeaders,
	type ProviderStreams,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { type AuthStatus, AuthStorage } from "./auth-storage.js";
import { DEFAULT_MODELSJSON_PATH } from "./constants.js";
import type { CoreDiagnostic } from "./diagnostics.ts";
import { ConfigValueResolver } from "./resolve-config-value.js";

const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	sendSessionIdHeader: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() }),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({ providers: Type.Record(Type.String(), ProviderConfigSchema) });

const validateModelsConfig = Compile(ModelsConfigSchema);
type ModelsConfig = Static<typeof ModelsConfigSchema>;

interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

export type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: ProviderHeaders }
	| { ok: false; error: string };

export type ModelDiagnostic = CoreDiagnostic;
type DiagnosticPublisher = (diagnostics: readonly ModelDiagnostic[]) => Promise<void> | void;

interface CustomModelsResult {
	models: Model<Api>[];
	providerOverrides: Map<string, ProviderOverride>;
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

export interface ExtensionProviderProvenance {
	extensionId: string;
	agentId: string;
}

export type ExtensionProviderConflict = "builtin" | "extension" | "models_json" | "runtime";

export type ExtensionProviderRegistrationResult =
	| { ok: true }
	| { ok: false; reason: "conflict"; conflictWith: ExtensionProviderConflict; ownerExtensionId?: string }
	| { ok: false; reason: "invalid"; message: string };

export interface ExtensionProviderRegistrationSnapshot {
	providerName: string;
	extensionId: string;
	agentIds: readonly string[];
}

interface ExtensionProviderRegistration {
	config: ProviderConfigInput;
	extensionId: string;
	registrantAgentIds: Set<string>;
}

export interface ModelRegistryOptions {
	executionEnv: ExecutionEnv;
	authStorage?: AuthStorage;
	configValueResolver?: ConfigValueResolver;
	modelsJsonPath?: string;
}

export function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelReference(reference: string): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return undefined;
	}
	return { provider: trimmed.slice(0, slashIndex), modelId: trimmed.slice(slashIndex + 1) };
}

export const THINKING_LEVEL_SET = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} as const satisfies Record<ThinkingLevel | ModelThinkingLevel, true>;

export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_SET) as (keyof typeof THINKING_LEVEL_SET)[];

export function parseThinkingLevel(level: string): ThinkingLevel | undefined {
	const trimmed = level.trim();
	return THINKING_LEVELS.some((candidate) => candidate === trimmed) ? (trimmed as ThinkingLevel) : undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], providerOverrides: new Map(), modelOverrides: new Map(), error };
}

function createApiStreams(api: Api): ProviderStreams {
	switch (api) {
		case "anthropic-messages":
			return anthropicMessagesApi();
		case "openai-completions":
			return openAICompletionsApi();
		case "openai-responses":
			return openAIResponsesApi();
		case "openai-codex-responses":
			return openAICodexResponsesApi();
		case "azure-openai-responses":
			return azureOpenAIResponsesApi();
		case "google-generative-ai":
			return googleGenerativeAIApi();
		case "google-vertex":
			return googleVertexApi();
		case "mistral-conversations":
			return mistralConversationsApi();
		case "bedrock-converse-stream":
			return bedrockConverseStreamApi();
		default:
			throw new Error(`No API implementation registered for api: ${api}`);
	}
}

function providerDisplayName(providerName: string): string {
	return providerName
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(
			/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
			(match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""),
		);
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 *
 * Nested objects such as cost and compat are merged rather than replaced so
 * models.json can override only the fields it cares about.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides.
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// Cost is a partial override; missing fields keep the built-in values.
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	// Compat has nested provider-specific options, so merge it deeply.
	result.compat = mergeCompat(model.compat, override.compat);
	return result;
}

/**
 * Model registry - loads built-in models, custom models, and request auth config.
 */
export class ModelRegistry {
	private readonly runtime: MutableModels;
	private readonly runtimeWithDiagnostics: Models;
	private readonly providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private readonly modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private readonly registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private readonly extensionProviders: Map<string, ExtensionProviderRegistration> = new Map();
	private loadError: string | undefined;
	private loadDiagnostic: ModelDiagnostic | undefined;
	private diagnostics: ModelDiagnostic[] = [];
	private diagnosticPublisher: DiagnosticPublisher | undefined;
	readonly authStorage: AuthStorage;
	readonly configValueResolver: ConfigValueResolver;
	private readonly executionEnv: ExecutionEnv;
	private readonly modelsJsonPath: string | undefined;

	private constructor(options: {
		executionEnv: ExecutionEnv;
		authStorage: AuthStorage;
		configValueResolver: ConfigValueResolver;
		modelsJsonPath?: string;
	}) {
		this.executionEnv = options.executionEnv;
		this.authStorage = options.authStorage;
		this.configValueResolver = options.configValueResolver;
		this.modelsJsonPath = options.modelsJsonPath;
		this.runtime = createModels({
			credentials: this.authStorage,
			authContext: {
				env: async (name) => await this.configValueResolver.getEnv(name),
				fileExists: async (path) => {
					const result = await this.executionEnv.exists(path);
					return result.ok ? result.value : false;
				},
			},
		});
		this.authStorage.setOAuthProvidersSource(() =>
			this.runtime
				.getProviders()
				.flatMap((provider) =>
					provider.auth.oauth ? [{ id: provider.id, name: provider.auth.oauth.name, oauth: provider.auth.oauth }] : [],
				),
		);
		this.runtimeWithDiagnostics = new DiagnosticPublishingModels(
			this.runtime,
			async () => {
				await this.publishRuntimeDiagnostics();
			},
			async (model) => {
				return await this.configValueResolver.resolveHeadersOrThrow(
					this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
					`model "${model.provider}/${model.id}"`,
				);
			},
		);
	}

	static async create(options: ModelRegistryOptions): Promise<ModelRegistry> {
		const configValueResolver = options.configValueResolver ?? new ConfigValueResolver(options.executionEnv);
		const authStorage = options.authStorage ?? AuthStorage.create(options.executionEnv, { configValueResolver });
		await authStorage.initialize();
		const registry = new ModelRegistry({
			executionEnv: options.executionEnv,
			authStorage,
			configValueResolver,
			modelsJsonPath: options.modelsJsonPath ?? DEFAULT_MODELSJSON_PATH,
		});
		await registry.refresh();
		return registry;
	}

	static async inMemory(options: Omit<ModelRegistryOptions, "modelsJsonPath">): Promise<ModelRegistry> {
		const configValueResolver = options.configValueResolver ?? new ConfigValueResolver(options.executionEnv);
		const authStorage = options.authStorage ?? AuthStorage.inMemory({ configValueResolver });
		await authStorage.initialize();
		const registry = new ModelRegistry({
			executionEnv: options.executionEnv,
			authStorage,
			configValueResolver,
			modelsJsonPath: undefined,
		});
		await registry.refresh();
		return registry;
	}

	/**
	 * Reload models from the runtime-backed models.json plus built-in defaults.
	 */
	async refresh(): Promise<void> {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.loadError = undefined;
		this.loadDiagnostic = undefined;

		this.runtime.clearProviders();

		await this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}

		// Extension registrations replay last and re-check first-registration-wins:
		// a models.json edit or runtime registration that claimed the name since
		// the extension registered drops the extension provider with a diagnostic.
		for (const [providerName, registration] of this.extensionProviders.entries()) {
			const conflict = this.findCoreProviderConflict(providerName);
			if (conflict) {
				this.extensionProviders.delete(providerName);
				this.recordModelDiagnostic(
					createExtensionProviderDroppedDiagnostic(providerName, registration.extensionId, conflict),
				);
				continue;
			}
			this.applyProviderConfig(providerName, registration.config);
		}
	}

	/**
	 * Get any error from loading models.json. Undefined means no load error.
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	getLoadDiagnostic(): ModelDiagnostic | undefined {
		return this.loadDiagnostic;
	}

	drainDiagnostics(): ModelDiagnostic[] {
		const drained = [...this.diagnostics];
		this.diagnostics = [];
		return drained;
	}

	/**
	 * Get all models, including built-ins, custom models, and dynamic providers.
	 *
	 * If models.json had errors, the registry still exposes built-in models.
	 */
	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getRuntime(): Models {
		return this.runtimeWithDiagnostics;
	}

	setDiagnosticPublisher(publisher: DiagnosticPublisher | undefined): void {
		this.diagnosticPublisher = publisher;
	}

	/**
	 * Get models whose provider currently has some usable auth configured.
	 *
	 * Stored credentials and declared config values are pure presence checks;
	 * the ambient-source fallback fully resolves provider auth, which may run
	 * an expired OAuth token refresh through the credential store.
	 */
	async getAvailable(): Promise<Model<Api>[]> {
		const available: Model<Api>[] = [];
		for (const model of this.runtime.getModels()) {
			if (await this.hasConfiguredAuth(model)) {
				available.push(model);
			}
		}
		return available;
	}

	/**
	 * Find a model by provider and model id.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/**
	 * Check whether a model has provider auth configured.
	 *
	 * Auth can come from AuthStorage or from request auth declared in models.json.
	 */
	async hasConfiguredAuth(model: Model<Api>): Promise<boolean> {
		if (this.authStorage.hasAuth(model.provider)) {
			return true;
		}
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		if (providerApiKey !== undefined) {
			return await this.configValueResolver.isConfigValueConfigured(providerApiKey);
		}

		try {
			return (await this.runtime.getAuth(model)) !== undefined;
		} catch (error) {
			this.recordModelDiagnostic(
				createModelRequestDiagnostic(
					"model.auth_resolution_failed",
					error instanceof Error ? error.message : String(error),
					{ provider: model.provider, modelId: model.id },
				),
			);
			return false;
		}
	}

	/**
	 * Resolve request auth for a model.
	 *
	 * Provider headers and model headers use ConfigValueResolver, so $ENV and
	 * !command config values share the same ExecutionEnv boundary as auth keys.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
		return await this.resolveConfiguredRequestAuth(model, apiKeyFromAuthStorage);
	}

	private async resolveConfiguredRequestAuth(
		model: Model<Api>,
		baseApiKey?: string,
		baseHeaders?: ProviderHeaders,
	): Promise<ResolvedRequestAuth> {
		return await this.resolveRequestAuth(model.provider, model.id, baseApiKey, baseHeaders);
	}

	/**
	 * Provider-scoped variant used by the runtime auth resolution path, which
	 * no longer sees the model. Model headers are merged separately by the
	 * DiagnosticPublishingModels wrapper.
	 */
	private async resolveProviderRequestAuth(
		provider: string,
		baseApiKey?: string,
		baseHeaders?: ProviderHeaders,
	): Promise<ResolvedRequestAuth> {
		return await this.resolveRequestAuth(provider, undefined, baseApiKey, baseHeaders);
	}

	private async resolveRequestAuth(
		provider: string,
		modelId: string | undefined,
		baseApiKey?: string,
		baseHeaders?: ProviderHeaders,
	): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(provider);
			const apiKey =
				baseApiKey ??
				(providerConfig?.apiKey
					? await this.configValueResolver.resolveConfigValueOrThrow(
							providerConfig.apiKey,
							`API key for provider "${provider}"`,
						)
					: undefined);

			const providerHeaders = await this.configValueResolver.resolveHeadersOrThrow(
				providerConfig?.headers,
				`provider "${provider}"`,
			);
			const modelHeaders = modelId
				? await this.configValueResolver.resolveHeadersOrThrow(
						this.modelRequestHeaders.get(this.getModelRequestKey(provider, modelId)),
						`model "${provider}/${modelId}"`,
					)
				: undefined;

			let headers: ProviderHeaders | undefined =
				baseHeaders || providerHeaders || modelHeaders
					? { ...baseHeaders, ...providerHeaders, ...modelHeaders }
					: undefined;

			// Some providers expect the resolved API key as an Authorization header.
			if (providerConfig?.authHeader) {
				if (!apiKey) {
					const error = `No API key found for "${provider}"`;
					this.recordModelDiagnostic(createModelRequestDiagnostic("model.auth_missing", error, { provider, modelId }));
					return { ok: false, error };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			return { ok: true, apiKey, headers: headers && Object.keys(headers).length > 0 ? headers : undefined };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.recordModelDiagnostic(
				createModelRequestDiagnostic("model.auth_resolution_failed", message, { provider, modelId }),
			);
			return { ok: false, error: message };
		}
	}

	/**
	 * Return auth status for a provider, including request auth from models.json.
	 *
	 * Command-backed values are reported as configured without executing them.
	 */
	async getProviderAuthStatus(provider: string): Promise<AuthStatus> {
		const authStatus = this.authStorage.getAuthStatus(provider);
		if (authStatus.source) {
			return authStatus;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (providerApiKey) {
			if (this.configValueResolver.isCommandConfigValue(providerApiKey)) {
				return { configured: true, source: "models_json_command" };
			}

			const envVarNames = this.configValueResolver.getConfigValueEnvVarNames(providerApiKey);
			if (envVarNames.length > 0) {
				return (await this.configValueResolver.isConfigValueConfigured(providerApiKey))
					? { configured: true, source: "environment", label: envVarNames.join(", ") }
					: { configured: false };
			}

			return { configured: true, source: "models_json_key" };
		}

		const [model] = this.runtime.getModels(provider);
		if (model) {
			try {
				const result = await this.runtime.getAuth(model);
				if (result?.source) {
					return {
						configured: true,
						source: result.source === "stored credential" ? "stored" : "environment",
						label: result.source,
					};
				}
				if (result) {
					return { configured: true, source: "environment" };
				}
			} catch {
				return authStatus;
			}
		}

		return authStatus;
	}

	/**
	 * Resolve an API key for a provider without using the fallback resolver.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
		if (apiKey !== undefined) {
			return apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey ? await this.configValueResolver.resolveConfigValueUncached(providerApiKey) : undefined;
	}

	/**
	 * Check whether a model is currently backed by OAuth credentials.
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically.
	 *
	 * If the provider has models, they replace existing models for that provider.
	 * If it only has baseUrl/headers, it overrides matching existing models.
	 * If it has OAuth, the provider becomes available for login flows.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.upsertRegisteredProvider(providerName, config);
	}

	/**
	 * Unregister a dynamic provider and rebuild models from the remaining state.
	 */
	async unregisterProvider(providerName: string): Promise<void> {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		await this.refresh();
	}

	/**
	 * Register a provider contributed by an extension (ME slice 9).
	 *
	 * Extension registrations are stricter than runtime ones: the provider
	 * name must be new (first-registration-wins against built-ins, models.json
	 * and other extensions - no override channel) and the config must define
	 * complete models. The same extension may re-register its provider from
	 * another agent scope; the registration is tracked per contributing agent
	 * so a runner lifecycle boundary can withdraw it.
	 */
	registerExtensionProvider(
		providerName: string,
		config: ProviderConfigInput,
		provenance: ExtensionProviderProvenance,
	): ExtensionProviderRegistrationResult {
		const name = providerName.trim();
		if (!name) {
			return { ok: false, reason: "invalid", message: "Provider name must not be empty." };
		}
		const existing = this.extensionProviders.get(name);
		if (existing && existing.extensionId !== provenance.extensionId) {
			return { ok: false, reason: "conflict", conflictWith: "extension", ownerExtensionId: existing.extensionId };
		}
		if (!existing) {
			const conflict = this.findCoreProviderConflict(name);
			if (conflict) {
				return { ok: false, reason: "conflict", conflictWith: conflict };
			}
		}
		if (!config.models || config.models.length === 0) {
			return { ok: false, reason: "invalid", message: `Provider ${name}: extension providers must define "models".` };
		}
		try {
			this.validateProviderConfig(name, config);
			this.applyProviderConfig(name, config);
		} catch (error) {
			return { ok: false, reason: "invalid", message: error instanceof Error ? error.message : String(error) };
		}
		if (existing) {
			existing.config = config;
			existing.registrantAgentIds.add(provenance.agentId);
		} else {
			this.extensionProviders.set(name, {
				config,
				extensionId: provenance.extensionId,
				registrantAgentIds: new Set([provenance.agentId]),
			});
		}
		return { ok: true };
	}

	/**
	 * Withdraw an agent's extension provider registrations (runner lifecycle
	 * boundary: reload and dispose). A provider is removed once its last
	 * registrant agent exits; removal rebuilds the runtime so no replaced
	 * provider state lingers.
	 */
	async unregisterExtensionProviders(agentId: string): Promise<string[]> {
		const removed: string[] = [];
		for (const [name, registration] of this.extensionProviders.entries()) {
			registration.registrantAgentIds.delete(agentId);
			if (registration.registrantAgentIds.size === 0) {
				this.extensionProviders.delete(name);
				removed.push(name);
			}
		}
		if (removed.length > 0) {
			await this.refresh();
		}
		return removed;
	}

	/**
	 * Extension provider provenance facts: name, owning extension, and the
	 * agents whose runners currently hold the registration.
	 */
	getExtensionProviderRegistrations(): ExtensionProviderRegistrationSnapshot[] {
		return [...this.extensionProviders.entries()].map(([providerName, registration]) => ({
			providerName,
			extensionId: registration.extensionId,
			agentIds: [...registration.registrantAgentIds],
		}));
	}

	private findCoreProviderConflict(providerName: string): Exclude<ExtensionProviderConflict, "extension"> | undefined {
		if (new Set<string>(getBuiltinProviders()).has(providerName)) {
			return "builtin";
		}
		if (this.registeredProviders.has(providerName)) {
			return "runtime";
		}
		// Anything else already present in the runtime or holding request auth
		// config was declared by models.json.
		if (this.runtime.getProvider(providerName) || this.providerRequestConfigs.has(providerName)) {
			return "models_json";
		}
		return undefined;
	}

	private async loadModels(): Promise<void> {
		// Load custom models and provider/model overrides from models.json.
		const {
			models: customModels,
			providerOverrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? await this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			this.loadDiagnostic = createModelLoadDiagnostic(error, this.modelsJsonPath);
			this.recordModelDiagnostic(this.loadDiagnostic);
			// Keep built-in models available even if custom model loading fails.
		}

		this.loadBuiltInProviders(providerOverrides, modelOverrides, customModels);
	}

	private loadBuiltInProviders(
		providerOverrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
		customModels: readonly Model<Api>[],
	): void {
		const customModelsByProvider = new Map<string, Model<Api>[]>();
		for (const model of customModels) {
			const models = customModelsByProvider.get(model.provider) ?? [];
			models.push(model);
			customModelsByProvider.set(model.provider, models);
		}

		for (const provider of builtinProviders()) {
			const providerOverride = providerOverrides.get(provider.id);
			const perModelOverrides = modelOverrides.get(provider.id);
			const models = provider.getModels().map((sourceModel) => {
				let model = sourceModel;

				// Apply provider-level baseUrl/compat overrides from models.json.
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model overrides after provider-level changes.
				const modelOverride = perModelOverrides?.get(sourceModel.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});

			const mergedModels = this.mergeProviderModels(models, customModelsByProvider.get(provider.id) ?? []);
			customModelsByProvider.delete(provider.id);
			this.runtime.setProvider(this.createConfiguredProvider(provider, mergedModels));
		}

		for (const [providerName, models] of customModelsByProvider.entries()) {
			this.runtime.setProvider(this.createCustomProvider(providerName, models));
		}
	}

	private mergeProviderModels(builtInModels: readonly Model<Api>[], customModels: readonly Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((model) => model.id === customModel.id);
			if (existingIndex >= 0) merged[existingIndex] = customModel;
			else merged.push(customModel);
		}
		return merged;
	}

	private createConfiguredProvider(provider: Provider, models: readonly Model<Api>[]): Provider {
		return { ...provider, auth: this.createProviderAuth(provider.id, provider.auth), getModels: () => models };
	}

	/**
	 * Build the `api` dispatch for createProvider: one ProviderStreams per
	 * model api, collapsed to a single entry when uniform. A config
	 * streamSimple overrides the streams for its declared api.
	 */
	private createProviderApi(
		models: readonly Model<Api>[],
		config?: ProviderConfigInput,
	): ProviderStreams | Partial<Record<Api, ProviderStreams>> {
		const customStreamSimple = config?.streamSimple;
		const apiStreams = new Map<Api, ProviderStreams>();
		for (const model of models) {
			if (apiStreams.has(model.api)) continue;
			apiStreams.set(
				model.api,
				customStreamSimple && model.api === config?.api
					? {
							stream: (requestModel, context, options) =>
								customStreamSimple(requestModel, context, options as SimpleStreamOptions),
							streamSimple: customStreamSimple,
						}
					: createApiStreams(model.api),
			);
		}
		return apiStreams.size === 1 ? [...apiStreams.values()][0] : Object.fromEntries(apiStreams.entries());
	}

	private createCustomProvider(providerName: string, models: readonly Model<Api>[]): Provider {
		return createProvider({
			id: providerName,
			name: providerDisplayName(providerName),
			auth: this.createProviderAuth(providerName),
			models,
			api: this.createProviderApi(models),
		});
	}

	private createDynamicProvider(
		providerName: string,
		config: ProviderConfigInput,
		models: readonly Model<Api>[],
	): Provider {
		return createProvider({
			id: providerName,
			name: config.name ?? providerDisplayName(providerName),
			auth: this.createProviderAuth(providerName, undefined, config.oauth),
			models,
			api: this.createProviderApi(models, config),
		});
	}

	private createProviderAuth(
		providerName: string,
		baseAuth?: ProviderAuth,
		oauthConfig?: OAuthProviderConfig,
	): ProviderAuth {
		const baseApiKeyAuth = baseAuth?.apiKey;
		const oauth = oauthConfig ? adaptOAuthConfig(oauthConfig) : baseAuth?.oauth;
		return {
			...(oauth ? { oauth } : {}),
			apiKey: {
				name: baseApiKeyAuth?.name ?? `${providerDisplayName(providerName)} API key`,
				login: baseApiKeyAuth?.login,
				resolve: async (input) => {
					let baseResult: Awaited<ReturnType<NonNullable<ProviderAuth["apiKey"]>["resolve"]>> | undefined;
					if (baseApiKeyAuth) {
						baseResult = await baseApiKeyAuth.resolve(input);
					} else if (input.credential?.key) {
						baseResult = { auth: { apiKey: input.credential.key }, source: "stored credential" };
					}

					const configuredAuth = await this.resolveProviderRequestAuth(
						providerName,
						baseResult?.auth.apiKey,
						baseResult?.auth.headers,
					);
					if (!configuredAuth.ok) {
						throw new Error(configuredAuth.error);
					}
					if (!configuredAuth.apiKey && !configuredAuth.headers && !baseResult?.auth.baseUrl) {
						return undefined;
					}
					return {
						auth: { apiKey: configuredAuth.apiKey, headers: configuredAuth.headers, baseUrl: baseResult?.auth.baseUrl },
						source: baseResult?.source,
					};
				},
			},
		};
	}

	private async loadCustomModels(modelsJsonPath: string): Promise<CustomModelsResult> {
		// models.json is optional; absence is not an error.
		const existsResult = await this.executionEnv.exists(modelsJsonPath);
		if (!existsResult.ok) {
			return emptyCustomModelsResult(
				`Failed to access models.json: ${existsResult.error.message}\n\nFile: ${modelsJsonPath}`,
			);
		}
		if (!existsResult.value) {
			return emptyCustomModelsResult();
		}

		const readResult = await this.executionEnv.readTextFile(modelsJsonPath);
		if (!readResult.ok) {
			return emptyCustomModelsResult(
				`Failed to load models.json: ${readResult.error.message}\n\nFile: ${modelsJsonPath}`,
			);
		}

		try {
			// Match Pi behavior: allow JSON comments and trailing commas.
			const parsed = JSON.parse(stripJsonComments(readResult.value)) as unknown;

			if (!validateModelsConfig.Check(parsed)) {
				const errors =
					validateModelsConfig
						.Errors(parsed)
						.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
						.join("\n") || "Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			const config = parsed as ModelsConfig;
			// Schema validation checks shape; validateConfig checks cross-field rules.
			this.validateConfig(config);

			const providerOverrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				// Provider-level model overrides affect built-in models for that provider.
				if (providerConfig.baseUrl || providerConfig.compat) {
					providerOverrides.set(providerName, { baseUrl: providerConfig.baseUrl, compat: providerConfig.compat });
				}

				// Request auth is stored separately from Model.headers so it can be resolved lazily.
				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						// Model override headers also resolve at request time.
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
					}
				}
			}

			return { models: this.parseModels(config), providerOverrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		const builtInProviders = new Set<string>(getBuiltinProviders());

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const isBuiltIn = builtInProviders.has(providerName);
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides = providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// Override-only provider config must still change something meaningful.
				if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
					);
				}
			} else if (!isBuiltIn) {
				// Custom providers need an endpoint and auth source when defining models.
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
				if (!providerConfig.apiKey) {
					throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
				}
			}
			// Built-in providers can inherit api/baseUrl/auth from their built-in models and AuthStorage.

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;
				if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}
				// contextWindow and maxTokens have defaults, but provided values must be positive.
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				}
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
				}
			}
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getBuiltinProviders());
		// Cache built-in defaults per provider; custom models often inherit api/baseUrl.
		const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();

		const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			const cached = builtInDefaultsCache.get(providerName);
			if (cached) return cached;
			const builtIn =
				builtinProviders()
					.find((provider) => provider.id === providerName)
					?.getModels() ?? [];
			if (builtIn.length === 0) return undefined;
			const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			// Override-only provider config does not create custom models.
			if (modelDefs.length === 0) continue;

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				// Store request headers out of band so ConfigValueResolver can resolve them later.
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: undefined,
					compat: mergeCompat(providerConfig.compat, modelDef.compat),
				} as Model<Api>);
			}
		}

		return models;
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: { apiKey?: string; headers?: Record<string, string>; authHeader?: boolean },
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * Store dynamic provider config for future refreshes.
	 *
	 * Defined incoming fields replace existing fields; undefined fields preserve
	 * the previously registered value.
	 */
	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, config);
			return;
		}
		for (const key of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[key] !== undefined) {
				(existing as Record<string, unknown>)[key] = config[key];
			}
		}
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			// Override-only dynamic providers can omit model construction fields.
			return;
		}

		// Dynamic providers with models must be complete enough to instantiate requests.
		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			const models: Model<Api>[] = [];
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;
				const baseUrl = modelDef.baseUrl ?? config.baseUrl;
				if (!baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
				}
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				models.push({
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: modelDef.input,
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>);
			}

			if (config.oauth?.modifyModels) {
				const cred = this.authStorage.get(providerName);
				if (cred?.type === "oauth") {
					this.runtime.setProvider(
						this.createDynamicProvider(providerName, config, config.oauth.modifyModels(models, cred)),
					);
					return;
				}
			}
			this.runtime.setProvider(this.createDynamicProvider(providerName, config, models));
		} else if (config.baseUrl || config.headers) {
			const provider = this.runtime.getProvider(providerName);
			if (!provider) return;
			const models = provider.getModels().map((model) => ({ ...model, baseUrl: config.baseUrl ?? model.baseUrl }));
			this.runtime.setProvider(this.createConfiguredProvider(provider, models));
		}
	}

	private recordModelDiagnostic(diagnostic: ModelDiagnostic): void {
		this.diagnostics.push(diagnostic);
	}

	private async publishRuntimeDiagnostics(): Promise<void> {
		if (!this.diagnosticPublisher) {
			return;
		}
		const diagnostics = [...this.authStorage.drainDiagnostics(), ...this.drainDiagnostics()];
		if (diagnostics.length > 0) {
			await this.diagnosticPublisher(diagnostics);
		}
	}
}

type AuthResolutionOverrides = Parameters<Models["getAuth"]>[1];

class DiagnosticPublishingModels implements Models {
	private readonly base: Models;
	private readonly publishDiagnostics: () => Promise<void>;
	private readonly resolveModelHeaders: (model: Model<Api>) => Promise<ProviderHeaders | undefined>;

	constructor(
		base: Models,
		publishDiagnostics: () => Promise<void>,
		resolveModelHeaders: (model: Model<Api>) => Promise<ProviderHeaders | undefined>,
	) {
		this.base = base;
		this.publishDiagnostics = publishDiagnostics;
		this.resolveModelHeaders = resolveModelHeaders;
	}

	getProviders(): readonly Provider[] {
		return this.base.getProviders();
	}

	getProvider(id: string): Provider | undefined {
		return this.base.getProvider(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		return this.base.getModels(provider);
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.base.getModel(provider, id);
	}

	async refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		try {
			return await this.base.refresh(options);
		} finally {
			await this.publishDiagnostics();
		}
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		try {
			return await this.base.checkAuth(providerId);
		} finally {
			await this.publishDiagnostics();
		}
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		try {
			return await this.base.getAvailable(providerId);
		} finally {
			await this.publishDiagnostics();
		}
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		try {
			const result = await this.base.getAuth(providerOrModel as Model<Api>, overrides);
			if (result && typeof providerOrModel !== "string") {
				const modelHeaders = await this.resolveModelHeaders(providerOrModel);
				if (modelHeaders) {
					return { ...result, auth: { ...result.auth, headers: { ...result.auth.headers, ...modelHeaders } } };
				}
			}
			return result;
		} finally {
			await this.publishDiagnostics();
		}
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		try {
			return await this.base.login(providerId, type, interaction);
		} finally {
			await this.publishDiagnostics();
		}
	}

	async logout(providerId: string): Promise<void> {
		try {
			await this.base.logout(providerId);
		} finally {
			await this.publishDiagnostics();
		}
	}

	/**
	 * Merge resolved model headers under any caller-provided headers so models.json
	 * model headers keep their original precedence: below request options, above
	 * provider-level auth headers.
	 */
	private async withModelHeaders<TOptions extends { headers?: ProviderHeaders }>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<TOptions | undefined> {
		const modelHeaders = await this.resolveModelHeaders(model);
		if (!modelHeaders) {
			return options;
		}
		return { ...options, headers: { ...modelHeaders, ...options?.headers } } as TOptions;
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.watchStream(
			lazyStream(model, async () => this.base.stream(model, context, await this.withModelHeaders(model, options))),
		);
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		try {
			return await this.base.complete(model, context, await this.withModelHeaders(model, options));
		} finally {
			await this.publishDiagnostics();
		}
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.watchStream(
			lazyStream(model, async () =>
				this.base.streamSimple(model, context, await this.withModelHeaders(model, options)),
			),
		);
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		try {
			return await this.base.completeSimple(model, context, await this.withModelHeaders(model, options));
		} finally {
			await this.publishDiagnostics();
		}
	}

	private watchStream(stream: AssistantMessageEventStream): AssistantMessageEventStream {
		void stream
			.result()
			.finally(async () => {
				await this.publishDiagnostics();
			})
			.catch(() => {});
		return stream;
	}
}

function createModelLoadDiagnostic(message: string, modelsJsonPath: string | undefined): ModelDiagnostic {
	return {
		severity: "error",
		code: "model.load_failed",
		message: modelsJsonPath ? `${message} (${modelsJsonPath})` : message,
	};
}

function createModelRequestDiagnostic(
	code: "model.auth_missing" | "model.auth_resolution_failed",
	message: string,
	ref: { provider: string; modelId?: string },
): ModelDiagnostic {
	const target = ref.modelId ? `${ref.provider}/${ref.modelId}` : ref.provider;
	return { severity: "error", code, message: `${target}: ${message}` };
}

function createExtensionProviderDroppedDiagnostic(
	providerName: string,
	extensionId: string,
	conflictWith: ExtensionProviderConflict,
): ModelDiagnostic {
	return {
		severity: "warning",
		code: "extension.provider_conflict",
		message: `Extension '${extensionId}' provider '${providerName}' conflicts with a ${conflictWith} provider and was dropped on refresh.`,
		extensionId,
	};
}

/**
 * Legacy extension-style OAuth provider config. The provider id is forced to
 * the registered provider name. Adapted to the pi-ai OAuthAuth surface by
 * adaptOAuthConfig().
 */
export interface OAuthProviderConfig {
	name: string;
	/** Whether login uses a local callback server and supports manual code input. */
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/**
 * Bridge a legacy OAuthProviderConfig to the provider-owned OAuthAuth
 * interface used by the pi-ai Models runtime.
 */
function adaptOAuthConfig(config: OAuthProviderConfig): OAuthAuth {
	return {
		name: config.name,
		login: async (interaction) => {
			const credential = await config.login({
				onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => interaction.prompt({ type: "text", ...prompt }),
				onProgress: (message) => interaction.notify({ type: "progress", message }),
				onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => interaction.prompt({ type: "select", ...prompt }),
				signal: interaction.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential) => ({ ...(await config.refreshToken(credential)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: OAuthProviderConfig;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
