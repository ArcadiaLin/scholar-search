/**
 * The runtime-level extension event bus (stage 0, capability C5): the channel
 * two extensions use to agree on a protocol - `herdr:blocked` and the like -
 * without either one knowing whether the other is installed.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { ExtensionActivationApi, ExtensionEventEnvelope } from "../../src/core/extension/api.ts";
import { MAX_EXTENSION_EVENT_DISPATCH_DEPTH } from "../../src/core/extension/index.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { createOrchestrator, MemoryExecutionEnv, requireLiveAgent } from "../helpers/orchestrator.ts";

function requireActions(orchestrator: AgentOrchestrator, agentId: string) {
	const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return runner.createContext("sender").actions;
}

function collectDiagnostics(
	orchestrator: AgentOrchestrator,
): Extract<OrchestratorEvent, { type: "diagnostic" }>["diagnostic"][] {
	const diagnostics: Extract<OrchestratorEvent, { type: "diagnostic" }>["diagnostic"][] = [];
	orchestrator.subscribe((event) => {
		if (event.type === "diagnostic") diagnostics.push(event.diagnostic);
	});
	return diagnostics;
}

describe("extension event bus", () => {
	it("delivers to every live runtime, including the sender's own", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const received: { agentId: string; envelope: ExtensionEventEnvelope }[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("herdr:blocked", (envelope, context) => {
				received.push({ agentId: context.agentId, envelope });
			});
		});
		const firstAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, firstAgentId).emitExtensionEvent("herdr:blocked", { pane: 3 });

		expect(received.map((entry) => entry.agentId).sort()).toEqual([firstAgentId, secondAgentId].sort());
		for (const entry of received) {
			expect(entry.envelope.name).toBe("herdr:blocked");
			expect(entry.envelope.payload).toEqual({ pane: 3 });
			expect(entry.envelope.sourceExtensionId).toBe("sender");
			expect(entry.envelope.sourceAgentId).toBe(firstAgentId);
		}
	});

	it("only wakes subscribers of the emitted name", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const names: string[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("wanted", () => {
				names.push("wanted");
			});
			api.onExtensionEvent("other", () => {
				names.push("other");
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, agentId).emitExtensionEvent("wanted");

		expect(names).toEqual(["wanted"]);
	});

	it("hands every subscriber a payload detached from the emitter", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const payloads: unknown[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("state", (envelope) => {
				payloads.push(envelope.payload);
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const payload = { counts: [1, 2] };

		await requireActions(orchestrator, agentId).emitExtensionEvent("state", payload);
		payload.counts.push(3);

		expect(payloads).toEqual([{ counts: [1, 2] }]);
	});

	it("hands subscribers a deeply immutable shared envelope", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		let sourceMutationSucceeded = false;
		let payloadMutationSucceeded = false;
		let received: ExtensionEventEnvelope | undefined;
		const frozen: boolean[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("state", (envelope) => {
				const payload = envelope.payload as { nested: { count: number } };
				frozen.push(Object.isFrozen(envelope), Object.isFrozen(payload), Object.isFrozen(payload.nested));
				try {
					(envelope as { sourceExtensionId: string }).sourceExtensionId = "forged";
					sourceMutationSucceeded = true;
				} catch {
					// Runtime immutability is the behavior under test.
				}
				try {
					payload.nested.count = 99;
					payloadMutationSucceeded = true;
				} catch {
					// Runtime immutability is the behavior under test.
				}
			});
		});
		orchestrator.registerExtension("receiver", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("state", (envelope) => {
				received = envelope;
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, agentId).emitExtensionEvent("state", { nested: { count: 1 } });

		expect(frozen).toEqual([true, true, true]);
		expect(sourceMutationSucceeded).toBe(false);
		expect(payloadMutationSucceeded).toBe(false);
		expect(received?.sourceExtensionId).toBe("sender");
		expect(received?.payload).toEqual({ nested: { count: 1 } });
	});

	it("rejects an unusable name or payload before anything is delivered", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		let delivered = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("fine", () => {
				delivered += 1;
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const actions = requireActions(orchestrator, agentId);

		await expect(actions.emitExtensionEvent("has space")).rejects.toThrow(TypeError);
		await expect(actions.emitExtensionEvent("fine", { big: "x".repeat(70_000) })).rejects.toThrow(RangeError);

		expect(delivered).toBe(0);
	});

	// Registration-time validation, like registerProvider's: a name nobody emits
	// is indistinguishable from one nobody has sent yet, so a typo would
	// otherwise stay silent for the life of the extension.
	it("refuses a subscription to an invalid name at activation", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("broken", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("has space", () => {});
		});

		await expect(orchestrator.spawnAgent({ origin: { kind: "new" } })).rejects.toThrow(
			"Extension event name must contain only",
		);
	});

	it("reports a failing subscriber and still reaches the rest", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		let reached = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("ping", () => {
				throw new Error("subscriber exploded");
			});
			api.onExtensionEvent("ping", () => {
				reached += 1;
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, agentId).emitExtensionEvent("ping");

		expect(reached).toBe(1);
		const failure = diagnostics.find((diagnostic) => diagnostic.code === "extension.handler_failed");
		expect(failure?.message).toContain("subscriber exploded");
	});

	it("stops a cascade at the dispatch depth limit", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		let relays = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("echo", async (_envelope, context) => {
				relays += 1;
				await context.actions.emitExtensionEvent("echo");
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, agentId).emitExtensionEvent("echo");

		expect(relays).toBe(MAX_EXTENSION_EVENT_DISPATCH_DEPTH);
		expect(
			diagnostics.some(
				(diagnostic) => diagnostic.code === "extension.event_recursion_dropped" && diagnostic.extensionId === "sender",
			),
		).toBe(true);
	});

	it("does not count independent concurrent dispatches as recursion", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		let releaseHandlers!: () => void;
		const handlersReleased = new Promise<void>((resolve) => {
			releaseHandlers = resolve;
		});
		let received = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("parallel", async () => {
				received += 1;
				await handlersReleased;
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const actions = requireActions(orchestrator, agentId);

		const dispatches = Promise.all(
			Array.from(
				{ length: MAX_EXTENSION_EVENT_DISPATCH_DEPTH + 1 },
				async () => await actions.emitExtensionEvent("parallel"),
			),
		);
		try {
			await vi.waitFor(() => {
				expect(received).toBe(MAX_EXTENSION_EVENT_DISPATCH_DEPTH + 1);
			});
		} finally {
			releaseHandlers();
			await dispatches;
		}

		expect(diagnostics.some((diagnostic) => diagnostic.code === "extension.event_recursion_dropped")).toBe(false);
	});

	it("drops the subscriptions of a disposed agent", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const seen: string[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("ping", (_envelope, context) => {
				seen.push(context.agentId);
			});
		});
		const survivorId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const disposedId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.disposeAgent(disposedId, { intent: "removed", reason: "test" });

		await requireActions(orchestrator, survivorId).emitExtensionEvent("ping");

		expect(seen).toEqual([survivorId]);
	});

	it("moves subscriptions to the runner an extension reload installs", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const generations: number[] = [];
		let generation = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			const activationGeneration = ++generation;
			api.onExtensionEvent("ping", () => {
				generations.push(activationGeneration);
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.reloadExtensions({ agentIds: [agentId] });

		await requireActions(orchestrator, agentId).emitExtensionEvent("ping");

		expect(generations).toEqual([2]);
	});

	it("delivers to a registered non-runner subscriber, and stops on detach", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const seen: ExtensionEventEnvelope[] = [];
		const detach = orchestrator.registerExtensionEventSubscriber({
			deliver: (envelope) => {
				seen.push(envelope);
			},
		});
		orchestrator.registerExtension("sender", () => {});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await requireActions(orchestrator, agentId).emitExtensionEvent("herdr:blocked", { pane: 3 });
		detach();
		await requireActions(orchestrator, agentId).emitExtensionEvent("herdr:blocked");

		expect(seen).toHaveLength(1);
		expect(seen[0]?.payload).toEqual({ pane: 3 });
		expect(seen[0]?.sourceExtensionId).toBe("sender");
		expect(seen[0]?.sourceAgentId).toBe(agentId);
	});

	// A host is out-of-core code: it may not take the fan-out or the emitter down.
	it("contains a throwing subscriber as a diagnostic", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		const reached: string[] = [];
		orchestrator.registerExtensionEventSubscriber({
			deliver: () => {
				throw new Error("host exploded");
			},
		});
		orchestrator.registerExtensionEventSubscriber({
			deliver: () => {
				reached.push("second");
			},
		});
		orchestrator.registerExtension("sender", () => {});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(requireActions(orchestrator, agentId).emitExtensionEvent("ping")).resolves.toBeUndefined();

		expect(reached).toEqual(["second"]);
		const failure = diagnostics.find((diagnostic) => diagnostic.code === "extension.event_subscriber_failed");
		expect(failure?.message).toContain("host exploded");
	});

	it("emits on behalf of a host through the public entry point", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const received: ExtensionEventEnvelope[] = [];
		orchestrator.registerExtension("listener", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("drill:step", (envelope) => {
				received.push(envelope);
			});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await orchestrator.emitExtensionEvent(agentId, "drill", "drill:step", { index: 1 });

		expect(received).toHaveLength(1);
		expect(received[0]?.sourceExtensionId).toBe("drill");
		expect(received[0]?.sourceAgentId).toBe(agentId);
		await expect(orchestrator.emitExtensionEvent(agentId, "drill", "has space")).rejects.toThrow(TypeError);
		await expect(orchestrator.emitExtensionEvent("missing", "drill", "drill:step")).rejects.toThrow();
	});

	it("lists bus subscriptions among the inspectable hooks", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("herdr:blocked", () => {});
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const hooks = orchestrator.inspectAgent(agentId).extensions.hooks;

		expect(hooks).toContainEqual({
			kind: "event",
			extensionId: "sender",
			eventName: "herdr:blocked",
			divisionId: undefined,
		});
	});
});
