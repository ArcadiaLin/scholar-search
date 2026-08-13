import type { AgentHarnessEvent, AgentMessage, CustomMessage } from "@arcadialin/agent-core";
import type { AssistantMessage, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "../core/agent-types.ts";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionStatusSnapshot } from "../core/extension/api.ts";
import {
	type HumanQuestion,
	type HumanRequestKind,
	type HumanRequestOption,
	type HumanResponse,
	normalizeHumanRequestOptions,
} from "../core/human-request.ts";
import type { MessageEntryDetails } from "../core/message.ts";
import { ORCHESTRATOR_MESSAGE_CUSTOM_TYPE } from "../core/session-manager.ts";
import type { AgentId, OrchestratorEvent } from "../core/types.ts";
import { diagnosticKey } from "./diagnostics-log.ts";
import { maintenanceLabel } from "./labels.ts";
import { setSteadyQuip, setTransientQuip } from "./quips.ts";
import type { HydrationResult } from "./session-hydrator.ts";
import {
	type AgentAttention,
	type AgentViewState,
	ensureAgentProjection,
	extensionStatusKey,
	isTimelineEvent,
	type OrchestratorMessageItem,
	retainedAttention,
	type TimelineItem,
	type ToolExecutionItem,
	type TuiApplicationState,
} from "./state.ts";
import { flushStreaming } from "./streaming-flush.ts";
import { applyTimelineWindow } from "./timeline-window.ts";

/** Failures in a row before the working line stops calling it a tool result. */
const TOOL_ERROR_STREAK_QUIP = 3;

const ATTENTION_PRIORITY: Record<AgentAttention, number> = {
	none: 0,
	completed: 1,
	warning: 2,
	"human-request": 3,
	error: 4,
};

interface ThinkingPreviewState {
	readonly agentId: AgentId;
	completedLines: string[];
	currentLine: string;
}

const THINKING_PREVIEW_LINE_CHARACTERS = 2_000;

function thinkingPreviewKey(agentId: AgentId, assistantId: string): string {
	return `${agentId}\0${assistantId}`;
}

export class EventProjector {
	readonly state: TuiApplicationState;
	/** Bounded, incremental tails for live thinking streams. */
	private readonly thinkingPreviews = new Map<string, ThinkingPreviewState>();

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	ensureAgent(agentId: AgentId): AgentViewState {
		return ensureAgentProjection(this.state, agentId);
	}

	/**
	 * Set or clear a tool item's per-item expand override (parity §4.3-3).
	 * The override survives later item updates; clearing it returns the item
	 * to the global toolOutputExpanded toggle.
	 */
	setToolExpanded(agentId: AgentId, toolCallId: string, expanded: boolean | undefined): void {
		const item = findTool(ensureAgentProjection(this.state, agentId), toolCallId);
		if (!item) return;
		if (expanded === undefined) delete item.expanded;
		else item.expanded = expanded;
	}

	apply(event: OrchestratorEvent): void {
		const agentId = eventAgentId(event);
		if (agentId && this.shouldBuffer(ensureAgentProjection(this.state, agentId), event)) {
			ensureAgentProjection(this.state, agentId).bufferedEvents.push(event);
			return;
		}
		this.applyImmediately(event);
	}

	beginHydration(agentId: AgentId): AgentViewState {
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.hydration === "pending") return agent;
		agent.hydration = "pending";
		agent.bufferedEvents = [];
		agent.display.rehydrateRequested = false;
		// The timeline is about to be rebuilt; stale streaming buffers would
		// point at items that hydration replaces.
		agent.pendingAssistantText = undefined;
		agent.pendingToolUpdates?.clear();
		this.clearThinkingPreviews(agentId);
		return agent;
	}

	completeHydration(
		agentId: AgentId,
		result: HydrationResult,
		extensionStatuses: readonly ExtensionStatusSnapshot[] = [],
	): AgentViewState {
		const agent = ensureAgentProjection(this.state, agentId);
		// The hydrated timeline rebuilds from the full session history, so the
		// old window marker must not survive: its hidden-turn count would be
		// double-counted when the window re-trims the rebuilt timeline.
		const liveBeforeHydration = agent.timeline.filter(
			(item) => item.durability === "ephemeral" && item.type !== "window-marker",
		);
		agent.timeline = mergeTimeline(result.timeline, liveBeforeHydration);
		if (result.display.model && agent.display.model) {
			agent.display.model = {
				...agent.display.model,
				provider: result.display.model.provider,
				id: result.display.model.modelId,
			};
		}
		if (result.display.thinkingLevel !== undefined) {
			agent.display.thinkingLevel = result.display.thinkingLevel;
		}
		if (result.display.activeToolNames !== undefined) {
			agent.display.activeToolNames = [...result.display.activeToolNames];
		}
		if (result.display.sessionName !== undefined) {
			agent.display.sessionName = result.display.sessionName;
		}
		agent.extensionStatuses = new Map(
			extensionStatuses.map((status) => [extensionStatusKey(status.extensionId, status.key), status]),
		);
		const buffered = agent.bufferedEvents;
		agent.bufferedEvents = [];
		agent.hydration = "ready";
		for (const event of buffered) this.applyImmediately(event);
		applyTimelineWindow(agent);
		return agent;
	}

	failHydration(agentId: AgentId, message: string, createdAt = now()): void {
		const agent = ensureAgentProjection(this.state, agentId);
		const buffered = agent.bufferedEvents;
		agent.bufferedEvents = [];
		agent.hydration = "failed";
		agent.timeline.push({
			type: "application-notice",
			id: `hydration:${agentId}:${createdAt}`,
			durability: "ephemeral",
			createdAt,
			text: message,
		});
		for (const event of buffered) this.applyImmediately(event);
	}

	private shouldBuffer(agent: AgentViewState, event: OrchestratorEvent): boolean {
		if (agent.hydration !== "pending") return false;
		// Resolution must close the capturing overlay immediately. Its trace is
		// ephemeral and completeHydration preserves pre-existing ephemeral items.
		if (event.type === "human_request_resolved") return false;
		if (event.type === "extension_status_changed") return true;
		return isTimelineEvent(event);
	}

	private applyImmediately(event: OrchestratorEvent): void {
		switch (event.type) {
			case "agent_harness_event":
				this.applyHarnessEvent(ensureAgentProjection(this.state, event.agentId), event.event);
				return;
			case "agent_status_changed": {
				const agent = ensureAgentProjection(this.state, event.agentId, event.activity);
				const wasRunning = agent.status === "running";
				agent.status = event.activity;
				agent.maintenance = event.activity === "running" ? event.maintenance : undefined;
				if (event.activity === "running" && !wasRunning) {
					agent.runToolCount = 0;
					agent.runToolErrorStreak = 0;
				}
				if (wasRunning && event.activity !== "running" && agent.runStartedAt) {
					agent.lastRun = { startedAt: agent.runStartedAt, endedAt: event.changedAt, toolCount: agent.runToolCount };
				}
				setSteadyQuip(agent, event.activity === "running" ? "working" : "idle");
				agent.runStartedAt = event.activity === "running" ? event.changedAt : undefined;
				// Experience indicator: covers the model's first-token latency
				// after submit; completes (renders empty) once the run leaves
				// "running".
				if (event.activity === "running") upsertAwaitingThinking(agent);
				else {
					completeAwaitingThinking(agent);
					this.clearThinkingPreviews(event.agentId);
				}
				if (wasRunning && event.activity !== "running") {
					// Abort can end a run without message_end; never lose the tail of
					// the stream still sitting in the pending buffer.
					flushStreaming(agent);
					// A run can end while a streamed tool call never reached
					// tool_execution_start; don't leave its placeholder preparing.
					for (const entry of agent.timeline) {
						if (entry.type === "tool-execution" && entry.status === "preparing") {
							entry.status = "cancelled";
						}
					}
				}
				if (wasRunning && event.activity === "idle" && this.state.activeAgentId !== event.agentId) {
					raiseAttention(agent, "completed");
				}
				return;
			}
			// Only the working line reads this: `agent_status_changed` says the run
			// ended, this says how it ended. `ready` and `maintenance` are not stops
			// a person was waiting on, so they get no line of their own.
			case "agent_idle": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				if (event.reason === "settled") {
					setTransientQuip(agent, "done");
				} else if (event.reason === "aborted") {
					setTransientQuip(
						agent,
						event.abortedBy === "human"
							? "aborted-by-human"
							: event.abortedBy === "extension"
								? "aborted-by-extension"
								: "aborted",
					);
				}
				return;
			}
			case "agent_spawned": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				agent.display.model = event.model;
				agent.hydration = "pending";
				agent.spawnedBy = event.spawnedBy;
				return;
			}
			case "agent_resumed": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				agent.display.model = event.model;
				agent.hydration = "pending";
				return;
			}
			// Not `ensureAgentProjection`: an agent this shell never projected has
			// nothing to mark, and creating a row for it only to bury it would put
			// it back in a tree that filters on this very status.
			case "agent_disposed": {
				const agent = this.state.agents.get(event.agentId);
				if (agent) agent.status = "disposed";
				return;
			}
			case "agent_session_info_changed":
				ensureAgentProjection(this.state, event.agentId).display.sessionName = event.name;
				return;
			case "agent_session_forked": {
				ensureAgentProjection(this.state, event.agentId).display.rehydrateRequested = true;
				ensureAgentProjection(this.state, event.forkedSessionId).display.forkedFromAgentId = event.agentId;
				return;
			}
			case "input_blocked":
				ensureAgentProjection(this.state, event.agentId).pendingInput = undefined;
				return;
			case "extension_output": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				upsertTimeline(agent, {
					type: "extension-output",
					id: event.presentationId,
					presentationId: event.presentationId,
					durability: "ephemeral",
					createdAt: event.createdAt,
					extensionId: event.extensionId,
					text: event.text,
				});
				this.markBackgroundActivity(event.agentId);
				return;
			}
			case "extension_notification":
				this.state.globalNotices.push({
					id: event.presentationId,
					kind: "extension-notification",
					createdAt: event.createdAt,
					text: event.text,
					agentId: event.agentId,
					extensionId: event.extensionId,
				});
				return;
			case "extension_status_changed": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				const key = extensionStatusKey(event.extensionId, event.key);
				if (!event.status) {
					agent.extensionStatuses.delete(key);
				} else {
					agent.extensionStatuses.set(key, {
						agentId: event.agentId,
						extensionId: event.extensionId,
						key: event.key,
						status: event.status,
						updatedAt: event.changedAt,
					});
				}
				return;
			}
			case "extension_message_published": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				upsertTimeline(agent, {
					type: "extension-message",
					id: event.entryId,
					entryId: event.entryId,
					extensionId: event.extensionId,
					message: event.message,
					durability: "durable",
					createdAt: event.createdAt,
				});
				this.markBackgroundActivity(event.agentId);
				return;
			}
			case "diagnostic":
				this.applyDiagnostic(event.diagnostic, event.createdAt);
				return;
			case "human_request_pending": {
				if (event.agentId) {
					// The user answers against what is on screen; show the latest
					// streamed state before the request overlay opens.
					flushStreaming(ensureAgentProjection(this.state, event.agentId));
				}
				this.state.humanRequests = [
					...this.state.humanRequests.filter((item) => item.request.id !== event.request.id),
					{ request: event.request, agentId: event.agentId },
				];
				if (event.agentId) {
					raiseAttention(ensureAgentProjection(this.state, event.agentId), "human-request");
				}
				return;
			}
			case "human_request_resolved":
				this.resolveHumanRequest(event.agentId, event.requestId, event.response, event.completedAt);
				return;
			case "human_request_timeout":
			case "human_request_cancelled":
				this.removeHumanRequest(event.requestId, event.agentId);
				return;
			case "input_transformed":
				return;
		}
	}

	private clearThinkingPreviews(agentId: AgentId): void {
		for (const [key, preview] of this.thinkingPreviews) {
			if (preview.agentId === agentId) this.thinkingPreviews.delete(key);
		}
	}

	private applyHarnessEvent(agent: AgentViewState, event: AgentHarnessEvent): void {
		switch (event.type) {
			case "message_start":
				this.applyMessageStart(agent, event.message);
				return;
			case "message_update": {
				if (event.message.role !== "assistant") return;
				const item = findAssistant(agent, agent.currentAssistantId);
				if (!item) return;
				// Deltas accumulate in the pending buffer; the timeline item only
				// changes on flush, keeping the ChatView render cache valid between
				// flushes.
				agent.pendingAssistantText = { itemId: item.id, text: assistantText(event.message), message: event.message };
				const streamEvent = event.assistantMessageEvent;
				if (streamEvent.type === "thinking_start") {
					const previewState: ThinkingPreviewState = { agentId: agent.agentId, completedLines: [], currentLine: "" };
					const content = event.message.content[streamEvent.contentIndex];
					if (content?.type === "thinking") {
						appendThinkingPreview(previewState, content.thinking);
					}
					this.thinkingPreviews.set(thinkingPreviewKey(agent.agentId, item.id), previewState);
					upsertTimeline(agent, {
						type: "thinking-status",
						id: `${item.id}:thinking`,
						durability: "ephemeral",
						createdAt: now(),
						status: "thinking",
						preview: thinkingPreviewText(previewState),
					});
				} else if (streamEvent.type === "thinking_delta") {
					const thinking = agent.timeline.find(
						(entry) => entry.type === "thinking-status" && entry.id === `${item.id}:thinking`,
					);
					if (thinking?.type === "thinking-status") {
						const key = thinkingPreviewKey(agent.agentId, item.id);
						const previewState = this.thinkingPreviews.get(key) ?? {
							agentId: agent.agentId,
							completedLines: [],
							currentLine: "",
						};
						appendThinkingPreview(previewState, streamEvent.delta);
						this.thinkingPreviews.set(key, previewState);
						const preview = thinkingPreviewText(previewState);
						// Skip the write when the visible tail is unchanged so the
						// ChatView render cache stays valid between flushes.
						if (thinking.preview !== preview) thinking.preview = preview;
					}
				} else if (streamEvent.type === "thinking_end") {
					flushStreaming(agent);
					const thinking = agent.timeline.find(
						(entry) => entry.type === "thinking-status" && entry.id === `${item.id}:thinking`,
					);
					if (thinking?.type === "thinking-status") {
						thinking.status = "completed";
					}
					this.thinkingPreviews.delete(thinkingPreviewKey(agent.agentId, item.id));
				} else if (
					streamEvent.type === "toolcall_start" ||
					streamEvent.type === "toolcall_delta" ||
					streamEvent.type === "toolcall_end"
				) {
					// The provider-facing tool id and name may arrive after
					// toolcall_start. Keep a stream-position identity until the
					// execution event supplies the stable call id.
					const content = event.message.content[streamEvent.contentIndex];
					if (content?.type === "toolCall") {
						upsertPreparingTool(agent, item.id, streamEvent.contentIndex, content);
					}
				}
				return;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					flushStreaming(agent);
					const item = findAssistant(agent, agent.currentAssistantId);
					if (item) {
						item.text = assistantText(event.message);
						item.message = event.message;
						item.streaming = false;
						this.thinkingPreviews.delete(thinkingPreviewKey(agent.agentId, item.id));
					}
					const usage = event.message.usage;
					if (usage) {
						agent.display.contextTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					}
					agent.currentAssistantId = undefined;
				}
				return;
			case "tool_execution_start":
				flushStreaming(agent);
				startToolExecution(agent, event.toolCallId, event.toolName, event.args);
				agent.runToolCount++;
				this.markBackgroundActivity(agent.agentId);
				return;
			case "tool_execution_update": {
				if (!findTool(agent, event.toolCallId)) return;
				if (!agent.pendingToolUpdates) agent.pendingToolUpdates = new Map();
				agent.pendingToolUpdates.set(event.toolCallId, { args: event.args, partialResult: event.partialResult });
				return;
			}
			case "tool_execution_end": {
				agent.pendingToolUpdates?.delete(event.toolCallId);
				let tool = findTool(agent, event.toolCallId);
				if (!tool) {
					tool = {
						type: "tool-execution",
						id: event.toolCallId,
						toolCallId: event.toolCallId,
						durability: "durable",
						createdAt: now(),
						toolName: event.toolName,
						status: "running",
					};
				}
				tool.toolName = event.toolName;
				tool.result = event.result;
				tool.isError = event.isError;
				tool.status = "completed";
				tool.endedAt = now();
				upsertTimeline(agent, tool);
				// Experience indicator: the agent is still running and now waits
				// for the next assistant message; show thinking through that gap.
				if (agent.status === "running") upsertAwaitingThinking(agent);
				// An active agent's tool failure stays an inline tool error; only
				// background agents get a transient warning in the strip.
				if (event.isError) {
					this.markBackgroundActivity(agent.agentId, false, "warning");
					agent.runToolErrorStreak++;
					// One failed call is a tool result; a run that keeps failing is the
					// agent going nowhere, and that is worth saying out loud once.
					if (agent.runToolErrorStreak === TOOL_ERROR_STREAK_QUIP) {
						setTransientQuip(agent, "error");
					}
				} else {
					agent.runToolErrorStreak = 0;
				}
				return;
			}
			case "queue_update":
				agent.queue = {
					steer: event.steer.map(queuedMessageText).filter(nonEmpty),
					followUp: event.followUp.map(queuedMessageText).filter(nonEmpty),
					nextTurn: event.nextTurn.length,
				};
				return;
			case "model_update":
				agent.display.model = event.model;
				return;
			case "thinking_level_update":
				agent.display.thinkingLevel = event.level;
				return;
			case "tools_update":
				agent.display.activeToolNames = [...event.activeToolNames];
				return;
			case "session_tree":
			case "session_compact":
				agent.display.rehydrateRequested = true;
				return;
			default:
				return;
		}
	}

	private applyMessageStart(agent: AgentViewState, message: AgentMessage): void {
		if (message.role === "toolResult") return;
		const id = `live-message:${agent.agentId}:${agent.nextLiveItemId++}`;
		// Everything the runtime put into context on someone else's behalf. It
		// opens a turn exactly as a user message does - the model is reading it
		// either way - so the window housekeeping is the same.
		if (message.role === "custom") {
			const item = toLiveOrchestratorMessage(id, message);
			if (!item) return;
			upsertTimeline(agent, item);
			if (agent.status === "running") upsertAwaitingThinking(agent);
			applyTimelineWindow(agent);
			this.markBackgroundActivity(agent.agentId);
			return;
		}
		if (message.role === "user") {
			const modelText = userText(message);
			const text = agent.pendingInput?.originalText ?? modelText;
			agent.pendingInput = undefined;
			upsertTimeline(agent, {
				type: "user-message",
				id,
				durability: "durable",
				createdAt: messageTimestamp(message),
				text,
				modelText: text === modelText ? undefined : modelText,
			});
			// The running status precedes the harness's user message. Reappend
			// the gap indicator here so it follows the prompt in transcript order.
			if (agent.status === "running") upsertAwaitingThinking(agent);
			// A new user message opens a turn; this is the only live-event path
			// where the turn count can grow.
			applyTimelineWindow(agent);
		} else if (message.role === "assistant") {
			// The real stream is starting; the gap-filling indicator yields.
			completeAwaitingThinking(agent);
			agent.currentAssistantId = id;
			upsertTimeline(agent, {
				type: "assistant-message",
				id,
				durability: "durable",
				createdAt: messageTimestamp(message),
				text: assistantText(message),
				streaming: true,
				message,
			});
		}
		this.markBackgroundActivity(agent.agentId);
	}

	private applyDiagnostic(diagnostic: OrchestratorDiagnostic, createdAt: string): void {
		// The only funnel every diagnostic passes through, whether it came from
		// core as an event or from the application's own config loading.
		this.state.diagnostics.record(diagnostic, createdAt);
		if (!diagnostic.agentId) {
			const id = diagnosticKey(diagnostic);
			if (!this.state.globalNotices.some((notice) => notice.id === id)) {
				this.state.globalNotices.push({ id, kind: "diagnostic", createdAt, text: diagnostic.message, diagnostic });
			}
			return;
		}
		const agent = ensureAgentProjection(this.state, diagnostic.agentId);
		upsertTimeline(agent, {
			type: "diagnostic",
			id: diagnosticKey(diagnostic),
			durability: "ephemeral",
			createdAt,
			diagnostic,
		});
		raiseDiagnosticAttention(agent, diagnostic);
		this.markBackgroundActivity(diagnostic.agentId);
	}

	private resolveHumanRequest(
		agentId: AgentId | undefined,
		requestId: string,
		response: HumanResponse,
		completedAt: string,
	): void {
		const pending = this.state.humanRequests.find((item) => item.request.id === requestId);
		this.removeHumanRequest(requestId, agentId);
		const resolvedAgentId = agentId ?? pending?.agentId;
		if (!pending || !resolvedAgentId) return;
		const answer = summarizeHumanResponse(pending.request, response);
		const agent = ensureAgentProjection(this.state, resolvedAgentId);
		upsertTimeline(agent, {
			type: "human-request-trace",
			id: requestId,
			requestId,
			requestKind: pending.request.kind,
			title: pending.request.title,
			options:
				pending.request.kind === "select" || pending.request.kind === "multi-select"
					? normalizeHumanRequestOptions(pending.request.options).map((option) => option.label)
					: undefined,
			answer,
			durability: "ephemeral",
			createdAt: completedAt,
		});
		this.markBackgroundActivity(resolvedAgentId);
	}

	private removeHumanRequest(requestId: string, agentId?: AgentId): void {
		this.state.humanRequests = this.state.humanRequests.filter((item) => item.request.id !== requestId);
		if (agentId) {
			const agent = ensureAgentProjection(this.state, agentId);
			if (agent.attention === "human-request" && !this.state.humanRequests.some((item) => item.agentId === agentId)) {
				agent.attention = retainedAttention(this.state, agent);
			}
		}
	}

	private markBackgroundActivity(agentId: AgentId, incrementUnread = true, attention?: AgentAttention): void {
		if (this.state.activeAgentId === agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (incrementUnread) agent.unreadCount++;
		if (attention) raiseAttention(agent, attention);
	}
}

export function applyAgentSnapshot(state: TuiApplicationState, snapshot: AgentSnapshot): AgentViewState {
	const agent = ensureAgentProjection(state, snapshot.agentId, snapshot.activity.activity);
	agent.snapshot = snapshot;
	agent.status = snapshot.activity.activity;
	agent.maintenance = snapshot.activity.maintenance;
	agent.display.cwd = snapshot.cwd;
	agent.display.model = snapshot.model;
	if (snapshot.spawnedBy !== undefined) agent.spawnedBy = snapshot.spawnedBy;
	agent.display.activeToolNames = [...snapshot.tools.activeToolNames];
	for (const diagnostic of snapshot.diagnostics) {
		raiseDiagnosticAttention(agent, diagnostic);
	}
	return agent;
}

function eventAgentId(event: OrchestratorEvent): AgentId | undefined {
	if ("agentId" in event && typeof event.agentId === "string") {
		return event.agentId;
	}
	if (event.type === "diagnostic") return event.diagnostic.agentId;
	return undefined;
}

function upsertTimeline(agent: AgentViewState, item: TimelineItem): void {
	const index = agent.timeline.findIndex((existing) => existing.type === item.type && existing.id === item.id);
	if (index === -1) agent.timeline.push(item);
	else agent.timeline[index] = item;
}

/**
 * Experience indicator covering gaps with no streamed content: the model's
 * first-token latency after submit and the wait between tool executions.
 * Distinct from the streaming `${item.id}:thinking` entry, it carries no
 * preview. Each gap is appended at the current timeline position and removed
 * when real streamed content takes over.
 */
function upsertAwaitingThinking(agent: AgentViewState): void {
	completeAwaitingThinking(agent);
	agent.timeline.push({
		type: "thinking-status",
		id: `${awaitingThinkingPrefix(agent.agentId)}${agent.nextLiveItemId++}`,
		durability: "ephemeral",
		createdAt: now(),
		status: "thinking",
		label: agent.maintenance ? `${maintenanceLabel(agent.maintenance)}…` : undefined,
	});
}

function completeAwaitingThinking(agent: AgentViewState): void {
	const prefix = awaitingThinkingPrefix(agent.agentId);
	for (let index = agent.timeline.length - 1; index >= 0; index--) {
		const item = agent.timeline[index];
		if (item?.type === "thinking-status" && item.id.startsWith(prefix)) {
			agent.timeline.splice(index, 1);
		}
	}
}

function awaitingThinkingPrefix(agentId: AgentId): string {
	return `awaiting:${agentId}:`;
}

function upsertPreparingTool(
	agent: AgentViewState,
	sourceAssistantId: string,
	contentIndex: number,
	content: ToolCall,
): void {
	const id = preparingToolId(sourceAssistantId, contentIndex);
	const index = agent.timeline.findIndex((item) => item.type === "tool-execution" && item.id === id);
	const existing = index === -1 ? undefined : agent.timeline[index];
	const previous = existing?.type === "tool-execution" ? existing : undefined;
	const item = {
		type: "tool-execution",
		id,
		toolCallId: content.id || previous?.toolCallId || id,
		durability: "durable",
		createdAt: previous?.createdAt ?? now(),
		sourceAssistantId,
		toolName: content.name || previous?.toolName || "tool",
		args: content.arguments,
		...(previous?.expanded !== undefined ? { expanded: previous.expanded } : {}),
		status: "preparing",
	} satisfies ToolExecutionItem;
	if (index === -1) agent.timeline.push(item);
	else agent.timeline[index] = item;
}

function preparingToolId(sourceAssistantId: string, contentIndex: number): string {
	return `preparing-tool:${sourceAssistantId}:${contentIndex}`;
}

function startToolExecution(agent: AgentViewState, toolCallId: string, toolName: string, args: unknown): void {
	const preparing =
		findPreparingTool(agent, (item) => item.toolCallId === toolCallId) ??
		findPreparingTool(agent, (item) => item.toolName === toolName) ??
		findPreparingTool(agent);
	const existing = preparing ?? findTool(agent, toolCallId);
	if (existing) {
		const index = agent.timeline.indexOf(existing);
		agent.timeline[index] = {
			...existing,
			toolCallId,
			toolName,
			args,
			// The preparing placeholder was created while the call was still being
			// streamed; the run starts here, not there.
			startedAt: now(),
			status: "running",
		} satisfies ToolExecutionItem;
		return;
	}
	upsertTimeline(agent, {
		type: "tool-execution",
		id: toolCallId,
		toolCallId,
		durability: "durable",
		createdAt: now(),
		startedAt: now(),
		toolName,
		args,
		status: "running",
	});
}

function findPreparingTool(
	agent: AgentViewState,
	matches: (item: ToolExecutionItem) => boolean = () => true,
): ToolExecutionItem | undefined {
	return agent.timeline.find(
		(item): item is ToolExecutionItem => item.type === "tool-execution" && item.status === "preparing" && matches(item),
	);
}

function appendThinkingPreview(state: ThinkingPreviewState, delta: string): void {
	const segments = delta.replace(/\r\n?/g, "\n").split("\n");
	state.currentLine = appendThinkingLineTail(state.currentLine, segments[0] ?? "");
	for (let index = 1; index < segments.length; index++) {
		commitThinkingLine(state);
		state.currentLine = appendThinkingLineTail("", segments[index] ?? "");
	}
}

function commitThinkingLine(state: ThinkingPreviewState): void {
	if (state.currentLine.trim() === "") return;
	state.completedLines.push(state.currentLine);
	if (state.completedLines.length > 2) state.completedLines.shift();
}

function appendThinkingLineTail(current: string, delta: string): string {
	const characters = [...current, ...delta];
	return characters.length <= THINKING_PREVIEW_LINE_CHARACTERS
		? characters.join("")
		: characters.slice(-THINKING_PREVIEW_LINE_CHARACTERS).join("");
}

function thinkingPreviewText(state: ThinkingPreviewState): string | undefined {
	const lines = [...state.completedLines];
	if (state.currentLine.trim() !== "") lines.push(state.currentLine);
	return lines.length === 0 ? undefined : lines.slice(-2).join("\n");
}

function mergeTimeline(base: readonly TimelineItem[], existing: readonly TimelineItem[]): TimelineItem[] {
	const merged = [...base];
	for (const item of existing) {
		const index = merged.findIndex((candidate) => candidate.type === item.type && candidate.id === item.id);
		if (index === -1) merged.push(item);
		else merged[index] = item;
	}
	return merged;
}

function findAssistant(agent: AgentViewState, id?: string) {
	if (!id) return undefined;
	const item = agent.timeline.find((entry) => entry.type === "assistant-message" && entry.id === id);
	return item?.type === "assistant-message" ? item : undefined;
}

function findTool(agent: AgentViewState, toolCallId: string) {
	const item = agent.timeline.find((entry) => entry.type === "tool-execution" && entry.toolCallId === toolCallId);
	return item?.type === "tool-execution" ? item : undefined;
}

function raiseAttention(agent: AgentViewState, attention: AgentAttention): void {
	if (ATTENTION_PRIORITY[attention] > ATTENTION_PRIORITY[agent.attention]) {
		agent.attention = attention;
	}
}

function raiseDiagnosticAttention(agent: AgentViewState, diagnostic: OrchestratorDiagnostic): void {
	if (diagnostic.severity === "error") raiseAttention(agent, "error");
	else if (diagnostic.severity === "warning") raiseAttention(agent, "warning");
}

function summarizeHumanResponse(
	request: {
		kind: HumanRequestKind;
		options?: readonly (string | HumanRequestOption)[];
		questions?: readonly HumanQuestion[];
	},
	response: HumanResponse,
):
	| { kind: "confirm"; confirmed: boolean }
	| { kind: "selected-option"; value: string }
	| { kind: "selected-options"; values: string[] }
	| { kind: "answered-questions"; items: { title: string; values: string[] }[] }
	| { kind: "answered" } {
	if (request.kind === "confirm" && response.kind === "confirm") {
		return { kind: "confirm", confirmed: response.confirmed };
	}
	if (request.kind === "questions" && response.kind === "questions") {
		const questions = request.questions ?? [];
		const items = response.answers.map((answer, index) => {
			const question = questions[index];
			const options = normalizeHumanRequestOptions(question?.options);
			const values =
				answer.kind === "multi-select" ? (answer.values ?? []) : answer.value !== undefined ? [answer.value] : [];
			return {
				title: question?.title ?? `Question ${index + 1}`,
				values: values
					.map((value) => options.find((option) => option.value === value)?.label ?? value)
					.filter((label) => label.length > 0),
			};
		});
		return { kind: "answered-questions", items };
	}
	const options = normalizeHumanRequestOptions(request.options);
	if (request.kind === "select" && response.kind === "select" && response.value !== undefined) {
		const match = options.find((option) => option.value === response.value);
		if (match) return { kind: "selected-option", value: match.label };
	}
	if (request.kind === "multi-select" && response.kind === "multi-select" && response.values !== undefined) {
		// Only options the request itself offered may appear in the transcript;
		// free-form or unknown values are dropped to a generic "answered".
		const labels = response.values
			.map((value) => options.find((option) => option.value === value)?.label)
			.filter((label): label is string => label !== undefined);
		if (labels.length > 0) return { kind: "selected-options", values: labels };
	}
	return { kind: "answered" };
}

function queuedMessageText(message: AgentMessage): string {
	if (message.role === "user") return userText(message);
	if (message.role === "assistant") return assistantText(message);
	// Queued input the runtime wrote. The queue preview is what is waiting to be
	// read, so it shows the body a person would recognize, not the rendered form
	// carrying the attribution prefix.
	if (message.role === "custom") {
		const details = message.details;
		if (isMessageEntryDetails(details)) return details.body;
		return customMessageText(message.content);
	}
	return "";
}

/**
 * One live orchestrator message, or undefined when the entry carries no record
 * of who wrote it - the same rule the hydrator applies, for the same reason.
 */
function toLiveOrchestratorMessage(id: string, message: CustomMessage): OrchestratorMessageItem | undefined {
	if (message.customType !== ORCHESTRATOR_MESSAGE_CUSTOM_TYPE) return undefined;
	if (!isMessageEntryDetails(message.details)) return undefined;
	const modelText = customMessageText(message.content);
	return {
		type: "orchestrator-message",
		id,
		durability: "durable",
		createdAt: messageTimestamp(message),
		source: message.details.source,
		text: message.details.body,
		...(message.details.body === modelText ? undefined : { modelText }),
		...(message.details.editedByHuman ? { editedByHuman: true as const } : undefined),
	};
}

function isMessageEntryDetails(details: unknown): details is MessageEntryDetails {
	if (typeof details !== "object" || details === null) return false;
	const record = details as { body?: unknown; source?: unknown };
	if (typeof record.body !== "string") return false;
	const source = record.source;
	return typeof source === "object" && source !== null && typeof (source as { kind?: unknown }).kind === "string";
}

function customMessageText(content: CustomMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function nonEmpty(text: string): boolean {
	return text.length > 0;
}

function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n\n");
}

function messageTimestamp(message: { timestamp?: number }): string {
	return new Date(message.timestamp ?? Date.now()).toISOString();
}

function now(): string {
	return new Date().toISOString();
}
