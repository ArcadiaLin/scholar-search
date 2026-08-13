import type {
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	BeforeAgentStartResult,
	BeforeProviderRequestResult,
	ContextResult,
	ToolCallResult,
	ToolResultPatch,
} from "@arcadialin/agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatError } from "../../utils/errors.ts";
import type { CoreDiagnostic } from "../diagnostics.ts";
import type { MessageDeliveryMode, MessageRequest } from "../message.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type { ExtensionEventEnvelope } from "./events.ts";
import type {
	ExtensionIdentity,
	ExtensionInterceptorRegistration,
	ExtensionProfileContribution,
	ExtensionProviderContribution,
	ExtensionToolContribution,
	LoadedExtensionScope,
} from "./loader.ts";
import type {
	ExtensionActionFailure,
	ExtensionActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionCoreActions,
	ExtensionDivisionSnapshot,
	ExtensionInputEvent,
	ExtensionInputResult,
	ExtensionInterceptorEventFor,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionObservedEvent,
	ExtensionObserver,
	ExtensionSendOptions,
	ExtensionSessionContext,
} from "./types.ts";

export interface ExtensionRunnerOptions {
	loadedScope: LoadedExtensionScope;
}

export interface ExtensionInterceptorRun<TName extends ExtensionInterceptorName> {
	result: ExtensionInterceptorResultFor<TName>;
	diagnostics: readonly CoreDiagnostic[];
}

// Input runs carry extension attribution so the orchestrator can publish
// input_transformed/input_blocked facts without re-deriving blame.
export type ExtensionInputInterceptRun = { diagnostics: readonly CoreDiagnostic[] } & (
	| { kind: "pass" }
	| {
			kind: "transform";
			text: string;
			images?: readonly ImageContent[];
			// Extensions that returned a rewrite, in application order.
			transformedBy: readonly string[];
	  }
	| {
			kind: "block";
			reason?: string;
			// The extension whose handler ended the pipeline - a deliberate
			// block, or a crash blocked fail-closed.
			blockedBy: string;
	  }
);

type ExtensionInterceptorHandlerRun<TName extends ExtensionInterceptorName> =
	| { ok: true; result: ExtensionInterceptorResultFor<TName> }
	| { ok: false; diagnostic: CoreDiagnostic };

export type ExtensionHookSnapshot =
	| { kind: "observe"; extensionId: string; eventName: ExtensionObservedEvent["type"]; divisionId?: string }
	| { kind: "intercept"; extensionId: string; eventName: ExtensionInterceptorName; divisionId?: string }
	| {
			kind: "event";
			extensionId: string;
			/** Extension event bus name this runtime subscribed to. */
			eventName: string;
			divisionId?: string;
	  };

export type ExtensionToolContributionSnapshot =
	| {
			kind: "define";
			extensionId: string;
			toolName: string;
			source: ExtensionToolContribution["source"];
			divisionId?: string;
	  }
	| {
			kind: "patch";
			extensionId: string;
			targetToolName: string;
			patchedFields: readonly string[];
			source: ExtensionToolContribution["source"];
			divisionId?: string;
	  };

// Provider contribution facts stay secret-free: model ids and an OAuth flag
// only - never the config value references (a literal apiKey is a secret).
export interface ExtensionProviderContributionSnapshot {
	readonly extensionId: string;
	readonly providerName: string;
	readonly modelIds: readonly string[];
	readonly oauth: boolean;
	readonly divisionId?: string;
}

// System prompt contribution facts carry no text: the appended section is
// prompt content, not an inspectable fact about the extension.
export interface ExtensionSystemPromptContributionSnapshot {
	readonly extensionId: string;
	readonly divisionId?: string;
}

export interface ExtensionRunnerSnapshot {
	extensionIds: readonly string[];
	extensions: readonly ExtensionIdentity[];
	hooks: readonly ExtensionHookSnapshot[];
	toolContributions: readonly ExtensionToolContributionSnapshot[];
	providerContributions: readonly ExtensionProviderContributionSnapshot[];
	systemPromptContributions: readonly ExtensionSystemPromptContributionSnapshot[];
	// Declared and used divisions with their resolved state; empty for an agent
	// whose extensions declare none.
	divisions: readonly ExtensionDivisionSnapshot[];
	stale: { readonly stale: boolean; readonly message?: string };
}

const patchInspectableFields = ["description", "parameters", "strict", "execute", "aroundExecute"] as const;

export class ExtensionRunner {
	readonly agentId: string;
	readonly profileId: string;
	readonly extensionIds: readonly string[];
	readonly extensions: readonly ExtensionIdentity[];
	readonly diagnostics: readonly CoreDiagnostic[];

	private _loadedScope: LoadedExtensionScope;
	private _actions: ExtensionCoreActions = createUnboundActions();
	private _contextActions: ExtensionContextActions = {};
	private _staleMessage: string | undefined;
	private _disposed = false;
	private _disposedSnapshot: ExtensionRunnerSnapshot | undefined;

	constructor(options: ExtensionRunnerOptions) {
		this._loadedScope = options.loadedScope;
		this.agentId = options.loadedScope.agentId;
		this.profileId = options.loadedScope.profileId;
		this.extensionIds = [...options.loadedScope.extensionIds];
		this.extensions = [...options.loadedScope.extensions];
		this.diagnostics = [...options.loadedScope.diagnostics];
	}

	bindCore(actions: ExtensionCoreActions, contextActions: ExtensionContextActions): void {
		this._actions = actions;
		this._contextActions = contextActions;
	}

	createContext(extensionId = this.extensionIds[0]): ExtensionContext {
		if (!extensionId) {
			throw new Error("Extension context requires an extension id; this runner has no loaded extensions.");
		}
		const runner = this;
		return {
			extensionId,
			agentId: this.agentId,
			profileId: this.profileId,
			actions: this._createContextActions(extensionId),
			session: this._createSessionContext(extensionId),
			get signal() {
				runner._assertActive();
				return runner._contextActions.getSignal?.();
			},
			isIdle: () => {
				this._assertActive();
				return this._contextActions.isIdle?.() ?? true;
			},
		};
	}

	getProviderContributions(): readonly ExtensionProviderContribution[] {
		return this._loadedScope.providerContributions;
	}

	getProfileContributions(): readonly ExtensionProfileContribution[] {
		return this._loadedScope.profileContributions;
	}

	/** The appended system prompt sections, in registration order. */
	getSystemPromptAppends(): readonly string[] {
		return this._loadedScope.systemPromptContributions.map((contribution) => contribution.text);
	}

	invalidate(message = "This extension context is stale after runtime replacement or reload."): void {
		this._staleMessage = message;
	}

	/**
	 * Invalidate plus extension teardown: runs every onDispose handler
	 * registered during activation (idempotent). Handler failures are
	 * aggregated and rethrown after all handlers ran, so one broken
	 * extension cannot skip the others' cleanup.
	 */
	async dispose(message = "This extension context is stale after runtime replacement or reload."): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		this.invalidate(message);
		const errors: unknown[] = [];
		for (const registration of this._loadedScope.disposeHandlers) {
			try {
				await registration.handler();
			} catch (error) {
				errors.push(error);
			}
		}
		this._disposedSnapshot = this.inspect();
		this._loadedScope = {
			agentId: this.agentId,
			profileId: this.profileId,
			extensionIds: this.extensionIds,
			extensions: this.extensions,
			diagnostics: this.diagnostics,
			toolContributions: [],
			providerContributions: [],
			profileContributions: [],
			systemPromptContributions: [],
			observerHandlers: new Map(),
			interceptorHandlers: new Map(),
			extensionEventHandlers: new Map(),
			disposeHandlers: [],
			// Plain data, no closures retained: keep it so the resolved division
			// state stays inspectable after disposal.
			divisions: this._loadedScope.divisions,
		};
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) {
			throw new AggregateError(errors, "Extension dispose handlers failed.");
		}
	}

	isStale(): boolean {
		return this._staleMessage !== undefined;
	}

	inspect(): ExtensionRunnerSnapshot {
		if (this._disposedSnapshot) return this._disposedSnapshot;
		const hooks: ExtensionHookSnapshot[] = [];
		for (const handlers of this._loadedScope.observerHandlers.values()) {
			for (const registration of handlers) {
				hooks.push({
					kind: "observe",
					extensionId: registration.extensionId,
					eventName: registration.eventName,
					divisionId: registration.divisionId,
				});
			}
		}
		for (const handlers of this._loadedScope.interceptorHandlers.values()) {
			for (const registration of handlers) {
				hooks.push({
					kind: "intercept",
					extensionId: registration.extensionId,
					eventName: registration.eventName,
					divisionId: registration.divisionId,
				});
			}
		}
		for (const handlers of this._loadedScope.extensionEventHandlers.values()) {
			for (const registration of handlers) {
				hooks.push({
					kind: "event",
					extensionId: registration.extensionId,
					eventName: registration.eventName,
					divisionId: registration.divisionId,
				});
			}
		}

		return {
			extensionIds: [...this.extensionIds],
			extensions: [...this.extensions],
			hooks,
			toolContributions: this._loadedScope.toolContributions.map((contribution) => {
				if (contribution.kind === "define") {
					return {
						kind: "define",
						extensionId: contribution.extensionId,
						toolName: contribution.definition.name,
						source: contribution.source,
						divisionId: contribution.divisionId,
					};
				}
				return {
					kind: "patch",
					extensionId: contribution.extensionId,
					targetToolName: contribution.targetToolName,
					patchedFields: patchInspectableFields.filter((field) => Object.hasOwn(contribution.patch, field)),
					source: contribution.source,
					divisionId: contribution.divisionId,
				};
			}),
			providerContributions: this._loadedScope.providerContributions.map((contribution) => ({
				extensionId: contribution.extensionId,
				providerName: contribution.providerName,
				modelIds: (contribution.config.models ?? []).map((model) => model.id),
				oauth: contribution.config.oauth !== undefined,
				divisionId: contribution.divisionId,
			})),
			systemPromptContributions: this._loadedScope.systemPromptContributions.map((contribution) => ({
				extensionId: contribution.extensionId,
				divisionId: contribution.divisionId,
			})),
			divisions: [...this._loadedScope.divisions],
			stale: this._staleMessage ? { stale: true, message: this._staleMessage } : { stale: false },
		};
	}

	contributeToolsTo(registry: ToolRegistry): void {
		for (const contribution of this._loadedScope.toolContributions) {
			if (contribution.kind === "define") {
				registry.defineTool(contribution.definition, contribution.source);
			} else {
				registry.patchTool(contribution.targetToolName, contribution.patch, contribution.source);
			}
		}
	}

	async emitObserved(event: ExtensionObservedEvent): Promise<CoreDiagnostic[]> {
		const diagnostics: CoreDiagnostic[] = [];
		const handlers = this._loadedScope.observerHandlers.get(event.type) ?? [];
		for (const registration of handlers) {
			try {
				await (registration.handler as ExtensionObserver)(event, this.createContext(registration.extensionId));
			} catch (error) {
				diagnostics.push(this._createHandlerDiagnostic(registration, error));
			}
		}
		return diagnostics;
	}

	/**
	 * Deliver one bus event to this runtime's subscribers. The runtime that
	 * emitted it is not excluded: subscription is per extension runtime, and two
	 * instances of the same extension in different agents are exactly the case
	 * the bus exists for.
	 */
	async emitExtensionEvent(envelope: ExtensionEventEnvelope): Promise<CoreDiagnostic[]> {
		const diagnostics: CoreDiagnostic[] = [];
		const handlers = this._loadedScope.extensionEventHandlers.get(envelope.name) ?? [];
		for (const registration of handlers) {
			try {
				await registration.handler(envelope, this.createContext(registration.extensionId));
			} catch (error) {
				diagnostics.push(this._createHandlerDiagnostic(registration, error));
			}
		}
		return diagnostics;
	}

	async intercept<TName extends ExtensionInterceptorName>(
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		return (await this.interceptWithDiagnostics(event)).result;
	}

	async interceptWithDiagnostics<TName extends ExtensionInterceptorName>(
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorRun<TName>> {
		const handlers = this._loadedScope.interceptorHandlers.get(event.type as TName);
		if (!handlers || handlers.length === 0) {
			return { result: undefined as ExtensionInterceptorResultFor<TName>, diagnostics: [] };
		}
		if (event.type === "input") {
			const run = await this.interceptInput(event as ExtensionInterceptorEventFor<"input">);
			const result: ExtensionInputResult =
				run.kind === "block"
					? { block: true, reason: run.reason }
					: run.kind === "transform"
						? { text: run.text, images: run.images }
						: undefined;
			return { result: result as ExtensionInterceptorResultFor<TName>, diagnostics: run.diagnostics };
		}
		const diagnostics: CoreDiagnostic[] = [];
		let result: ExtensionInterceptorResultFor<TName>;
		if (event.type === "before_agent_start") {
			result = (await this._interceptBeforeAgentStart(
				event as ExtensionInterceptorEventFor<"before_agent_start">,
				handlers as ExtensionInterceptorRegistration<"before_agent_start">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else if (event.type === "before_provider_request") {
			result = (await this._interceptBeforeProviderRequest(
				event as ExtensionInterceptorEventFor<"before_provider_request">,
				handlers as ExtensionInterceptorRegistration<"before_provider_request">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else if (event.type === "context") {
			result = (await this._interceptContext(
				event as ExtensionInterceptorEventFor<"context">,
				handlers as ExtensionInterceptorRegistration<"context">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else if (event.type === "tool_call") {
			result = (await this._interceptToolCall(
				event as ExtensionInterceptorEventFor<"tool_call">,
				handlers as ExtensionInterceptorRegistration<"tool_call">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else {
			result = (await this._interceptToolResult(
				event as ExtensionInterceptorEventFor<"tool_result">,
				handlers as ExtensionInterceptorRegistration<"tool_result">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		}
		return { result, diagnostics };
	}

	private async _interceptBeforeAgentStart(
		event: ExtensionInterceptorEventFor<"before_agent_start">,
		registrations: ExtensionInterceptorRegistration<"before_agent_start">[],
		diagnostics: CoreDiagnostic[],
	): Promise<BeforeAgentStartResult | undefined> {
		const result: BeforeAgentStartResult = {};
		let hasResult = false;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, event);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
			if (nextResult === undefined) continue;
			hasResult = true;
			if (nextResult.messages) {
				result.messages = [...(result.messages ?? []), ...nextResult.messages];
			}
			if (nextResult.systemPrompt !== undefined) {
				result.systemPrompt = nextResult.systemPrompt;
			}
		}
		return hasResult ? result : undefined;
	}

	// Provider request pipeline (ME slice 9): context-style composition - each
	// handler sees the stream options as patched so far, and a failed handler
	// is skipped without touching the request (this is a shaping hook, not a
	// policy gate). The composed change is returned as a single faithful
	// base-to-final patch, including key deletes.
	private async _interceptBeforeProviderRequest(
		event: ExtensionInterceptorEventFor<"before_provider_request">,
		registrations: ExtensionInterceptorRegistration<"before_provider_request">[],
		diagnostics: CoreDiagnostic[],
	): Promise<BeforeProviderRequestResult | undefined> {
		const base = cloneStreamOptions(event.streamOptions);
		let current = base;
		let hasResult = false;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, { ...event, streamOptions: cloneStreamOptions(current) });
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
			if (nextResult?.streamOptions === undefined) continue;
			hasResult = true;
			current = applyStreamOptionsPatch(current, nextResult.streamOptions);
		}
		if (!hasResult) return undefined;
		return { streamOptions: diffStreamOptions(event.streamOptions, current) };
	}

	private async _interceptContext(
		event: ExtensionInterceptorEventFor<"context">,
		registrations: ExtensionInterceptorRegistration<"context">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ContextResult | undefined> {
		let messages = [...event.messages];
		let hasResult = false;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, { ...event, messages });
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
			if (nextResult === undefined) continue;
			hasResult = true;
			messages = nextResult.messages;
		}
		return hasResult ? { messages } : undefined;
	}

	private async _interceptToolCall(
		event: ExtensionInterceptorEventFor<"tool_call">,
		registrations: ExtensionInterceptorRegistration<"tool_call">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ToolCallResult | undefined> {
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, event);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				return { block: true };
			}
			const result = run.result;
			if (result?.block) {
				return { block: true, reason: result.reason };
			}
		}
		return undefined;
	}

	private async _interceptToolResult(
		event: ExtensionInterceptorEventFor<"tool_result">,
		registrations: ExtensionInterceptorRegistration<"tool_result">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ToolResultPatch | undefined> {
		const patch: ToolResultPatch = {};
		let hasPatch = false;
		let nextEvent = event;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, nextEvent);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const result = run.result;
			if (result === undefined) continue;
			hasPatch = true;
			if (Object.hasOwn(result, "content")) patch.content = result.content;
			if (Object.hasOwn(result, "details")) patch.details = result.details;
			if (Object.hasOwn(result, "isError")) patch.isError = result.isError;
			if (result.terminate) patch.terminate = true;
			nextEvent = {
				...nextEvent,
				content: patch.content ?? nextEvent.content,
				details: Object.hasOwn(patch, "details") ? patch.details : nextEvent.details,
				isError: patch.isError ?? nextEvent.isError,
			};
		}
		return hasPatch ? patch : undefined;
	}

	// Input pipeline (ME slice 6): each handler sees the text as rewritten so
	// far (like context); the first block short-circuits (like tool_call). A
	// crashed handler blocks fail-closed - an input policy must not be
	// bypassed by its own failure.
	async interceptInput(event: ExtensionInputEvent): Promise<ExtensionInputInterceptRun> {
		const registrations = (this._loadedScope.interceptorHandlers.get("input") ??
			[]) as readonly ExtensionInterceptorRegistration<"input">[];
		const diagnostics: CoreDiagnostic[] = [];
		const transformedBy: string[] = [];
		let text = event.text;
		let images = event.images;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, { ...event, text, images });
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				return { kind: "block", diagnostics, blockedBy: registration.extensionId };
			}
			const result = run.result;
			if (result === undefined) continue;
			if ("block" in result) {
				return { kind: "block", diagnostics, reason: result.reason, blockedBy: registration.extensionId };
			}
			transformedBy.push(registration.extensionId);
			text = result.text;
			images = result.images ?? images;
		}
		if (text === event.text && images === event.images) {
			return { kind: "pass", diagnostics };
		}
		return { kind: "transform", diagnostics, text, images, transformedBy };
	}

	private async _runInterceptor<TName extends ExtensionInterceptorName>(
		registration: ExtensionInterceptorRegistration<TName>,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorHandlerRun<TName>> {
		try {
			return {
				ok: true,
				result: await (registration.handler as ExtensionInterceptorFor<TName>)(
					event,
					this.createContext(registration.extensionId),
				),
			};
		} catch (error) {
			return { ok: false, diagnostic: this._createHandlerDiagnostic(registration, error) };
		}
	}

	private _assertActive(): void {
		if (this._staleMessage) {
			throw new Error(this._staleMessage);
		}
	}

	// Narrowing boundary: the scoped author-facing actions inject this
	// runner's agent id and the calling extension's id; neither ever appears
	// in an ExtensionActions signature.
	private _createContextActions(extensionId: string): ExtensionActions {
		const agentId = this.agentId;
		const failure = (action: ExtensionActionFailure["action"]): Omit<ExtensionActionFailure, "error"> => ({
			extensionId,
			action,
			code: "extension.action_failed",
		});
		return {
			listProfiles: async () =>
				await this._runReportedAction(failure("listProfiles"), async () => await this._actions.listProfileBriefs()),
			listAgents: async () =>
				await this._runReportedAction(failure("listAgents"), async () => await this._actions.listAgentTree(agentId)),
			describeAgent: (targetAgentId) => {
				this._assertActive();
				return this._actions.describeAgentFor(agentId, targetAgentId);
			},
			spawnAgent: async (request) =>
				await this._runReportedAction(
					failure("spawnAgent"),
					async () => await this._actions.spawnAgentFor(agentId, request),
				),
			disposeAgent: async (targetAgentId, options) =>
				await this._runReportedAction(
					failure("disposeAgent"),
					async () => await this._actions.disposeAgentFor(agentId, targetAgentId, options),
				),
			getTools: () => {
				this._assertActive();
				return this._actions.getAgentTools(agentId);
			},
			setTools: async (toolNames, activeToolNames) => {
				await this._runReportedAction(failure("setTools"), async () => {
					await this._actions.setAgentTools(agentId, toolNames, activeToolNames);
				});
			},
			setActiveTools: async (toolNames) => {
				await this._runReportedAction(failure("setActiveTools"), async () => {
					await this._actions.setAgentActiveTools(agentId, toolNames);
				});
			},
			requestHuman: async (request) =>
				await this._runReportedAction(
					failure("requestHuman"),
					async () => await this._actions.requestHuman(agentId, extensionId, request),
				),
			emitOutput: async (text) => {
				await this._runReportedAction(failure("emitOutput"), async () => {
					await this._actions.emitOutput(agentId, extensionId, text);
				});
			},
			notify: async (text) => {
				await this._runReportedAction(failure("notify"), async () => {
					await this._actions.notify(agentId, extensionId, text);
				});
			},
			setStatus: async (key, status) => {
				await this._runReportedAction(failure("setStatus"), async () => {
					await this._actions.setStatus(agentId, extensionId, key, status);
				});
			},
			clearStatus: async (key) => {
				await this._runReportedAction(failure("clearStatus"), async () => {
					await this._actions.clearStatus(agentId, extensionId, key);
				});
			},
			publishMessage: async (message) =>
				await this._runReportedAction(
					failure("publishMessage"),
					async () => await this._actions.publishMessage(agentId, extensionId, message),
				),
			reportDiagnostic: async (draft) => {
				await this._runReportedAction(failure("reportDiagnostic"), async () => {
					await this._actions.reportDiagnostic(agentId, extensionId, draft);
				});
			},
			prompt: async (text, options) => {
				await this._runReportedAction(failure("prompt"), async () => {
					await this._actions.messageSinkFor(extensionId).prompt(toMessageRequest(agentId, text, "next_turn", options));
				});
			},
			steer: async (text, options) => {
				await this._runReportedAction(failure("steer"), async () => {
					await this._actions.messageSinkFor(extensionId).send(toMessageRequest(agentId, text, "interrupt", options));
				});
			},
			followUp: async (text, options) => {
				await this._runReportedAction(failure("followUp"), async () => {
					await this._actions.messageSinkFor(extensionId).send(toMessageRequest(agentId, text, "next_turn", options));
				});
			},
			precede: async (text, options) => {
				await this._runReportedAction(failure("precede"), async () => {
					await this._actions.messageSinkFor(extensionId).send(toMessageRequest(agentId, text, "precede", options));
				});
			},
			getContextUsage: () => {
				this._assertActive();
				return this._actions.getAgentContextUsage(agentId);
			},
			isProjectTrusted: () => {
				this._assertActive();
				return this._actions.isProjectTrusted();
			},
			getSystemPrompt: async () =>
				await this._runReportedAction(
					failure("getSystemPrompt"),
					async () => await this._actions.getAgentSystemPrompt(agentId),
				),
			hasPendingMessages: () => {
				this._assertActive();
				return this._actions.agentHasPendingMessages(agentId);
			},
			waitForIdle: async (options) => {
				await this._runReportedAction(failure("waitForIdle"), async () => {
					await this._actions.waitForAgentIdle(agentId, options);
				});
			},
			emitExtensionEvent: async (name, payload) => {
				await this._runReportedAction(failure("emitExtensionEvent"), async () => {
					await this._actions.emitExtensionEvent(agentId, extensionId, name, payload);
				});
			},
			requestShutdown: async (reason) => {
				await this._runReportedAction(failure("requestShutdown"), async () => {
					await this._actions.requestRuntimeShutdown(agentId, extensionId, reason);
				});
			},
			disposeRuntime: async (reason) => {
				// The stale guard inside runs before the teardown, so a live runtime
				// can always start one; a call made from an onDispose handler, after
				// this same runtime was invalidated, is refused.
				await this._runReportedAction(failure("disposeRuntime"), async () => {
					await this._actions.disposeRuntime(agentId, extensionId, reason);
				});
			},
			setSessionName: async (name) => {
				await this._runReportedAction(failure("setSessionName"), async () => {
					await this._actions.setAgentSessionName(agentId, name);
				});
			},
			getSessionName: async () =>
				await this._runReportedAction(
					failure("getSessionName"),
					async () => await this._actions.getAgentSessionName(agentId),
				),
			compact: async (customInstructions) =>
				await this._runReportedAction(
					failure("compact"),
					async () => await this._actions.compactAgent(agentId, customInstructions),
				),
			navigateTree: async (targetEntryId, options) =>
				await this._runReportedAction(
					failure("navigateTree"),
					async () => await this._actions.navigateAgentTree(agentId, targetEntryId, options),
				),
			setModel: async (reference) =>
				await this._runReportedAction(
					failure("setModel"),
					async () => await this._actions.setAgentModelByReference(agentId, reference),
				),
			getModel: () => {
				this._assertActive();
				return this._actions.getAgentModel(agentId);
			},
			listModelCandidates: async () =>
				await this._runReportedAction(
					failure("listModelCandidates"),
					async () => await this._actions.listModelCandidates(),
				),
			getThinkingLevel: () => {
				this._assertActive();
				return this._actions.getAgentThinkingLevel(agentId);
			},
			setThinkingLevel: async (level) => {
				await this._runReportedAction(failure("setThinkingLevel"), async () => {
					await this._actions.setAgentThinkingLevel(agentId, level);
				});
			},
			abort: async () => {
				await this._runReportedAction(failure("abort"), async () => {
					await this._actions.abortAgent(agentId);
				});
			},
			exec: async (command, options) =>
				await this._runReportedAction(
					failure("exec"),
					async () => await this._actions.exec(agentId, extensionId, command, options),
				),
		};
	}

	private async _runReportedAction<T>(
		failure: Omit<ExtensionActionFailure, "error">,
		run: () => Promise<T>,
	): Promise<T> {
		this._assertActive();
		try {
			return await run();
		} catch (error) {
			await this._reportActionFailure({ ...failure, error });
			throw error;
		}
	}

	private _createSessionContext(extensionId: string): ExtensionSessionContext {
		const sessionFailure = (action: ExtensionActionFailure["action"]): Omit<ExtensionActionFailure, "error"> => ({
			extensionId,
			action,
			code: "extension.session_read_failed",
		});
		return {
			appendEntry: async (type, data) =>
				await this._runReportedAction(
					{ extensionId, action: "appendEntry", code: "extension.custom_entry_append_failed" },
					async () => await this._requireSessionActions().appendEntry(extensionId, type, data),
				),
			findEntries: async (type) =>
				await this._runReportedAction(
					{ extensionId, action: "findEntries", code: "extension.custom_entry_find_failed" },
					async () => await this._requireSessionActions().findEntries(extensionId, type),
				),
			getSnapshot: async () =>
				await this._runReportedAction(
					sessionFailure("getSnapshot"),
					async () => await this._requireSessionActions().getSnapshot(),
				),
			getTree: async () =>
				await this._runReportedAction(
					sessionFailure("getTree"),
					async () => await this._requireSessionActions().getTree(),
				),
			getLeafId: async () =>
				await this._runReportedAction(
					sessionFailure("getLeafId"),
					async () => await this._requireSessionActions().getLeafId(),
				),
			listSessions: async () =>
				await this._runReportedAction(
					sessionFailure("listSessions"),
					async () => await this._requireSessionActions().listSessions(extensionId),
				),
			readSession: async (reference) =>
				await this._runReportedAction(
					sessionFailure("readSession"),
					async () => await this._requireSessionActions().readSession(extensionId, reference),
				),
		};
	}

	private _requireSessionActions() {
		const session = this._contextActions.session;
		if (!session) {
			throw new Error("Extension runner session actions are not bound.");
		}
		return session;
	}

	private async _reportActionFailure(failure: ExtensionActionFailure): Promise<void> {
		await this._contextActions.reportActionFailure?.(failure);
	}

	private _createHandlerDiagnostic(
		registration: { readonly extensionId: string; readonly eventName: string; readonly divisionId?: string },
		error: unknown,
	): CoreDiagnostic {
		const origin = registration.divisionId
			? `Extension '${registration.extensionId}' division '${registration.divisionId}'`
			: `Extension '${registration.extensionId}'`;
		return {
			code: "extension.handler_failed",
			severity: "warning",
			message: `${origin} handler '${registration.eventName}' failed: ${formatError(error)}`,
			agentId: this.agentId,
			extensionId: registration.extensionId,
		};
	}
}

function cloneStreamOptions(streamOptions: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

// Mirrors the Pi harness patch semantics (module-private upstream): scalar
// keys apply when present, header/metadata patches merge key-wise with
// `undefined` deleting a key and an explicit `undefined` map clearing all.
function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) {
		result.maxRetryDelayMs = patch.maxRetryDelayMs;
	}
	if (Object.hasOwn(patch, "cacheRetention")) {
		result.cacheRetention = patch.cacheRetention;
	}

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

// Encode base-to-final as one patch. Key-wise deletes keep the encoding
// faithful for composed handler chains that removed headers or metadata.
function diffStreamOptions(
	base: AgentHarnessStreamOptions,
	final: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
	const patch: AgentHarnessStreamOptionsPatch = {};
	if (base.transport !== final.transport) patch.transport = final.transport;
	if (base.timeoutMs !== final.timeoutMs) patch.timeoutMs = final.timeoutMs;
	if (base.maxRetries !== final.maxRetries) {
		patch.maxRetries = final.maxRetries;
	}
	if (base.maxRetryDelayMs !== final.maxRetryDelayMs) {
		patch.maxRetryDelayMs = final.maxRetryDelayMs;
	}
	if (base.cacheRetention !== final.cacheRetention) {
		patch.cacheRetention = final.cacheRetention;
	}

	const headerPatch = diffRecord(base.headers, final.headers);
	if (headerPatch) patch.headers = headerPatch;
	const metadataPatch = diffRecord(base.metadata, final.metadata);
	if (metadataPatch) patch.metadata = metadataPatch;
	return patch;
}

function diffRecord<T>(
	base: Record<string, T> | undefined,
	final: Record<string, T> | undefined,
): Record<string, T | undefined> | undefined {
	const patch: Record<string, T | undefined> = {};
	for (const key of Object.keys(base ?? {})) {
		if (!Object.hasOwn(final ?? {}, key)) patch[key] = undefined;
	}
	for (const [key, value] of Object.entries(final ?? {})) {
		if (base?.[key] !== value) patch[key] = value;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * The extension half of a message request. The delivery policy is not here: it
 * belongs to the sink, which the orchestrator bound to this extension before
 * handing it over. Source and render are the author's optional overrides; the
 * sink's defaults fill in whatever they omit.
 */
function toMessageRequest(
	agentId: string,
	text: string,
	mode: MessageDeliveryMode,
	options: ExtensionSendOptions | undefined,
): MessageRequest {
	return {
		targetAgentId: options?.target ?? agentId,
		body: text,
		...(options?.images === undefined ? undefined : { images: options.images }),
		...(options?.source === undefined ? undefined : { source: options.source }),
		...(options?.render === undefined ? undefined : { render: options.render }),
		mode,
	};
}

function createUnboundActions(): ExtensionCoreActions {
	const notBound = () => {
		throw new Error("Extension runner core actions are not bound.");
	};
	return {
		listProfileBriefs: async () => notBound(),
		listAgentTree: async () => notBound(),
		describeAgentFor: () => notBound(),
		spawnAgentFor: async () => notBound(),
		disposeAgentFor: async () => notBound(),
		getAgentTools: () => notBound(),
		setAgentTools: async () => notBound(),
		setAgentActiveTools: async () => notBound(),
		requestHuman: async () => notBound(),
		emitOutput: async () => notBound(),
		notify: async () => notBound(),
		setStatus: async () => notBound(),
		clearStatus: async () => notBound(),
		publishMessage: async () => notBound(),
		reportDiagnostic: async () => notBound(),
		messageSinkFor: () => notBound(),
		getAgentContextUsage: () => notBound(),
		isProjectTrusted: () => notBound(),
		getAgentSystemPrompt: async () => notBound(),
		agentHasPendingMessages: () => notBound(),
		waitForAgentIdle: async () => notBound(),
		emitExtensionEvent: async () => notBound(),
		requestRuntimeShutdown: async () => notBound(),
		disposeRuntime: async () => notBound(),
		setAgentSessionName: async () => notBound(),
		getAgentSessionName: async () => notBound(),
		compactAgent: async () => notBound(),
		navigateAgentTree: async () => notBound(),
		setAgentModelByReference: async () => notBound(),
		getAgentModel: () => notBound(),
		listModelCandidates: async () => notBound(),
		getAgentThinkingLevel: () => notBound(),
		setAgentThinkingLevel: async () => notBound(),
		abortAgent: async () => notBound(),
		exec: async () => notBound(),
	};
}
