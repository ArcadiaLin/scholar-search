import type { AgentHarnessStreamOptionsPatch } from "@arcadialin/agent-core";
import type { ExtensionFactory, ExtensionProviderConfig } from "../../src/core/extension/index.ts";

export interface ProviderExtensionOptions {
	readonly providerName: string;
	readonly config: ExtensionProviderConfig;
	/**
	 * Optional request stamping: header / metadata patches applied to every
	 * provider request through the before_provider_request interceptor.
	 */
	readonly requestHeaders?: Record<string, string | undefined>;
	readonly requestMetadata?: Record<string, unknown>;
}

/**
 * Anchor consumer for ME slice 9: a model-gateway extension that registers a
 * provider at activation and, optionally, stamps outgoing provider requests
 * with headers/metadata. The consumers of the registered models are the
 * existing core pipelines - the model registry, `setModel`, and `/model`
 * candidates - so the integration tests exercise the contribution surface
 * end to end.
 */
export function createProviderExtension(options: ProviderExtensionOptions): ExtensionFactory {
	return (api) => {
		api.registerProvider(options.providerName, options.config);
		if (options.requestHeaders || options.requestMetadata) {
			// A present-but-undefined headers/metadata key means "clear all" in
			// the Pi patch semantics, so only declared patches carry their key.
			const patch: AgentHarnessStreamOptionsPatch = {};
			if (options.requestHeaders) patch.headers = options.requestHeaders;
			if (options.requestMetadata) patch.metadata = options.requestMetadata;
			api.intercept("before_provider_request", () => ({ streamOptions: patch }));
		}
	};
}

export function gatewayProviderConfig(overrides: Partial<ExtensionProviderConfig> = {}): ExtensionProviderConfig {
	return {
		baseUrl: "https://gateway.test/v1",
		apiKey: "gateway-key",
		api: "openai-completions",
		models: [
			{
				id: "gateway-model",
				name: "Gateway Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 4096,
			},
		],
		...overrides,
	};
}
