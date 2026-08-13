import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { WidiCommandAutocompleteProvider } from "../../src/tui/autocomplete.ts";
import { widiCommands } from "../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import { stubCommandHost } from "../helpers/command-host.ts";

function provider(overrides: Record<string, unknown> = {}) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(widiCommands(stubCommandHost())),
		agentId: "main",
		orchestrator: overrides as unknown as AgentOrchestrator,
		getActivity: () => ({ activity: "idle" }),
	});
}

function pendingProvider(overrides: Record<string, unknown> = {}) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(widiCommands(stubCommandHost())),
		orchestrator: overrides as unknown as AgentOrchestrator,
		getActivity: () => undefined,
	});
}

function atProvider(cwd: string) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(widiCommands(stubCommandHost())),
		agentId: "main",
		orchestrator: {} as unknown as AgentOrchestrator,
		getActivity: () => ({ activity: "idle" }),
		cwd,
		// Force the Node fallback regardless of whether fd is installed.
		fdPath: null,
	});
}

function signal() {
	return new AbortController().signal;
}

describe("WidiCommandAutocompleteProvider", () => {
	it("completes command names and lands the cursor in argument position", async () => {
		const commandProvider = provider();
		const commands = await commandProvider.getSuggestions(["/mo"], 0, 3, { signal: signal() });
		expect(commands?.items[0]).toMatchObject({ value: "/model", label: "/model" });
		expect(commands?.prefix).toBe("/mo");
		if (!commands?.items[0]) throw new Error("Expected command completion.");
		const applied = commandProvider.applyCompletion(["/mo"], 0, 3, commands.items[0], commands.prefix);
		expect(applied.lines).toEqual(["/model "]);
		expect(applied.cursorCol).toBe("/model ".length);
	});

	it("completes a terminal command argument as the full command line", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [{ value: "anthropic/claude", label: "claude", description: "anthropic" }],
			}),
		});
		const result = await commandProvider.getSuggestions(["/model ant"], 0, "/model ant".length, { signal: signal() });
		// The prefix covers "/name arg…", so pi-tui's fall-through submits the
		// completed command the moment Enter accepts the candidate.
		expect(result).toMatchObject({
			prefix: "/model ant",
			items: [{ value: "/model anthropic/claude", label: "claude" }],
		});
		if (!result?.items[0]) throw new Error("Expected argument completion.");
		const applied = commandProvider.applyCompletion(
			["/model ant"],
			0,
			"/model ant".length,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["/model anthropic/claude"]);
		expect(applied.cursorCol).toBe("/model anthropic/claude".length);
	});

	it("filters argument candidates by case-insensitive prefix on value or label", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [
					{ value: "anthropic/claude", label: "Claude" },
					{ value: "openai/gpt", label: "GPT" },
				],
			}),
		});
		const byValue = await commandProvider.getSuggestions(["/model ANT"], 0, "/model ANT".length, { signal: signal() });
		expect(byValue?.items.map((item) => item.value)).toEqual(["/model anthropic/claude"]);
		const byLabel = await commandProvider.getSuggestions(["/model gpt"], 0, "/model gpt".length, { signal: signal() });
		expect(byLabel?.items.map((item) => item.value)).toEqual(["/model openai/gpt"]);
	});

	it("falls back to fuzzy filtering when no prefix matches", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({ models: [{ value: "fast-mode", label: "fast-mode" }] }),
		});
		const result = await commandProvider.getSuggestions(["/model fm"], 0, "/model fm".length, { signal: signal() });
		expect(result?.items.map((item) => item.value)).toEqual(["/model fast-mode"]);
	});

	it("closes the menu on a sole exact argument match", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({ models: [{ value: "safe", label: "safe" }] }),
		});
		await expect(
			commandProvider.getSuggestions(["/model safe"], 0, "/model safe".length, { signal: signal() }),
		).resolves.toBeNull();
	});

	it("no longer advances an exact command name to its argument candidates", async () => {
		const commandProvider = provider({
			listAgentSessions: async () => ({
				sessions: [
					{
						id: "alpha",
						path: "/sessions/a.jsonl",
						createdAt: "2026-01-01T00:00:00.000Z",
						cwd: "/workspace",
						name: "auth-fix",
						firstUserMessage: "Fix the flaky auth test",
					},
				],
			}),
		});
		const result = await commandProvider.getSuggestions(["/resume"], 0, 7, { signal: signal() });
		expect(result?.prefix).toBe("/resume");
		expect(result?.items.map((item) => item.value)).toEqual(["/resume"]);
	});

	it("returns no argument suggestions without a completer", async () => {
		const commandProvider = provider();
		await expect(commandProvider.getSuggestions(["/session foo"], 0, 12, { signal: signal() })).resolves.toBeNull();
		await expect(commandProvider.getSuggestions(["/nope foo"], 0, 10, { signal: signal() })).resolves.toBeNull();
	});

	it("contains failures from argument completers", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => {
				throw new Error("completion failed");
			},
		});
		await expect(commandProvider.getSuggestions(["/model value"], 0, 12, { signal: signal() })).resolves.toBeNull();
	});

	it("marks status-gated commands unavailable in suggestions", async () => {
		const commandProvider = new WidiCommandAutocompleteProvider({
			engine: new CommandEngine(widiCommands(stubCommandHost())),
			agentId: "main",
			orchestrator: {} as unknown as AgentOrchestrator,
			getActivity: () => ({ activity: "running" }),
		});
		const result = await commandProvider.getSuggestions(["/re"], 0, 3, { signal: signal() });
		const resume = result?.items.find((item) => item.label === "/resume");
		expect(resume?.description).toContain("unavailable: Command /resume is not available while the agent is running");
	});

	it("marks active commands unavailable in pending suggestions", async () => {
		const result = await pendingProvider().getSuggestions(["/st"], 0, 3, { signal: signal() });
		const status = result?.items.find((item) => item.label === "/status");

		expect(status?.description).toContain("active agent");
	});

	it("completes skill and prompt names like any other command argument", async () => {
		const commandProvider = provider({
			listAgentSkillCandidates: async () => ({
				skills: [{ value: "self-check", label: "self-check", description: "Run the harness self-check" }],
			}),
		});
		const result = await commandProvider.getSuggestions(["/skill sel"], 0, "/skill sel".length, { signal: signal() });
		expect(result).toMatchObject({ prefix: "sel", items: [{ value: "self-check", label: "self-check" }] });
		if (!result?.items[0]) throw new Error("Expected argument completion.");
		const applied = commandProvider.applyCompletion(
			["/skill sel"],
			0,
			"/skill sel".length,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["/skill self-check"]);
	});

	it("stops completing past the first argument", async () => {
		const commandProvider = provider({
			listAgentSkillCandidates: async () => ({ skills: [{ value: "self-check", label: "self-check" }] }),
		});
		await expect(
			commandProvider.getSuggestions(["/skill self-check foc"], 0, "/skill self-check foc".length, {
				signal: signal(),
			}),
		).resolves.toBeNull();
	});

	it('no longer treats "<" as a completion trigger', async () => {
		const commandProvider = provider();
		expect(commandProvider.triggerCharacters).toEqual(["/", "@"]);
		await expect(commandProvider.getSuggestions(["use <sk"], 0, 7, { signal: signal() })).resolves.toBeNull();
	});
});

describe("WidiCommandAutocompleteProvider @ fallback", () => {
	function fixture() {
		const cwd = mkdtempSync(join(tmpdir(), "widi-at-"));
		writeFileSync(join(cwd, "alpha.txt"), "alpha");
		writeFileSync(join(cwd, "with space.txt"), "space");
		mkdirSync(join(cwd, "beta"));
		writeFileSync(join(cwd, "beta", "inner.ts"), "inner");
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "config"), "git");
		return cwd;
	}

	it("triggers on @ via the provider trigger characters", () => {
		expect(provider().triggerCharacters).toContain("@");
	});

	it("completes @ mentions through the Node fallback when fd is missing", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(["say @alp"], 0, "say @alp".length, { signal: signal() });
		expect(result).toMatchObject({ prefix: "@alp", items: [{ value: "@alpha.txt", label: "alpha.txt" }] });
		if (!result?.items[0]) throw new Error("Expected @ completion.");
		const applied = commandProvider.applyCompletion(["say @alp"], 0, "say @alp".length, result.items[0], result.prefix);
		expect(applied.lines).toEqual(["say @alpha.txt "]);
		expect(applied.cursorCol).toBe("say @alpha.txt ".length);
	});

	it("ranks directories first on an empty query and skips .git", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(["@"], 0, 1, { signal: signal() });
		expect(result?.items[0]).toMatchObject({ value: "@beta/", label: "beta/" });
		const descriptions = result?.items.map((item) => item.description) ?? [];
		expect(descriptions.some((entry) => entry?.includes(".git"))).toBe(false);
	});

	it("quotes values that contain spaces", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(["@with"], 0, 5, { signal: signal() });
		expect(result?.items.map((item) => item.value)).toEqual(['@"with space.txt"']);
	});

	it("returns null when the @ query matches nothing", async () => {
		const commandProvider = atProvider(fixture());
		await expect(commandProvider.getSuggestions(["@zzz"], 0, 4, { signal: signal() })).resolves.toBeNull();
	});
});
