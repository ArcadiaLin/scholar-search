import type { SessionTreeEntry } from "@arcadialin/agent-core";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { type ExtensionMessage, validateExtensionMessage } from "../core/extension/api.ts";
import type { MessageEntryDetails } from "../core/message.ts";
import {
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	type ExtensionMessageEntryData,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	type InputTransformEntryData,
	ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
} from "../core/session-manager.ts";
import type {
	AssistantMessageItem,
	OrchestratorMessageItem,
	PersistentMessageItem,
	SessionMarkerItem,
	TimelineItem,
	ToolExecutionItem,
	UserMessageItem,
} from "./state.ts";

export interface HydratedDisplayFacts {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	activeToolNames?: readonly string[];
	sessionName?: string;
}

export interface HydrationResult {
	readonly timeline: TimelineItem[];
	readonly display: HydratedDisplayFacts;
}

export class SessionHydrator {
	hydrate(entries: readonly SessionTreeEntry[]): HydrationResult {
		return hydrateSessionEntries(entries);
	}
}

/**
 * Pure current-branch hydrator. Unknown/custom extension data is intentionally
 * ignored unless it uses a core-owned presentation entry type.
 */
export function hydrateSessionEntries(entries: readonly SessionTreeEntry[]): HydrationResult {
	const timeline: TimelineItem[] = [];
	const display: HydratedDisplayFacts = {};
	let pendingOriginalText: string | undefined;
	const tools = new Map<string, ToolExecutionItem>();

	for (const entry of entries) {
		switch (entry.type) {
			case "custom": {
				if (entry.customType === INPUT_TRANSFORM_CUSTOM_TYPE && isInputTransformData(entry.data)) {
					pendingOriginalText ??= entry.data.originalText;
				} else if (entry.customType === EXTENSION_MESSAGE_CUSTOM_TYPE) {
					const data = parseExtensionMessageData(entry.data);
					if (data) upsertTimeline(timeline, toExtensionMessage(entry, data));
				}
				break;
			}
			// A message the runtime wrote on someone else's behalf and woke the
			// agent with. Same entry type as a user message, different role.
			case "custom_message": {
				if (entry.customType !== ORCHESTRATOR_MESSAGE_CUSTOM_TYPE) break;
				const item = toOrchestratorMessage(entry.id, entry.timestamp, entry.content, entry.details);
				if (item) timeline.push(item);
				break;
			}
			case "message": {
				const message = entry.message;
				if (message.role === "custom") {
					if (message.customType !== ORCHESTRATOR_MESSAGE_CUSTOM_TYPE) break;
					const item = toOrchestratorMessage(entry.id, entry.timestamp, message.content, message.details);
					if (item) timeline.push(item);
					break;
				}
				if (message.role === "user") {
					const modelText = messageText(message);
					const text = pendingOriginalText ?? modelText;
					pendingOriginalText = undefined;
					timeline.push({
						type: "user-message",
						id: entry.id,
						durability: "durable",
						createdAt: entry.timestamp,
						text,
						modelText: text === modelText ? undefined : modelText,
					} satisfies UserMessageItem);
				} else if (message.role === "assistant") {
					timeline.push(toAssistantMessage(entry.id, entry.timestamp, message));
					for (const call of message.content.filter(isToolCall)) {
						const item: ToolExecutionItem = {
							type: "tool-execution",
							id: call.id,
							toolCallId: call.id,
							durability: "durable",
							createdAt: entry.timestamp,
							toolName: call.name,
							args: call.arguments,
							status: "running",
						};
						tools.set(call.id, item);
						upsertTimeline(timeline, item);
					}
				} else if (message.role === "toolResult") {
					applyToolResult(tools, timeline, entry.id, entry.timestamp, message);
				}
				break;
			}
			case "compaction":
				timeline.push({
					type: "session-marker",
					id: entry.id,
					durability: "durable",
					createdAt: entry.timestamp,
					marker: "compaction",
					summary: entry.summary,
				} satisfies SessionMarkerItem);
				break;
			case "branch_summary":
				timeline.push({
					type: "session-marker",
					id: entry.id,
					durability: "durable",
					createdAt: entry.timestamp,
					marker: "branch-summary",
					summary: entry.summary,
				} satisfies SessionMarkerItem);
				break;
			case "model_change":
				display.model = { provider: entry.provider, modelId: entry.modelId };
				break;
			case "thinking_level_change":
				display.thinkingLevel = entry.thinkingLevel;
				break;
			case "active_tools_change":
				display.activeToolNames = [...entry.activeToolNames];
				break;
			case "session_info":
				display.sessionName = entry.name;
				break;
			default:
				break;
		}
	}

	return { timeline, display };
}

function toAssistantMessage(id: string, createdAt: string, message: AssistantMessage): AssistantMessageItem {
	return {
		type: "assistant-message",
		id,
		durability: "durable",
		createdAt,
		text: assistantText(message),
		streaming: false,
		message,
	};
}

/**
 * One orchestrator message, from either entry form.
 *
 * `details` is what the producer recorded about itself and is the whole basis
 * for rendering, so an entry without it is dropped rather than shown as an
 * anonymous user message - claiming the person said it would be worse than
 * saying nothing.
 */
function toOrchestratorMessage(
	id: string,
	createdAt: string,
	content: string | readonly { type: string; text?: string }[],
	details: unknown,
): OrchestratorMessageItem | undefined {
	if (!isMessageEntryDetails(details)) return undefined;
	const modelText = contentText(content);
	return {
		type: "orchestrator-message",
		id,
		durability: "durable",
		createdAt,
		source: details.source,
		text: details.body,
		...(details.body === modelText ? undefined : { modelText }),
		...(details.editedByHuman ? { editedByHuman: true as const } : undefined),
	};
}

function isMessageEntryDetails(details: unknown): details is MessageEntryDetails {
	if (!isRecord(details) || typeof details.body !== "string") return false;
	const source = details.source;
	return isRecord(source) && typeof source.kind === "string";
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && part.text !== undefined)
		.map((part) => part.text)
		.join("");
}

function toExtensionMessage(
	entry: Extract<SessionTreeEntry, { type: "custom" }>,
	data: ExtensionMessageEntryData,
): PersistentMessageItem {
	return {
		type: "extension-message",
		id: entry.id,
		entryId: entry.id,
		extensionId: data.extensionId,
		message: data.message,
		durability: "durable",
		createdAt: entry.timestamp,
	};
}

function applyToolResult(
	tools: Map<string, ToolExecutionItem>,
	timeline: TimelineItem[],
	entryId: string,
	createdAt: string,
	message: ToolResultMessage,
): void {
	const existing = tools.get(message.toolCallId);
	if (existing) {
		existing.toolName = message.toolName;
		existing.result = message;
		existing.isError = message.isError;
		existing.status = "completed";
		return;
	}
	const item: ToolExecutionItem = {
		type: "tool-execution",
		id: message.toolCallId || entryId,
		toolCallId: message.toolCallId || entryId,
		durability: "durable",
		createdAt,
		toolName: message.toolName,
		result: message,
		isError: message.isError,
		status: "completed",
	};
	tools.set(item.toolCallId, item);
	timeline.push(item);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n\n");
}

function messageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function isToolCall(content: unknown): content is ToolCall {
	return typeof content === "object" && content !== null && "type" in content && content.type === "toolCall";
}

function isInputTransformData(data: unknown): data is InputTransformEntryData {
	return (
		isRecord(data) &&
		typeof data.inputId === "string" &&
		typeof data.originalText === "string" &&
		typeof data.text === "string" &&
		Array.isArray(data.transformedBy)
	);
}

/**
 * Read a persisted extension message back through the same validator that
 * admitted it: a bounded, detached value carrying a kind. What that kind means
 * is decided later, at render time, where a shape this build cannot draw
 * degrades to the frame's header instead of disappearing from the timeline.
 */
function parseExtensionMessageData(data: unknown): ExtensionMessageEntryData | undefined {
	if (!isRecord(data) || typeof data.extensionId !== "string") return undefined;
	try {
		return { extensionId: data.extensionId, message: validateExtensionMessage(data.message as ExtensionMessage) };
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function upsertTimeline(timeline: TimelineItem[], item: TimelineItem): void {
	const index = timeline.findIndex((existing) => existing.type === item.type && existing.id === item.id);
	if (index === -1) timeline.push(item);
	else timeline[index] = item;
}
