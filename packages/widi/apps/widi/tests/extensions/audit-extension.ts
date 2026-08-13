import type { AgentHarnessEvent } from "@arcadialin/agent-core";
import type { ExtensionFactory, ExtensionObservedEventName } from "../../src/core/extension/api.ts";

export const AUDIT_EVENT_ENTRY_TYPE = "event";
export const AUDIT_VERDICT_ENTRY_TYPE = "verdict";
export const AUDIT_INPUT_VERDICT_ENTRY_TYPE = "input-verdict";

export interface AuditDenyRule {
	readonly tool: string;
	readonly reason: string;
}

export interface AuditAskRule {
	readonly tool: string;
	readonly prompt: string;
}

// Kill switch: abort the whole run when the tool is requested, not just
// block the single call.
export interface AuditAbortRule {
	readonly tool: string;
	readonly reason: string;
}

export interface AuditInputDenyRule {
	readonly match: string;
	readonly reason: string;
}

export interface AuditPolicy {
	readonly deny?: readonly AuditDenyRule[];
	readonly ask?: readonly AuditAskRule[];
	readonly abortOn?: readonly AuditAbortRule[];
	readonly denyInput?: readonly AuditInputDenyRule[];
	readonly recordHarnessEvents?: readonly AgentHarnessEvent["type"][];
	readonly recordCoreEvents?: readonly Exclude<ExtensionObservedEventName, "agent_harness_event">[];
}

export interface AuditEventEntry {
	readonly source: "harness" | "orchestrator";
	readonly eventType: string;
}

export interface AuditVerdictEntry {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly outcome: "allowed" | "blocked";
	readonly decidedBy: "abort_rule" | "default" | "deny_rule" | "human" | "human_unavailable";
	readonly reason?: string;
}

export interface AuditInputVerdictEntry {
	readonly text: string;
	readonly outcome: "allowed" | "blocked";
	readonly decidedBy: "default" | "deny_rule";
	readonly reason?: string;
}

export function createAuditExtension(policy: AuditPolicy): ExtensionFactory {
	const denyRules = new Map((policy.deny ?? []).map((rule) => [rule.tool, rule] as const));
	const askRules = new Map((policy.ask ?? []).map((rule) => [rule.tool, rule] as const));
	const abortRules = new Map((policy.abortOn ?? []).map((rule) => [rule.tool, rule] as const));
	const inputDenyRules = [...(policy.denyInput ?? [])];
	const recordedHarnessEvents = new Set(policy.recordHarnessEvents ?? []);
	const recordedCoreEvents = new Set(policy.recordCoreEvents ?? []);

	return (api) => {
		api.observe("agent_harness_event", async (event, context) => {
			if (!recordedHarnessEvents.has(event.event.type)) return;
			await context.session.appendEntry<AuditEventEntry>(AUDIT_EVENT_ENTRY_TYPE, {
				source: "harness",
				eventType: event.event.type,
			});
		});
		for (const eventName of recordedCoreEvents) {
			api.observe(eventName, async (event, context) => {
				await context.session.appendEntry<AuditEventEntry>(AUDIT_EVENT_ENTRY_TYPE, {
					source: "orchestrator",
					eventType: event.type,
				});
			});
		}

		if (inputDenyRules.length > 0) {
			api.intercept("input", async (event, context) => {
				const denied = inputDenyRules.find((rule) => event.text.includes(rule.match));
				await context.session.appendEntry<AuditInputVerdictEntry>(AUDIT_INPUT_VERDICT_ENTRY_TYPE, {
					text: event.text,
					outcome: denied ? "blocked" : "allowed",
					decidedBy: denied ? "deny_rule" : "default",
					reason: denied?.reason,
				});
				return denied ? { block: true, reason: denied.reason } : undefined;
			});
		}

		api.intercept("tool_call", async (event, context) => {
			const abortRule = abortRules.get(event.toolName);
			if (abortRule) {
				try {
					await context.actions.abort();
				} catch {
					// The kill switch stays fail-closed: the tool call is blocked
					// below even when the abort action itself fails.
				}
				await context.session.appendEntry<AuditVerdictEntry>(AUDIT_VERDICT_ENTRY_TYPE, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					outcome: "blocked",
					decidedBy: "abort_rule",
					reason: abortRule.reason,
				});
				return { block: true, reason: abortRule.reason };
			}

			const denied = denyRules.get(event.toolName);
			if (denied) {
				await context.session.appendEntry<AuditVerdictEntry>(AUDIT_VERDICT_ENTRY_TYPE, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					outcome: "blocked",
					decidedBy: "deny_rule",
					reason: denied.reason,
				});
				return { block: true, reason: denied.reason };
			}

			const asked = askRules.get(event.toolName);
			if (asked) {
				try {
					const response = await context.actions.requestHuman({
						kind: "select",
						title: `Approve tool ${event.toolName}`,
						message: asked.prompt,
						options: ["allow", "deny"],
					});
					const allowed = response.kind === "select" && response.value === "allow";
					const reason = allowed ? undefined : "Human approval was denied.";
					await context.session.appendEntry<AuditVerdictEntry>(AUDIT_VERDICT_ENTRY_TYPE, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						outcome: allowed ? "allowed" : "blocked",
						decidedBy: "human",
						reason,
					});
					return allowed ? undefined : { block: true, reason };
				} catch (error) {
					const reason = `Human approval unavailable: ${formatError(error)}`;
					await context.session.appendEntry<AuditVerdictEntry>(AUDIT_VERDICT_ENTRY_TYPE, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						outcome: "blocked",
						decidedBy: "human_unavailable",
						reason,
					});
					return { block: true, reason };
				}
			}

			await context.session.appendEntry<AuditVerdictEntry>(AUDIT_VERDICT_ENTRY_TYPE, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				outcome: "allowed",
				decidedBy: "default",
			});
			return undefined;
		});
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
