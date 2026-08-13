import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ExtensionLoader } from "../../src/core/extension/index.ts";
import type {
	ExtensionActivationApi,
	ExtensionDefinition,
	ExtensionDivisionSelections,
} from "../../src/core/extension/types.ts";

function registerSampleTool(api: ExtensionActivationApi, name: string): void {
	api.registerTool({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
	});
}

async function loadScope(
	definition: ExtensionDefinition,
	selections?: ExtensionDivisionSelections,
	extensionId = "integration",
) {
	const loader = new ExtensionLoader();
	loader.registerExtension(extensionId, definition);
	return await loader.loadForAgent({
		agentId: "agent",
		profileId: "profile",
		extensionIds: [extensionId],
		divisionSelections: selections,
	});
}

function toolNames(scope: { toolContributions: readonly unknown[] }): string[] {
	return (scope.toolContributions as readonly { kind: string; definition?: { name: string } }[]).flatMap(
		(contribution) => (contribution.kind === "define" && contribution.definition ? [contribution.definition.name] : []),
	);
}

describe("extension divisions", () => {
	it("exposes declarations before activation and tags contributions", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtension("integration", {
			apiVersion: 1,
			divisions: [
				{ id: "servers", label: "Servers" },
				{ id: "tools", label: "Tools", description: "Extra tools" },
			],
			activate: async (api) => {
				registerSampleTool(api, "rootTool");
				await api.division("tools", (division) => {
					registerSampleTool(division, "divisionTool");
					division.observe("agent_spawned", () => {});
				});
			},
		});

		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["integration"] });

		expect(scope.extensions[0]?.divisions.map((entry) => entry.id)).toEqual(["servers", "tools"]);
		expect(toolNames(scope)).toEqual(["rootTool", "divisionTool"]);
		expect(scope.toolContributions.map((contribution) => contribution.divisionId)).toEqual([undefined, "tools"]);
		expect(scope.observerHandlers.get("agent_spawned")?.[0]?.divisionId).toBe("tools");
		expect(scope.divisions).toEqual([
			{
				extensionId: "integration",
				id: "servers",
				label: "Servers",
				description: undefined,
				enabled: true,
				declared: true,
				source: "default",
			},
			{
				extensionId: "integration",
				id: "tools",
				label: "Tools",
				description: "Extra tools",
				enabled: true,
				declared: true,
				source: "default",
			},
		]);
	});

	it("drops an appended system prompt section from a disabled division", async () => {
		const scope = await loadScope(
			{
				apiVersion: 1,
				divisions: [{ id: "guidance", label: "Guidance" }],
				activate: async (api) => {
					api.appendSystemPrompt("root section");
					await api.division("guidance", (division) => {
						division.appendSystemPrompt("division section");
					});
				},
			},
			{ settings: { integration: { disable: ["guidance"] } } },
		);

		expect(scope.systemPromptContributions).toEqual([
			{ extensionId: "integration", text: "root section", divisionId: undefined },
		]);
	});

	it("never runs a disabled division's register callback", async () => {
		let registerRuns = 0;
		const scope = await loadScope(
			{
				apiVersion: 1,
				divisions: [{ id: "tools", label: "Tools" }],
				activate: async (api) => {
					registerSampleTool(api, "rootTool");
					await api.division("tools", (division) => {
						registerRuns += 1;
						registerSampleTool(division, "divisionTool");
					});
				},
			},
			{ settings: { integration: { disable: ["tools"] } } },
		);

		expect(registerRuns).toBe(0);
		expect(toolNames(scope)).toEqual(["rootTool"]);
		expect(scope.divisions[0]).toMatchObject({ id: "tools", enabled: false, source: "settings" });
	});

	it("honours enabledByDefault and lets a rule turn the part back on", async () => {
		const definition: ExtensionDefinition = {
			apiVersion: 1,
			divisions: [{ id: "experimental", label: "Experimental", enabledByDefault: false }],
			activate: async (api) => {
				await api.division("experimental", (division) => {
					registerSampleTool(division, "experimentalTool");
				});
			},
		};

		const off = await loadScope(definition);
		expect(toolNames(off)).toEqual([]);
		expect(off.divisions[0]).toMatchObject({ enabled: false, source: "default" });

		const on = await loadScope(definition, { settings: { integration: { enable: ["experimental"] } } });
		expect(toolNames(on)).toEqual(["experimentalTool"]);
		expect(on.divisions[0]).toMatchObject({ enabled: true, source: "settings" });
	});

	it("applies a rule to the whole subtree and gates children behind ancestors", async () => {
		const definition: ExtensionDefinition = {
			apiVersion: 1,
			divisions: [
				{ id: "servers", label: "Servers" },
				{ id: "servers.github", label: "GitHub" },
				{ id: "servers.gitlab", label: "GitLab" },
			],
			activate: async (api) => {
				await api.division("servers", async (servers) => {
					registerSampleTool(servers, "serversTool");
					await servers.division("github", (github) => {
						registerSampleTool(github, "githubTool");
					});
					await servers.division("gitlab", (gitlab) => {
						registerSampleTool(gitlab, "gitlabTool");
					});
				});
			},
		};

		const subtreeOff = await loadScope(definition, { settings: { integration: { disable: ["servers"] } } });
		expect(toolNames(subtreeOff)).toEqual([]);

		// The child rule is more specific, but a disabled ancestor is a hard gate:
		// the child never gets a chance to re-enable itself.
		const childForcedOff = await loadScope(definition, {
			settings: { integration: { disable: ["servers"], enable: ["servers.github"] } },
		});
		expect(toolNames(childForcedOff)).toEqual([]);

		const oneChildOff = await loadScope(definition, { settings: { integration: { disable: ["servers.gitlab"] } } });
		expect(toolNames(oneChildOff)).toEqual(["serversTool", "githubTool"]);
		expect(oneChildOff.divisions.find((entry) => entry.id === "servers.gitlab")).toMatchObject({
			enabled: false,
			source: "settings",
		});
	});

	it("lets the nearest rule win over an inherited one", async () => {
		const definition: ExtensionDefinition = {
			apiVersion: 1,
			divisions: [
				{ id: "servers", label: "Servers" },
				{ id: "servers.github", label: "GitHub" },
			],
			activate: async (api) => {
				await api.division("servers", async (servers) => {
					registerSampleTool(servers, "serversTool");
					await servers.division("github", (github) => {
						registerSampleTool(github, "githubTool");
					});
				});
			},
		};

		// The parent's `enable` does not reach the child, which carries a nearer
		// rule of its own. Only an inherited *disable* is absolute, and that is
		// the ancestor gate rather than this rule.
		const scope = await loadScope(definition, {
			settings: { integration: { enable: ["servers"], disable: ["servers.github"] } },
		});

		expect(toolNames(scope)).toEqual(["serversTool"]);
		expect(scope.divisions.find((entry) => entry.id === "servers.github")).toMatchObject({
			enabled: false,
			source: "settings",
		});
	});

	it("keeps an undeclared division enabled and reports it", async () => {
		const scope = await loadScope({
			apiVersion: 1,
			activate: async (api) => {
				await api.division("ad-hoc", (division) => {
					registerSampleTool(division, "adHocTool");
				});
			},
		});

		expect(toolNames(scope)).toEqual(["adHocTool"]);
		expect(scope.divisions[0]).toMatchObject({ id: "ad-hoc", label: "ad-hoc", declared: false, enabled: true });
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.division_undeclared", severity: "warning" }),
		);
	});

	it("reports selection rules that match no division", async () => {
		const scope = await loadScope(
			{ apiVersion: 1, divisions: [{ id: "tools", label: "Tools" }], activate: () => {} },
			{ settings: { integration: { disable: ["typo"] } } },
		);

		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.division_unknown", severity: "warning" }),
		);
	});

	it("drops invalid or duplicate declarations without failing the extension", async () => {
		const scope = await loadScope({
			apiVersion: 1,
			divisions: [
				{ id: "ok", label: "Ok" },
				{ id: "bad id", label: "Bad" },
				{ id: "ok", label: "Duplicate" },
				{ id: "no-label", label: "  " },
			],
			activate: (api) => {
				registerSampleTool(api, "rootTool");
			},
		});

		expect(scope.extensions[0]?.divisions.map((entry) => entry.id)).toEqual(["ok"]);
		expect(toolNames(scope)).toEqual(["rootTool"]);
		expect(scope.diagnostics.filter((diagnostic) => diagnostic.code === "extension.division_invalid")).toHaveLength(3);
	});

	it("settles a division that the author forgot to await", async () => {
		const scope = await loadScope({
			apiVersion: 1,
			divisions: [{ id: "tools", label: "Tools" }],
			activate: (api) => {
				// No await: the loader still drains pending registrations before it
				// settles the scope.
				void api.division("tools", async (division) => {
					await Promise.resolve();
					registerSampleTool(division, "divisionTool");
				});
			},
		});

		expect(toolNames(scope)).toEqual(["divisionTool"]);
	});

	it("isolates a failing division from the rest of the integration", async () => {
		const scope = await loadScope({
			apiVersion: 1,
			divisions: [
				{ id: "broken", label: "Broken" },
				{ id: "healthy", label: "Healthy" },
			],
			activate: async (api) => {
				await api.division("broken", () => {
					throw new Error("boom");
				});
				await api.division("healthy", (division) => {
					registerSampleTool(division, "healthyTool");
				});
			},
		});

		expect(toolNames(scope)).toEqual(["healthyTool"]);
		const failures = scope.diagnostics.filter(
			(diagnostic) => diagnostic.code === "extension.division_activation_failed",
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.message).toContain("division 'broken'");
		// Non-blocking: the orchestrator refuses agent creation on any error-level
		// extension diagnostic, and one broken part must not cost the agent.
		expect(failures[0]?.severity).toBe("warning");
		expect(scope.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
	});

	it("drains an unawaited division even when the root factory throws", async () => {
		let lateSideEffect = 0;
		const scope = await loadScope({
			apiVersion: 1,
			divisions: [{ id: "tools", label: "Tools" }],
			activate: (api) => {
				void api.division("tools", async (division) => {
					await Promise.resolve();
					lateSideEffect += 1;
					registerSampleTool(division, "divisionTool");
				});
				throw new Error("root boom");
			},
		});

		// The scope handed back is already settled: nothing keeps writing into
		// its contribution arrays after loadForAgent resolved.
		expect(lateSideEffect).toBe(1);
		expect(toolNames(scope)).toEqual(["divisionTool"]);
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.activation_failed", severity: "error" }),
		);
	});

	it("survives malformed runtime declarations without throwing", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtension("integration", {
			apiVersion: 1,
			// Module exports are unvalidated runtime data.
			divisions: [
				null,
				"tools",
				{ id: "ok", label: "Ok" },
				{ id: "typed", label: "Typed", enabledByDefault: "yes" },
				{ id: "described", label: "Described", description: 7 },
			],
			activate: (api: ExtensionActivationApi) => {
				registerSampleTool(api, "rootTool");
			},
		} as unknown as ExtensionDefinition);

		const scope = await loader.loadForAgent({ agentId: "agent", profileId: "profile", extensionIds: ["integration"] });

		expect(scope.extensions[0]?.divisions.map((entry) => entry.id)).toEqual(["ok"]);
		expect(toolNames(scope)).toEqual(["rootTool"]);
		expect(scope.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
	});

	it("reports a non-array divisions field instead of ignoring it", async () => {
		const scope = await loadScope({
			apiVersion: 1,
			divisions: "tools",
			activate: () => {},
		} as unknown as ExtensionDefinition);

		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.division_invalid", severity: "warning" }),
		);
	});

	it("refuses an invalid id from isDivisionEnabled just like division()", async () => {
		let sideEffects = 0;
		const scope = await loadScope({
			apiVersion: 1,
			activate: (api) => {
				if (api.isDivisionEnabled("bad id")) sideEffects += 1;
			},
		});

		expect(sideEffects).toBe(0);
		expect(scope.divisions).toEqual([]);
		expect(scope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "extension.division_invalid", severity: "warning" }),
		);
	});

	it("answers isDivisionEnabled for imperative branches", async () => {
		const seen: boolean[] = [];
		const scope = await loadScope(
			{
				apiVersion: 1,
				divisions: [
					{ id: "tools", label: "Tools" },
					{ id: "servers", label: "Servers" },
				],
				activate: (api) => {
					seen.push(api.isDivisionEnabled("tools"));
					seen.push(api.isDivisionEnabled("servers"));
				},
			},
			{ settings: { integration: { disable: ["servers"] } } },
		);

		expect(seen).toEqual([true, false]);
		expect(scope.divisions.map((entry) => entry.enabled)).toEqual([false, true]);
	});
});
