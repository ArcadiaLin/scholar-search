import {
	type AssistantMessage,
	contentText,
	type ImageContent,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	type TextContent,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { runAgentLoop } from "../agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessQueuedMessageCounts,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessSystemPrompt,
	AgentHarnessTool,
	AgentHarnessToolContextSource,
	CompactResult,
	NavigateTreeResult,
	PendingSessionWrite,
	Session,
} from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

/**
 * WIDI fork: the four input entry points take a message, not only text.
 *
 * A caller that hands over a plain string still gets the user message it always
 * got. One that builds its own message keeps whatever role and type it chose,
 * which is how an input can record who wrote it and still reach the model as
 * ordinary user text.
 */
function toInputMessage(input: string | AgentMessage, images?: ImageContent[]): AgentMessage {
	return typeof input === "string" ? createUserMessage(input, images) : input;
}

/** The text an input hook sees, whichever form the caller used. */
function toInputText(input: string | AgentMessage): string {
	if (typeof input === "string") return input;
	const content = (input as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent => (part as { type?: unknown }).type === "text")
		.map((part) => part.text)
		.join("");
}

function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

const SUBSCRIBER_EVENT_TYPE = "*";

/**
 * Write kinds an embedder addresses by entry id afterwards, and therefore the
 * ones `session_write` reports. Model, thinking level and active tool changes
 * are excluded on purpose: each already has a dedicated update event.
 */
const ADDRESSABLE_SESSION_WRITE_TYPES: ReadonlySet<PendingSessionWrite["type"]> = new Set([
	"message",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

type TrackedTaskKind = "operation" | "mutation";

function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

interface AgentHarnessTurnState<
	TContext extends object | undefined,
	TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> {
	messages: AgentMessage[];
	toolContext: TContext;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export class AgentHarness<
	TContext extends object | undefined = undefined,
	TTool extends AgentHarnessTool<TContext> = AgentHarnessTool<TContext>,
> {
	private session: Session;
	readonly models: Models;
	private phase: AgentHarnessPhase = "idle";
	private activeAbortController?: AbortController;
	private readonly activeTasks = new Map<Promise<void>, TrackedTaskKind>();
	private shutdownPromise?: Promise<void>;
	private isShutdown = false;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private sessionWriteTail: Promise<void> = Promise.resolve();
	private sessionWriteNotifications: Array<{ entryId: string; write: PendingSessionWrite }> = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessSystemPrompt<TContext, TTool> | undefined;
	private toolContext: AgentHarnessToolContextSource<TContext> | undefined;
	private streamOptions: AgentHarnessStreamOptions;
	private retry: RetryPolicy | undefined;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private steerQueue: AgentMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: AgentMessage[] = [];
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();

	constructor(options: AgentHarnessOptions<TContext, TTool>) {
		this.session = options.session;
		this.models = options.models;
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.retry = options.retry;
		this.systemPrompt = options.systemPrompt;
		this.toolContext = options.toolContext;
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private assertNotShutDown(): void {
		if (this.isShutdown) throw new AgentHarnessError("shutdown", "AgentHarness has been shut down");
	}

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	private async emitOwn(event: AgentHarnessOwnEvent, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitAny(event: AgentHarnessEvent, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	private retryCallbacks(operation: "compaction" | "branch_summary"): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) =>
				this.emitOwn({ type: "retry_scheduled", operation, attempt, maxAttempts, delayMs, errorMessage }),
			onRetryAttemptStart: () => this.emitOwn({ type: "retry_attempt_start", operation }),
			onRetryFinished: () => this.emitOwn({ type: "retry_finished", operation }),
		};
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	/**
	 * Assign synchronously, then announce. A no-op transition emits nothing: a
	 * failure path back to `idle` can run after the operation's tail cleared it.
	 */
	private async setPhase(phase: AgentHarnessPhase): Promise<void> {
		const previousPhase = this.phase;
		if (previousPhase === phase) return;
		this.phase = phase;
		await this.emitOwn({ type: "phase_change", phase, previousPhase });
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	private startOperation(): { signal: AbortSignal; finish: () => void } {
		const abortController = new AbortController();
		let finish = () => {};
		this.activeAbortController = abortController;
		void this.track(
			"operation",
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		return {
			signal: abortController.signal,
			finish: () => {
				this.activeAbortController = undefined;
				finish();
			},
		};
	}

	private async track<T>(kind: TrackedTaskKind, operation: () => Promise<T>): Promise<T> {
		let settle = () => {};
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.activeTasks.set(settled, kind);
		try {
			return await operation();
		} finally {
			this.activeTasks.delete(settled);
			settle();
		}
	}

	/**
	 * Take the session away from concurrent writers.
	 *
	 * The phase is already set by the caller, so every write arriving from here on
	 * buffers instead of touching the branch. What remains is the writes that read
	 * `idle` before that and are still in flight: this waits for them, so the
	 * operation's first read of the session sees a settled branch and its own
	 * appends cannot be parented to an entry a mutation is about to replace.
	 */
	private async settleSessionOwnership(): Promise<void> {
		await this.waitForTasks("mutation");
	}

	private async waitForTasks(kind?: TrackedTaskKind): Promise<void> {
		while (true) {
			const tasks = [...this.activeTasks].flatMap(([task, taskKind]) =>
				kind === undefined || kind === taskKind ? [task] : [],
			);
			if (tasks.length === 0) return;
			await Promise.all(tasks);
		}
	}

	private async resolveToolContext(): Promise<TContext> {
		if (typeof this.toolContext === "function") {
			return await (this.toolContext as () => TContext | Promise<TContext>)();
		}
		return this.toolContext as TContext;
	}

	private bindToolContext(tool: TTool, context: TContext): AgentTool {
		return {
			...tool,
			execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, context),
		};
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TContext, TTool>> {
		this.assertNotShutDown();
		const context = await this.session.buildContext();
		const sessionMetadata = await this.session.getMetadata();
		const toolContext = await this.resolveToolContext();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
			});
		}
		return {
			messages: context.messages,
			toolContext,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	private createContext(turnState: AgentHarnessTurnState<TContext, TTool>, systemPrompt?: string): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.map((tool) => this.bindToolContext(tool, turnState.toolContext)),
		};
	}

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TContext, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			return this.models.streamSimple(model, context, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
			});
		};
	}

	private async drainQueuedMessages(queue: AgentMessage[], mode: QueueMode): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TContext, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TContext, TTool>) => void,
	): AgentLoopConfig {
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm,
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
					usage: result.usage,
				});
				return patch
					? {
							content: patch.content,
							details: patch.details,
							isError: patch.isError,
							usage: patch.usage,
							terminate: patch.terminate,
						}
					: undefined;
			},
			prepareNextTurn: async () => {
				await this.flushPendingSessionWrites();
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState),
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode),
		};
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	/** Perform one session write. Returns the entry id, or undefined for a leaf move. */
	private async applySessionWrite(write: PendingSessionWrite): Promise<string | undefined> {
		if (write.type === "message") {
			return await this.session.appendMessage(write.message);
		} else if (write.type === "model_change") {
			return await this.session.appendModelChange(write.provider, write.modelId);
		} else if (write.type === "thinking_level_change") {
			return await this.session.appendThinkingLevelChange(write.thinkingLevel);
		} else if (write.type === "active_tools_change") {
			return await this.session.appendActiveToolsChange(write.activeToolNames);
		} else if (write.type === "custom") {
			return await this.session.appendCustomEntry(write.customType, write.data);
		} else if (write.type === "custom_message") {
			return await this.session.appendCustomMessageEntry(
				write.customType,
				write.content,
				write.display,
				write.details,
			);
		} else if (write.type === "label") {
			return await this.session.appendLabel(write.targetId, write.label);
		} else if (write.type === "session_info") {
			return await this.session.appendSessionName(write.name ?? "");
		} else if (write.type === "leaf") {
			await this.session.moveTo(write.targetId);
			return undefined;
		}
		return undefined;
	}

	/**
	 * Serialize one session write behind every write already queued.
	 *
	 * Appending reads the current leaf and then writes a child of it, so two
	 * writes that interleave across that await both parent themselves to the same
	 * entry and one of them falls off the branch. The tail is what makes the
	 * harness a single writer in fact and not just by convention; a failed write
	 * does not poison it, because the next write is a new decision.
	 */
	private enqueueSessionWrite(write: PendingSessionWrite): Promise<string | undefined> {
		const result = this.sessionWriteTail.then(() => this.writeOrBufferSessionEntry(write));
		this.sessionWriteTail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/**
	 * Write now if nothing owns the session, otherwise buffer until the next save
	 * point. The id is only knowable in the first case; a buffered write reports
	 * its id through `session_write` when it is flushed.
	 */
	private async writeOrBufferSessionEntry(write: PendingSessionWrite): Promise<string | undefined> {
		if (this.phase !== "idle") {
			this.pendingSessionWrites.push(write);
			return undefined;
		}
		const entryId = await this.applySessionWrite(write);
		if (entryId !== undefined) this.recordSessionWrite(entryId, write);
		await this.drainSessionWriteNotifications();
		return entryId;
	}

	private recordSessionWrite(entryId: string, write: PendingSessionWrite): void {
		if (!ADDRESSABLE_SESSION_WRITE_TYPES.has(write.type)) return;
		this.sessionWriteNotifications.push({ entryId, write });
	}

	/**
	 * Announce durable entries, oldest first, keeping anything not yet announced.
	 *
	 * An entry id exists only inside the harness until it is emitted, so a write
	 * that lands and then fails to be reported - because a later write in the same
	 * flush threw, or because an observer did - would take its id with it. The
	 * queue outlives the call that filled it, so the next write or flush retries.
	 */
	private async drainSessionWriteNotifications(): Promise<void> {
		while (this.sessionWriteNotifications.length > 0) {
			const notification = this.sessionWriteNotifications[0]!;
			await this.emitOwn({ type: "session_write", entryId: notification.entryId, write: notification.write });
			this.sessionWriteNotifications.shift();
		}
	}

	private async flushPendingSessionWrites(): Promise<void> {
		let writeError: unknown;
		try {
			while (this.pendingSessionWrites.length > 0) {
				const write = this.pendingSessionWrites[0]!;
				const entryId = await this.applySessionWrite(write);
				this.pendingSessionWrites.shift();
				if (entryId !== undefined) this.recordSessionWrite(entryId, write);
			}
		} catch (error) {
			writeError = error;
		}
		// Reported only once every buffered write is durable: a failing observer
		// must not leave the rest of the buffer unflushed. A failed write still
		// reports what landed before it, and keeps the rest queued for retry.
		try {
			await this.drainSessionWriteNotifications();
		} catch (error) {
			if (writeError === undefined) throw error;
		}
		if (writeError !== undefined) throw writeError;
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		if (event.type === "message_end") {
			const entryId = await this.session.appendMessage(event.message);
			this.recordSessionWrite(entryId, { type: "message", message: event.message });
			await this.drainSessionWriteNotifications();
			await this.emitAny(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			await this.setPhase("idle");
			await this.emitAny(event, signal);
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TContext, TTool>,
		input: string | AgentMessage,
		signal: AbortSignal,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		this.assertNotShutDown();
		let activeTurnState = turnState;
		let messages: AgentMessage[] = [toInputMessage(input, options?.images)];
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
			messages = [...queuedMessages, messages[0]!];
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: toInputText(input),
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
		});
		this.assertNotShutDown();
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TContext, TTool>) => {
			activeTurnState = nextTurnState;
		};
		const runResultPromise = (async () => {
			try {
				return await runAgentLoop(
					messages,
					this.createContext(turnState, beforeResult?.systemPrompt),
					this.createLoopConfig(getTurnState, setTurnState),
					(event) => this.handleAgentEvent(event, signal),
					signal,
					this.createStreamFn(getTurnState),
				);
			} catch (error) {
				try {
					return await this.emitRunFailure(activeTurnState.model, error, signal.aborted, signal);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			await this.flushPendingSessionWrites();
		}
	}

	async prompt(input: string | AgentMessage, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		this.assertNotShutDown();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		// Registered before the phase is announced, so an observer that reacts by
		// aborting finds a controller to abort.
		const operation = this.startOperation();
		try {
			await this.setPhase("turn");
			await this.settleSessionOwnership();
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, input, operation.signal, options);
		} catch (error) {
			await this.setPhase("idle");
			throw normalizeHarnessError(error, "unknown");
		} finally {
			operation.finish();
		}
	}

	async steer(input: string | AgentMessage, options?: { images?: ImageContent[] }): Promise<void> {
		this.assertNotShutDown();
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.steerQueue.push(toInputMessage(input, options?.images));
		await this.emitQueueUpdate();
	}

	async followUp(input: string | AgentMessage, options?: { images?: ImageContent[] }): Promise<void> {
		this.assertNotShutDown();
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.followUpQueue.push(toInputMessage(input, options?.images));
		await this.emitQueueUpdate();
	}

	/**
	 * Move every queued follow-up to the end of the steering queue and return the
	 * messages that moved.
	 *
	 * A follow-up is only read where the agent would otherwise stop, so a user who
	 * queued one and then decides it cannot wait has no way to promote it: sending
	 * the same text as a steer would deliver it twice, and only the harness can
	 * take it back out. Moving the messages keeps them intact - text, images and
	 * order - and preserves "steering first" by appending after any steer already
	 * queued.
	 */
	async promoteFollowUpsToSteer(): Promise<AgentMessage[]> {
		this.assertNotShutDown();
		if (this.followUpQueue.length === 0) return [];
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		const promoted = this.followUpQueue.splice(0);
		this.steerQueue.push(...promoted);
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			// Queue observers are awaited, so the agent loop or another caller can
			// mutate the steering queue before a failing observer returns. Roll
			// back by message identity: leave newer steers alone, and do not
			// resurrect promoted messages the loop already consumed or abort
			// already cleared.
			const promotedSet = new Set(promoted);
			const stillQueued = new Set(this.steerQueue.filter((message) => promotedSet.has(message)));
			this.steerQueue = this.steerQueue.filter((message) => !stillQueued.has(message));
			this.followUpQueue.unshift(...promoted.filter((message) => stillQueued.has(message)));
			throw normalizeHookError(error);
		}
		return promoted;
	}

	async nextTurn(input: string | AgentMessage, options?: { images?: ImageContent[] }): Promise<void> {
		this.assertNotShutDown();
		this.nextTurnQueue.push(toInputMessage(input, options?.images));
		await this.emitQueueUpdate();
	}

	/**
	 * Append a message to the session branch.
	 *
	 * Resolves to the entry id when the harness was idle and the write went
	 * straight through, and to undefined when it was buffered behind a running
	 * operation - the id does not exist until the next save point, and arrives
	 * then as a `session_write` event.
	 */
	async appendMessage(message: AgentMessage): Promise<string | undefined> {
		return await this.writeSessionEntry({ type: "message", message });
	}

	/**
	 * Append an application-defined entry to the session branch.
	 *
	 * The four methods below exist because the harness owns the branch while an
	 * operation is running: it buffers its own writes so a turn's messages stay
	 * contiguous, and an application writing to the same session directly would
	 * land between them and take the leaf with it. Routing through the harness
	 * makes it the single writer, at the cost of not knowing the id up front.
	 */
	async appendCustomEntry(customType: string, data?: unknown): Promise<string | undefined> {
		return await this.writeSessionEntry({ type: "custom", customType, data });
	}

	async appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
	): Promise<string | undefined> {
		return await this.writeSessionEntry({ type: "custom_message", customType, content, display, details });
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string | undefined> {
		return await this.writeSessionEntry({ type: "label", targetId, label });
	}

	async setSessionName(name: string): Promise<string | undefined> {
		return await this.writeSessionEntry({ type: "session_info", name });
	}

	private async writeSessionEntry(write: PendingSessionWrite): Promise<string | undefined> {
		this.assertNotShutDown();
		return this.track("mutation", async () => {
			try {
				return await this.enqueueSessionWrite(write);
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		});
	}

	async compact(customInstructions?: string): Promise<CompactResult> {
		this.assertNotShutDown();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		const operation = this.startOperation();
		try {
			await this.setPhase("compaction");
			await this.settleSessionOwnership();
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const branchEntries = await this.session.getBranch();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions,
				signal: operation.signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(
						preparation,
						this.models,
						model,
						customInstructions,
						operation.signal,
						this.thinkingLevel,
						this.retry,
						this.retryCallbacks("compaction"),
					);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			this.assertNotShutDown();
			const entryId = await this.session.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				provided !== undefined,
				result.usage,
				result.retainedTail,
			);
			const entry = await this.session.getEntry(entryId);
			if (entry?.type === "compaction") {
				await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
			}
			return result;
		} catch (error) {
			throw normalizeHarnessError(error, "compaction");
		} finally {
			// Before the phase reopens, so a write that arrives during the flush
			// still buffers behind it rather than jumping the queue it is in.
			try {
				await this.flushPendingSessionWrites();
			} finally {
				operation.finish();
				await this.setPhase("idle");
			}
		}
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		this.assertNotShutDown();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		const operation = this.startOperation();
		try {
			await this.setPhase("branch_summary");
			await this.settleSessionOwnership();
			const oldLeafId = await this.session.getLeafId();
			if (oldLeafId === targetId) return { cancelled: false };
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			};
			const hookResult = await this.emitHook({
				type: "session_before_tree",
				preparation,
				signal: operation.signal,
			});
			if (hookResult?.cancel) return { cancelled: true };
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: unknown = hookResult?.summary?.details;
			let summaryUsage = hookResult?.summary?.usage;
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const branchSummary = await generateBranchSummary(entries, {
					models: this.models,
					model,
					signal: operation.signal,
					customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
					replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
					retry: this.retry,
					callbacks: this.retryCallbacks("branch_summary"),
				});
				if (!branchSummary.ok) {
					if (branchSummary.error.code === "aborted") return { cancelled: true };
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryUsage = branchSummary.value.usage;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			let editorText: string | undefined;
			let newLeafId: string | null;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				newLeafId = targetId;
			}
			this.assertNotShutDown();
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? {
							summary: summaryText,
							details: summaryDetails,
							usage: summaryUsage,
							fromHook: hookResult?.summary !== undefined,
						}
					: undefined,
			);
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromHook: hookResult?.summary !== undefined,
			});
			return { cancelled: false, editorText, summaryEntry };
		} catch (error) {
			throw normalizeHarnessError(error, "branch_summary");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				operation.finish();
				await this.setPhase("idle");
			}
		}
	}

	getModel(): Model<any> {
		return this.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		this.assertNotShutDown();
		return this.track("mutation", async () => {
			try {
				const previousModel = this.model;
				await this.enqueueSessionWrite({ type: "model_change", provider: model.provider, modelId: model.id });
				this.model = model;
				await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		});
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.assertNotShutDown();
		return this.track("mutation", async () => {
			try {
				const previousLevel = this.thinkingLevel;
				await this.enqueueSessionWrite({ type: "thinking_level_change", thinkingLevel: level });
				this.thinkingLevel = level;
				await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		});
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		this.assertNotShutDown();
		return this.track("mutation", () => this.applyTools(tools, activeToolNames));
	}

	private async applyTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			await this.enqueueSessionWrite({ type: "active_tools_change", activeToolNames: [...nextActiveToolNames] });
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		this.assertNotShutDown();
		return this.track("mutation", () => this.applyActiveTools(toolNames));
	}

	private async applyActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			await this.enqueueSessionWrite({ type: "active_tools_change", activeToolNames: [...toolNames] });
			this.activeToolNames = [...toolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.assertNotShutDown();
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.assertNotShutDown();
		this.followUpQueueMode = mode;
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.assertNotShutDown();
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	/**
	 * Which operation currently owns the harness. Every phase transition happens
	 * synchronously, before the operation's first await, so a caller that reads this
	 * and then calls a method races only against other callers - never against the
	 * operation it just observed.
	 */
	getPhase(): AgentHarnessPhase {
		return this.phase;
	}

	/**
	 * How much handed-over text is still unread. The queues are private and otherwise
	 * reported only by `queue_update`, which forces observers to mirror the counts to
	 * answer "is anything pending" at an arbitrary moment.
	 */
	getQueuedMessageCounts(): AgentHarnessQueuedMessageCounts {
		return {
			steer: this.steerQueue.length,
			followUp: this.followUpQueue.length,
			nextTurn: this.nextTurnQueue.length,
		};
	}

	/**
	 * Permanently stop this harness instance without deleting its durable session.
	 * Clears queued work, aborts the active operation, and waits for it to settle.
	 *
	 * Subscribers are released only once everything has settled: the aborted
	 * operation still emits its tail - the failed message, `agent_end`, the final
	 * `queue_update` - and an observer that stopped receiving events at the first
	 * line of shutdown would be left believing the agent is still running.
	 */
	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.isShutdown = true;
		// Publish the promise before the state it describes becomes observable.
		// Aborting the active operation dispatches its signal listeners
		// synchronously, and anything those listeners call reads a harness that
		// already reports itself shut down; a reentrant abort() would await an
		// unassigned promise and settle before the shutdown it is meant to follow.
		let finished = () => {};
		this.shutdownPromise = new Promise<void>((resolve) => {
			finished = resolve;
		});
		this.pendingSessionWrites = [];
		this.steerQueue = [];
		this.followUpQueue = [];
		this.nextTurnQueue = [];
		this.activeAbortController?.abort();
		const release = () => {
			this.handlers.clear();
			finished();
		};
		void this.waitForTasks().then(release, release);
		return this.shutdownPromise;
	}

	async abort(): Promise<AbortResult> {
		// A shut-down harness has already cleared both queues and aborted its
		// operation, so there is nothing left to abort and nothing to report as
		// cleared. Teardown paths call both, and duplicate teardown is normal;
		// failing here would only force every caller to guard the second call.
		if (this.isShutdown) {
			await this.shutdownPromise;
			return { clearedSteer: [], clearedFollowUp: [] };
		}
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		this.activeAbortController?.abort();
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		await this.waitForTasks("operation");
	}

	subscribe(listener: (event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> | void): () => void {
		this.assertNotShutDown();
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		this.assertNotShutDown();
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}
}
