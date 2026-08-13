import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
import type { ExtensionCustomEntry, ExtensionFactory } from "../../src/core/extension/index.ts";
import {
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	toExtensionCustomType,
} from "../../src/core/session-manager.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	AUDIT_EVENT_ENTRY_TYPE,
	AUDIT_INPUT_VERDICT_ENTRY_TYPE,
	AUDIT_VERDICT_ENTRY_TYPE,
	type AuditEventEntry,
	type AuditInputVerdictEntry,
	type AuditPolicy,
	type AuditVerdictEntry,
	createAuditExtension,
} from "../extensions/audit-extension.ts";
import {
	createOrchestrator,
	harnessEventDriver,
	humanSink,
	MemoryExecutionEnv,
	recordExtensionDiagnostics,
	requireAgentHarness,
	requireLiveAgent,
} from "../helpers/orchestrator.ts";

function createAuditTestDiagnostic(agentId: string): OrchestratorDiagnostic {
	return {
		severity: "warning",
		code: "extension.audit_test",
		message: "Audit diagnostic",
		agentId,
		extensionId: "audit-test",
	};
}

interface AuditHarnessOptions {
	readonly persist?: boolean;
	readonly beforeAudit?: readonly { readonly id: string; readonly factory: ExtensionFactory }[];
}

async function createAuditHarness(
	policy: AuditPolicy,
	options: AuditHarnessOptions = {},
): Promise<{ orchestrator: AgentOrchestrator; agentId: string; events: OrchestratorEvent[] }> {
	const extensionProfile: AgentProfile = {
		id: "audit-profile",
		label: "Audit Profile",
		systemPrompt: "Audit test prompt",
		persist: options.persist ?? false,
	};
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: extensionProfile.id,
		profileRegistry: new AgentProfileRegistry(
			InMemoryProfileStorageBackend.fromProfiles([{ profile: extensionProfile }]),
		),
	});
	for (const extension of options.beforeAudit ?? []) {
		orchestrator.registerExtension(extension.id, extension.factory);
	}
	orchestrator.registerExtension("audit", createAuditExtension(policy));
	const events: OrchestratorEvent[] = [];
	orchestrator.subscribe((event) => {
		events.push(event);
	});
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	return { orchestrator, agentId, events };
}

async function runToolCall(
	orchestrator: AgentOrchestrator,
	agentId: string,
	toolCallId: string,
	toolName: string,
): Promise<unknown> {
	const harness = requireAgentHarness(orchestrator, agentId);
	const handlers = (harness as unknown as { handlers: Map<string, Set<(event: unknown) => Promise<unknown>>> })
		.handlers;
	const handler = Array.from(handlers.get("tool_call") ?? [])[0];
	if (!handler) throw new Error("Missing tool_call harness hook.");
	return await handler({ type: "tool_call", toolCallId, toolName, input: {} });
}

async function emitHarnessEvent(
	orchestrator: AgentOrchestrator,
	agentId: string,
	event: AgentHarnessEvent,
): Promise<void> {
	const handler = harnessEventDriver(orchestrator);
	await handler(agentId, event);
}

async function readAuditEntries<T>(
	orchestrator: AgentOrchestrator,
	agentId: string,
	type: string,
): Promise<ExtensionCustomEntry<T>[]> {
	const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Missing audit extension runner.");
	return await runner.createContext("audit").session.findEntries<T>(type);
}

describe("audit extension consumer", () => {
	it("records selected harness events and default-allow verdicts", async () => {
		const { orchestrator, agentId } = await createAuditHarness({ recordHarnessEvents: ["turn_start"] });

		await emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });
		await expect(runToolCall(orchestrator, agentId, "call-1", "read")).resolves.toBeUndefined();

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "harness", eventType: "turn_start" } }]);
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([
			{ data: { toolCallId: "call-1", toolName: "read", outcome: "allowed", decidedBy: "default" } },
		]);
	});

	// Recording session writes onto the session is the shape that used to
	// self-feed: the extension's own entry came back as another session_write.
	// The core-owned types are the same cycle wearing core's namespace, so they
	// are asserted here rather than in a test of their own.
	it("does not report an extension-authored session write back to its observers", async () => {
		const { orchestrator, agentId } = await createAuditHarness({ recordHarnessEvents: ["session_write"] });
		const suppressed = [toExtensionCustomType("audit", AUDIT_EVENT_ENTRY_TYPE), EXTENSION_MESSAGE_CUSTOM_TYPE];

		await emitHarnessEvent(orchestrator, agentId, {
			type: "session_write",
			entryId: "entry-core",
			write: { type: "custom", customType: INPUT_TRANSFORM_CUSTOM_TYPE, data: {} },
		});
		for (const [index, customType] of suppressed.entries()) {
			await emitHarnessEvent(orchestrator, agentId, {
				type: "session_write",
				entryId: `entry-extension-${index}`,
				write: { type: "custom", customType, data: {} },
			});
		}

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "harness", eventType: "session_write" } }]);
	});

	it("blocks explicit deny rules and records the reason", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			deny: [{ tool: "write", reason: "Repository is read-only." }],
		});

		await expect(runToolCall(orchestrator, agentId, "call-2", "write")).resolves.toEqual({
			block: true,
			reason: "Repository is read-only.",
		});
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([
			{
				data: { toolCallId: "call-2", outcome: "blocked", decidedBy: "deny_rule", reason: "Repository is read-only." },
			},
		]);
	});

	it("aborts the run through the scoped kill switch and blocks the call", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			abortOn: [{ tool: "bash", reason: "Shell access ends the run." }],
		});
		const aborted: string[] = [];
		Object.assign(orchestrator, {
			abortAgent: async (abortedAgentId: string) => {
				aborted.push(abortedAgentId);
			},
		});

		await expect(runToolCall(orchestrator, agentId, "call-3", "bash")).resolves.toEqual({
			block: true,
			reason: "Shell access ends the run.",
		});
		expect(aborted).toEqual([agentId]);
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([
			{
				data: {
					toolCallId: "call-3",
					outcome: "blocked",
					decidedBy: "abort_rule",
					reason: "Shell access ends the run.",
				},
			},
		]);
	});

	it("records agent-scoped orchestrator facts in order", async () => {
		const { orchestrator, agentId, events } = await createAuditHarness(
			{
				recordCoreEvents: [
					"human_request_pending",
					"human_request_resolved",
					"diagnostic",
					"agent_session_info_changed",
					"agent_session_forked",
				],
			},
			{ persist: true },
		);
		orchestrator.registerClient({ id: "human", requestHuman: async () => ({ kind: "confirm", confirmed: true }) });

		await orchestrator.requestHuman({ source: { kind: "agent", agentId }, kind: "confirm", title: "Continue?" });
		await orchestrator.setAgentSessionName(agentId, "Audited session");
		await recordExtensionDiagnostics(orchestrator, agentId, [createAuditTestDiagnostic(agentId)]);
		await orchestrator.spawnAgent({ origin: { kind: "fork", sourceAgentId: agentId } });

		const entries = await readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE);
		expect(entries.map((entry) => entry.data?.eventType)).toEqual([
			"human_request_pending",
			"human_request_resolved",
			"agent_session_info_changed",
			"diagnostic",
			"agent_session_forked",
		]);
		expect(entries.every((entry) => entry.data?.source === "orchestrator")).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "agent_session_info_changed", agentId, name: "Audited session" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "agent_session_forked", agentId, forkedSessionId: expect.any(String) }),
		);
	});

	it("does not leak orchestrator events across agent runners", async () => {
		const { orchestrator, agentId } = await createAuditHarness({ recordCoreEvents: ["agent_session_info_changed"] });
		const otherAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await orchestrator.setAgentSessionName(agentId, "Audited");

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "orchestrator", eventType: "agent_session_info_changed" } }]);
		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, otherAgentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toEqual([]);
	});

	it("does not fan global diagnostics out to agent-scoped runners", async () => {
		const { orchestrator, agentId } = await createAuditHarness({ recordCoreEvents: ["diagnostic"] });

		await expect(
			orchestrator.requestHuman({ source: { kind: "system" }, kind: "confirm", title: "No client" }),
		).rejects.toMatchObject({ code: "orchestrator.human_request_unhandled" });

		await expect(readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE)).resolves.toEqual([]);
	});

	it("asks the human with an injected extension source", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			ask: [{ tool: "write", prompt: "Allow this write?" }],
			recordCoreEvents: ["human_request_pending", "human_request_resolved"],
		});
		const responses = ["allow", "deny"];
		const requests: unknown[] = [];
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				requests.push(request);
				return { kind: "select", value: responses.shift() };
			},
		});

		await expect(runToolCall(orchestrator, agentId, "call-3", "write")).resolves.toBeUndefined();
		await expect(runToolCall(orchestrator, agentId, "call-4", "write")).resolves.toEqual({
			block: true,
			reason: "Human approval was denied.",
		});
		expect(requests).toEqual([
			expect.objectContaining({
				source: { kind: "extension", extensionId: "audit" },
				kind: "select",
				title: "Approve tool write",
				options: ["allow", "deny"],
			}),
			expect.objectContaining({ source: { kind: "extension", extensionId: "audit" } }),
		]);
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([
			{ data: { toolCallId: "call-3", outcome: "allowed", decidedBy: "human" } },
			{ data: { toolCallId: "call-4", outcome: "blocked", decidedBy: "human" } },
		]);
		const eventEntries = await readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE);
		expect(eventEntries.map((entry) => entry.data?.eventType)).toEqual([
			"human_request_pending",
			"human_request_resolved",
			"human_request_pending",
			"human_request_resolved",
		]);
	});

	it("fails closed when the human request cannot be served", async () => {
		// No human client is registered, so the broker rejects the request and
		// the extension must block rather than fall through to an allow.
		const { orchestrator, agentId, events } = await createAuditHarness({
			ask: [{ tool: "write", prompt: "Allow this write?" }],
		});

		await expect(runToolCall(orchestrator, agentId, "call-5", "write")).resolves.toMatchObject({
			block: true,
			reason: expect.stringContaining("Human approval unavailable"),
		});
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { toolCallId: "call-5", outcome: "blocked", decidedBy: "human_unavailable" } }]);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "diagnostic",
					diagnostic: expect.objectContaining({
						code: "extension.action_failed",
						extensionId: "audit",
						message: expect.stringContaining("action 'requestHuman' failed"),
					}),
				}),
			]),
		);
	});

	it("blocks denied input, records the verdict, and observes its own fact", async () => {
		const { orchestrator, agentId, events } = await createAuditHarness({
			denyInput: [{ match: "secret", reason: "Sensitive input." }],
			recordCoreEvents: ["input_blocked"],
		});
		Object.assign(requireAgentHarness(orchestrator, agentId), { prompt: async () => ({ role: "assistant" }) });

		await expect(
			humanSink(orchestrator).prompt({ targetAgentId: agentId, body: "status report", mode: "next_turn" }),
		).resolves.toMatchObject({ kind: "completed" });
		await expect(
			humanSink(orchestrator).prompt({ targetAgentId: agentId, body: "share the secret", mode: "next_turn" }),
		).resolves.toEqual({
			kind: "blocked",
			inputId: expect.any(String),
			reason: "Sensitive input.",
			blockedBy: "audit",
		});

		await expect(
			readAuditEntries<AuditInputVerdictEntry>(orchestrator, agentId, AUDIT_INPUT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([
			{ data: { text: "status report", outcome: "allowed", decidedBy: "default" } },
			{ data: { text: "share the secret", outcome: "blocked", decidedBy: "deny_rule", reason: "Sensitive input." } },
		]);
		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "orchestrator", eventType: "input_blocked" } }]);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "input_blocked", agentId, originalText: "share the secret", blockedBy: "audit" }),
		);
	});

	it("keeps input auditing when another input interceptor fails on later input", async () => {
		let firstCall = true;
		const broken: ExtensionFactory = (api) => {
			api.intercept("input", () => {
				if (!firstCall) return undefined;
				firstCall = false;
				throw new Error("input policy exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{ denyInput: [{ match: "secret", reason: "Sensitive input." }] },
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		// First input fails closed on the broken extension before audit runs.
		await expect(
			humanSink(orchestrator).prompt({ targetAgentId: agentId, body: "status report", mode: "next_turn" }),
		).resolves.toMatchObject({ kind: "blocked", blockedBy: "broken" });
		// The next input reaches the audit policy, which still enforces.
		await expect(
			humanSink(orchestrator).prompt({ targetAgentId: agentId, body: "share the secret", mode: "next_turn" }),
		).resolves.toMatchObject({ kind: "blocked", blockedBy: "audit" });

		await expect(
			readAuditEntries<AuditInputVerdictEntry>(orchestrator, agentId, AUDIT_INPUT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { text: "share the secret", outcome: "blocked" } }]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					message: expect.stringContaining("handler 'input' failed"),
				}),
			}),
		);
	});

	it("keeps auditing when another observer fails", async () => {
		const broken: ExtensionFactory = (api) => {
			api.observe("agent_harness_event", () => {
				throw new Error("observer exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{ recordHarnessEvents: ["turn_start"] },
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		await emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "harness", eventType: "turn_start" } }]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					message: expect.stringContaining("handler 'agent_harness_event' failed"),
				}),
			}),
		);
	});

	it("publishes diagnostic observer failures once without feeding them back", async () => {
		const broken: ExtensionFactory = (api) => {
			api.observe("diagnostic", () => {
				throw new Error("diagnostic observer exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{ recordCoreEvents: ["diagnostic"] },
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		await recordExtensionDiagnostics(orchestrator, agentId, [createAuditTestDiagnostic(agentId)]);

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "orchestrator", eventType: "diagnostic" } }]);
		expect(
			events.filter((event) => event.type === "diagnostic" && event.diagnostic.code === "extension.handler_failed"),
		).toHaveLength(1);
	});

	it("keeps routing diagnostics to observers after interleaved dispatches", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow: ExtensionFactory = (api) => {
			api.observe("agent_harness_event", async () => {
				await gate;
			});
		};
		const { orchestrator, agentId } = await createAuditHarness(
			{ recordCoreEvents: ["diagnostic"] },
			{ beforeAudit: [{ id: "slow", factory: slow }] },
		);

		// Two harness events for the same agent whose observer dispatches
		// overlap, like events arriving while an observer is still awaiting.
		const first = emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });
		const second = emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });
		release();
		await Promise.all([first, second]);

		await recordExtensionDiagnostics(orchestrator, agentId, [createAuditTestDiagnostic(agentId)]);

		await expect(
			readAuditEntries<AuditEventEntry>(orchestrator, agentId, AUDIT_EVENT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { source: "orchestrator", eventType: "diagnostic" } }]);
	});

	it("stops dispatching to observers after the agent is disposed", async () => {
		const observed: string[] = [];
		const probe: ExtensionFactory = (api) => {
			api.observe("diagnostic", (event) => {
				observed.push(event.diagnostic.code);
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{},
			{ beforeAudit: [{ id: "probe", factory: probe }] },
		);

		await orchestrator.disposeAgent(agentId, { intent: "removed" });
		observed.length = 0;
		await recordExtensionDiagnostics(orchestrator, agentId, [createAuditTestDiagnostic(agentId)]);

		expect(observed).toEqual([]);
		expect(
			events.filter((event) => event.type === "diagnostic" && event.diagnostic.code === "extension.handler_failed"),
		).toHaveLength(0);
	});

	it("fails closed on another tool interceptor error without disabling audit", async () => {
		let firstCall = true;
		const broken: ExtensionFactory = (api) => {
			api.intercept("tool_call", () => {
				if (!firstCall) return undefined;
				firstCall = false;
				throw new Error("tool policy exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{},
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		await expect(runToolCall(orchestrator, agentId, "call-6", "read")).resolves.toEqual({ block: true });
		await expect(runToolCall(orchestrator, agentId, "call-7", "read")).resolves.toBeUndefined();
		await expect(
			readAuditEntries<AuditVerdictEntry>(orchestrator, agentId, AUDIT_VERDICT_ENTRY_TYPE),
		).resolves.toMatchObject([{ data: { toolCallId: "call-7", outcome: "allowed" } }]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					message: expect.stringContaining("handler 'tool_call' failed"),
				}),
			}),
		);
	});
});
