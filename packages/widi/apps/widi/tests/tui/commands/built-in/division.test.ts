import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../../../src/core/agent-orchestrator.ts";
import { ExtensionDivisionResolver } from "../../../../src/core/extension/division.ts";
import type { ExtensionDivisionDeclaration, ExtensionDivisionSelection } from "../../../../src/core/extension/types.ts";
import { widiCommands } from "../../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../../src/tui/commands/engine.ts";
import { stubCommandHost } from "../../../helpers/command-host.ts";

const DECLARATIONS: readonly ExtensionDivisionDeclaration[] = [
	{ id: "basic", label: "Basic chapter" },
	{ id: "advanced", label: "Advanced chapter" },
	{ id: "advanced.deep", label: "Deep dive" },
];

type Selections = Record<string, ExtensionDivisionSelection>;

function setup(
	options: {
		readonly global?: Selections;
		readonly project?: Selections;
		readonly reload?: { readonly status: "reloaded" | "skipped"; readonly reason?: string };
	} = {},
) {
	let globalSelections: Selections = structuredClone(options.global ?? {});
	const projectSelections: Selections = structuredClone(options.project ?? {});
	// The project layer replaces the global rules of the extensions it names,
	// which is what deepMergeSettings does one level down.
	const merged = (): Selections => ({ ...globalSelections, ...projectSelections });

	const resolve = () => {
		const resolver = new ExtensionDivisionResolver({
			extensionId: "drill",
			declarations: DECLARATIONS,
			selections: { settings: merged() },
		});
		return resolver.snapshots();
	};

	let divisions = resolve();
	const reloadResult = options.reload ?? { status: "reloaded" as const };
	const orchestrator = {
		settingManager: {
			getExtensionDivisionSelections: () => structuredClone(merged()),
			getGlobalExtensionDivisionSelections: () => structuredClone(globalSelections),
			setExtensionDivisionSelections: (next: Selections) => {
				globalSelections = structuredClone(next);
			},
		},
		getAgentStatus: () => "idle",
		getAgentActivity: () => ({ activity: "idle" }),
		inspectAgent: () => ({ extensions: { divisions } }),
		reloadExtensions: async () => {
			if (reloadResult.status === "reloaded") divisions = resolve();
			return {
				catalog: { loaded: [], diagnostics: [] },
				agents: [{ agentId: "agent-1", ...reloadResult, diagnostics: [] }],
			};
		},
	} as unknown as AgentOrchestrator;

	return {
		engine: new CommandEngine(widiCommands(stubCommandHost())),
		context: { agentId: "agent-1", orchestrator },
		globalSelections: () => globalSelections,
		divisions: () => divisions,
	};
}

function executed(outcome: unknown): string {
	expect(outcome).toMatchObject({ kind: "executed", name: "division" });
	return (outcome as { value: string }).value;
}

describe("/division", () => {
	it("offers every division with the state it resolved to", async () => {
		const { engine, context } = setup({ global: { drill: { disable: ["advanced"] } } });
		const outcome = await engine.handleInput("/division", context);
		expect(outcome.kind).toBe("needs-argument");
		const candidates = (outcome as { candidates: readonly { value: string; label?: string }[] }).candidates;
		expect(candidates.map((candidate) => candidate.label)).toEqual([
			"off drill/advanced · Advanced chapter",
			"off drill/advanced.deep · Deep dive",
			"on  drill/basic · Basic chapter",
		]);
		expect(candidates.map((candidate) => candidate.value)).toContain("drill/advanced.deep");
	});

	it("toggles a division off, writes the rule and reloads the agent", async () => {
		const { engine, context, globalSelections, divisions } = setup();
		const value = executed(await engine.handleInput("/division drill/basic", context));
		expect(value).toBe("drill/basic is now off.\nrule saved in global settings · agent-1 reloaded");
		expect(globalSelections()).toEqual({ drill: { disable: ["basic"] } });
		expect(divisions().find((division) => division.id === "basic")?.enabled).toBe(false);
	});

	it("toggles it back on without leaving a redundant rule behind", async () => {
		const { engine, context, globalSelections } = setup({ global: { drill: { disable: ["basic"] } } });
		const value = executed(await engine.handleInput("/division drill/basic", context));
		expect(value.split("\n")[0]).toBe("drill/basic is now on.");
		expect(globalSelections()).toEqual({ drill: { enable: ["basic"] } });
	});

	it("drops the rule on 'default' and reports the declared state", async () => {
		const { engine, context, globalSelections } = setup({ global: { drill: { disable: ["basic"] } } });
		const value = executed(await engine.handleInput("/division default drill/basic", context));
		expect(value).toBe("drill/basic is on by default.\nrule removed from global settings · agent-1 reloaded");
		expect(globalSelections()).toEqual({});
	});

	it("says a disabled ancestor kept the division off", async () => {
		const { engine, context, globalSelections } = setup({ global: { drill: { disable: ["advanced"] } } });
		const value = executed(await engine.handleInput("/division drill/advanced.deep", context));
		expect(value.split("\n")[0]).toBe("drill/advanced.deep is still off: an ancestor division is disabled.");
		expect(globalSelections()).toEqual({ drill: { enable: ["advanced.deep"], disable: ["advanced"] } });
	});

	it("says a project rule won, and never copies it into the global layer", async () => {
		const { engine, context, globalSelections } = setup({ project: { drill: { disable: ["basic"] } } });
		const value = executed(await engine.handleInput("/division drill/basic", context));
		expect(value.split("\n")[0]).toBe("drill/basic is still off: a project settings rule for this extension wins.");
		expect(globalSelections()).toEqual({ drill: { enable: ["basic"] } });
	});

	it("reports a rule it could not apply yet", async () => {
		const { engine, context, globalSelections } = setup({ reload: { status: "skipped", reason: "running" } });
		const value = executed(await engine.handleInput("/division drill/basic", context));
		expect(value).toBe(
			"drill/basic: not applied yet.\nrule saved in global settings · agent-1 was not reloaded (running)",
		);
		expect(globalSelections()).toEqual({ drill: { disable: ["basic"] } });
	});

	it("opens the selector for an argument that names no division", async () => {
		const { engine, context, globalSelections } = setup();
		const outcome = await engine.handleInput("/division drill/nope", context);
		expect(outcome).toMatchObject({ kind: "open-selector", query: "drill/nope" });
		expect(globalSelections()).toEqual({});
	});

	it("resolves a unique prefix, including behind 'default'", async () => {
		const { engine, context, globalSelections } = setup({ global: { drill: { disable: ["advanced.deep"] } } });
		const value = executed(await engine.handleInput("/division default drill/advanced.d", context));
		expect(value.split("\n")[0]).toBe("drill/advanced.deep is on by default.");
		expect(globalSelections()).toEqual({});
	});
});
