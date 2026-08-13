import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../../../src/core/agent-orchestrator.ts";
import type { RuntimeModel } from "../../../../src/core/types.ts";
import { widiCommands } from "../../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../../src/tui/commands/engine.ts";
import { DiagnosticsLog } from "../../../../src/tui/diagnostics-log.ts";

const NOW = "2026-08-09T10:00:00.000Z";

function setup(status: "idle" | "running" = "idle") {
	const host = {
		quitCalls: 0,
		newAgentCalls: [] as Array<string | undefined>,
		newSessionCalls: [] as Array<string | undefined>,
		disposeAgentCalls: [] as string[],
		workspaceCalls: [] as string[],
		themeCalls: [] as string[],
		copied: [] as string[],
		diagnostics: new DiagnosticsLog(),
		quit() {
			this.quitCalls += 1;
		},
		async switchToAgent() {},
		setEditorText() {},
		restoreSubmittedText() {},
		async newAgent(profileId: string | undefined) {
			this.newAgentCalls.push(profileId);
		},
		async newSession(sourceAgentId: string | undefined) {
			this.newSessionCalls.push(sourceAgentId);
		},
		async disposeAgent(agentId: string) {
			this.disposeAgentCalls.push(agentId);
		},
		async setWorkspace(path: string) {
			this.workspaceCalls.push(path);
			return `Staged session will open in ${path}`;
		},
		setPendingModel(model: RuntimeModel) {
			return `Staged session will use ${model.provider}/${model.id}`;
		},
		setTheme(name: string) {
			this.themeCalls.push(name);
			return `Theme set to ${name}`;
		},
		async copyText(text: string) {
			this.copied.push(text);
		},
	};
	const engine = new CommandEngine(widiCommands(host));
	const context = {
		agentId: "agent-1",
		orchestrator: {
			getAgentStatus: () => status,
			listAgentProfileCandidates: async () => ({
				profiles: [
					{ value: "main", label: "Main Agent" },
					{ value: "reviewer", label: "Reviewer" },
				],
			}),
		} as unknown as AgentOrchestrator,
	};
	return { engine, host, context };
}

describe("host-backed commands", () => {
	it("executes /exit through the engine and notifies the host", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/exit", context);
		expect(outcome).toMatchObject({ kind: "executed", name: "exit" });
		expect(host.quitCalls).toBe(1);
	});

	it("stays available while the agent is running", async () => {
		const { engine, host, context } = setup("running");
		const views = engine.list({ activity: "running" });
		for (const name of ["exit", "new", "clear", "diagnostics", "dispose"]) {
			expect(views.find((view) => view.name === name)?.available).toBe(true);
		}
		const outcome = await engine.handleInput("/exit", context);
		expect(outcome.kind).toBe("executed");
		expect(host.quitCalls).toBe(1);
		const disposeOutcome = await engine.handleInput("/dispose", context);
		expect(disposeOutcome).toMatchObject({ kind: "executed", name: "dispose" });
		expect(host.disposeAgentCalls).toEqual(["agent-1"]);
	});

	it("hands the named profile to /new without touching the current session", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/new reviewer", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "new" });
		expect(host.newAgentCalls).toEqual(["reviewer"]);
		expect(host.newSessionCalls).toEqual([]);
	});

	it("offers the profiles when /new names none", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/new", context);

		expect(outcome).toMatchObject({ kind: "needs-argument", candidates: [{ value: "main" }, { value: "reviewer" }] });
		expect(host.newAgentCalls).toEqual([]);
	});

	it("closes the current session on /clear", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/clear", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "clear" });
		expect(host.newSessionCalls).toEqual(["agent-1"]);
		expect(host.newAgentCalls).toEqual([]);
	});

	it("hands /dispose to the application for the active agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/dispose", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "dispose" });
		expect(host.disposeAgentCalls).toEqual(["agent-1"]);
	});

	it("rejects /dispose without an active agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/dispose", { orchestrator: context.orchestrator });

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("active agent") } });
		expect(host.disposeAgentCalls).toEqual([]);
	});

	it("says so instead of opening an empty selector when nothing was reported", async () => {
		const { engine, context } = setup();
		const outcome = await engine.handleInput("/diagnostics", context);

		expect(outcome).toMatchObject({ kind: "executed", value: "No diagnostics reported this session." });
	});

	it("offers every recorded diagnostic, newest first, with source and phase on the label", async () => {
		const { engine, host, context } = setup();
		host.diagnostics.record({ severity: "warning", code: "theme.unreadable", message: "theme.json" }, NOW);
		host.diagnostics.phase = "runtime";
		host.diagnostics.record(
			{ severity: "error", code: "mcp.connect_failed", message: "docs server", extensionId: "mcp" },
			NOW,
		);

		const outcome = await engine.handleInput("/diagnostics", context);

		expect(outcome.kind).toBe("needs-argument");
		const candidates = outcome.kind === "needs-argument" ? outcome.candidates : [];
		expect(candidates.map((candidate) => candidate.label)).toEqual([
			"✕ mcp.connect_failed · extension mcp · runtime",
			"▲ theme.unreadable · theme · startup",
		]);
		expect(candidates[0]?.description).toBe("docs server");
	});

	it("copies the whole entry when one is picked", async () => {
		const { engine, host, context } = setup();
		const record = host.diagnostics.record(
			{ severity: "error", code: "mcp.connect_failed", message: "docs server\nrefused" },
			NOW,
		);

		const outcome = await engine.handleInput(`/diagnostics ${record.id}`, context);

		expect(outcome).toMatchObject({ kind: "executed", value: "Copied mcp.connect_failed to the clipboard." });
		expect(host.copied).toEqual([`error · mcp.connect_failed · mcp · startup · ${NOW}\ndocs server\nrefused`]);
	});

	it("fails on an entry the empty log cannot offer rather than copying nothing", async () => {
		const { engine, host, context } = setup();

		const outcome = await engine.handleInput("/diagnostics d9", context);

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("d9") } });
		expect(host.copied).toEqual([]);
	});

	it("reopens the selector on an id that does not match a recorded entry", async () => {
		const { engine, host, context } = setup();
		host.diagnostics.record({ severity: "warning", code: "theme.unreadable", message: "theme.json" }, NOW);

		const outcome = await engine.handleInput("/diagnostics d9", context);

		expect(outcome).toMatchObject({ kind: "open-selector", query: "d9" });
		expect(host.copied).toEqual([]);
	});
});

describe("/workspace", () => {
	it("moves the staged session and refuses once an agent exists", async () => {
		const { engine, host, context } = setup();

		const staged = await engine.handleInput("/workspace ../other", { ...context, agentId: undefined });
		expect(staged).toMatchObject({ kind: "executed", name: "workspace" });
		expect(host.workspaceCalls).toEqual(["../other"]);

		// An agent's workspace is frozen at spawn, so there is nothing here to
		// change and saying so beats silently editing a staged session elsewhere.
		const running = await engine.handleInput("/workspace ../other", context);
		expect(running).toMatchObject({ kind: "failed", name: "workspace" });
		expect(host.workspaceCalls).toEqual(["../other"]);
	});

	it("is listed as unavailable while an agent is open", async () => {
		const { engine } = setup();

		expect(engine.list(undefined).find((view) => view.name === "workspace")?.available).toBe(true);
		expect(engine.list({ activity: "idle" }).find((view) => view.name === "workspace")).toMatchObject({
			available: false,
			unavailableReason: expect.stringContaining("has not started yet"),
		});
	});
});

describe("/theme", () => {
	it("switches through the host and completes with the registered themes", async () => {
		const { engine, host, context } = setup();

		const outcome = await engine.handleInput("/theme default", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "theme", value: "Theme set to default" });
		expect(host.themeCalls).toEqual(["default"]);

		const candidates = await engine.get("theme")?.complete?.(context, "");
		expect(candidates).toEqual([{ value: "default", description: "active" }]);
	});
});

// A command that answers with nothing renders no row, and a person cannot tell
// that from a keystroke the editor dropped. /exit is the one exception: it is
// leaving, and there is no transcript left to draw in.
describe("every command answers", () => {
	it("returns something to show for the commands that retire their own agent", async () => {
		const { engine, context } = setup();

		for (const input of ["/clear", "/dispose", "/new main"]) {
			const outcome = await engine.handleInput(input, context);
			expect(outcome).toMatchObject({ kind: "executed" });
			if (outcome.kind !== "executed") continue;
			expect(typeof outcome.value).toBe("string");
			expect(outcome.value).not.toBe("");
		}
	});

	it("leaves /exit with nothing to say", async () => {
		const { engine, context } = setup();

		const outcome = await engine.handleInput("/exit", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "exit", value: undefined });
	});
});
