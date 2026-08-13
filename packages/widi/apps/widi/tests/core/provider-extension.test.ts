import type { AgentHarnessStreamOptions, BeforeProviderRequestResult } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { ExtensionFactory } from "../../src/core/extension/index.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { createProviderExtension, gatewayProviderConfig } from "../extensions/provider-extension.ts";
import {
	createModelRegistry,
	createOrchestrator,
	defaultProfile,
	MemoryExecutionEnv,
	requireAgentHarness,
} from "../helpers/orchestrator.ts";

async function createProviderHarness(
	extensions: readonly { readonly id: string; readonly factory: ExtensionFactory }[],
	options: { readonly projectTrusted?: boolean } = {},
): Promise<{
	orchestrator: AgentOrchestrator;
	modelRegistry: ModelRegistry;
	agentId: string;
	events: OrchestratorEvent[];
}> {
	const extensionProfile: AgentProfile = {
		...defaultProfile,
		id: "provider-profile",
		label: "Provider Profile",
		persist: false,
	};
	const env = new MemoryExecutionEnv();
	const modelRegistry = await createModelRegistry(env);
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: extensionProfile.id,
		modelRegistry,
		profileRegistry: new AgentProfileRegistry(
			InMemoryProfileStorageBackend.fromProfiles([{ profile: extensionProfile }]),
		),
	});
	if (options.projectTrusted === false) {
		await orchestrator.settingManager.setProjectTrusted(false);
	}
	for (const extension of extensions) {
		orchestrator.registerExtension(extension.id, extension.factory);
	}
	const events: OrchestratorEvent[] = [];
	orchestrator.subscribe((event) => {
		events.push(event);
	});
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	return { orchestrator, modelRegistry, agentId, events };
}

async function runBeforeProviderRequest(
	orchestrator: AgentOrchestrator,
	agentId: string,
	streamOptions: AgentHarnessStreamOptions = {},
): Promise<BeforeProviderRequestResult | undefined> {
	const harness = requireAgentHarness(orchestrator, agentId);
	const handlers = (harness as unknown as { handlers: Map<string, Set<(event: unknown) => Promise<unknown>>> })
		.handlers;
	const handler = Array.from(handlers.get("before_provider_request") ?? [])[0];
	if (!handler) throw new Error("Missing before_provider_request harness hook.");
	return (await handler({
		type: "before_provider_request",
		model: { provider: "gateway", id: "gateway-model" },
		sessionId: "session-1",
		streamOptions,
	})) as BeforeProviderRequestResult | undefined;
}

describe("provider extension consumer", () => {
	it("registers an extension provider and exposes its models to the agent", async () => {
		const { orchestrator, modelRegistry, agentId } = await createProviderHarness([
			{ id: "gateway", factory: createProviderExtension({ providerName: "gateway", config: gatewayProviderConfig() }) },
		]);

		const model = modelRegistry.find("gateway", "gateway-model");
		expect(model).toMatchObject({ provider: "gateway", id: "gateway-model", baseUrl: "https://gateway.test/v1" });
		if (!model) throw new Error("Expected the gateway model to resolve.");
		await expect(modelRegistry.getAvailable()).resolves.toContainEqual(
			expect.objectContaining({ provider: "gateway", id: "gateway-model" }),
		);
		await expect(orchestrator.setAgentModelByReference(agentId, "gateway/gateway-model")).resolves.toMatchObject({
			provider: "gateway",
			id: "gateway-model",
		});

		// Registration provenance is an inspect fact on both sides.
		expect(orchestrator.inspectAgent(agentId).extensions.providerContributions).toEqual([
			{ extensionId: "gateway", providerName: "gateway", modelIds: ["gateway-model"], oauth: false },
		]);
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "gateway", agentIds: [agentId] },
		]);
	});

	it("drops a built-in provider name with a conflict diagnostic", async () => {
		const { orchestrator, modelRegistry, agentId, events } = await createProviderHarness([
			{
				id: "gateway",
				factory: createProviderExtension({ providerName: "anthropic", config: gatewayProviderConfig() }),
			},
		]);

		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "warning",
					code: "extension.provider_conflict",
					extensionId: "gateway",
					message: "Extension 'gateway' provider 'anthropic' conflicts with a builtin provider and was skipped.",
				}),
			}),
		);
		expect(
			orchestrator.inspectAgent(agentId).diagnostics.filter((entry) => entry.extensionId !== undefined),
		).toContainEqual(expect.objectContaining({ code: "extension.provider_conflict" }));
	});

	it("keeps the first extension's provider and drops a same-name late registration", async () => {
		const { modelRegistry, agentId, events } = await createProviderHarness([
			{ id: "alpha", factory: createProviderExtension({ providerName: "gateway", config: gatewayProviderConfig() }) },
			{
				id: "beta",
				factory: createProviderExtension({
					providerName: "gateway",
					config: gatewayProviderConfig({ baseUrl: "https://impostor.test/v1" }),
				}),
			},
		]);

		expect(modelRegistry.find("gateway", "gateway-model")).toMatchObject({ baseUrl: "https://gateway.test/v1" });
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "alpha", agentIds: [agentId] },
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "warning",
					code: "extension.provider_conflict",
					extensionId: "beta",
					message: expect.stringContaining("Extension 'beta' provider 'gateway' conflicts with a extension provider"),
				}),
			}),
		);
	});

	it("rejects an extension provider without models", async () => {
		const { modelRegistry, events } = await createProviderHarness([
			{
				id: "gateway",
				factory: createProviderExtension({
					providerName: "gateway",
					config: { baseUrl: "https://gateway.test/v1", apiKey: "key" },
				}),
			},
		]);

		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "error",
					code: "extension.provider_invalid",
					extensionId: "gateway",
					message:
						"Extension 'gateway' provider 'gateway' was rejected: Provider gateway: extension providers must define \"models\".",
				}),
			}),
		);
	});

	it("gates command config values on project trust without blocking literal configs", async () => {
		const { modelRegistry, events } = await createProviderHarness(
			[
				{
					id: "commanded",
					factory: createProviderExtension({
						providerName: "commanded-gateway",
						config: gatewayProviderConfig({ apiKey: "!token-command" }),
					}),
				},
				{
					id: "literal",
					factory: createProviderExtension({ providerName: "literal-gateway", config: gatewayProviderConfig() }),
				},
			],
			{ projectTrusted: false },
		);

		expect(modelRegistry.find("commanded-gateway", "gateway-model")).toBe(undefined);
		expect(modelRegistry.find("literal-gateway", "gateway-model")).toBeDefined();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "error",
					code: "extension.provider_trust_denied",
					extensionId: "commanded",
					message:
						"Extension 'commanded' provider 'commanded-gateway' uses command config values and was denied because the project is not trusted.",
				}),
			}),
		);
		expect(modelRegistry.getExtensionProviderRegistrations().map(({ providerName }) => providerName)).toEqual([
			"literal-gateway",
		]);
	});

	it("withdraws provider registrations per agent lifecycle", async () => {
		const { orchestrator, modelRegistry, agentId } = await createProviderHarness([
			{ id: "gateway", factory: createProviderExtension({ providerName: "gateway", config: gatewayProviderConfig() }) },
		]);
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "gateway", agentIds: [agentId, secondAgentId] },
		]);

		// The provider survives while another registrant agent is alive.
		await orchestrator.disposeAgent(agentId, { intent: "removed" });
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "gateway", agentIds: [secondAgentId] },
		]);
		expect(modelRegistry.find("gateway", "gateway-model")).toBeDefined();

		await orchestrator.disposeAgent(secondAgentId, { intent: "removed" });
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([]);
		expect(modelRegistry.find("gateway", "gateway-model")).toBe(undefined);
	});

	it("drops the stale runner's provider on reload when the factory no longer registers it", async () => {
		const { orchestrator, modelRegistry, agentId } = await createProviderHarness([
			{ id: "gateway", factory: createProviderExtension({ providerName: "gateway", config: gatewayProviderConfig() }) },
		]);
		expect(modelRegistry.find("gateway", "gateway-model")).toBeDefined();

		// Reload with the same factory re-registers the provider.
		await orchestrator.reloadExtensions({ agentIds: [agentId] });
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([
			{ providerName: "gateway", extensionId: "gateway", agentIds: [agentId] },
		]);

		// A reloaded runner that stops contributing withdraws the provider.
		orchestrator.registerExtension("gateway", () => {});
		await orchestrator.reloadExtensions({ agentIds: [agentId] });
		expect(modelRegistry.getExtensionProviderRegistrations()).toEqual([]);
		expect(modelRegistry.find("gateway", "gateway-model")).toBe(undefined);
	});

	it("composes before_provider_request patches and skips a failing handler", async () => {
		const { orchestrator, agentId, events } = await createProviderHarness([
			{
				id: "stamp-a",
				factory: createProviderExtension({
					providerName: "gateway",
					config: gatewayProviderConfig(),
					requestHeaders: { "X-Gateway": "a" },
				}),
			},
			{
				id: "boom",
				factory: (api) => {
					api.intercept("before_provider_request", () => {
						throw new Error("boom");
					});
				},
			},
			{
				id: "stamp-b",
				factory: (api) => {
					api.intercept("before_provider_request", (event) => ({
						streamOptions: { headers: { "X-Session": event.sessionId }, metadata: { audited: true } },
					}));
				},
			},
		]);

		const result = await runBeforeProviderRequest(orchestrator, agentId, { headers: { legacy: "keep" } });

		// The failing handler is skipped; both stamps land in one merged patch.
		expect(result).toEqual({
			streamOptions: { headers: { "X-Gateway": "a", "X-Session": "session-1" }, metadata: { audited: true } },
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "warning",
					code: "extension.handler_failed",
					extensionId: "boom",
					message: "Extension 'boom' handler 'before_provider_request' failed: boom",
				}),
			}),
		);
	});
});
