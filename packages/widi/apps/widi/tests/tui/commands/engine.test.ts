import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import type { RuntimeModel } from "../../../src/core/types.ts";
import { widiCommands } from "../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../src/tui/commands/engine.ts";
import type { ActionCommand, CommandDefinition } from "../../../src/tui/commands/types.ts";
import { stubCommandHost } from "../../helpers/command-host.ts";

function stubOrchestrator(overrides: Record<string, unknown>): AgentOrchestrator {
	// Status gates read `getAgentActivity`; the overrides may replace it.
	return {
		getAgentStatus: () => "idle",
		getAgentActivity: () => ({ activity: "idle" }),
		sendMessage: async () => ({ kind: "accepted" }),
		...overrides,
	} as unknown as AgentOrchestrator;
}

function context(overrides: Record<string, unknown> = {}) {
	return { agentId: "agent-1", orchestrator: stubOrchestrator(overrides) };
}

function pendingContext(overrides: Record<string, unknown> = {}) {
	return { orchestrator: stubOrchestrator(overrides) };
}

describe("CommandEngine.handleInput", () => {
	const engine = new CommandEngine(widiCommands(stubCommandHost()));

	it("passes plain prompts through", async () => {
		expect(await engine.handleInput("hello world", context())).toEqual({ kind: "pass" });
	});

	it("executes a line command against orchestrator atomics", async () => {
		let reloads = 0;
		const outcome = await engine.handleInput(
			"/reload",
			context({
				reloadExtensions: async () => {
					reloads += 1;
					return { catalog: { loaded: [] }, agents: [] };
				},
			}),
		);
		expect(outcome.kind).toBe("executed");
		expect(reloads).toBe(1);
	});

	it("returns needs-argument for a bare command with completion", async () => {
		const outcome = await engine.handleInput(
			"/model",
			context({ listAvailableModelCandidates: async () => ({ models: [{ value: "openai/gpt-5" }] }) }),
		);
		expect(outcome.kind).toBe("needs-argument");
		if (outcome.kind === "needs-argument") {
			expect(outcome.command.name).toBe("model");
			expect(outcome.candidates).toEqual([{ value: "openai/gpt-5" }]);
		}
	});

	it("executes an explicit empty argument instead of re-prompting", async () => {
		let forkedFrom: unknown = "unset";
		const outcome = await engine.handleInput(
			"/fork:",
			context({
				spawnAgent: async (request: { origin: unknown }) => {
					forkedFrom = request.origin;
					return "agent-2";
				},
				inspectAgent: () => ({ agentId: "agent-2" }),
			}),
		);
		expect(outcome.kind).toBe("executed");
		// An explicit empty argument forks at the current leaf, so no entry id.
		expect(forkedFrom).toEqual({ kind: "fork", sourceAgentId: "agent-1" });
	});

	it("runs the bare form when an optional argument has no candidates", async () => {
		let treeCalls = 0;
		const outcome = await engine.handleInput(
			"/tree",
			context({
				getAgentSessionTree: async () => {
					treeCalls += 1;
					return { entries: [] };
				},
			}),
		);
		// A fresh session has no user messages to navigate to; demanding an
		// argument would hide /tree's own listing behind "/tree:".
		expect(outcome).toMatchObject({ kind: "executed", name: "tree" });
		expect(treeCalls).toBe(2);
	});

	it("still offers a menu for an optional argument that has candidates", async () => {
		const outcome = await engine.handleInput(
			"/tree",
			context({
				getAgentSessionTree: async () => ({
					entries: [
						{
							id: "entry-1",
							type: "message",
							timestamp: "2026-01-01T00:00:00.000Z",
							message: { role: "user", content: "Fix the flaky test" },
						},
					],
				}),
			}),
		);
		expect(outcome).toMatchObject({
			kind: "needs-argument",
			candidates: [{ value: "entry-1", label: "Fix the flaky test" }],
		});
	});

	it("re-prompts a required argument given as blank", async () => {
		const outcome = await engine.handleInput("/rename: ", context());
		expect(outcome.kind).toBe("needs-argument");
		if (outcome.kind === "needs-argument") {
			expect(outcome.command.name).toBe("rename");
			expect(outcome.candidates).toEqual([]);
		}
	});

	it("fails unavailable commands with a CommandError", async () => {
		const reloadExtensions = vi.fn(async () => ({ catalog: { loaded: [] }, agents: [] }));
		const outcome = await engine.handleInput(
			"/resume:session-1",
			context({ getAgentActivity: () => ({ activity: "running" }), reloadExtensions }),
		);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.error.message).toContain("running");
		}
		expect(reloadExtensions).not.toHaveBeenCalled();
	});

	it("wraps execute exceptions as failed outcomes", async () => {
		const outcome = await engine.handleInput(
			"/reload",
			context({
				reloadExtensions: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.error.message).toBe("boom");
	});

	it("executes runtime commands without an active agent", async () => {
		const outcome = await engine.handleInput(
			"/logout test",
			pendingContext({
				listAuthCredentialCandidates: async () => ({ providers: [{ value: "test" }] }),
				logoutAuthProvider: async () => ({ removed: true, providerId: "test" }),
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "logout" });
	});

	it("carries the command's formatResult as display text", async () => {
		const outcome = await engine.handleInput(
			"/resume session-1",
			context({
				listAgentSessions: async () => ({
					sessions: [{ id: "session-1", ref: "session-1", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/workspace" }],
				}),
				spawnAgent: async () => "agent-2",
				inspectAgent: () => ({
					agentId: "agent-2",
					profile: { reference: { id: "default", label: "Default" } },
					model: { id: "test-model" },
				}),
			}),
		);

		expect(outcome).toMatchObject({
			kind: "executed",
			name: "resume",
			display: "resumed agent-2 · Default · test-model",
		});
	});

	it("rejects active-only commands without an active agent", async () => {
		const outcome = await engine.handleInput("/status", pendingContext());

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("active agent") } });
	});

	it("offers model candidates without an active agent", async () => {
		const outcome = await engine.handleInput(
			"/model",
			pendingContext({ listAvailableModelCandidates: async () => ({ models: [{ value: "openai/gpt-5" }] }) }),
		);

		expect(outcome).toMatchObject({ kind: "needs-argument", candidates: [{ value: "openai/gpt-5" }] });
	});

	it("stages the model on the staged session when no agent is open", async () => {
		const resolved: string[] = [];
		const staged: string[] = [];
		const model = { provider: "openai", id: "gpt-5" } as RuntimeModel;
		const engine = new CommandEngine(
			widiCommands(
				stubCommandHost({
					setPendingModel: (stagedModel) => {
						staged.push(`${stagedModel.provider}/${stagedModel.id}`);
						return `Staged session will use ${stagedModel.provider}/${stagedModel.id}`;
					},
				}),
			),
		);

		const outcome = await engine.handleInput(
			"/model:openai/gpt-5",
			pendingContext({
				listAvailableModelCandidates: async () => ({ models: [{ value: "openai/gpt-5" }] }),
				resolveModelByReference: async (reference: string) => {
					resolved.push(reference);
					return model;
				},
				setDefaultModel: () => {},
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "model" });
		expect(resolved).toEqual(["openai/gpt-5"]);
		expect(staged).toEqual(["openai/gpt-5"]);
	});

	it("reports command start through hooks", async () => {
		const started: string[] = [];
		await engine.handleInput("/status", context(), {
			onCommandStart: (_id, name) => {
				started.push(name);
			},
		});
		expect(started).toEqual(["status"]);
	});

	it("expands a prompt command into the submitted text", async () => {
		const outcome = await engine.handleInput(
			"/skill review focus on locking",
			context({
				getAgentSkill: async () => ({
					name: "review",
					description: "Review code.",
					content: "Review the diff carefully.",
					filePath: "/skills/review/SKILL.md",
				}),
			}),
		);
		expect(outcome.kind).toBe("expanded");
		if (outcome.kind === "expanded") {
			expect(outcome.text).toContain('<skill name="review" location="/skills/review/SKILL.md">');
			// The body is inlined, not pointed at.
			expect(outcome.text).toContain("Review the diff carefully.");
			expect(outcome.text).toContain("focus on locking");
		}
	});

	it("substitutes positional arguments into a prompt template", async () => {
		const outcome = await engine.handleInput(
			'/prompt review src/a.ts "src/b c.ts"',
			context({
				getAgentPromptTemplate: async () => ({
					name: "review",
					description: "Review files.",
					content: "Review $1 and $2. All: $ARGUMENTS",
				}),
			}),
		);
		expect(outcome).toMatchObject({
			kind: "expanded",
			text: "Review src/a.ts and src/b c.ts. All: src/a.ts src/b c.ts",
		});
	});

	it("fails the input when a prompt expansion throws", async () => {
		const outcome = await engine.handleInput(
			"/prompt missing",
			context({
				getAgentPromptTemplate: async () => {
					throw new Error("not found");
				},
			}),
		);
		expect(outcome.kind).toBe("failed");
	});

	it("offers candidates for a prompt command given no argument", async () => {
		const outcome = await engine.handleInput(
			"/skill",
			context({ listAgentSkillCandidates: async () => ({ skills: [{ value: "review" }] }) }),
		);
		expect(outcome).toMatchObject({ kind: "needs-argument", candidates: [{ value: "review" }] });
	});
});

describe("CommandEngine argument resolution", () => {
	function picker(received: string[], overrides: Partial<ActionCommand> = {}): CommandDefinition {
		return {
			kind: "action",
			agentPolicy: "runtime",
			name: "pick",
			description: "Pick a value.",
			argumentHint: "<value>",
			requiresArgument: true,
			complete: async () => [{ value: "alpha-one" }, { value: "alpha-two" }, { value: "beta" }],
			execute: async (_context, argument) => {
				received.push(argument);
				return argument;
			},
			...overrides,
		};
	}

	it("snaps an exact match to the canonical candidate value", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick ALPHA-ONE", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["alpha-one"]);
	});

	it("snaps a unique prefix to its candidate", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick alpha-t", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["alpha-two"]);
	});

	it("opens the selector with the query on an ambiguous prefix", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick alpha", pendingContext());

		expect(outcome).toMatchObject({ kind: "open-selector", query: "alpha" });
		if (outcome.kind === "open-selector") {
			expect(outcome.command.name).toBe("pick");
			expect(outcome.candidates).toHaveLength(3);
		}
		expect(received).toEqual([]);
	});

	it("opens the selector with the query on no match", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick zzz", pendingContext());

		expect(outcome).toMatchObject({ kind: "open-selector", query: "zzz" });
		expect(received).toEqual([]);
	});

	it("passes the raw argument through when there are no candidates", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received, { complete: async () => [] })]);

		const outcome = await engine.handleInput("/pick anything", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["anything"]);
	});

	it("prefers the command's own resolveArgument over the generic matching", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([
			picker(received, { resolveArgument: () => ({ kind: "resolved", value: "custom" }) }),
		]);

		const outcome = await engine.handleInput("/pick whatever", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["custom"]);
	});

	it("does not resolve prompt command arguments", async () => {
		const engine = new CommandEngine([
			{
				kind: "prompt",
				agentPolicy: "runtime",
				name: "echo",
				description: "Echo the argument.",
				argumentHint: "<text>",
				requiresArgument: true,
				complete: async () => [{ value: "alpha-one" }],
				expand: async (_context, argument) => argument,
			},
		]);

		// "alpha" prefixes the sole candidate, but a prompt argument is free
		// text: it reaches expand exactly as typed.
		const outcome = await engine.handleInput("/echo alpha", pendingContext());

		expect(outcome).toEqual({ kind: "expanded", text: "alpha" });
	});

	it("resolves a unique model prefix to the full reference", async () => {
		const setAgentModelByReference = vi.fn(async () => ({ provider: "vllm", id: "hello-world" }));
		const engine = new CommandEngine(widiCommands(stubCommandHost()));

		const outcome = await engine.handleInput(
			"/model vllm/hello",
			context({
				listAvailableModelCandidates: async () => ({
					models: [{ value: "vllm/hello-world" }, { value: "openai/gpt-5" }],
				}),
				setAgentModelByReference,
				setDefaultModel: () => {},
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "model" });
		expect(setAgentModelByReference).toHaveBeenCalledWith("agent-1", "vllm/hello-world");
	});

	// Picking either one picks it for what is spawned next and for the next run,
	// which is the only way a user ever sets these at all.
	it("carries a model and a thinking level into the runtime defaults", async () => {
		const setDefaultModel = vi.fn(() => {});
		const setDefaultThinkingLevel = vi.fn(() => {});
		const engine = new CommandEngine(widiCommands(stubCommandHost()));
		const orchestrator = {
			listAvailableModelCandidates: async () => ({ models: [{ value: "vllm/hello-world" }] }),
			listAgentThinkingLevelCandidates: () => ({ levels: [{ value: "high" }] }),
			setAgentModelByReference: async () => ({ provider: "vllm", id: "hello-world" }),
			setAgentThinkingLevelByName: async () => ({ level: "high" }),
			setDefaultModel,
			setDefaultThinkingLevel,
		};

		await engine.handleInput("/model vllm/hello-world", context(orchestrator));
		await engine.handleInput("/thinking high", context(orchestrator));

		expect(setDefaultModel).toHaveBeenCalledWith({ provider: "vllm", id: "hello-world" });
		expect(setDefaultThinkingLevel).toHaveBeenCalledWith("high");
	});
});

describe("CommandEngine.list and match", () => {
	const engine = new CommandEngine(widiCommands(stubCommandHost()));

	it("marks status-gated commands unavailable", () => {
		const idle = engine.list({ activity: "idle" }).find((view) => view.name === "resume");
		expect(idle?.available).toBe(true);
		const running = engine.list({ activity: "running" }).find((view) => view.name === "resume");
		expect(running?.available).toBe(false);
	});

	it("marks active commands unavailable without an agent", () => {
		const views = engine.list(undefined);

		expect(views.find((view) => view.name === "status")).toMatchObject({
			available: false,
			unavailableReason: expect.stringContaining("active agent"),
		});
		expect(views.find((view) => view.name === "model")?.available).toBe(true);
		expect(views.find((view) => view.name === "resume")?.available).toBe(true);
	});

	it("matches known line commands only", () => {
		expect(engine.match("/reload")?.name).toBe("reload");
		expect(engine.match("/nope:x")).toBeUndefined();
		expect(engine.match("plain text")).toBeUndefined();
	});
});

describe("agent-switching commands", () => {
	it("moves the application onto the agent they opened, and nothing else does", async () => {
		const switched: string[] = [];
		const engine = new CommandEngine(
			widiCommands(stubCommandHost({ switchToAgent: async (id) => void switched.push(id) })),
		);
		const orchestrator = {
			spawnAgent: async () => "agent-9",
			inspectAgent: () => ({ agentId: "agent-9", profile: { reference: { id: "d" } }, model: { id: "m" } }),
			listAgentSessions: async () => ({ sessions: [{ id: "s1", ref: "s1", createdAt: "", cwd: "/w" }] }),
			getAgentSessionTree: async () => ({ entries: [] }),
		};

		await engine.handleInput("/fork:", context(orchestrator));
		await engine.handleInput("/resume s1", context(orchestrator));
		await engine.handleInput("/status", context({ getAgentActivity: () => ({ activity: "idle" }) }));

		expect(switched).toEqual(["agent-9", "agent-9"]);
	});
});

describe("CommandEngine runtime registration", () => {
	function actionCommand(name: string): CommandDefinition {
		return {
			kind: "action",
			name,
			description: `${name} command`,
			agentPolicy: "runtime",
			execute: async () => `ran ${name}`,
		};
	}

	it("registers and unregisters a command at runtime", async () => {
		const engine = new CommandEngine();
		expect(engine.list(undefined)).toEqual([]);

		expect(engine.register(actionCommand("deploy"))).toBeUndefined();
		expect(engine.match("/deploy now")?.name).toBe("deploy");
		const outcome = await engine.handleInput("/deploy now", pendingContext());
		expect(outcome).toMatchObject({ kind: "executed", name: "deploy", value: "ran deploy" });

		expect(engine.unregister("deploy")).toBe(true);
		expect(engine.match("/deploy now")).toBeUndefined();
		expect(engine.unregister("deploy")).toBe(false);
	});

	it("refuses a conflicting name and keeps the original", () => {
		const engine = new CommandEngine();
		const original = actionCommand("deploy");
		engine.register(original);

		const diagnostic = engine.register(actionCommand("deploy"));

		expect(diagnostic).toMatchObject({ severity: "warning", code: "command.name_conflict" });
		expect(engine.get("deploy")).toBe(original);
	});

	it("list() snapshots reflect runtime registration changes", () => {
		const engine = new CommandEngine();
		engine.register(actionCommand("alpha"));
		engine.register(actionCommand("beta"));
		expect(engine.list(undefined).map((view) => view.name)).toEqual(["alpha", "beta"]);

		engine.unregister("alpha");
		expect(engine.list(undefined).map((view) => view.name)).toEqual(["beta"]);
	});
});
