import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import { EXTENSION_API_VERSION, type ExtensionModule } from "../../src/core/extension/index.ts";
import { SettingManager } from "../../src/core/setting-manager.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { createThirdPartyExtension } from "../extensions/third-party-extension.ts";
import { createOrchestrator, defaultProfile, MemoryExecutionEnv } from "../helpers/orchestrator.ts";

async function createThirdPartyOrchestrator(
	module: ExtensionModule,
): Promise<{ orchestrator: AgentOrchestrator; events: OrchestratorEvent[] }> {
	const profile: AgentProfile = {
		...defaultProfile,
		id: "third-party-profile",
		label: "Third Party Profile",
		persist: false,
	};
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: profile.id,
		profileRegistry: new AgentProfileRegistry(InMemoryProfileStorageBackend.fromProfiles([{ profile }])),
		// Named rather than left to the default "everything available": these
		// tests are about an extension the user asked for by name.
		settingManager: new SettingManager({ enabledExtensions: ["third-party"] }),
	});
	orchestrator.registerExtension("third-party", module);
	const events: OrchestratorEvent[] = [];
	orchestrator.subscribe((event) => {
		events.push(event);
	});
	return { orchestrator, events };
}

async function createThirdPartyHarness(
	module: ExtensionModule,
): Promise<{ orchestrator: AgentOrchestrator; agentId: string; events: OrchestratorEvent[] }> {
	const { orchestrator, events } = await createThirdPartyOrchestrator(module);
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	return { orchestrator, agentId, events };
}

describe("third-party extension consumer", () => {
	it("combines tool and observer registrations through the public contract only", async () => {
		const { definition } = createThirdPartyExtension();
		const { orchestrator, agentId } = await createThirdPartyHarness(definition);

		expect(orchestrator.getAgentTools(agentId).toolNames).toContain("tp_echo");
		expect(orchestrator.inspectAgent(agentId).extensions.toolContributions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "define", extensionId: "third-party", toolName: "tp_echo" }),
			]),
		);
		expect(orchestrator.inspectAgent(agentId).extensions.hooks).toContainEqual({
			kind: "observe",
			extensionId: "third-party",
			eventName: "agent_harness_event",
		});
	});

	it("refuses to spawn an agent when an enabled extension is incompatible", async () => {
		let activated = false;
		const { orchestrator, events } = await createThirdPartyOrchestrator({
			apiVersion: EXTENSION_API_VERSION + 1,
			activate: () => {
				activated = true;
			},
		});

		// A blocked extension diagnostic fails the spawn, the same family as
		// activation_failed: settings named this extension, so silently running
		// without it would not be honouring the configuration.
		await expect(orchestrator.spawnAgent({ origin: { kind: "new" } })).rejects.toThrow(/targets extension API version/);
		expect(activated).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.version_incompatible",
					extensionId: "third-party",
					severity: "error",
					message: expect.stringContaining(`targets extension API version ${EXTENSION_API_VERSION + 1}`),
				}),
			}),
		);
		// The refusal names the real reason - not a missing factory.
		expect(events).not.toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({ code: "extension.factory_missing" }),
			}),
		);
	});

	it("accepts a bare factory as targeting the current api version", async () => {
		const { orchestrator, agentId } = await createThirdPartyHarness((api) => {
			api.intercept("input", () => undefined);
		});

		expect(orchestrator.inspectAgent(agentId).extensions.hooks).toContainEqual({
			kind: "intercept",
			extensionId: "third-party",
			eventName: "input",
		});
		expect(
			orchestrator.inspectAgent(agentId).diagnostics.filter((entry) => entry.extensionId !== undefined),
		).not.toContainEqual(expect.objectContaining({ code: "extension.version_incompatible" }));
	});
});
