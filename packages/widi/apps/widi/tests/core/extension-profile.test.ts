import { describe, expect, it } from "vitest";
import {
	AgentProfileRegistry,
	CompositeProfileStorageBackend,
	ExtensionProfileStorageBackend,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { ExtensionFactory } from "../../src/core/extension/index.ts";
import { createOrchestrator, defaultProfile, MemoryExecutionEnv } from "../helpers/orchestrator.ts";

const helperProfile = {
	id: "drill-helper",
	label: "Drill Helper",
	description: "A throwaway agent a rehearsal can delegate to.",
	systemPrompt: "You are a helper agent in a rehearsal. Do exactly what you are asked and stop.",
	persist: false,
	tools: [] as readonly string[],
};

/** An extension that ships one role, the way drill ships its rehearsal helper. */
const profileExtension: ExtensionFactory = (api) => {
	api.registerProfile(helperProfile);
};

async function createProfileHarness(options: { readonly enabledProfileIds?: readonly string[] } = {}) {
	const env = new MemoryExecutionEnv();
	const extensionProfiles = new ExtensionProfileStorageBackend();
	const orchestrator = await createOrchestrator(env, {
		extensionProfiles,
		...(options.enabledProfileIds === undefined ? undefined : { enabledProfileIds: options.enabledProfileIds }),
		profileRegistry: new AgentProfileRegistry(
			new CompositeProfileStorageBackend([
				InMemoryProfileStorageBackend.fromProfiles([{ profile: defaultProfile }]),
				extensionProfiles,
			]),
		),
	});
	orchestrator.registerExtension("drill", profileExtension);
	return { orchestrator, extensionProfiles };
}

describe("extension-registered profiles", () => {
	it("is spawnable once any agent has activated the extension", async () => {
		const { orchestrator } = await createProfileHarness();

		// Nothing has activated the extension yet, so the role does not exist.
		await expect(orchestrator.spawnAgent({ origin: { kind: "new", profileId: helperProfile.id } })).rejects.toThrow(
			/drill-helper/,
		);

		const host = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const helper = await orchestrator.spawnAgent({
			origin: { kind: "new", profileId: helperProfile.id },
			parent: host,
		});

		expect(orchestrator.inspectAgent(helper).profile.reference.id).toBe(helperProfile.id);
	});

	// The whole point of the source: installing the extension is the consent, and
	// demanding the id again in enabledProfiles would make it look broken.
	it("needs no entry in the enabled-profiles list", async () => {
		const { orchestrator } = await createProfileHarness({ enabledProfileIds: [defaultProfile.id] });
		const host = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const helper = await orchestrator.spawnAgent({
			origin: { kind: "new", profileId: helperProfile.id },
			parent: host,
		});

		expect(orchestrator.inspectAgent(helper).profile.reference.id).toBe(helperProfile.id);
		const candidates = await orchestrator.listAgentProfileCandidates();
		expect(candidates.profiles.map((profile) => profile.value)).toContain(helperProfile.id);
	});

	it("keeps the role while any holder is left and drops it with the last one", async () => {
		const { orchestrator, extensionProfiles } = await createProfileHarness();
		const first = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const second = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		expect(extensionProfiles.profileIds()).toEqual([helperProfile.id]);

		await orchestrator.disposeAgent(first, { intent: "removed" });
		expect(extensionProfiles.profileIds()).toEqual([helperProfile.id]);

		await orchestrator.disposeAgent(second, { intent: "removed" });
		expect(extensionProfiles.profileIds()).toEqual([]);
	});

	// A malformed role fails activation like any other bad registration, which
	// blocks the agent. That is the existing contract for a throwing activate and
	// is better than starting an agent whose extension half-registered.
	it("refuses a role with no system prompt", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerExtension("broken", (api) => {
			api.registerProfile({ ...helperProfile, systemPrompt: "  " });
		});

		await expect(orchestrator.spawnAgent({ origin: { kind: "new" } })).rejects.toThrow(/must define a system prompt/);
	});
});
