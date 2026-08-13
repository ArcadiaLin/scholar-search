/**
 * AgentOrchestrator - the multi-agent runtime.
 *
 * One criterion shapes this file: a fact about a single agent is read from that
 * agent's `AgentHarness`; the orchestrator only decides what needs more than one
 * agent to answer - AgentId allocation, spawn-tree ownership, cross-agent
 * routing, who is waiting on whom to go idle, and the persistence of those
 * facts. The exceptions are enumerated in `notes/develop/agent-harness-ownership-plan.md`.
 *
 * A collaborator earns its own class only when it owns state whose invariant it
 * can maintain without consulting `_live`. Three qualify: `OrchestratorEventBus`,
 * `AgentContextMonitor`, `AuthRuntimeController`. Everything whose central
 * judgement is a join across `_live`, harness phase, or the spawn tree stays
 * here.
 *
 * Design: `docs/orchestrator.pseudo.ts`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AbortResult,
	AgentHarness,
	AgentHarnessError,
	type AgentHarnessEvent,
	type AgentHarnessPhase,
	type AgentMessage,
	type CompactResult,
	createCustomMessage,
	type ExecutionEnv,
	type JsonlSessionMetadata,
	type NavigateTreeResult,
	type PendingSessionWrite,
	type PromptTemplate,
	type Session,
	type SessionTreeEntry,
	type Skill,
	shouldCompact,
	type ThinkingLevel,
} from "@arcadialin/agent-core";
import { type AssistantMessage, getSupportedThinkingLevels, type TextContent } from "@earendil-works/pi-ai";
import { formatError } from "../utils/errors.ts";
import type { JsonValue } from "../utils/json.ts";
import type { AgentProfile, AgentProfileOverride, AgentProfileRegistry, AgentProfileSource } from "./agent-profile.js";
import { ExtensionProfileStorageBackend, parseAgentProfileReference } from "./agent-profile.js";
import type {
	AgentResourcesSnapshot,
	AgentSettings,
	AgentSnapshot,
	AgentSystemPromptFacts,
	AgentToolPolicy,
	ExtensionRunnerBindings,
	LiveAgent,
	WidiAgentHarness,
} from "./agent-types.ts";
import { createAgentProfileRecordReference } from "./agent-types.ts";
import type {
	AuthCredentialCandidateListResult,
	AuthProviderCandidateListResult,
	AuthProviderLoginResult,
	AuthProviderLogoutResult,
} from "./auth-controller.ts";
import { AuthRuntimeController } from "./auth-controller.ts";
import type { OrchestratorClient } from "./client.ts";
import { AgentContextMonitor } from "./context-monitor.ts";
import { type OrchestratorDiagnostic, OrchestratorError, validateExtensionDiagnosticDraft } from "./diagnostics.ts";
import type { EventPublishOptions } from "./event-bus.ts";
import { OrchestratorEventBus } from "./event-bus.ts";
import type { ExtensionEventEnvelope, ExtensionEventSubscriber } from "./extension/events.ts";
import type { ExtensionContextActions, ExtensionCoreActions, ExtensionIdentity } from "./extension/index.ts";
import {
	EXTENSION_OBSERVED_EVENT_NAMES,
	EXTENSION_TREE_BROADCAST_EVENT_NAMES,
	ExtensionLoader,
	ExtensionRunner,
	freezeExtensionEventEnvelope,
	MAX_EXTENSION_EVENT_DISPATCH_DEPTH,
	validateExtensionEventName,
	validateExtensionEventPayload,
} from "./extension/index.ts";
import { ExtensionStatusRegistry } from "./extension/status-registry.ts";
import type {
	ExtensionInterceptorEventFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionModule,
	ExtensionObservedEvent,
	ExtensionSessionSnapshot,
	ExtensionSessionTree,
	ExtensionSpawnOrigin,
} from "./extension/types.ts";
import {
	assertExtensionNotificationText,
	assertExtensionOutputText,
	assertExtensionStatusKey,
	type ExtensionStatusSnapshot,
	validateExtensionMessage,
	validateExtensionStatus,
} from "./extension/types.ts";
import type {
	AgentBrief,
	AgentDisposeScope,
	AgentProfileBrief,
	AgentRequestedDisposeOptions,
	AgentRequestedDisposeOutcome,
	AgentSpawnOrigin,
	AgentStop,
	AgentToOrchestratorHost,
	AgentTreeEntry,
	AgentTreeListing,
} from "./host.ts";
import { AgentGoneError } from "./host.ts";
import { HumanInterruptRegistry } from "./human-interrupt.ts";
import type { HumanRequest, HumanResponse } from "./human-request.ts";
import { HumanRequestBroker } from "./human-request.ts";
import { stripImagesFromMessages } from "./image-policy.ts";
import {
	assertMessageBody,
	type MessageBlockPolicy,
	type MessageDeliveryPhase,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDeliveryRequest,
	type MessageDraft,
	type MessageEntryPayload,
	type MessageInterceptEvent,
	type MessageInterceptRun,
	type MessageRequest,
	type MessageSendOutcome,
	type MessageSink,
	type MessageSinkBinding,
	messageBindingFor,
	renderMessageContent,
	transformMessage,
} from "./message.ts";
import {
	type ModelRegistry,
	modelReference,
	parseModelReference,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./model-registry.js";
import type { ProviderConfigInput } from "./model-registry.ts";
import {
	PERSISTENCE_REF_CUSTOM_TYPE,
	type PersistedSessionInfo,
	type PersistenceDiagnostic,
	PersistenceDiagnostics,
	type PersistenceRefData,
	sessionKeysEqual,
} from "./persistence/index.ts";
import type { ConfigValueResolver } from "./resolve-config-value.js";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	AgentSessionSnapshot,
	AgentSessionTreeNode,
	AgentSessionTreeSnapshot,
	SessionManager,
} from "./session-manager.ts";
import {
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	type ExtensionMessageEntryData,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	type InputTransformEntryData,
	isExtensionCustomType,
	ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
	toExtensionCustomType,
} from "./session-manager.ts";
import type { SettingManager } from "./setting-manager.js";
import { buildAgentSystemPrompt, type ToolPromptGuidance } from "./system-prompt.ts";
import {
	createAgentHarnessToolsFromResolvedTools,
	type ResolvedAgentHarnessTool,
	type ToolAdapterContext,
	ToolRegistry,
} from "./tool-registry.ts";
import type {
	AgentAbortOrigin,
	AgentActivitySnapshot,
	AgentId,
	AgentIdleReason,
	AgentToolsSnapshot,
	CandidateItem,
	OrchestratorEvent,
	OrchestratorEventListener,
	PromptOutcome,
	RuntimeModel,
	RuntimeShutdownRequest,
} from "./types.ts";
import { maintenanceDescription, maintenanceKindOf } from "./types.ts";
import type { Workspace, WorkspaceResolver } from "./workspace.ts";

export type { AgentSnapshot, LiveAgent } from "./agent-types.ts";
export type {
	AuthCredentialCandidateListResult,
	AuthProviderCandidateListResult,
	AuthProviderLoginResult,
	AuthProviderLogoutResult,
} from "./auth-controller.ts";

export interface AgentOrchestratorConfig {
	executionEnv: ExecutionEnv;
	workspaces: WorkspaceResolver;
	sessionManager: SessionManager;
	settingManager: SettingManager;
	modelRegistry: ModelRegistry;
	profileRegistry: AgentProfileRegistry;
	/** Where `registerProfile` contributions land; absent when nobody publishes them. */
	extensionProfiles?: ExtensionProfileStorageBackend;
	toolRegistry?: ToolRegistry;
	extensionLoader?: ExtensionLoader;
	defaultProfileId: string;
	enabledProfileIds?: readonly string[];
	/** Undefined on a fresh install with no authenticated model; spawning refuses. */
	defaultModel: RuntimeModel | undefined;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface AgentSessionListResult {
	readonly sessions: readonly AgentSessionCandidate[];
}

export interface AgentListResult {
	readonly agents: readonly AgentSnapshot[];
}

export interface AgentModelCandidateListResult {
	readonly models: readonly CandidateItem[];
}

export interface AgentThinkingLevelCandidateListResult {
	readonly levels: readonly CandidateItem[];
}

export interface AgentThinkingLevelResult {
	readonly level: ThinkingLevel;
}

export interface AgentPromptTemplateCandidateListResult {
	readonly templates: readonly CandidateItem[];
}

export interface AgentSkillCandidateListResult {
	readonly skills: readonly CandidateItem[];
}

export interface AgentProfileCandidateListResult {
	readonly profiles: readonly CandidateItem[];
}

export type ExtensionReloadAgentStatus = "reloaded" | "skipped" | "failed";

/** `running` covers every non-idle phase: a replacement would swap the interceptors an operation is midway through. */
export type ExtensionReloadAgentSkipReason = "creating" | "running" | "gone";

export interface ExtensionReloadAgentResult {
	readonly agentId: AgentId;
	readonly status: ExtensionReloadAgentStatus;
	readonly reason?: ExtensionReloadAgentSkipReason;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
}

export interface ExtensionReloadResult {
	readonly catalog: {
		readonly loaded: readonly ExtensionIdentity[];
		readonly diagnostics: readonly OrchestratorDiagnostic[];
	};
	readonly agents: readonly ExtensionReloadAgentResult[];
}

export type SpawnAgentOrigin =
	| { readonly kind: "new"; readonly profileId?: string; readonly profileOverride?: AgentProfileOverride }
	| { readonly kind: "resume"; readonly reference: string | PersistedSessionInfo }
	| { readonly kind: "fork"; readonly sourceAgentId: AgentId; readonly entryId?: string };

export interface SpawnAgentOptions {
	readonly origin: SpawnAgentOrigin;
	/** Absent means top-level; present records `spawnedBy` and the tree edge. */
	readonly parent?: AgentId;
	/**
	 * The workspace this spawn happens in, defaulting to the one the process
	 * started in. Read only when `parent` is absent: a spawned agent always works
	 * where its spawner does, so a whole tree shares one cwd and one storage
	 * group.
	 *
	 * For a resume it names the group the reference is looked up in, not the
	 * workspace the agent gets: a stored session already says where it belongs,
	 * and reopening it anywhere else would split its tree across two groups.
	 */
	readonly cwd?: string;
	readonly model?: RuntimeModel;
	readonly thinkingLevel?: ThinkingLevel;
}

export type AgentDisposeIntent = "removed" | "runtime_shutdown";

export interface DisposeAgentOptions {
	readonly intent: AgentDisposeIntent;
	readonly reason?: string;
	/** Default: dispose only the named agent. */
	readonly scope?: AgentDisposeScope;
}

interface AgentCreationReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<AgentId>;
	cancelled: boolean;
	readonly cancel: () => void;
}

/** Merges duplicate dispose requests. Never decides routability. */
interface AgentDisposalReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<void>;
}

/** The four cases exhaust what an AgentId can mean; each comes from one table. */
type AgentLookup =
	| { readonly kind: "live"; readonly liveAgent: LiveAgent }
	| { readonly kind: "gone" }
	| { readonly kind: "creating"; readonly reservation: AgentCreationReservation }
	| { readonly kind: "unknown" };

interface DeliveryTarget {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly harness: WidiAgentHarness;
	readonly phase: AgentHarnessPhase;
}

/** Why an agent arrived at idle, with the abort's origin when it had one. */
interface AgentIdleCause {
	readonly reason: AgentIdleReason;
	readonly abortedBy?: AgentAbortOrigin;
}

/** A prompt run this orchestrator started and still owes an outcome for. */
interface AgentPromptRun {
	idleCause?: AgentIdleCause;
}

interface AgentIdleWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

type AgentIdleState =
	| { readonly kind: "idle" }
	| { readonly kind: "busy" }
	| { readonly kind: "gone"; readonly message: string };

type AcceptedMessage =
	| { readonly kind: "accepted"; readonly receipt: MessageDeliveryReceipt }
	| { readonly kind: "blocked"; readonly inputId: string; readonly reason?: string; readonly blockedBy: string };

interface RouteMessageOptions {
	/** The caller awaits this run's assistant message, so it must be a prompt. */
	readonly requiresIdle: boolean;
	/** The enqueuing caller awaits `receipt.completed` itself. */
	readonly awaited: boolean;
}

interface ResolvedAgentProfile {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
}

/**
 * Everything `_buildLiveAgent` needs, resolved before any live resource is
 * touched. Producing it can fail freely: nothing is registered yet.
 */
interface AgentBuildRequest {
	readonly agentId: AgentId;
	readonly origin: SpawnAgentOrigin["kind"];
	readonly workspace: Workspace;
	readonly resolvedProfile: ResolvedAgentProfile;
	readonly session: Session<AgentSessionMetadata>;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly settings: AgentSettings;
	readonly toolPolicy: AgentToolPolicy;
	readonly parent: AgentId | undefined;
}

interface LiveAgentBuild {
	readonly liveAgent: LiveAgent;
	readonly parent?: AgentId;
}

interface DisposedLiveAgent {
	readonly agentId: AgentId;
	readonly liveAgent?: LiveAgent;
}

export class AgentOrchestrator {
	readonly executionEnv: ExecutionEnv;
	readonly workspaces: WorkspaceResolver;
	readonly sessionManager: SessionManager;
	readonly settingManager: SettingManager;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	readonly extensionProfiles: ExtensionProfileStorageBackend;
	readonly toolRegistry: ToolRegistry;
	readonly extensionLoader: ExtensionLoader;

	// -- Independent runtimes ------------------------------------------------

	private readonly _events: OrchestratorEventBus;
	private readonly _context: AgentContextMonitor;
	private readonly _auth: AuthRuntimeController;
	private readonly _humanRequests: HumanRequestBroker;
	private readonly _humanInterrupts = new HumanInterruptRegistry();

	// -- Message delivery ----------------------------------------------------

	private readonly _messages: MessageDeliveryQueue;
	private readonly _agentPromptRuns = new Map<AgentId, AgentPromptRun>();
	private readonly _agentRunStartWaiters = new Map<AgentId, Set<() => void>>();
	private readonly _agentRunSignals = new Map<AgentId, AbortSignal>();
	private readonly _agentIdleWaiters = new Map<AgentId, Set<AgentIdleWaiter>>();
	private readonly _agentIdleCauses = new Map<AgentId, AgentIdleCause>();
	private readonly _publishedAgentIdles = new Set<AgentId>();
	private readonly _publishedAgentActivities = new Map<AgentId, AgentActivitySnapshot>();
	private _nextInputId = 1;
	private _nextPresentationId = 1;

	// -- Extension data plane ------------------------------------------------

	private readonly _extensionStatuses = new ExtensionStatusRegistry();
	private readonly _extensionEventDispatchContext = new AsyncLocalStorage<number>();
	private readonly _extensionEventSubscribers = new Set<ExtensionEventSubscriber>();
	private readonly _extensionCausedScope = new AsyncLocalStorage<true>();
	private readonly _extensionCoreActions: ExtensionCoreActions;

	// -- Agent registry ------------------------------------------------------

	private readonly _live = new Map<AgentId, LiveAgent>();
	private readonly _disposingHarnesses = new Map<AgentId, WidiAgentHarness>();
	private readonly _tombstones = new Set<AgentId>();
	private readonly _spawnParent = new Map<AgentId, AgentId>();
	private readonly _agentGenerations = new Map<AgentId, number>();
	private readonly _agentCreations = new Map<AgentId, AgentCreationReservation>();
	private readonly _agentDisposals = new Map<AgentId, AgentDisposalReservation>();
	private readonly _agentDiagnostics = new Map<AgentId, OrchestratorDiagnostic[]>();
	private readonly _autoCompactingAgents = new Set<AgentId>();

	// -- Runtime defaults ----------------------------------------------------

	private _defaultModel: RuntimeModel | undefined;
	private _defaultThinkingLevel: ThinkingLevel | undefined;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;

	private _shutdownRequested = false;

	constructor(config: AgentOrchestratorConfig) {
		this.executionEnv = config.executionEnv;
		this.workspaces = config.workspaces;
		this.sessionManager = config.sessionManager;
		this.settingManager = config.settingManager;
		this.modelRegistry = config.modelRegistry;
		this.profileRegistry = config.profileRegistry;
		this.extensionProfiles = config.extensionProfiles ?? new ExtensionProfileStorageBackend();
		this.toolRegistry = config.toolRegistry ?? new ToolRegistry();
		this.extensionLoader = config.extensionLoader ?? new ExtensionLoader();
		this._defaultProfileId = config.defaultProfileId;
		this._enabledProfileIds = config.enabledProfileIds ? [...config.enabledProfileIds] : undefined;
		this._defaultModel = config.defaultModel;
		this._defaultThinkingLevel = config.defaultThinkingLevel;

		this.modelRegistry.setDiagnosticPublisher(async (diagnostics) => await this._publishDiagnostics(diagnostics));

		// Every port below points back at a private method of this class, so the
		// dependency edge stays one-way: a runtime knows its callbacks and nothing
		// about the orchestrator.
		this._events = new OrchestratorEventBus({
			diagnose: async (diagnostic, options) => await this._publishDiagnostic(diagnostic, options),
		});
		this._context = new AgentContextMonitor({
			sessionManager: this.sessionManager,
			resolve: (agentId) => {
				const liveAgent = this._live.get(agentId);
				return liveAgent ? { generation: liveAgent.generation, model: liveAgent.harness.getModel() } : undefined;
			},
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
		});
		this._humanRequests = new HumanRequestBroker({
			findHumanRequestHandler: () => this._events.findHumanRequestHandler(),
			emit: async (event) => await this._emit(event),
			publishDiagnostic: async (diagnostic) => await this._publishDiagnostic(diagnostic),
			recordAgentLifecycleFailure: async (agentId, code, message) =>
				await this._recordAgentLifecycleFailure(agentId, code, message),
		});
		this._auth = new AuthRuntimeController({
			models: this.modelRegistry,
			humanRequests: this._humanRequests,
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
			diagnoseMany: async (diagnostics) => await this._publishDiagnostics(diagnostics),
		});
		this._messages = new MessageDeliveryQueue({
			resolvePhase: (agentId) => this._resolveDeliveryPhase(agentId),
			deliver: async (request) => await this._deliverQueuedMessage(request),
		});
		this._extensionCoreActions = this._createExtensionCoreActions();
	}

	getDefaultModel(): RuntimeModel | undefined {
		return this._defaultModel;
	}

	/**
	 * A fresh install boots with no authenticated model so the user can reach
	 * /login; the refusal lands here, at the first spawn that needs one.
	 */
	private _requireDefaultModel(): RuntimeModel {
		if (!this._defaultModel) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.none_available",
				message: "No model is available. Log in with /login or set a provider API key, then pick one with /model.",
			});
		}
		return this._defaultModel;
	}

	/**
	 * What a top-level agent starts under, for this run and the next. Persisted
	 * because `/model` is the only way a user picks a model at all: a choice that
	 * lived until the process exited would have to be made again every run, and
	 * the settings file would keep naming a model the user stopped using. An
	 * agent already running is not touched - its model is on its own branch.
	 */
	setDefaultModel(model: RuntimeModel): void {
		this._defaultModel = model;
		this.settingManager.setDefaultModelAndProvider(model.provider, model.id);
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this._defaultThinkingLevel;
	}

	/** Persisted for the same reason `setDefaultModel` is. */
	setDefaultThinkingLevel(level: ThinkingLevel | undefined): void {
		this._defaultThinkingLevel = level;
		// A level is either on or absent; there is no "unset" to write, so
		// clearing it leaves the file naming the last level that was chosen.
		if (level !== undefined) this.settingManager.setDefaultThinkingLevel(level);
	}

	getDefaultProfileId(): string {
		return this._defaultProfileId;
	}

	setDefaultProfileId(profileId: string): void {
		this._defaultProfileId = profileId;
	}

	getEnabledProfileIds(): readonly string[] | undefined {
		return this._enabledProfileIds ? [...this._enabledProfileIds] : undefined;
	}

	setEnabledProfileIds(profileIds: readonly string[] | undefined): void {
		this._enabledProfileIds = profileIds ? [...profileIds] : undefined;
	}

	/**
	 * Separate from the constructor: at construction no client has subscribed
	 * yet, so anything emitted there reaches nobody.
	 */
	async emitStartupDiagnostics(): Promise<void> {
		await this._publishDiagnostics(this._drainCoreDiagnostics());
	}

	// -----------------------------------------------------------------------
	// Registry lookup and projection
	// -----------------------------------------------------------------------

	/**
	 * The single lookup entry point, giving the complete gate answer at once.
	 * There is no second cross-table join afterwards: the hit itself carries the
	 * harness, profile, settings, and runner.
	 */
	private _resolveAgent(agentId: AgentId): AgentLookup {
		const liveAgent = this._live.get(agentId);
		if (liveAgent) return { kind: "live", liveAgent };
		if (this._tombstones.has(agentId)) return { kind: "gone" };
		const reservation = this._agentCreations.get(agentId);
		if (reservation) return { kind: "creating", reservation };
		return { kind: "unknown" };
	}

	/** The live branch of `_resolveAgent`; the other three all throw. */
	private _requireLiveAgent(agentId: AgentId): LiveAgent {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind === "live") return lookup.liveAgent;
		throw new OrchestratorError({
			severity: "error",
			code:
				lookup.kind === "gone"
					? "orchestrator.agent_gone"
					: lookup.kind === "creating"
						? "orchestrator.agent_creating"
						: "orchestrator.agent_unknown",
			message:
				lookup.kind === "gone"
					? `Agent ${agentId} is gone.`
					: lookup.kind === "creating"
						? `Agent ${agentId} is still being created.`
						: `Unknown agent: ${agentId}`,
			agentId,
		});
	}

	/**
	 * Take the harness, rejecting `compaction` and `branch_summary` - the phases
	 * that would accept text nothing reads.
	 *
	 * Idle is deliberately not rejected here: the harness already throws
	 * `invalid_state` for steer and follow-up, and abort while idle is meaningful
	 * (it drains the queues). Blocking only maintenance is what lets all four
	 * entry points share this helper.
	 */
	private _requireHarnessOutsideMaintenance(agentId: AgentId, action: string): WidiAgentHarness {
		const harness = this._requireLiveAgent(agentId).harness;
		const maintenance = maintenanceKindOf(harness.getPhase());
		if (maintenance) {
			throw new AgentHarnessError(
				"busy",
				`Agent ${agentId} cannot ${action} during ${maintenanceDescription(maintenance)}.`,
			);
		}
		return harness;
	}

	/**
	 * Mapped straight from the harness phase. The mapping only holds for a live
	 * agent: a shut-down harness also reports idle, and the `_live` miss rejects
	 * it before this point.
	 */
	getAgentActivity(agentId: AgentId): AgentActivitySnapshot {
		return toActivitySnapshot(this._requireLiveAgent(agentId).harness.getPhase());
	}

	private _snapshotAgent(liveAgent: LiveAgent): AgentSnapshot {
		const { agentId, harness } = liveAgent;
		const spawnedBy = this._spawnParent.get(agentId);
		const contextUsage = this._context.get(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			cwd: liveAgent.workspace.cwd,
			profile: liveAgent.profile,
			...(spawnedBy === undefined ? undefined : { spawnedBy }),
			...(liveAgent.sessionMetadata === undefined ? undefined : { sessionMetadata: liveAgent.sessionMetadata }),
			...(liveAgent.sessionRef === undefined ? undefined : { sessionRef: liveAgent.sessionRef }),
			model: harness.getModel(),
			thinkingLevel: harness.getThinkingLevel(),
			tools: this._snapshotAgentTools(liveAgent),
			activity: toActivitySnapshot(harness.getPhase()),
			extensions: liveAgent.extensionRunner.inspect(),
			diagnostics: [...(this._agentDiagnostics.get(agentId) ?? [])],
			...(contextUsage === undefined ? undefined : { contextUsage }),
		};
	}

	inspectAgent(agentId: AgentId): AgentSnapshot {
		return this._snapshotAgent(this._requireLiveAgent(agentId));
	}

	/** Live agents only; surfaces drop a row on `agent_disposed`. */
	listAgents(): AgentListResult {
		return { agents: Array.from(this._live.values(), (liveAgent) => this._snapshotAgent(liveAgent)) };
	}

	/**
	 * `_live` and `_tombstones` are disjoint, and every parent in `_spawnParent`
	 * is live or a tombstone. For lifecycle boundaries and tests; never part of a
	 * business branch.
	 */
	private _assertRegistryInvariant(agentId?: AgentId): void {
		for (const id of agentId ? [agentId] : this._live.keys()) {
			if (this._live.has(id) && this._tombstones.has(id)) {
				throw new Error(`Agent ${id} is both live and a tombstone.`);
			}
		}
		for (const [child, parent] of this._spawnParent) {
			if (!this._live.has(parent) && !this._tombstones.has(parent)) {
				throw new Error(`Spawn edge ${child} -> ${parent} points at an unknown agent.`);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Spawn tree traversal
	// -----------------------------------------------------------------------

	/** Walk `_spawnParent` to the root, cycle-safe. */
	private _resolveAgentTreeRoot(agentId: AgentId): AgentId {
		const seen = new Set<AgentId>([agentId]);
		let current = agentId;
		for (;;) {
			const parent = this._spawnParent.get(current);
			if (parent === undefined || seen.has(parent)) return current;
			seen.add(parent);
			current = parent;
		}
	}

	private _agentsShareTree(firstAgentId: AgentId, secondAgentId: AgentId): boolean {
		return this._resolveAgentTreeRoot(firstAgentId) === this._resolveAgentTreeRoot(secondAgentId);
	}

	/** Cycle-safe subtree snapshot in a deterministic leaf-to-root order. */
	private _collectAgentSubtreePostOrder(agentId: AgentId): readonly AgentId[] {
		const children = new Map<AgentId, AgentId[]>();
		for (const [child, parent] of this._spawnParent) {
			const siblings = children.get(parent);
			if (siblings) siblings.push(child);
			else children.set(parent, [child]);
		}
		const ordered: AgentId[] = [];
		const visited = new Set<AgentId>();
		const visit = (current: AgentId): void => {
			if (visited.has(current)) return;
			visited.add(current);
			for (const child of children.get(current) ?? []) visit(child);
			ordered.push(current);
		};
		visit(agentId);
		return ordered;
	}

	private async _listAgentTree(agentId: AgentId): Promise<AgentTreeListing> {
		const rootAgentId = this._resolveAgentTreeRoot(agentId);
		const liveInTree = [...this._live.values()].filter(
			(liveAgent) => this._resolveAgentTreeRoot(liveAgent.agentId) === rootAgentId,
		);
		const liveByRef = new Map<string, LiveAgent>();
		const liveChildren = new Map<AgentId, LiveAgent[]>();
		for (const liveAgent of liveInTree) {
			if (liveAgent.sessionRef !== undefined) liveByRef.set(liveAgent.sessionRef, liveAgent);
			const parent = this._spawnParent.get(liveAgent.agentId);
			if (parent === undefined) continue;
			const siblings = liveChildren.get(parent);
			if (siblings) siblings.push(liveAgent);
			else liveChildren.set(parent, [liveAgent]);
		}
		const walked = await this._readAgentSessionTrees([rootAgentId, ...liveInTree.map((live) => live.agentId)]);

		const rendered = new Set<AgentId>();
		const fromLiveAgent = (liveAgent: LiveAgent): AgentTreeEntry => {
			rendered.add(liveAgent.agentId);
			const node = liveAgent.sessionRef === undefined ? undefined : walked.nodesByRef.get(liveAgent.sessionRef);
			const children = (node?.children ?? []).map(fromSessionNode);
			// Live agents whose session is not under this one's directory: an
			// ephemeral spawner owns no directory, and a spawn too deep to nest
			// degrades to a top-level session. The spawn edge is still the truth.
			for (const child of liveChildren.get(liveAgent.agentId) ?? []) {
				if (!rendered.has(child.agentId)) children.push(fromLiveAgent(child));
			}
			const { reference } = liveAgent.profile;
			return {
				status: "running",
				agentId: liveAgent.agentId,
				...(node === undefined ? undefined : { sessionAgentId: node.id }),
				activity: toActivitySnapshot(liveAgent.harness.getPhase()).activity,
				profileId: reference.id,
				...(reference.label === undefined ? undefined : { label: reference.label }),
				...(liveAgent.sessionRef === undefined ? undefined : { sessionRef: liveAgent.sessionRef }),
				children,
			};
		};
		const fromSessionNode = (node: AgentSessionTreeNode): AgentTreeEntry => {
			const liveAgent = liveByRef.get(node.ref);
			if (liveAgent) return fromLiveAgent(liveAgent);
			return {
				status: "closed",
				sessionRef: node.ref,
				// Withheld once this runtime has buried the id, so a message cannot
				// reopen a session whose agent it disposed or is disposing. A live agent
				// elsewhere holding the same id is not that: the session here is another
				// one, and reopening it takes a free id.
				...(this._resolveAgent(node.id).kind === "gone" ? undefined : { sessionAgentId: node.id }),
				...(node.profile === undefined ? undefined : { profileId: node.profile.id }),
				...(node.profile?.label === undefined ? undefined : { label: node.profile.label }),
				createdAt: node.createdAt,
				children: node.children.map(fromSessionNode),
			};
		};

		const entries: AgentTreeEntry[] = [];
		const rootLiveAgent = this._live.get(rootAgentId);
		const rootRef = this.sessionManager.getAgentSessionRef(rootAgentId);
		const rootNode = rootRef === undefined ? undefined : walked.nodesByRef.get(rootRef);
		if (rootLiveAgent) entries.push(fromLiveAgent(rootLiveAgent));
		else if (rootNode) entries.push(fromSessionNode(rootNode));
		// Whatever the root did not reach becomes a root of its own, but only once
		// its own spawner has had its turn - otherwise a child would be promoted
		// out from under a parent that was going to render it.
		for (const liveAgent of liveInTree) {
			const parent = this._spawnParent.get(liveAgent.agentId);
			if (rendered.has(liveAgent.agentId) || (parent !== undefined && this._live.has(parent))) continue;
			entries.push(fromLiveAgent(liveAgent));
		}
		// A spawn-edge cycle leaves every member skipped above; listing them flat
		// beats dropping them, and matches how the other traversals stay cycle-safe.
		for (const liveAgent of liveInTree) {
			if (!rendered.has(liveAgent.agentId)) entries.push(fromLiveAgent(liveAgent));
		}
		return { entries, ...(walked.unavailable ? { closedUnavailable: true } : undefined) };
	}

	/**
	 * Index every session directory reachable from these agents, one walk per
	 * tree they do not share.
	 *
	 * Normally the first walk answers everything, since the root's directory
	 * holds the whole tree; the rest of the list then costs one map lookup each.
	 * A failed walk is reported and skipped rather than thrown: which agents are
	 * running is readable from memory alone, and losing that answer to a
	 * filesystem error would be the worse trade.
	 */
	private async _readAgentSessionTrees(
		agentIds: readonly AgentId[],
	): Promise<{ readonly nodesByRef: ReadonlyMap<string, AgentSessionTreeNode>; readonly unavailable: boolean }> {
		const nodesByRef = new Map<string, AgentSessionTreeNode>();
		const index = (node: AgentSessionTreeNode): void => {
			nodesByRef.set(node.ref, node);
			for (const child of node.children) index(child);
		};
		let unavailable = false;
		for (const agentId of agentIds) {
			const ref = this.sessionManager.getAgentSessionRef(agentId);
			const address = this.sessionManager.getAgentSessionAddress(agentId);
			if (ref === undefined || address === undefined || nodesByRef.has(ref)) continue;
			try {
				const node = await this.sessionManager.listAgentSessionTree(address);
				if (node) index(node);
			} catch (error) {
				unavailable = true;
				await this._publishDiagnostic({
					severity: "warning",
					code: "orchestrator.session_tree_unreadable",
					message: `Sessions under ${ref} could not be listed: ${formatError(error)}`,
					agentId,
				});
			}
		}
		return { nodesByRef, unavailable };
	}

	/**
	 * Drop this agent's edge once it has no surviving descendants, then walk up
	 * dropping every ancestor tombstone edge that likewise has none. Without it a
	 * session that spawns and disposes in a loop accumulates one dead edge per
	 * spawn.
	 */
	private _pruneSpawnEdges(agentId: AgentId): void {
		let current: AgentId | undefined = agentId;
		while (current !== undefined && !this._live.has(current)) {
			let hasDescendant = false;
			for (const parent of this._spawnParent.values()) {
				if (parent === current) {
					hasDescendant = true;
					break;
				}
			}
			if (hasDescendant) return;
			const next = this._spawnParent.get(current);
			this._spawnParent.delete(current);
			current = next;
		}
	}

	// -----------------------------------------------------------------------
	// Spawn
	// -----------------------------------------------------------------------

	/**
	 * The only creation entry point. It returns an AgentId and nothing else: the
	 * harness never crosses this boundary.
	 */
	async spawnAgent(options: SpawnAgentOptions): Promise<AgentId> {
		await this.emitStartupDiagnostics();
		if (this._shutdownRequested) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.shutdown",
				message: "The runtime is shutting down and cannot spawn agents.",
			});
		}
		if (options.parent !== undefined) this._assertAgentCanParent(options.parent);

		const request = await this._resolveAgentBuild(options);
		// A resume that names a session another caller is already resuming waits for
		// that build instead of opening the same session twice.
		const existing = this._agentCreations.get(request.agentId);
		if (existing) return await existing.completion;
		if (this._live.has(request.agentId)) return request.agentId;

		const reservation = this._createAgentCreationReservation(request.agentId);
		try {
			const build = await this._buildLiveAgent(request, reservation);
			if (reservation.cancelled) {
				await this._releaseFailedBuild(
					request.agentId,
					build,
					new Error(`Creation of agent ${request.agentId} was cancelled.`),
				);
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.agent_creation_cancelled",
					message: `Creation of agent ${request.agentId} was cancelled.`,
					agentId: request.agentId,
				});
			}
			const agentId = this._installLiveAgent(build);
			// Released before the lifecycle event so a listener may synchronously
			// dispose the agent it was just told about.
			this._finishAgentCreation(agentId, reservation, agentId);
			// The first activity edge for this agent, ahead of both the resume
			// notices and the lifecycle event. A consumer that learns an agent's
			// activity from `agent_status_changed` must not have to special-case
			// arrival by reading the registry once at subscribe time.
			await this._publishAgentActivityEdge(agentId, build.liveAgent.harness.getPhase());
			// The first arrival at idle, stamped `ready` by `_installLiveAgent`. It
			// has no turn behind it, and a consumer that waits to be told an agent is
			// ready has nothing else to wait for.
			await this._settleAgentIdle(agentId);
			if (this._live.has(agentId)) {
				await this._emit(
					request.origin === "resume"
						? {
								type: "agent_resumed",
								agentId,
								profile: request.resolvedProfile.profile,
								model: build.liveAgent.harness.getModel(),
								...(request.parent === undefined ? undefined : { spawnedBy: request.parent }),
							}
						: {
								type: "agent_spawned",
								agentId,
								profile: request.resolvedProfile.profile,
								model: build.liveAgent.harness.getModel(),
								origin: request.origin,
								...(request.parent === undefined ? undefined : { spawnedBy: request.parent }),
							},
				);
			}
			return agentId;
		} catch (error) {
			this._finishAgentCreation(request.agentId, reservation, undefined, error);
			throw error;
		}
	}

	/**
	 * Resolve an origin into a build request. `new` and `fork` allocate a readable
	 * AgentId and create the session under it, `resume` reuses the id the session
	 * recorded. Nothing live is registered here.
	 */
	private async _resolveAgentBuild(options: SpawnAgentOptions): Promise<AgentBuildRequest> {
		const settings = this._captureAgentSettings();
		if (options.origin.kind === "resume") {
			const info =
				typeof options.origin.reference === "string"
					? await this.sessionManager.resolveAgentSessionReference(options.origin.reference, options.cwd)
					: options.origin.reference;
			const resolvedProfile = await this._resolveResumeProfile(info.metadata.id, info.metadata);
			const agentId = this._resumeAgentId(info, resolvedProfile.profile);
			const diagnostics = new PersistenceDiagnostics();
			const session = await this.sessionManager.resumeAgentSession({ agentId, info, diagnostics });
			await this._publishPersistenceDiagnostics(agentId, diagnostics.entries);
			const context = await this.sessionManager.buildAgentSessionContext(agentId);
			return {
				agentId,
				origin: "resume",
				// Not the caller's choice and not the default: a session is stored
				// under the directory it was written in, and reopening it anywhere
				// else would put its continuation in a different storage group.
				workspace: await this.workspaces.resolve(info.metadata.cwd),
				resolvedProfile,
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? this._resolveResumeModel(context.model),
				thinkingLevel:
					options.thinkingLevel ?? resolveThinkingLevel(context.thinkingLevel) ?? this._defaultThinkingLevel,
				settings,
				toolPolicy: {
					requestedToolNames: resolvedProfile.profile.tools,
					activeToolSelection:
						context.activeToolNames == null
							? { mode: "default_all" }
							: { mode: "explicit", toolNames: [...context.activeToolNames] },
				},
				parent: options.parent,
			};
		}

		if (options.origin.kind === "fork") {
			const source = this._requireLiveAgent(options.origin.sourceAgentId);
			if (!source.resolvedProfile.persist) {
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.agent_not_forkable",
					message: `Agent ${source.agentId} has no persistent session to fork.`,
					agentId: source.agentId,
				});
			}
			// The fork owns a new session directory, so it needs an id of its own
			// before the copy: the directory name is built from it, and the source's
			// id is taken by the agent still running under it.
			const agentId = this._allocateAgentId(source.resolvedProfile);
			const forked = await this.sessionManager.forkAgentSession(source.agentId, {
				sessionId: agentId,
				...(options.origin.entryId === undefined ? undefined : { entryId: options.origin.entryId }),
			});
			await this._publishPersistenceDiagnostics(agentId, forked.diagnostics);
			await this._emit({
				type: "agent_session_forked",
				agentId: source.agentId,
				forkedSessionId: agentId,
				...(options.origin.entryId === undefined ? undefined : { entryId: options.origin.entryId }),
				createdAt: now(),
			});
			const session = await this.sessionManager.resumeAgentSession({ agentId, info: forked.info });
			return {
				agentId,
				origin: "fork",
				workspace: source.workspace,
				// The source's exact profile, overrides included: re-resolving could
				// hand the fork a profile the branch it inherits was never written under.
				resolvedProfile: {
					profile: source.resolvedProfile,
					source: source.profile.source,
					entryId: source.profile.entryId,
				},
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? source.harness.getModel(),
				thinkingLevel: options.thinkingLevel ?? source.harness.getThinkingLevel(),
				settings,
				toolPolicy: source.toolPolicy,
				parent: options.parent,
			};
		}

		const resolvedProfile = await this._resolveCreateProfile(options.origin);
		const agentId = this._allocateAgentId(resolvedProfile.profile);
		// A spawn inherits the spawner's model and thinking level, exactly as a
		// fork does: a caller that switched model and then delegates means the
		// delegate to run under it too, and a profile names a role, never a model.
		// Only a top-level agent, which has no spawner to follow, takes the
		// runtime defaults.
		const parent = options.parent === undefined ? undefined : this._requireLiveAgent(options.parent);
		// A spawned agent works where its spawner does, and `options.cwd` is not
		// consulted at all in that case. That is the whole of "no cross-workspace
		// subagents": there is no check to pass because there is no way to ask.
		const workspace = parent
			? parent.workspace
			: options.cwd === undefined
				? this.workspaces.startup
				: await this.workspaces.resolve(options.cwd);
		// The spawner's session directory owns the new one. That nesting is the
		// only record of the agent tree - `notes/develop/ZH/agent-tree-persistence.md` §1 -
		// so it is established here, at the one moment the parent is known.
		const diagnostics = new PersistenceDiagnostics();
		const session = await this.sessionManager.createAgentSession({
			agentId,
			agentProfile: resolvedProfile.profile,
			cwd: workspace.cwd,
			...(options.parent === undefined ? undefined : { parentAgentId: options.parent }),
			diagnostics,
		});
		await this._publishPersistenceDiagnostics(agentId, diagnostics.entries);
		return {
			agentId,
			origin: "new",
			workspace,
			resolvedProfile,
			session,
			sessionMetadata: await session.getMetadata(),
			model: options.model ?? parent?.harness.getModel() ?? this._requireDefaultModel(),
			thinkingLevel: options.thinkingLevel ?? parent?.harness.getThinkingLevel() ?? this._defaultThinkingLevel,
			settings,
			toolPolicy: { requestedToolNames: resolvedProfile.profile.tools, activeToolSelection: { mode: "default_all" } },
			parent: options.parent,
		};
	}

	/**
	 * Build everything in local variables; the live registry is not touched until
	 * this succeeds.
	 *
	 * Order matters: activate the runner, apply provider contributions, resolve
	 * scoped tools against those contributions, create the harness, then bind.
	 * The reservation is re-checked after every await, and any failure releases
	 * in reverse order.
	 */
	private async _buildLiveAgent(
		request: AgentBuildRequest,
		reservation: AgentCreationReservation,
	): Promise<LiveAgentBuild> {
		const { agentId, resolvedProfile } = request;
		const { profile } = resolvedProfile;
		const generation = (this._agentGenerations.get(agentId) ?? 0) + 1;
		const partial: {
			extensionRunner?: ExtensionRunner;
			extensionBindings?: ExtensionRunnerBindings;
			harness?: WidiAgentHarness;
			releaseHarnessBindings?: () => Promise<void>;
		} = {};

		try {
			const sessionRef = this.sessionManager.getAgentSessionRef(agentId);

			const extensionRunner = await this._createExtensionRunner(agentId, profile.id);
			partial.extensionRunner = extensionRunner;
			await this._publishDiagnostics(extensionRunner.diagnostics);
			this._addAgentDiagnostics(agentId, extensionRunner.diagnostics);
			const blocked = extensionRunner.diagnostics.find(isBlockedExtensionDiagnostic);
			if (blocked) throw new OrchestratorError(blocked);
			// Before the harness exists, so contributed models are selectable from the
			// first turn. This spawn's own model resolution already happened.
			await this._applyExtensionProviderContributions(agentId, extensionRunner);
			this._applyExtensionProfileContributions(agentId, extensionRunner);
			this._assertBuildNotCancelled(agentId, reservation);

			const loaded = await request.workspace.resourceLoader.loadAgentResources(profile);
			const resourceDiagnostics = loaded.diagnostics.map((diagnostic) => ({ ...diagnostic, agentId }));
			await this._publishDiagnostics(resourceDiagnostics);
			this._addAgentDiagnostics(agentId, resourceDiagnostics);
			this._assertBuildNotCancelled(agentId, reservation);

			const resources: AgentResourcesSnapshot = {
				skills: loaded.skills.map(({ skill, source }) => ({ name: skill.name, source })),
				promptTemplates: loaded.promptTemplates.map(({ promptTemplate, source }) => ({
					name: promptTemplate.name,
					source,
				})),
			};
			const systemPrompt: AgentSystemPromptFacts = {
				basePrompt: profile.systemPrompt,
				skills: loaded.skills.map(({ skill }) => skill),
				// The role's own append text is the most specific statement about this
				// agent, so it comes first; extension sections follow, read per turn.
				appendSections: profile.appendSystemPrompt ? [profile.appendSystemPrompt] : [],
				contextFiles: loaded.contextFiles,
				...(profile.skillsListing === undefined ? undefined : { includeSkills: profile.skillsListing }),
				// The agent's own workspace, not the execution env's: the file tools
				// resolve relative paths against it, and the prompt must name the same one.
				...((profile.includeCwd ?? true) ? { cwd: request.workspace.cwd } : undefined),
			};

			const resolvedTools = await this._resolveAgentToolsForBuild(agentId, request.toolPolicy, extensionRunner);
			this._assertBuildNotCancelled(agentId, reservation);

			const harness: WidiAgentHarness = new AgentHarness({
				session: request.session,
				models: this.modelRegistry.getRuntime(),
				toolContext: () => this._createToolAdapterContext(agentId, profile.id),
				streamOptions: request.settings.providerRetry,
				retry: request.settings.retry,
				tools: resolvedTools.tools,
				// A callback, so the listing tracks the harness's active tools at each
				// turn start and follows a reload that replaced the runner.
				systemPrompt: ({ activeTools }) => this._composeAgentSystemPrompt(agentId, activeTools),
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				activeToolNames: [...resolvedTools.activeToolNames],
				steeringMode: this.settingManager.getSteeringMode(),
				followUpMode: this.settingManager.getFollowUpMode(),
			});
			partial.harness = harness;

			const liveAgent: LiveAgent = {
				agentId,
				generation,
				workspace: request.workspace,
				profile: createAgentProfileRecordReference(resolvedProfile),
				resolvedProfile: profile,
				...(request.sessionMetadata === undefined ? undefined : { sessionMetadata: request.sessionMetadata }),
				...(sessionRef === undefined ? undefined : { sessionRef }),
				resources,
				systemPrompt,
				harness,
				settings: request.settings,
				extensionRunner,
				extensionBindings: { release: async () => {} },
				toolPolicy: resolvedTools.policy,
				releaseHarnessBindings: async () => {},
			};

			const extensionBindings = await this._bindExtensionRunner(agentId, generation, harness, extensionRunner);
			partial.extensionBindings = extensionBindings;
			liveAgent.extensionBindings = extensionBindings;

			const releaseHarnessBindings = await this._bindHarness(agentId, generation, harness);
			partial.releaseHarnessBindings = releaseHarnessBindings;
			Object.assign(liveAgent, { releaseHarnessBindings });
			this._assertBuildNotCancelled(agentId, reservation);

			return request.parent === undefined ? { liveAgent } : { liveAgent, parent: request.parent };
		} catch (error) {
			await this._releaseFailedBuild(agentId, partial, error);
			throw error;
		}
	}

	/**
	 * Spawn's only routing cutover, with no await in between. Appearing in `_live`
	 * is what makes an agent routable; there is no intermediate "registered but
	 * harness pending" state for anything to observe.
	 */
	private _installLiveAgent(build: LiveAgentBuild): AgentId {
		const { liveAgent } = build;
		const { agentId } = liveAgent;
		this._agentGenerations.set(agentId, liveAgent.generation);
		// A resumed session legitimately reuses an id this runtime buried earlier.
		this._tombstones.delete(agentId);
		this._live.set(agentId, liveAgent);
		// The first idle has no turn behind it; every later one is stamped by
		// whoever ended the work.
		this._agentIdleCauses.set(agentId, { reason: "ready" });
		if (build.parent !== undefined) {
			this._spawnParent.set(agentId, build.parent);
		}
		this._context.attach(agentId, liveAgent.generation);
		this._assertRegistryInvariant(agentId);
		return agentId;
	}

	/**
	 * Release a build that failed or was cancelled.
	 *
	 * `shutdown()` rather than `abort()`: this harness was never routable, but the
	 * build may already have bound interceptors or written to its session, so
	 * sealing it is closer to the truth than leaving it usable.
	 *
	 * **No tombstone is written**: the agent never existed, so its AgentId stays
	 * available to a later spawn. The failure reaches the caller as the throw.
	 */
	private async _releaseFailedBuild(
		agentId: AgentId,
		build: {
			extensionRunner?: ExtensionRunner;
			extensionBindings?: ExtensionRunnerBindings;
			harness?: WidiAgentHarness;
			releaseHarnessBindings?: () => Promise<void>;
			liveAgent?: LiveAgent;
		},
		error: unknown,
	): Promise<void> {
		const liveAgent = build.liveAgent;
		const harness = build.harness ?? liveAgent?.harness;
		const runner = build.extensionRunner ?? liveAgent?.extensionRunner;
		const bindings = build.extensionBindings ?? liveAgent?.extensionBindings;
		const releaseHarnessBindings = build.releaseHarnessBindings ?? liveAgent?.releaseHarnessBindings;

		await this._tryTeardown(agentId, "release harness bindings", async () => {
			await releaseHarnessBindings?.();
		});
		if (harness) {
			await this._tryTeardown(agentId, "shut down harness", async () => {
				await harness.shutdown();
			});
		}
		if (runner) {
			await this._tryTeardown(agentId, "dispose extension runner", async () => {
				await this._disposeExtensionRunner(agentId, runner, bindings, "Agent creation failed.");
			});
		}
		await this._tryTeardown(agentId, "withdraw providers", async () => {
			await this._withdrawExtensionProviderContributions(agentId);
			this._withdrawExtensionProfileContributions(agentId);
		});
		await this._clearExtensionStatusesForAgent(agentId);
		this._agentDiagnostics.delete(agentId);
		await this._publishDiagnostic({
			severity: "error",
			code: "orchestrator.agent_creation_failed",
			message: `Cannot create agent ${agentId}: ${formatError(error)}`,
			agentId,
		});
	}

	/** A readable AgentId that collides with no live agent and no tombstone. */
	/**
	 * The id a resumed session's agent runs under.
	 *
	 * The header id normally answers: it is the id the session was created with,
	 * and restoring the agent under it keeps a resumed conversation recognizable.
	 * It is not an address though - it names whichever agent created that session,
	 * and a session written by another run can carry the same one. While it is
	 * held by a live agent that is not this very session, reusing it would hand
	 * the caller that agent instead of this session, silently. So this session
	 * takes a fresh id, and the header keeps naming its creator.
	 */
	private _resumeAgentId(info: PersistedSessionInfo, profile: AgentProfile): AgentId {
		const headerAgentId = info.metadata.id;
		const bound = this.sessionManager.getAgentSessionAddress(headerAgentId);
		const boundToThisSession = bound !== undefined && sessionKeysEqual(bound.key, info.address.key);
		if (boundToThisSession || !this._live.has(headerAgentId)) return headerAgentId;
		return this._allocateAgentId(profile);
	}

	/**
	 * A readable, runtime-unique agent id: the profile it runs, plus four random
	 * characters.
	 *
	 * The random half is what keeps ids from repeating across runs, and the
	 * session directory named after one needs exactly that. A counter would
	 * restart at 1 in every runtime, so a resumed root's first child would be
	 * handed the name the previous run's first child already owns - and creating
	 * a session writes its header with `writeFile`, which truncates rather than
	 * fails.
	 *
	 * Four characters, not a UUID: an id is quoted back by the model on every
	 * `send_message` and read by a human in the agent strip, and `worker-a3f9`
	 * stays inside the compact width where a UUID would be shown as a tail.
	 * Collisions inside one runtime are resolved by drawing again, and
	 * persistence still checks the directory it is about to create.
	 */
	private _allocateAgentId(profile: AgentProfile): AgentId {
		const base =
			profile.id
				.trim()
				.toLocaleLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "agent";
		for (;;) {
			const agentId: AgentId = `${base}-${randomAgentIdSuffix()}`;
			if (this._resolveAgent(agentId).kind === "unknown") return agentId;
		}
	}

	private _assertAgentCanParent(parentAgentId: AgentId): void {
		this._requireLiveAgent(parentAgentId);
	}

	private _createAgentCreationReservation(agentId: AgentId): AgentCreationReservation {
		let settle!: (agentId: AgentId) => void;
		let fail!: (error: unknown) => void;
		const completion = new Promise<AgentId>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const reservation: AgentCreationReservation = {
			agentId,
			completion,
			cancelled: false,
			cancel: () => {
				reservation.cancelled = true;
			},
		};
		// A rejection with no awaiter is an unhandled rejection.
		completion.catch(() => {});
		Object.assign(reservation, { _settle: settle, _fail: fail });
		this._agentCreations.set(agentId, reservation);
		return reservation;
	}

	private _finishAgentCreation(
		agentId: AgentId,
		reservation: AgentCreationReservation,
		result: AgentId | undefined,
		error?: unknown,
	): void {
		if (this._agentCreations.get(agentId) === reservation) {
			this._agentCreations.delete(agentId);
		}
		const settlers = reservation as unknown as { _settle: (agentId: AgentId) => void; _fail: (error: unknown) => void };
		if (result === undefined) settlers._fail(error);
		else settlers._settle(result);
	}

	private _assertBuildNotCancelled(agentId: AgentId, reservation: AgentCreationReservation): void {
		if (!reservation.cancelled) return;
		throw new OrchestratorError({
			severity: "error",
			code: "orchestrator.agent_creation_cancelled",
			message: `Creation of agent ${agentId} was cancelled.`,
			agentId,
		});
	}

	// -----------------------------------------------------------------------
	// Dispose
	// -----------------------------------------------------------------------

	/**
	 * Dispose one agent or a whole subtree. Every target completes its `_live`
	 * removal, tombstone write and background detach before the first await, so
	 * "is it routable" collapses to `_live.has(agentId)` and no second `disposing`
	 * set is needed.
	 */
	async disposeAgent(agentId: AgentId, options: DisposeAgentOptions): Promise<readonly AgentId[]> {
		const targets = options.scope === "subtree" ? this._collectAgentSubtreePostOrder(agentId) : [agentId];
		// Duplicate requests share one teardown. A subtree dispose must wait for a
		// descendant somebody else is tearing down before it removes the ancestor,
		// which is what makes this a lookup rather than a skip.
		const pending = targets
			.map((target) => this._agentDisposals.get(target))
			.filter((reservation) => reservation !== undefined);
		if (pending.length > 0) {
			await Promise.allSettled(pending.map((entry) => entry.completion));
		}

		const disposed = this._cutOverDisposed(targets, options);
		if (disposed.length === 0) return [];

		const failures: unknown[] = [];
		for (const target of disposed) {
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			this._agentDisposals.set(target.agentId, { agentId: target.agentId, completion });
			try {
				await this._disposeLiveAgent(target, options);
			} catch (error) {
				failures.push(error);
			} finally {
				const reservation = this._agentDisposals.get(target.agentId);
				if (reservation?.completion === completion) {
					this._agentDisposals.delete(target.agentId);
				}
				settle();
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, `Failed to dispose ${failures.length} agents in subtree ${agentId}.`);
		}
		return disposed.map((target) => target.agentId);
	}

	/**
	 * Complete the cutover with no await. `_spawnParent` is not deleted here: the
	 * edge belongs to surviving descendants.
	 *
	 * Cancelling the queue must precede the harness teardown: a cancelled queue
	 * swaps its array, which is how requeue logic decides an undeliverable message
	 * is `target_unavailable` instead of taking an extra lap through a shutdown
	 * code.
	 */
	private _cutOverDisposed(targets: readonly AgentId[], options: DisposeAgentOptions): readonly DisposedLiveAgent[] {
		const disposed: DisposedLiveAgent[] = [];
		for (const agentId of targets) {
			const liveAgent = this._live.get(agentId);
			const creation = this._agentCreations.get(agentId);
			if (!liveAgent && !creation) continue;
			// Cancelled rather than waited on: the build's own failure path releases
			// everything it had allocated.
			creation?.cancel();
			this._live.delete(agentId);
			if (options.intent === "removed") this._tombstones.add(agentId);
			this._messages.cancel(
				agentId,
				options.reason ?? `Agent ${agentId} was disposed before the message was delivered.`,
			);
			if (liveAgent) this._disposingHarnesses.set(agentId, liveAgent.harness);
			disposed.push(liveAgent ? { agentId, liveAgent } : { agentId });
		}
		return disposed;
	}

	/**
	 * Release the harness, runner, bindings and surrounding workflows through the
	 * references captured before the cutover. Failures record a diagnostic and
	 * never restore live routing.
	 *
	 * **abort() first, then shutdown().** `abort()` lets the interrupted turn run
	 * its `finally` and flush the session writes it buffered; `shutdown()`
	 * **discards** pending writes and so can never stand in for it. Both are
	 * idempotent.
	 *
	 * **shutdown() may only be disposal's tail.** `abort()` is not a tracked task,
	 * so a concurrent shutdown can clear the subscriber table before abort emits
	 * its last event. That is harmless only because this disposal is the sole
	 * source of concurrency; a future "seal the harness but keep the agent" use
	 * requires making `abort()` a harness lifecycle task first.
	 *
	 * `shutdown()` waits unbounded - it depends on every awaited tool honouring
	 * the abort signal, and `ask_human` inside a tool call is a counter-example -
	 * so the timeout is required. On expiry the teardown continues without
	 * restoring routing; the harness has already sealed further writes.
	 */
	private async _disposeLiveAgent(disposed: DisposedLiveAgent, options: DisposeAgentOptions): Promise<void> {
		const { agentId, liveAgent } = disposed;
		const reason = options.reason ?? `Agent disposed: ${agentId}`;

		this._humanInterrupts.forget(agentId);
		this._resolveAgentRunStartWaiters(agentId);
		this._rejectAgentIdleWaiters(agentId, `Agent ${agentId} was disposed while waiting for it to idle.`);
		// A resumed session reuses this id; all of these describe the occupant that
		// just left.
		this._agentIdleCauses.delete(agentId);
		this._publishedAgentIdles.delete(agentId);
		this._agentPromptRuns.delete(agentId);
		this._agentRunSignals.delete(agentId);
		this._autoCompactingAgents.delete(agentId);
		this._publishedAgentActivities.delete(agentId);

		if (liveAgent) {
			await this._tryTeardown(agentId, "abort", async () => {
				await liveAgent.harness.abort();
			});
			await this._tryTeardown(agentId, "release harness bindings", async () => {
				await liveAgent.releaseHarnessBindings();
			});
			await this._tryTeardown(agentId, "dispose extension runner", async () => {
				await this._disposeExtensionRunner(
					agentId,
					liveAgent.extensionRunner,
					liveAgent.extensionBindings,
					"Agent has been disposed.",
				);
			});
			await this._tryTeardown(agentId, "withdraw providers", async () => {
				await this._withdrawExtensionProviderContributions(agentId);
				this._withdrawExtensionProfileContributions(agentId);
			});
			await this._tryTeardown(agentId, "shut down harness", async () => {
				await withTimeout(
					liveAgent.harness.shutdown(),
					AGENT_SHUTDOWN_TIMEOUT_MS,
					`Timed out waiting for agent ${agentId} to shut down.`,
				);
			});
			this._context.detach(agentId, liveAgent.generation);
		}

		this._disposingHarnesses.delete(agentId);
		await this._clearExtensionStatusesForAgent(agentId);
		await this._humanRequests.cancelForAgent(agentId, reason);
		// Announced before the edge is dropped, not after: the tree this agent
		// belonged to is who the notice is for, and pruning first would resolve a
		// disposed leaf to a tree of its own with nobody left in it.
		await this._emit({
			type: "agent_disposed",
			agentId,
			intent: options.intent,
			...(options.reason === undefined ? undefined : { reason: options.reason }),
			disposedAt: now(),
		});
		this._pruneSpawnEdges(agentId);
	}

	/**
	 * Sever every live route, then release all runtime resources. Not
	 * `requestShutdown()`, which only broadcasts a request to extensions.
	 *
	 * `_shutdownRequested` first, then in-flight reservations cancelled and
	 * awaited, then the sweep with intent `runtime_shutdown` so nothing durable is
	 * written. Any other order lets an agent finish installing after the sweep
	 * passed it. When this returns every harness is sealed and its writes landed.
	 */
	async disposeAll(reason?: string): Promise<void> {
		this._shutdownRequested = true;
		for (const reservation of [...this._agentCreations.values()]) {
			reservation.cancel();
		}
		await Promise.allSettled([...this._agentCreations.values()].map((reservation) => reservation.completion));
		for (const agentId of [...this._live.keys()]) {
			try {
				await this.disposeAgent(agentId, {
					intent: "runtime_shutdown",
					...(reason === undefined ? undefined : { reason }),
				});
			} catch (error) {
				await this._publishDiagnostic({
					severity: "warning",
					code: "orchestrator.dispose_all_failed",
					message: `Failed to dispose agent ${agentId}: ${formatError(error)}`,
					agentId,
				});
			}
		}
		await this._humanRequests.cancelAll(reason ?? "Orchestrator disposed.");
		try {
			await this.executionEnv.cleanup();
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.dispose_all_failed",
				message: `Failed to cleanup execution environment: ${formatError(error)}`,
			});
		}
	}

	/** Run one teardown step; a failure is recorded and never re-thrown. */
	private async _tryTeardown(agentId: AgentId, step: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to ${step} for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// Input and message dispatch
	// -----------------------------------------------------------------------

	/**
	 * Hand out the message entry point, with an identity and a delivery policy
	 * already fixed to it.
	 *
	 * Every producer of model-facing text holds one of these and nothing else -
	 * there is no per-runtime wrapper on this class for background results,
	 * extension input, or the runtime's own notices. What differs between them is
	 * the binding, not the path.
	 *
	 * The two halves are bound for opposite reasons. `policy` decides what the
	 * message *does* - whether it counts as a human interrupt, whether an
	 * extension may end it, whether a failed delivery is retried - so a holder
	 * that could set it would be choosing how hard its own text lands. `source`
	 * only decides how the message is *rendered and traced*, so a request may
	 * override it freely; a holder renders its own text anyway (`request.render`),
	 * and binding the kind would not stop it from producing text that reads like
	 * any other source's.
	 */
	messageSinkFor(binding: MessageSinkBinding): MessageSink {
		return {
			send: async (request) => await this.sendMessage(request, binding),
			prompt: async (request) => await this.promptAgent(request, binding),
		};
	}

	/** The unified entry point. Resolves the request against its sink's binding. */
	async sendMessage(request: MessageRequest, binding: MessageSinkBinding): Promise<MessageSendOutcome> {
		const accepted = await this._routeMessage(toMessageDraft(request, binding), {
			requiresIdle: false,
			awaited: false,
		});
		return accepted.kind === "blocked" ? accepted : { kind: "accepted" };
	}

	/**
	 * The same pipeline, waiting for the assistant message the surface will
	 * render. Only the shell's sink exposes it: it refuses a busy target rather
	 * than queueing, which is the wrong answer for a holder that just wants its
	 * text read eventually.
	 */
	async promptAgent(request: MessageRequest, binding: MessageSinkBinding): Promise<PromptOutcome> {
		const accepted = await this._routeMessage(toMessageDraft(request, binding), { requiresIdle: true, awaited: true });
		if (accepted.kind === "blocked") return accepted;
		const completed = accepted.receipt.completed;
		if (!completed) {
			throw new Error(
				`Prompt for agent ${request.targetAgentId} was delivered as ${accepted.receipt.method} and produced no assistant message.`,
			);
		}
		return { kind: "completed", message: await completed };
	}

	/**
	 * Run one message through interception, session accounting, and the target's
	 * delivery queue. It stays in this class because every step's dependency is
	 * here: interception needs the target's runner, accounting its harness, the
	 * input events the bus.
	 *
	 * `requiresIdle` means only that the caller must receive this run's assistant
	 * result, so a busy target is refused up front rather than silently becoming a
	 * follow-up whose reply nobody awaits.
	 */
	private async _routeMessage(draft: MessageDraft, options: RouteMessageOptions): Promise<AcceptedMessage> {
		const agentId = draft.targetAgentId;
		assertMessageBody(draft.body);
		// Gate before interception and any session write: a prompt the harness would
		// reject must not emit input events or leave unpaired accounting entries.
		const target = this._resolveDeliveryTarget(agentId);
		if (options.requiresIdle && (target.phase !== "idle" || this._agentPromptRuns.has(agentId))) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.agent_busy",
				message: `Agent ${agentId} cannot accept a prompt while ${target.phase}.`,
				agentId,
			});
		}

		const outcome = await transformMessage(draft, {
			intercept: async (event) => await this._interceptExtensionInput(agentId, draft.binding.policy.blockPolicy, event),
		});

		if (outcome.kind === "block") {
			const inputId = this._createInputId();
			await this._emit({
				type: "input_blocked",
				agentId,
				inputId,
				originalText: draft.body,
				...(outcome.reason === undefined ? undefined : { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
				createdAt: now(),
			});
			return {
				kind: "blocked",
				inputId,
				...(outcome.reason === undefined ? undefined : { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
			};
		}

		if (outcome.kind === "transform") {
			const inputId = this._createInputId();
			await this._emit({
				type: "input_transformed",
				agentId,
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
				createdAt: now(),
			});
			await this._writeInputTransformEntry(target, {
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
			});
		}

		const { policy } = draft.binding;
		// The one place the model-facing text is decided. A holder's own renderer
		// runs here and only here: the queue re-attempts delivery across phase
		// changes, and a second run would give one message two versions of itself.
		const text = renderMessageContent(draft, outcome.text);
		const transformedBy = outcome.kind === "transform" ? outcome.transformedBy : undefined;
		// What this message records about itself. Absent only for the shell's own
		// human input, which keeps landing as a plain user entry.
		const entry: MessageEntryPayload | undefined =
			draft.binding.plainEntry && draft.source === draft.binding.source
				? undefined
				: {
						customType: ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
						details: {
							source: draft.source,
							body: outcome.text,
							...(transformedBy === undefined ? undefined : { transformedBy }),
							...(draft.editedByHuman ? { editedByHuman: true as const } : undefined),
						},
					};
		const receipt = await this._messages.enqueue({
			targetAgentId: agentId,
			text,
			...(entry === undefined ? undefined : { entry }),
			...(outcome.images === undefined ? undefined : { images: outcome.images }),
			mode: draft.mode,
			requiresIdle: options.requiresIdle,
			humanInterrupt: policy.humanInterrupt,
			...(policy.mergeKey === undefined ? undefined : { mergeKey: policy.mergeKey }),
			awaited: options.awaited,
			retryOnFailure: policy.retryOnFailure,
			// Reported per attempt, so a target that never accepts is visible rather
			// than silently accumulating messages. Only for a sender that keeps
			// waiting; one that gets its failure back has already been told.
			...(policy.retryOnFailure
				? {
						onDeferredFailure: (error: unknown) => {
							void this._publishDiagnostic({
								severity: "warning",
								code: "orchestrator.message_delivery_deferred",
								message: `A message from ${draft.source.label ?? draft.source.kind} to agent ${agentId} could not be delivered and will be retried at the next transition: ${formatError(error)}`,
								agentId,
							});
						},
					}
				: undefined),
		});
		return { kind: "accepted", receipt };
	}

	/**
	 * Record that an extension rewrote this message before the model saw it.
	 *
	 * **Session write.** `harness.appendCustomEntry` puts it on the branch because
	 * it is the durable half of a dual record: the user message carries the text
	 * the model read, and only this entry can still answer what was submitted
	 * after a resume. Blocked input writes nothing.
	 *
	 * The entry names its `inputId` rather than relying on adjacency, so a write
	 * buffered behind a running turn landing after the message it describes is a
	 * display-order wrinkle, not a lost pair. There is no retraction path.
	 */
	private async _writeInputTransformEntry(
		target: DeliveryTarget,
		transform: {
			readonly inputId: string;
			readonly originalText: string;
			readonly text: string;
			readonly transformedBy: readonly string[];
		},
	): Promise<void> {
		await target.harness.appendCustomEntry(INPUT_TRANSFORM_CUSTOM_TYPE, {
			inputId: transform.inputId,
			originalText: transform.originalText,
			text: transform.text,
			transformedBy: transform.transformedBy,
		} satisfies InputTransformEntryData);
	}

	/** The first availability gate: harness, generation, and the phase read on the spot. */
	private _resolveDeliveryTarget(agentId: AgentId): DeliveryTarget {
		const liveAgent = this._requireLiveAgent(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			harness: liveAgent.harness,
			phase: liveAgent.harness.getPhase(),
		};
	}

	/** The queue's `resolvePhase` port, re-read before every attempt. `undefined` means unroutable. */
	private _resolveDeliveryPhase(agentId: AgentId): MessageDeliveryPhase {
		return this._live.get(agentId)?.harness.getPhase();
	}

	/**
	 * The queue's `deliver` port. The method was chosen from the phase the queue
	 * re-read; the race between reading and calling is arbitrated by the typed
	 * harness errors, which the queue retries on the next phase change.
	 */
	private async _deliverQueuedMessage(request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt> {
		const { agentId } = request;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) {
			// Terminal for the queue: no phase change brings a routing entry back, so
			// a `retryOnFailure` message must not sit here waiting for one.
			throw new AgentHarnessError("shutdown", `Agent ${agentId} is no longer routable.`);
		}
		const { harness } = liveAgent;
		// A typed message carries its own images, so passing them again through
		// `options` would put every image on the branch twice.
		const input = toHarnessInput(request);
		const options = typeof input === "string" && request.images ? { images: [...request.images] } : undefined;
		if (request.method === "append") {
			// **Session write.** The message is the entry: there is no wake, so
			// nothing else would ever put it on the branch. `custom_message` is the
			// one entry type that carries a customType and still projects into model
			// context, which is exactly what a message nobody is woken for needs.
			await harness.appendCustomMessageEntry(
				request.entry?.customType ?? ORCHESTRATOR_MESSAGE_CUSTOM_TYPE,
				request.text,
				true,
				request.entry?.details,
			);
			return { method: "append" };
		}
		if (request.method === "prompt") {
			return await this._startPrompt(
				{ agentId, generation: liveAgent.generation, harness, phase: harness.getPhase() },
				request,
				input,
			);
		}
		if (request.method === "follow_up") {
			await harness.followUp(input, options);
			return { method: "follow_up" };
		}
		// A human steer counts as read only once the harness reports an empty
		// steering queue, so the interrupt is registered around the hand-over.
		const clearRevision = request.humanInterrupt ? this._humanInterrupts.captureClearRevision(agentId) : undefined;
		await harness.steer(input, options);
		if (clearRevision !== undefined) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return { method: "steer" };
	}

	/**
	 * The only delivery that must produce an assistant result.
	 *
	 * Acceptance waits for the harness's own `agent_start`, racing the run
	 * promise's rejection: a failure before that event means the user message was
	 * never persisted, and resolving early would let the queue drop a message
	 * the model is waiting for.
	 */
	private async _startPrompt(
		target: DeliveryTarget,
		request: MessageDeliveryRequest,
		input: string | AgentMessage,
	): Promise<MessageDeliveryReceipt> {
		const { agentId, harness } = target;
		if (target.phase !== "idle" || this._agentPromptRuns.has(agentId)) {
			throw new AgentHarnessError("busy", `Agent ${agentId} cannot accept a prompt while ${target.phase}.`);
		}

		// Registered before the call, so a fast `agent_start` cannot be missed.
		const started = this._awaitAgentRunStart(agentId);
		const promptRun: AgentPromptRun = {};
		this._agentPromptRuns.set(agentId, promptRun);
		const run = harness.prompt(input, {
			...(typeof input !== "string" || request.images === undefined ? undefined : { images: [...request.images] }),
		});
		// A run that settles without ever starting a loop still resolves here.
		const start = await Promise.race([
			started.reached,
			run.then(
				() => ({ kind: "started" }) as const,
				(error: unknown) => ({ kind: "rejected", error }) as const,
			),
		]);
		started.cancel();
		if (start.kind === "rejected") {
			if (this._agentPromptRuns.get(agentId) === promptRun) {
				this._agentPromptRuns.delete(agentId);
				// Nothing else will publish this edge: the run that would have has
				// already failed. `_settleAgentIdle` re-reads the live phase, so a
				// `busy` rejection just finds the agent still working and re-arms.
				await this._settleAgentIdle(agentId);
			}
			throw start.error;
		}

		void this._finishPrompt(agentId, run, promptRun, { reportFailure: !request.awaited }).catch(() => {});
		return { method: "prompt", completed: run };
	}

	/**
	 * Close out a prompt run and publish the idle edge it produced. Staleness is
	 * by object identity: a completion whose run was replaced while its promise
	 * settled must not stamp the successor's idle reason.
	 */
	private async _finishPrompt(
		agentId: AgentId,
		run: Promise<AssistantMessage>,
		promptRun: AgentPromptRun,
		options: { readonly reportFailure: boolean },
	): Promise<void> {
		try {
			const message = await run;
			if (message.stopReason === "aborted") promptRun.idleCause ??= { reason: "aborted" };
		} catch (error) {
			if (options.reportFailure) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_message_prompt_failed",
					`Prompt for agent ${agentId} failed after delivery: ${formatError(error)}`,
				);
			}
		} finally {
			if (this._agentPromptRuns.get(agentId) === promptRun) {
				this._agentPromptRuns.delete(agentId);
				this._agentIdleCauses.set(agentId, promptRun.idleCause ?? { reason: "settled" });
				this._messages.wake(agentId);
				// The phase is already idle; clearing this run is the last fact the
				// waiters and the observable edge were missing.
				await this._settleAgentIdle(agentId);
			}
		}
	}

	private _awaitAgentRunStart(agentId: AgentId): {
		readonly reached: Promise<{ readonly kind: "started" }>;
		readonly cancel: () => void;
	} {
		const waiters = this._agentRunStartWaiters.get(agentId) ?? new Set();
		this._agentRunStartWaiters.set(agentId, waiters);
		let waiter!: () => void;
		const reached = new Promise<{ readonly kind: "started" }>((resolve) => {
			waiter = () => resolve({ kind: "started" });
			waiters.add(waiter);
		});
		return {
			reached,
			cancel: () => {
				waiters.delete(waiter);
				if (waiters.size === 0) this._agentRunStartWaiters.delete(agentId);
			},
		};
	}

	private _resolveAgentRunStartWaiters(agentId: AgentId): void {
		const waiters = this._agentRunStartWaiters.get(agentId);
		if (!waiters) return;
		this._agentRunStartWaiters.delete(agentId);
		for (const waiter of waiters) waiter();
	}

	/**
	 * Promote queued follow-ups into steering, so they are read at the next turn
	 * boundary. Wrapped rather than exposed as a bare `promoteFollowUpsToSteer`
	 * because it adds the human-interrupt coordination. Returns how many moved.
	 */
	async steerQueuedFollowUps(agentId: AgentId): Promise<number> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "steer queued follow-ups");
		const clearRevision = this._humanInterrupts.captureClearRevision(agentId);
		const promoted = await harness.promoteFollowUpsToSteer();
		if (promoted.length > 0) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return promoted.length;
	}

	/**
	 * End the current harness operation. The result comes straight from the
	 * harness; there is no aborted/running mirror. The harness can also cancel
	 * compaction and branch summary, but `_requireHarnessOutsideMaintenance`
	 * refuses those phases here - disposal is what uses that capability.
	 */
	async abortAgent(agentId: AgentId, abortedBy: AgentAbortOrigin): Promise<AbortResult> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "abort");
		const cause: AgentIdleCause = { reason: "aborted", abortedBy };
		// Recorded before the harness is told, so the abort's own `abort` event
		// finds the origin already there rather than stamping a plain abort over it.
		const promptRun = this._agentPromptRuns.get(agentId);
		if (promptRun) promptRun.idleCause = cause;
		else this._agentIdleCauses.set(agentId, cause);
		return await harness.abort();
	}

	// -----------------------------------------------------------------------
	// Activity and the idle edge
	// -----------------------------------------------------------------------

	/** Whether the delivery queue or either harness queue still holds unread text. */
	agentHasPendingMessages(agentId: AgentId): boolean {
		if (this._messages.hasPending(agentId)) return true;
		const liveAgent = this._live.get(agentId);
		return liveAgent ? queuedMessageCount(liveAgent.harness) > 0 : false;
	}

	/**
	 * A join across four sources: the phase is idle, both harness queues are
	 * empty, `_messages` has nothing pending, and no prompt run started by this
	 * class is in flight. The last cannot be dropped - the phase goes idle inside
	 * `agent_end` while `prompt()` still has a flush to do in its `finally`.
	 *
	 * Not a synonym for `harness.waitForIdle()`, which looks at no queue at all,
	 * so a harness holding a steer reads as idle there.
	 */
	isAgentIdle(agentId: AgentId): boolean {
		return this._resolveAgentIdleState(agentId).kind === "idle";
	}

	/** Rejects rather than hanging when the agent can never reach that condition. */
	async waitForAgentIdle(agentId: AgentId, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		const settled = this._resolveAgentIdleState(agentId);
		if (settled.kind === "idle") return;
		if (settled.kind === "gone") throw new Error(settled.message);
		options.signal?.throwIfAborted();

		const waiters = this._agentIdleWaiters.get(agentId) ?? new Set();
		this._agentIdleWaiters.set(agentId, waiters);
		let waiter!: AgentIdleWaiter;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<void>((resolve, reject) => {
				waiter = { resolve, reject };
				waiters.add(waiter);
				const signal = options.signal;
				if (!signal) return;
				// Detached in the finally below: the caller's signal usually outlives one
				// wait, so a listener left behind pins this closure for its lifetime.
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			waiters.delete(waiter);
			if (waiters.size === 0) this._agentIdleWaiters.delete(agentId);
		}
	}

	/** Idle now, never going to be, or still busy. A creating agent counts as busy. */
	private _resolveAgentIdleState(agentId: AgentId): AgentIdleState {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind === "creating") return { kind: "busy" };
		if (lookup.kind !== "live") {
			return { kind: "gone", message: `Agent ${agentId} is gone.` };
		}
		const { harness } = lookup.liveAgent;
		if (harness.getPhase() !== "idle") return { kind: "busy" };
		if (this._agentPromptRuns.has(agentId)) return { kind: "busy" };
		if (queuedMessageCount(harness) > 0) return { kind: "busy" };
		return this._messages.hasPending(agentId) ? { kind: "busy" } : { kind: "idle" };
	}

	/**
	 * Waiters first, then the event: waiters resolve synchronously while a
	 * listener may take as long as it likes.
	 */
	private async _settleAgentIdle(agentId: AgentId): Promise<void> {
		this._settleAgentIdleWaiters(agentId);
		const state = this._resolveAgentIdleState(agentId);
		if (state.kind !== "idle") {
			// Busy or gone re-arms the edge. A gone agent never publishes: being torn
			// down is not becoming idle in any useful sense.
			this._publishedAgentIdles.delete(agentId);
			return;
		}
		if (this._publishedAgentIdles.has(agentId)) return;
		this._publishedAgentIdles.add(agentId);
		const cause = this._agentIdleCauses.get(agentId) ?? { reason: "settled" };
		await this._emit({
			type: "agent_idle",
			agentId,
			reason: cause.reason,
			...(cause.abortedBy === undefined ? undefined : { abortedBy: cause.abortedBy }),
			idleAt: now(),
		});
	}

	/**
	 * The next `agent_idle` this agent publishes. Edge-triggered, unlike
	 * `waitForAgentIdle`, which answers about now: a caller handing over work
	 * wants the stop that follows it, not the idle it started from.
	 */
	async waitForAgentStop(
		waiterAgentId: AgentId,
		agentId: AgentId,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<AgentStop> {
		this._requireLiveAgent(agentId);
		let unsubscribe = () => {};
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<AgentStop>((resolve, reject) => {
				unsubscribe = this.subscribe((event) => {
					if (event.type === "agent_idle" && event.agentId === agentId) {
						resolve({
							reason: event.reason,
							...(event.abortedBy === undefined ? undefined : { abortedBy: event.abortedBy }),
						});
					} else if (event.type === "agent_disposed" && event.agentId === agentId) {
						reject(new AgentGoneError(agentId));
					} else if (event.type === "agent_disposed" && event.agentId === waiterAgentId) {
						reject(new AgentGoneError(waiterAgentId));
					}
				});
				const signal = options.signal;
				if (!signal) return;
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
	}

	/**
	 * What this agent said in the run that just ended, read from its branch:
	 * `turn_end` and `agent_end` both flush the harness's pending writes, so the
	 * branch is durable by the time an agent is idle. The scan stops at the last
	 * user message, which is the run boundary.
	 */
	async readAgentReport(agentId: AgentId): Promise<string | undefined> {
		const branch = await this.sessionManager.getAgentSessionContextBranch(agentId);
		const texts: string[] = [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type !== "message") continue;
			if (entry.message.role === "user") break;
			if (entry.message.role !== "assistant") continue;
			const text = assistantMessageText(entry.message);
			if (text !== "") texts.unshift(text);
		}
		return texts.length === 0 ? undefined : texts.join("\n\n");
	}

	private _settleAgentIdleWaiters(agentId: AgentId): void {
		const waiters = this._agentIdleWaiters.get(agentId);
		if (!waiters || waiters.size === 0) return;
		const state = this._resolveAgentIdleState(agentId);
		if (state.kind === "busy") return;
		// The waiter's own finally removes it from the set; snapshot first so
		// settling one cannot skip the next.
		for (const waiter of [...waiters]) {
			if (state.kind === "idle") waiter.resolve();
			else waiter.reject(new Error(state.message));
		}
	}

	private _rejectAgentIdleWaiters(agentId: AgentId, message: string): void {
		const waiters = this._agentIdleWaiters.get(agentId);
		if (!waiters) return;
		for (const waiter of [...waiters]) waiter.reject(new Error(message));
		this._agentIdleWaiters.delete(agentId);
	}

	/**
	 * Edge detection driven by harness events. The activity value comes from the
	 * harness; the event supplies only the timing and the causality an
	 * `AgentIdleReason` needs, which no phase carries.
	 */
	private async _observeHarnessActivity(agentId: AgentId, generation: number, event: AgentHarnessEvent): Promise<void> {
		const liveAgent = this._live.get(agentId);
		if (!liveAgent || liveAgent.generation !== generation) return;

		if (event.type === "agent_start") {
			// The prompt's user message is now committed to this run. Resolved before
			// anything is awaited, so acceptance never waits on observers.
			this._resolveAgentRunStartWaiters(agentId);
		}
		// A turn may be followed by tool execution and another turn, so it is not
		// an idle boundary. It can still say that the eventual idle was an abort.
		if (event.type === "turn_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "aborted") {
				const promptRun = this._agentPromptRuns.get(agentId);
				if (promptRun) promptRun.idleCause ??= { reason: "aborted" };
			}
		}
		if (event.type === "abort") {
			const promptRun = this._agentPromptRuns.get(agentId);
			if (promptRun) promptRun.idleCause ??= { reason: "aborted" };
			else this._agentIdleCauses.set(agentId, { reason: "aborted" });
		}
		// Maintenance releases the harness with no turn behind it, so no prompt run
		// completion will stamp this idle.
		if (event.type === "phase_change" && event.phase === "idle" && maintenanceKindOf(event.previousPhase)) {
			this._agentIdleCauses.set(agentId, { reason: "maintenance" });
		}
		// An empty steering queue is the only honest evidence that the human's
		// interrupt was read; an abort clears the queue through the same event.
		if (event.type === "queue_update" && event.steer.length === 0) {
			this._humanInterrupts.clear(agentId);
		}

		await this._publishAgentActivityEdge(agentId, liveAgent.harness.getPhase());
		// Every harness event can change the delivery phase: this is what resumes a
		// message deferred during maintenance or retried after a busy race.
		this._messages.wake(agentId);
		await this._settleAgentIdle(agentId);

		// Auto-compaction rides the settled fact: the harness is idle and its writes
		// are flushed, so the branch and the last assistant usage are durable. A
		// settled with queued next turns is skipped - the next run starts
		// immediately and compaction would race its own idle check.
		if (event.type === "settled" && event.nextTurnCount === 0) {
			// The measurement walks the branch, so it runs once and is handed on.
			const contextTokens = await this._context.refresh(agentId);
			await this._maybeAutoCompact(agentId, contextTokens);
		}
	}

	private async _publishAgentActivityEdge(agentId: AgentId, phase: AgentHarnessPhase): Promise<void> {
		const activity = toActivitySnapshot(phase);
		const previous = this._publishedAgentActivities.get(agentId);
		if (previous?.activity === activity.activity && previous.maintenance === activity.maintenance) {
			return;
		}
		this._publishedAgentActivities.set(agentId, activity);
		await this._emit({
			type: "agent_status_changed",
			agentId,
			...(previous === undefined ? undefined : { previousActivity: previous.activity }),
			activity: activity.activity,
			...(activity.maintenance === undefined ? undefined : { maintenance: activity.maintenance }),
			changedAt: now(),
		});
	}

	/**
	 * Republish the writes whose own events need the entry id the harness only
	 * knows once the write lands. Nothing depends on `appendCustomEntry`'s return
	 * value, which is undefined whenever the write was buffered behind a running
	 * turn.
	 */
	private async _observeSessionWrite(agentId: AgentId, entryId: string, write: PendingSessionWrite): Promise<void> {
		if (write.type !== "custom") return;
		if (write.customType === PERSISTENCE_REF_CUSTOM_TYPE) {
			const ref = write.data as PersistenceRefData;
			await this._emit({
				type: "agent_persistence_ref_changed",
				agentId,
				namespace: ref.namespace,
				stateRoot: ref.stateRoot,
				entryId,
				changedAt: now(),
			});
			return;
		}
		if (write.customType !== EXTENSION_MESSAGE_CUSTOM_TYPE) return;
		const data = write.data as ExtensionMessageEntryData;
		// The entry data is already a deep-frozen normalized copy, so the event
		// carries the same value the branch holds and no consumer can edit either.
		await this._emit(
			Object.freeze({
				type: "extension_message_published" as const,
				presentationId: this._createPresentationId(),
				entryId,
				agentId,
				extensionId: data.extensionId,
				message: data.message,
				createdAt: now(),
			}),
			{ observeExtensions: false },
		);
	}

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------

	/**
	 * Compaction replaces the branch the cached measurement described, and the
	 * retained tail carries the pre-compaction usage, so re-measuring here would
	 * report the old number as current. Drop it; the next settled re-measures.
	 */
	async compactAgent(agentId: AgentId, customInstructions?: string): Promise<CompactResult> {
		const result = await this._requireLiveAgent(agentId).harness.compact(customInstructions);
		await this._context.invalidate(agentId);
		return result;
	}

	/**
	 * Run session tree navigation, then bring everything that reads the branch
	 * onto the branch the leaf moved to.
	 *
	 * Navigation is the one operation that changes which state is in force
	 * without anything having been written, so the context gauge has to be told
	 * afterwards rather than noticing: it describes a branch that is no longer
	 * current.
	 */
	async navigateAgentTree(
		agentId: AgentId,
		targetId: string,
		options?: {
			readonly summarize?: boolean;
			readonly customInstructions?: string;
			readonly replaceInstructions?: boolean;
			readonly label?: string;
		},
	): Promise<NavigateTreeResult> {
		const previousLeafId = await this.sessionManager.getAgentSessionLeafId(agentId);
		try {
			return await this._requireLiveAgent(agentId).harness.navigateTree(targetId, options);
		} finally {
			// A post-move observer can fail after the harness changed the leaf.
			// Comparing in `finally` still reaches both consumers on that path, while
			// cancellation and no-op navigation leave them intact.
			if ((await this.sessionManager.getAgentSessionLeafId(agentId)) !== previousLeafId) {
				await this._context.invalidate(agentId);
			}
		}
	}

	/**
	 * Failure is a warning, never a throw: an uncompactable over-threshold session
	 * keeps running until the provider rejects it, as it did before this trigger.
	 */
	private async _maybeAutoCompact(agentId: AgentId, contextTokens: number | undefined): Promise<void> {
		if (contextTokens === undefined) return;
		const settings = this.settingManager.getCompactionSettings();
		if (!settings.enabled) return;
		if (this._autoCompactingAgents.has(agentId)) return;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent || liveAgent.harness.getPhase() !== "idle") return;
		const { contextWindow } = liveAgent.harness.getModel();
		if (!shouldCompact(contextTokens, contextWindow, settings)) return;
		this._autoCompactingAgents.add(agentId);
		try {
			await this.compactAgent(agentId);
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "compaction.auto_failed",
				message: `Automatic compaction failed for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
		} finally {
			this._autoCompactingAgents.delete(agentId);
		}
	}

	private _createInputId(): string {
		const id = `orchestrator-input-${this._nextInputId}`;
		this._nextInputId += 1;
		return id;
	}

	private _createPresentationId(): string {
		const id = `orchestrator-presentation-${this._nextPresentationId}`;
		this._nextPresentationId += 1;
		return id;
	}

	// -----------------------------------------------------------------------
	// Extension runner lifecycle
	// -----------------------------------------------------------------------

	/** Register an in-process extension module with the loader. */
	registerExtension(extensionId: string, module: ExtensionModule): () => void {
		return this.extensionLoader.registerExtension(extensionId, module);
	}

	/**
	 * Per-agent because one extension can succeed for one agent and fail for
	 * another - the profile decides the enabled set. A reload resets the whole
	 * group rather than carrying the previous generation's failures forward.
	 */
	listExtensionStatuses(agentId: AgentId): readonly ExtensionStatusSnapshot[] {
		return this._extensionStatuses.list(agentId);
	}

	/** Refresh the catalog, then transactionally replace every selected agent's runner. */
	async reloadExtensions(options: { readonly agentIds?: readonly AgentId[] } = {}): Promise<ExtensionReloadResult> {
		const catalog = await this.extensionLoader.reloadAvailableExtensions(this.executionEnv);
		await this._publishDiagnostics(catalog.diagnostics);
		const agentIds = options.agentIds ? [...new Set(options.agentIds)] : [...this._live.keys()];
		const agents: ExtensionReloadAgentResult[] = [];
		for (const agentId of agentIds) {
			agents.push(await this._reloadLiveAgentExtensions(agentId));
		}
		return { catalog: { loaded: [...catalog.loaded], diagnostics: [...catalog.diagnostics] }, agents };
	}

	/**
	 * Build a candidate runner, re-resolve tools under the agent's current policy,
	 * then swap runner, bindings and policy in one step.
	 *
	 * A failure before installation leaves the original runner untouched; a failed
	 * harness write rolls all three fields back together. There is no state in
	 * which the harness holds the new tools while the agent points at the old
	 * runner. Any non-idle phase is skipped: replacing the runner underneath a
	 * running operation would swap the interceptors it is midway through.
	 */
	private async _reloadLiveAgentExtensions(agentId: AgentId): Promise<ExtensionReloadAgentResult> {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind !== "live") {
			const reason = lookup.kind === "creating" ? "creating" : "gone";
			const diagnostic: OrchestratorDiagnostic = {
				severity: "warning",
				code: "extension.reload_agent_skipped",
				message: `Skipped extension reload for agent ${agentId}: it is ${reason}.`,
				agentId,
			};
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "skipped", reason, diagnostics: [diagnostic] };
		}

		const { liveAgent } = lookup;
		const phase = liveAgent.harness.getPhase();
		if (phase !== "idle") {
			const diagnostic: OrchestratorDiagnostic = {
				severity: "warning",
				code: "extension.reload_agent_skipped",
				message: `Skipped extension reload for agent ${agentId}: it is in ${phase}.`,
				agentId,
			};
			this._addAgentDiagnostics(agentId, [diagnostic]);
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "skipped", reason: "running", diagnostics: [diagnostic] };
		}

		const previousRunner = liveAgent.extensionRunner;
		const previousBindings = liveAgent.extensionBindings;
		const previousPolicy = liveAgent.toolPolicy;
		let candidate: ExtensionRunner | undefined;
		let candidateBindings: ExtensionRunnerBindings | undefined;
		let installed = false;
		try {
			const profileId = liveAgent.profile.reference.id;
			candidate = await this._createExtensionRunner(agentId, profileId);
			const resolvedTools = await this._resolveAgentToolsForBuild(agentId, previousPolicy, candidate);
			candidateBindings = await this._bindExtensionRunner(agentId, liveAgent.generation, liveAgent.harness, candidate);
			// Before the awaited harness write: a turn starting mid-reload reads
			// `extensionRunner` for its tool context and must capture the new runner
			// rather than pin the one about to be disposed below.
			liveAgent.extensionRunner = candidate;
			liveAgent.extensionBindings = candidateBindings;
			liveAgent.toolPolicy = resolvedTools.policy;
			installed = true;
			try {
				await liveAgent.harness.setTools(resolvedTools.tools, [...resolvedTools.activeToolNames]);
			} catch (error) {
				liveAgent.extensionRunner = previousRunner;
				liveAgent.extensionBindings = previousBindings;
				liveAgent.toolPolicy = previousPolicy;
				installed = false;
				throw error;
			}

			// Provider registrations follow the runner: the stale runner's leases are
			// withdrawn before the replacement re-registers its own.
			await this._withdrawExtensionProviderContributions(agentId);
			this._withdrawExtensionProfileContributions(agentId);
			await this._applyExtensionProviderContributions(agentId, candidate);
			this._applyExtensionProfileContributions(agentId, candidate);
			await this._disposeExtensionRunner(
				agentId,
				previousRunner,
				previousBindings,
				"Extension runtime has been reloaded.",
			);
			// Before the new runner's diagnostics are published: those events reach
			// its observers, and a status one of them sets must survive this cleanup.
			await this._clearExtensionStatusesForAgent(agentId);
			this._addAgentDiagnostics(agentId, candidate.diagnostics);
			await this._publishDiagnostics(candidate.diagnostics);
			return { agentId, status: "reloaded", diagnostics: [...candidate.diagnostics] };
		} catch (error) {
			if (candidate && !installed) {
				await this._disposeExtensionRunner(
					agentId,
					candidate,
					candidateBindings,
					"Extension reload failed before installation.",
				);
			}
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "extension.reload_agent_failed",
				message: `Failed to reload extensions for agent ${agentId}: ${formatError(error)}`,
				agentId,
			};
			this._addAgentDiagnostics(agentId, [diagnostic]);
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "failed", diagnostics: [diagnostic] };
		}
	}

	/**
	 * Activate the factories this agent's profile and settings select. Nothing is
	 * bound yet, so the candidate is invisible until installation.
	 */
	private async _createExtensionRunner(agentId: AgentId, profileId: string): Promise<ExtensionRunner> {
		const enabledExtensionIds = this.settingManager.getEnabledExtensions();
		const loadedScope = await this.extensionLoader.loadForAgent({
			agentId,
			profileId,
			extensionIds: enabledExtensionIds ?? this.extensionLoader.listAvailableExtensionIds(),
			missingExtensionSeverity: enabledExtensionIds ? "warning" : "ignore",
			divisionSelections: { settings: this.settingManager.getExtensionDivisionSelections() },
		});
		return new ExtensionRunner({ loadedScope });
	}

	/**
	 * Bind a runner to core and return a generation-scoped release handle. The
	 * harness interceptors are registered here because they are the part of a
	 * binding that must be revoked by hand: `shutdown()` clears the subscriber
	 * table itself, but a reload replaces the generation without one.
	 */
	private async _bindExtensionRunner(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): Promise<ExtensionRunnerBindings> {
		runner.bindCore(this._extensionCoreActions, this._createExtensionContextActions(agentId, generation));
		const releaseInterceptors = this._registerExtensionHarnessInterceptors(agentId, harness, runner);
		return {
			release: async () => {
				releaseInterceptors();
			},
		};
	}

	/**
	 * Generation-scoped rather than shared: the run signal and the idle judgement
	 * are only meaningful for the generation that installed them, and a stale
	 * runner reaching a successor's session would be a cross-generation write.
	 */
	private _createExtensionContextActions(agentId: AgentId, generation: number): ExtensionContextActions {
		const requireGeneration = (): LiveAgent => {
			const liveAgent = this._requireLiveAgent(agentId);
			if (liveAgent.generation !== generation) {
				throw new OrchestratorError({
					severity: "error",
					code: "extension.stale_generation",
					message: `Agent ${agentId} has been replaced since this extension runtime was bound.`,
					agentId,
				});
			}
			return liveAgent;
		};
		return {
			getSignal: () => this._agentRunSignals.get(agentId),
			isIdle: () => this._resolveAgentIdleState(agentId).kind === "idle",
			reportActionFailure: async (failure) => {
				await this._recordAndPublishExtensionDiagnostics(agentId, [
					{
						code: failure.code,
						severity: "warning",
						message: `Extension '${failure.extensionId}' action '${failure.action}' failed: ${formatError(failure.error)}`,
						agentId,
						extensionId: failure.extensionId,
					},
				]);
			},
			session: {
				// **Session write.** An extension's own entries go onto the branch
				// through the harness: they are its durable state for this conversation
				// and `findEntries` reads them back after a resume. The persisted type
				// is namespaced by extension id, so one cannot reach another's.
				appendEntry: async (extensionId, type, data) =>
					await requireGeneration().harness.appendCustomEntry(toExtensionCustomType(extensionId, type), data),
				findEntries: async (extensionId, type) =>
					await this.sessionManager.findExtensionCustomEntries(agentId, extensionId, type),
				// No extra gate: the extension already runs inside this session.
				getSnapshot: async () =>
					toExtensionSessionSnapshot(await this.sessionManager.getAgentSessionSnapshot(agentId), this.sessionManager),
				getTree: async () =>
					toExtensionSessionTree(await this.sessionManager.getAgentSessionTree(agentId), this.sessionManager),
				getLeafId: async () => await this.sessionManager.getAgentSessionLeafId(agentId),
				// The cross-session readers widen what an extension sees to every
				// conversation in this project, so they carry the same bar as exec.
				listSessions: async (extensionId) => {
					this._requireProjectTrustForExtension(agentId, extensionId, "list the project's sessions");
					// The caller's own workspace: "this project" is the one the agent
					// runs in, not the one the process happened to start in.
					const candidates = await this.sessionManager.listAgentSessionCandidates(
						this._requireLiveAgent(agentId).workspace.cwd,
					);
					return candidates.map((candidate) => ({
						ref: this.sessionManager.toSessionHandle(candidate.ref),
						id: candidate.id,
						createdAt: candidate.createdAt,
						...(candidate.profile === undefined ? undefined : { profile: { ...candidate.profile } }),
						...(candidate.name === undefined ? undefined : { name: candidate.name }),
						...(candidate.firstUserMessage === undefined
							? undefined
							: { firstUserMessage: candidate.firstUserMessage }),
						// A ref for a session the extension may never have been shown: it
						// buys nothing it could not get by listing, since only sessions of
						// this project are listed and every one of them is listed.
						...(candidate.origin?.forkedFrom === undefined
							? undefined
							: { forkedFromRef: this.sessionManager.toSessionHandle(candidate.origin.forkedFrom) }),
					}));
				},
				readSession: async (extensionId, ref) => {
					this._requireProjectTrustForExtension(agentId, extensionId, "read another session");
					return toExtensionSessionTree(
						await this.sessionManager.readSessionSnapshot(this.sessionManager.resolveSessionHandle(ref)),
						this.sessionManager,
					);
				},
			},
		};
	}

	/**
	 * Register the five transformable harness hooks. The returned handle revokes
	 * exactly this generation's handlers, which is what makes a reload a
	 * replacement rather than an accumulation.
	 */
	private _registerExtensionHarnessInterceptors(
		agentId: AgentId,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): () => void {
		const unsubscribes = [
			harness.on(
				"before_agent_start",
				async (event) => await this._runExtensionInterceptor<"before_agent_start">(agentId, runner, event),
			),
			harness.on(
				"before_provider_request",
				async (event) => await this._runExtensionInterceptor<"before_provider_request">(agentId, runner, event),
			),
			// blockImages applies inside this one handler: the harness keeps only the
			// last non-undefined hook result, so a separately registered filter could
			// be overridden by an extension transform.
			harness.on("context", async (event) => {
				const result = await this._runExtensionInterceptor<"context">(agentId, runner, event);
				const blockImages =
					this._live.get(agentId)?.settings.blockImages ?? this.settingManager.getImageSettings().blockImages;
				if (!blockImages) return result;
				return { messages: stripImagesFromMessages(result?.messages ?? event.messages) };
			}),
			harness.on(
				"tool_call",
				async (event) => await this._runExtensionInterceptor<"tool_call">(agentId, runner, event),
			),
			harness.on(
				"tool_result",
				async (event) => await this._runExtensionInterceptor<"tool_result">(agentId, runner, event),
			),
		];
		return () => {
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}

	/** Run one runner interceptor, recording its handler diagnostics. */
	private async _runExtensionInterceptor<TName extends ExtensionInterceptorName>(
		agentId: AgentId,
		runner: ExtensionRunner,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		const run = await runner.interceptWithDiagnostics(event);
		await this._recordAndPublishExtensionDiagnostics(agentId, run.diagnostics);
		return run.result;
	}

	/**
	 * Input is not a harness hook: it sits in front of the harness, at
	 * `sendMessage`, so no delivery path can bypass an input policy.
	 */
	private async _interceptExtensionInput(
		agentId: AgentId,
		blockPolicy: MessageBlockPolicy,
		event: MessageInterceptEvent,
	): Promise<MessageInterceptRun> {
		const runner = this._live.get(agentId)?.extensionRunner;
		if (!runner || runner.isStale()) return { kind: "pass" };
		const run = await runner.interceptInput(event);
		await this._recordAndPublishExtensionDiagnostics(agentId, run.diagnostics);
		// A block this producer does not enforce is still worth recording.
		if (run.kind === "block" && blockPolicy === "ignore") {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.message_block_ignored",
				message: `Extension '${run.blockedBy}' blocked a ${event.source.kind} message for agent ${agentId}; it was delivered anyway because this producer does not enforce blocks.`,
				agentId,
			});
		}
		return run;
	}

	/**
	 * Trust ruling: a `!command` config value resolves through `ExecutionEnv.exec`
	 * at request time, so an untrusted project rejects the whole registration.
	 */
	private async _applyExtensionProviderContributions(agentId: AgentId, runner: ExtensionRunner): Promise<void> {
		const contributions = runner.getProviderContributions();
		if (contributions.length === 0) return;
		const diagnostics: OrchestratorDiagnostic[] = [];
		const projectTrusted = this.settingManager.isProjectTrusted();
		for (const contribution of contributions) {
			const attribution = { agentId, extensionId: contribution.extensionId } as const;
			if (!projectTrusted && hasCommandConfigValues(contribution.config, this.modelRegistry.configValueResolver)) {
				diagnostics.push({
					...attribution,
					severity: "error",
					code: "extension.provider_trust_denied",
					message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' uses command config values and was denied because the project is not trusted.`,
				});
				continue;
			}
			const result = this.modelRegistry.registerExtensionProvider(contribution.providerName, contribution.config, {
				extensionId: contribution.extensionId,
				agentId,
			});
			if (result.ok) continue;
			diagnostics.push(
				result.reason === "conflict"
					? {
							...attribution,
							severity: "warning",
							code: "extension.provider_conflict",
							message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' conflicts with a ${result.conflictWith} provider and was skipped.`,
						}
					: {
							...attribution,
							severity: "error",
							code: "extension.provider_invalid",
							message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' was rejected: ${result.message}`,
						},
			);
		}
		if (diagnostics.length === 0) return;
		this._addAgentDiagnostics(agentId, diagnostics);
		await this._publishDiagnostics(diagnostics);
	}

	/** Withdraw this agent's provider leases, leaving every other agent's alone. */
	private async _withdrawExtensionProviderContributions(agentId: AgentId): Promise<void> {
		try {
			await this.modelRegistry.unregisterExtensionProviders(agentId);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"extension.provider_unregister_failed",
				`Failed to withdraw extension providers for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	/**
	 * Register this runner's declared roles, leased to its agent.
	 *
	 * No trust ruling and no diagnostics of its own: a profile is inert data, the
	 * extension it came from is already loaded, and a duplicate id is a shadowing
	 * rule the profile registry decides rather than a failure here.
	 */
	private _applyExtensionProfileContributions(agentId: AgentId, runner: ExtensionRunner): void {
		let changed = false;
		for (const contribution of runner.getProfileContributions()) {
			if (this.extensionProfiles.register(contribution.extensionId, agentId, contribution.profile)) changed = true;
		}
		if (changed) this.profileRegistry.invalidate();
	}

	/** Withdraw this agent's profile leases, leaving every other agent's alone. */
	private _withdrawExtensionProfileContributions(agentId: AgentId): void {
		if (this.extensionProfiles.release(agentId)) this.profileRegistry.invalidate();
	}

	/** Make the contexts stale, revoke bindings, run every `onDispose` handler. */
	private async _disposeExtensionRunner(
		agentId: AgentId,
		runner: ExtensionRunner | undefined,
		bindings: ExtensionRunnerBindings | undefined,
		reason: string,
	): Promise<void> {
		// Bindings first: a released interceptor cannot fire into an onDispose
		// handler that has already run.
		try {
			await bindings?.release();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to release extension bindings for agent ${agentId}: ${formatError(error)}`,
			);
		}
		if (!runner) return;
		try {
			await runner.dispose(reason);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to dispose extension runtime for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	/** Drop every status this agent's runner published, announcing each removal. */
	private async _clearExtensionStatusesForAgent(agentId: AgentId): Promise<void> {
		for (const snapshot of this._extensionStatuses.clearAgent(agentId)) {
			await this._emit(
				{
					type: "extension_status_changed",
					presentationId: this._createPresentationId(),
					agentId,
					extensionId: snapshot.extensionId,
					key: snapshot.key,
					changedAt: now(),
				},
				{ observeExtensions: false },
			);
		}
	}

	private async _recordAndPublishExtensionDiagnostics(
		agentId: AgentId,
		diagnostics: readonly OrchestratorDiagnostic[],
	): Promise<void> {
		if (diagnostics.length === 0) return;
		this._addAgentDiagnostics(agentId, diagnostics);
		// A diagnostic raised inside an observer must not feed back into observers,
		// which `_emit` now decides for every event rather than only for this one.
		await this._publishDiagnostics(diagnostics);
	}

	/**
	 * Trust gate for extension actions that reach beyond the agent's own session.
	 * `action` completes "... is denied because the project is not trusted".
	 */
	private _requireProjectTrustForExtension(agentId: AgentId, extensionId: string, action: string): void {
		if (this.settingManager.isProjectTrusted()) return;
		throw new OrchestratorError({
			severity: "error",
			code: "extension.session_read_denied",
			message: `Extension '${extensionId}' may not ${action} because the project is not trusted.`,
			agentId,
			extensionId,
		});
	}

	// -----------------------------------------------------------------------
	// Extension event fan-out
	// -----------------------------------------------------------------------

	/**
	 * Attach a bus subscriber that is not an extension runner, and hand back the
	 * detach. The registrant owns its lifetime: nothing about an agent's disposal
	 * says whether a host's subscription is still wanted.
	 */
	registerExtensionEventSubscriber(subscriber: ExtensionEventSubscriber): () => void {
		this._extensionEventSubscribers.add(subscriber);
		return () => {
			this._extensionEventSubscribers.delete(subscriber);
		};
	}

	/**
	 * Emit onto the bus on behalf of one extension. `agentId` is the attribution
	 * the envelope carries and must name a live agent. A host emitting for a
	 * `tui` half - which belongs to no agent - names the agent the user is
	 * looking at, because that is the one its action is about.
	 */
	async emitExtensionEvent(agentId: AgentId, extensionId: string, name: string, payload?: JsonValue): Promise<void> {
		this._requireLiveAgent(agentId);
		await this._emitExtensionEvent({
			name: validateExtensionEventName(name),
			payload: validateExtensionEventPayload(payload),
			sourceExtensionId: extensionId,
			sourceAgentId: agentId,
			emittedAt: now(),
		});
	}

	/**
	 * Relay one named extension event to every live runner's subscribers, then to
	 * the registered non-runner subscribers. Runtime-level by construction: the
	 * runners are most of the subscriber set, so a reload swaps subscriptions
	 * with the runner it replaced and disposal drops them, with no second
	 * lifecycle to keep in step. The rest is the hosts, which keep their own.
	 */
	private async _emitExtensionEvent(envelope: ExtensionEventEnvelope): Promise<void> {
		const immutable = freezeExtensionEventEnvelope(envelope);
		const depth = this._extensionEventDispatchContext.getStore() ?? 0;
		if (depth >= MAX_EXTENSION_EVENT_DISPATCH_DEPTH) {
			await this._publishDiagnostic(
				{
					severity: "warning",
					code: "extension.event_recursion_dropped",
					message: `Extension event '${immutable.name}' from '${immutable.sourceExtensionId}' was dropped after ${MAX_EXTENSION_EVENT_DISPATCH_DEPTH} nested dispatches.`,
					agentId: immutable.sourceAgentId,
					extensionId: immutable.sourceExtensionId,
				},
				{ observeExtensions: false },
			);
			return;
		}
		await this._extensionEventDispatchContext.run(depth + 1, async () => {
			for (const [agentId, liveAgent] of [...this._live]) {
				const runner = liveAgent.extensionRunner;
				if (runner.isStale()) continue;
				await this._recordAndPublishExtensionDiagnostics(agentId, await runner.emitExtensionEvent(immutable));
			}
			for (const subscriber of [...this._extensionEventSubscribers]) {
				// A host lives outside core and outside any agent: a throw from one
				// must not cut the fan-out short or reject the emitter's call.
				try {
					await subscriber.deliver(immutable);
				} catch (error) {
					await this._publishDiagnostic(
						{
							severity: "warning",
							code: "extension.event_subscriber_failed",
							message: `A subscriber failed on extension event '${immutable.name}' from '${immutable.sourceExtensionId}': ${formatError(error)}`,
							agentId: immutable.sourceAgentId,
							extensionId: immutable.sourceExtensionId,
						},
						{ observeExtensions: false },
					);
				}
			}
		});
	}

	/**
	 * A runtime-scoped fact - today only `runtime_shutdown_requested` - goes to
	 * every live runner: the agents that must wind down are not only the one whose
	 * extension asked.
	 */
	private async _dispatchExtensionObservedEvent(event: ExtensionObservedEvent): Promise<void> {
		const agentId =
			event.type === "diagnostic"
				? event.diagnostic.agentId
				: event.type === "runtime_shutdown_requested"
					? undefined
					: event.agentId;
		if (agentId === undefined) {
			if (event.type !== "runtime_shutdown_requested") return;
			for (const observedAgentId of [...this._live.keys()]) {
				await this._dispatchExtensionObservedEventForAgent(observedAgentId, event);
			}
			return;
		}
		if (!Object.hasOwn(EXTENSION_TREE_BROADCAST_EVENT_NAMES, event.type)) {
			await this._dispatchExtensionObservedEventForAgent(agentId, event);
			return;
		}
		// An agent's tree learns that one of its own arrived, stopped, or is gone.
		// Only live agents have runners, so a disposed subject never hears its own
		// notice; the tree it belonged to is who the notice is for. Snapshotted
		// because a handler may spawn or dispose while this is walking.
		for (const observedAgentId of [...this._live.keys()]) {
			if (observedAgentId === agentId || this._agentsShareTree(observedAgentId, agentId)) {
				await this._dispatchExtensionObservedEventForAgent(observedAgentId, event);
			}
		}
	}

	private async _dispatchExtensionObservedEventForAgent(
		agentId: AgentId,
		event: ExtensionObservedEvent,
	): Promise<void> {
		const runner = this._live.get(agentId)?.extensionRunner;
		if (!runner || runner.isStale()) return;
		await this._extensionCausedScope.run(true, async () => {
			await this._recordAndPublishExtensionDiagnostics(agentId, await runner.emitObserved(event));
		});
	}

	/**
	 * Map the runner authors' actions onto host and runtime services. One shared
	 * table: the runner injects its own agentId and extensionId.
	 */
	private _createExtensionCoreActions(): ExtensionCoreActions {
		return {
			listProfileBriefs: async () => await this._listProfileBriefs(),
			listAgentTree: async (agentId) => await this._listAgentTree(agentId),
			describeAgentFor: (callerAgentId, targetAgentId) => this._describeAgentForCaller(callerAgentId, targetAgentId),
			// The extension's own agent becomes the parent, exactly as it would for a
			// tool the agent called: the child belongs to that tree either way.
			spawnAgentFor: async (callerAgentId, request) =>
				await this._spawnForCaller(
					callerAgentId,
					toExtensionSpawnAgentOrigin(request.origin),
					request.model,
					request.thinkingLevel,
				),
			disposeAgentFor: async (callerAgentId, targetAgentId, options) =>
				await this._disposeForCaller(callerAgentId, targetAgentId, options),
			getAgentTools: (agentId) => this.getAgentTools(agentId),
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				await this.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				await this.setAgentActiveTools(agentId, toolNames);
			},
			requestHuman: async (agentId, extensionId, request) =>
				await this._requestHumanForAgent(agentId, { ...request, source: { kind: "extension", extensionId } }),
			emitOutput: async (agentId, extensionId, text) => {
				this._requireLiveAgent(agentId);
				assertExtensionOutputText(text);
				await this._emit(
					{
						type: "extension_output",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						text,
						createdAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			notify: async (agentId, extensionId, text) => {
				this._requireLiveAgent(agentId);
				assertExtensionNotificationText(text);
				await this._emit(
					{
						type: "extension_notification",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						text,
						createdAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			setStatus: async (agentId, extensionId, key, status) => {
				this._requireLiveAgent(agentId);
				assertExtensionStatusKey(key);
				const changedAt = now();
				const snapshot = this._extensionStatuses.set(
					agentId,
					extensionId,
					key,
					validateExtensionStatus(status),
					changedAt,
				);
				await this._emit(
					{
						type: "extension_status_changed",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						key,
						status: snapshot.status,
						changedAt,
					},
					{ observeExtensions: false },
				);
			},
			clearStatus: async (agentId, extensionId, key) => {
				this._requireLiveAgent(agentId);
				assertExtensionStatusKey(key);
				if (!this._extensionStatuses.clear(agentId, extensionId, key)) return;
				await this._emit(
					{
						type: "extension_status_changed",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						key,
						changedAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			reportDiagnostic: async (agentId, extensionId, draft) => {
				this._requireLiveAgent(agentId);
				const validated = validateExtensionDiagnosticDraft(draft);
				const diagnostic: OrchestratorDiagnostic = {
					code: `extension.${extensionId}.${validated.code}`,
					severity: validated.severity,
					message: validated.message,
					agentId,
					extensionId,
				};
				this._addAgentDiagnostics(agentId, [diagnostic]);
				// Extension-published facts never feed back into extension observers.
				await this._publishDiagnostic(diagnostic, { observeExtensions: false });
			},
			/**
			 * **Session write.** A published message is durable presentation content
			 * belonging to the conversation it was published into, so it goes onto the
			 * branch through `harness.appendCustomEntry`. It never becomes model
			 * context. The id returned here is only the fast path for a write that
			 * landed immediately; the event is emitted from the `session_write`.
			 */
			publishMessage: async (agentId, extensionId, message) => {
				const liveAgent = this._requireLiveAgent(agentId);
				const entryId = await liveAgent.harness.appendCustomEntry(
					EXTENSION_MESSAGE_CUSTOM_TYPE,
					Object.freeze({
						extensionId,
						message: validateExtensionMessage(message),
					}) satisfies ExtensionMessageEntryData,
				);
				return entryId === undefined ? {} : { entryId };
			},
			// The same sink every other producer holds, with this extension's
			// identity and policy already bound into it. Nothing about an
			// extension's input is special enough to need its own path.
			messageSinkFor: (extensionId) => this.messageSinkFor(messageBindingFor({ kind: "extension", extensionId })),
			getAgentContextUsage: (agentId) => this._context.get(agentId),
			isProjectTrusted: () => this.settingManager.isProjectTrusted(),
			getAgentSystemPrompt: async (agentId) => await this.getAgentSystemPrompt(agentId),
			agentHasPendingMessages: (agentId) => this.agentHasPendingMessages(agentId),
			waitForAgentIdle: async (agentId, options) => {
				await this.waitForAgentIdle(agentId, options);
			},
			emitExtensionEvent: async (agentId, extensionId, name, payload) => {
				await this.emitExtensionEvent(agentId, extensionId, name, payload);
			},
			requestRuntimeShutdown: async (agentId, extensionId, reason) => {
				this._requireLiveAgent(agentId);
				await this.requestShutdown({
					requestedBy: extensionId,
					requestedByAgentId: agentId,
					...(reason === undefined ? undefined : { reason }),
				});
			},
			disposeRuntime: async (agentId, extensionId, reason) => {
				this._requireLiveAgent(agentId);
				await this.disposeAll(reason ?? `Extension '${extensionId}' disposed the runtime from agent ${agentId}.`);
			},
			setAgentSessionName: async (agentId, name) => {
				await this.setAgentSessionName(agentId, name);
			},
			getAgentSessionName: async (agentId) => await this.getAgentSessionName(agentId),
			compactAgent: async (agentId, customInstructions) => await this.compactAgent(agentId, customInstructions),
			navigateAgentTree: async (agentId, targetEntryId, options) =>
				await this.navigateAgentTree(agentId, targetEntryId, options),
			setAgentModelByReference: async (agentId, reference) => await this.setAgentModelByReference(agentId, reference),
			getAgentModel: (agentId) => this.getAgentModel(agentId),
			listModelCandidates: async () => (await this.listAvailableModelCandidates()).models,
			getAgentThinkingLevel: (agentId) => this.getAgentThinkingLevel(agentId),
			setAgentThinkingLevel: async (agentId, level) => {
				await this.setAgentThinkingLevel(agentId, level);
			},
			abortAgent: async (agentId) => {
				await this.abortAgent(agentId, "extension");
			},
			// Trust ruling: exec runs arbitrary commands in the project cwd.
			exec: async (agentId, extensionId, command, options) => {
				if (!this.settingManager.isProjectTrusted()) {
					throw new OrchestratorError({
						severity: "error",
						code: "extension.exec_denied",
						message: `Extension '${extensionId}' exec is denied because the project is not trusted.`,
						agentId,
						extensionId,
					});
				}
				return await this.executionEnv.exec(command, options);
			},
		};
	}

	// -----------------------------------------------------------------------
	// Tool policy and system prompt
	//
	// The harness owns the installed and active tools, and every read below asks
	// it. What stays here is the declarative intent behind them - which tool names
	// were requested, and whether the active set was chosen or defaulted - because
	// an extension reload has to resolve that intent again against a replacement
	// runner, and the resolved result cannot answer that question.
	// -----------------------------------------------------------------------

	/** The harness's own answer, projected. There is no second copy to drift. */
	private _snapshotAgentTools(liveAgent: LiveAgent): AgentToolsSnapshot {
		const { harness } = liveAgent;
		return {
			toolNames: harness.getTools().map((tool) => tool.name),
			activeToolNames: harness.getActiveTools().map((tool) => tool.name),
		};
	}

	getAgentTools(agentId: AgentId): AgentToolsSnapshot {
		return this._snapshotAgentTools(this._requireLiveAgent(agentId));
	}

	/**
	 * The policy is updated only after the harness accepts the new tools, so a
	 * rejected write leaves the recorded intent describing what is installed.
	 */
	async setAgentTools(
		agentId: AgentId,
		toolNames: readonly string[],
		activeToolNames?: readonly string[],
	): Promise<void> {
		const liveAgent = this._requireLiveAgent(agentId);
		const resolved = await this._resolveAgentToolsForBuild(
			agentId,
			{
				requestedToolNames: [...toolNames],
				activeToolSelection:
					activeToolNames === undefined
						? { mode: "default_all" }
						: { mode: "explicit", toolNames: [...activeToolNames] },
			},
			liveAgent.extensionRunner,
		);
		await liveAgent.harness.setTools(resolved.tools, [...resolved.activeToolNames]);
		liveAgent.toolPolicy = resolved.policy;
	}

	/**
	 * Validation runs against the harness's live tool list with no await between
	 * check and apply. Re-resolving the registry here would race a concurrent
	 * `setTools` and re-publish the standing resolve diagnostics on every toggle.
	 */
	async setAgentActiveTools(agentId: AgentId, toolNames: readonly string[]): Promise<void> {
		const liveAgent = this._requireLiveAgent(agentId);
		const { harness } = liveAgent;
		const { activeToolNames, diagnostics } = selectActiveToolNames(
			toolNames,
			new Set(harness.getTools().map((tool) => tool.name)),
			agentId,
		);
		await harness.setActiveTools(activeToolNames);
		// Re-read after the await: the harness is the source of truth, and a
		// concurrent tool-set change must not be overwritten by a stale copy.
		liveAgent.toolPolicy = {
			...liveAgent.toolPolicy,
			activeToolSelection: { mode: "explicit", toolNames: harness.getActiveTools().map((tool) => tool.name) },
		};
		await this._publishDiagnostics(diagnostics);
	}

	/**
	 * The returned policy is the intent as the registry understood it, which makes
	 * a later reload idempotent: an explicit selection narrows to what resolved,
	 * while `default_all` stays open to tools a replacement runner contributes.
	 */
	private async _resolveAgentToolsForBuild(
		agentId: AgentId,
		policy: AgentToolPolicy,
		extensionRunner: ExtensionRunner,
	): Promise<{
		readonly tools: ResolvedAgentHarnessTool[];
		readonly activeToolNames: readonly string[];
		readonly policy: AgentToolPolicy;
	}> {
		const registry = this.toolRegistry.clone();
		extensionRunner.contributeToolsTo(registry);
		const resolved = registry.resolve({
			...(policy.requestedToolNames === undefined ? undefined : { requestedToolNames: policy.requestedToolNames }),
			...(policy.activeToolSelection.mode === "explicit"
				? { activeToolNames: policy.activeToolSelection.toolNames }
				: undefined),
		});
		await this._publishDiagnostics(resolved.diagnostics.map((diagnostic) => ({ ...diagnostic, agentId })));
		return {
			tools: createAgentHarnessToolsFromResolvedTools(resolved.tools),
			activeToolNames: resolved.activeToolNames,
			policy: {
				...(policy.requestedToolNames === undefined
					? undefined
					: { requestedToolNames: [...policy.requestedToolNames] }),
				activeToolSelection:
					policy.activeToolSelection.mode === "explicit"
						? { mode: "explicit", toolNames: [...resolved.activeToolNames] }
						: { mode: "default_all" },
			},
		};
	}

	/**
	 * The runner is read here rather than captured at construction, which is the
	 * whole reason this is a callback: a reload replaces the runner and the
	 * sections it appends have to follow.
	 */
	private _composeAgentSystemPrompt(agentId: AgentId, activeTools: readonly ToolPromptGuidance[]): string {
		const liveAgent = this._requireLiveAgent(agentId);
		const facts = liveAgent.systemPrompt;
		return buildAgentSystemPrompt({
			basePrompt: facts.basePrompt,
			skills: facts.skills,
			activeTools,
			agentId,
			appendSections: [...facts.appendSections, ...liveAgent.extensionRunner.getSystemPromptAppends()],
			contextFiles: facts.contextFiles,
			...(facts.includeSkills === undefined ? undefined : { includeSkills: facts.includeSkills }),
			...(facts.cwd === undefined ? undefined : { cwd: facts.cwd }),
		});
	}

	async getAgentSystemPrompt(agentId: AgentId): Promise<string> {
		const { harness } = this._requireLiveAgent(agentId);
		return this._composeAgentSystemPrompt(agentId, harness.getActiveTools());
	}

	/**
	 * The runner is captured into this snapshot, so a call that continues in the
	 * background after a reload keeps the runner it started under and observes
	 * that runner's stale boundary instead of switching mid-call.
	 */
	private _createToolAdapterContext(agentId: AgentId, profileId: string): ToolAdapterContext {
		const liveAgent = this._requireLiveAgent(agentId);
		const extensionRunner = liveAgent.extensionRunner;
		return {
			workspace: { cwd: liveAgent.workspace.cwd },
			human: {
				request: async ({ tool, ...draft }) =>
					await this._requestHumanForAgent(agentId, {
						...draft,
						source: tool
							? { kind: "tool", agentId, toolCallId: tool.toolCallId, toolName: tool.toolName }
							: { kind: "agent", agentId },
					}),
			},
			agents: this._createAgentHost(agentId),
			humanInterrupts: this._humanInterrupts.watch(agentId),
			createExtensionContext: (source) => {
				if (source.kind !== "extension") return undefined;
				return {
					extensionId: source.id,
					host: { agentId, profileId, actions: extensionRunner.createContext(source.id).actions },
				};
			},
		};
	}

	/**
	 * Bind the orchestrator's collaboration surface to one agent. Everything the
	 * bound methods decide - who sent a message, which agents are discoverable,
	 * what a dispose may reach - resolves from this `agentId` over private
	 * runtime state, so a holder cannot ask as anyone else.
	 */
	private _createAgentHost(agentId: AgentId): AgentToOrchestratorHost {
		return {
			agentId,
			listProfiles: async () => await this._listProfileBriefs(),
			listAgents: async () => await this._listAgentTree(agentId),
			describe: (targetAgentId) => this._describeAgentForCaller(agentId, targetAgentId),
			spawn: async (request) =>
				await this._spawnForCaller(agentId, toSpawnAgentOrigin(request.origin), request.model, request.thinkingLevel),
			sendMessage: async (targetAgentId, body) =>
				await this.sendMessage(
					{ targetAgentId, body, mode: "next_turn" },
					messageBindingFor({ kind: "agent", senderAgentId: agentId }),
				),
			sharesTree: (targetAgentId) => this._live.has(targetAgentId) && this._agentsShareTree(agentId, targetAgentId),
			waitForAgentStop: async (targetAgentId, options) =>
				await this.waitForAgentStop(agentId, targetAgentId, options ?? {}),
			readAgentReport: async (targetAgentId) => await this.readAgentReport(targetAgentId),
			notifySelf: async (notification) =>
				await this.sendMessage(
					{ targetAgentId: agentId, body: notification.body, mode: notification.mode },
					messageBindingFor({ kind: "agent", senderAgentId: notification.aboutAgentId, notice: notification.notice }),
				),
			dispose: async (targetAgentId, options) => await this._disposeForCaller(agentId, targetAgentId, options),
			requestHuman: async (request) =>
				await this._requestHumanForAgent(agentId, { ...request, source: { kind: "agent", agentId } }),
		};
	}

	// -----------------------------------------------------------------------
	// Caller-scoped collaboration
	//
	// The bodies behind the agent host, kept here rather than inside it because
	// they have a second holder: the extension runtime asks the same questions
	// bound to the agent its runner belongs to. Scope and structure follow from
	// the caller id and nothing else, which is why one implementation serves
	// both - what differs between the two surfaces is attribution, and that is
	// decided by whoever builds the request, not here.
	// -----------------------------------------------------------------------

	private async _listProfileBriefs(): Promise<readonly AgentProfileBrief[]> {
		const result = await this.profileRegistry.listProfiles();
		await this._publishDiagnostics(result.diagnostics);
		return result.profiles
			.filter((profile) => this._isProfileEnabled(profile.id))
			.map(
				(profile): AgentProfileBrief => ({
					id: profile.id,
					label: profile.label,
					...(profile.description === undefined ? undefined : { description: profile.description }),
					...(profile.whenToUse === undefined ? undefined : { whenToUse: profile.whenToUse }),
					persist: profile.persist,
				}),
			);
	}

	private _describeAgentForCaller(_callerAgentId: AgentId, targetAgentId: AgentId): AgentBrief | undefined {
		const liveAgent = this._live.get(targetAgentId);
		return liveAgent ? describeAgentForTools(liveAgent) : undefined;
	}

	private async _spawnForCaller(
		callerAgentId: AgentId,
		origin: SpawnAgentOrigin,
		model: string | undefined,
		thinkingLevel: ThinkingLevel | undefined,
	): Promise<AgentId> {
		return await this.spawnAgent({
			origin,
			parent: callerAgentId,
			...(model === undefined ? undefined : { model: await this._resolveModelByReference(model) }),
			...(thinkingLevel === undefined ? undefined : { thinkingLevel }),
		});
	}

	private async _disposeForCaller(
		callerAgentId: AgentId,
		targetAgentId: AgentId,
		options: AgentRequestedDisposeOptions,
	): Promise<AgentRequestedDisposeOutcome> {
		if (!this._live.has(targetAgentId)) {
			return { kind: this._tombstones.has(targetAgentId) ? "already_disposed" : "unknown" };
		}
		if (!this._agentsShareTree(callerAgentId, targetAgentId)) {
			return { kind: "outside_tree" };
		}
		const selected = options.scope === "subtree" ? this._collectAgentSubtreePostOrder(targetAgentId) : [targetAgentId];
		// A caller cannot dispose the agent it is bound to, directly or inside the
		// subtree it named: the runtime being torn down is the one that would have
		// to receive this call's result.
		if (selected.includes(callerAgentId)) return { kind: "self" };
		const agentIds = await this.disposeAgent(targetAgentId, {
			intent: "removed",
			reason: options.reason,
			scope: options.scope,
		});
		return agentIds.length > 0 ? { kind: "disposed", agentIds } : { kind: "already_disposed" };
	}

	// -----------------------------------------------------------------------
	// Profiles, models, thinking levels, and resources
	//
	// Mostly forwarding. A single agent's model and thinking level live in its
	// harness; what is added here is the runtime policy around them - enabled
	// profiles, available models, and the refusal to resume under a model that is
	// no longer registered.
	// -----------------------------------------------------------------------

	/**
	 * A role an extension registered is enabled by that extension being enabled.
	 *
	 * `enabledProfiles` is a list of the user's own roles, and a profile that only
	 * exists because they installed something has already been consented to. Asking
	 * for the name a second time would make every such extension look broken on
	 * install, and the answer would always be yes.
	 */
	private _isProfileEnabled(profileId: string): boolean {
		if (this._enabledProfileIds === undefined) return true;
		return this._enabledProfileIds.includes(profileId) || this.extensionProfiles.profileIds().includes(profileId);
	}

	private async _resolveCreateProfile(
		origin: Extract<SpawnAgentOrigin, { kind: "new" }>,
	): Promise<ResolvedAgentProfile> {
		const resolved = await this._resolveProfileById(origin.profileId ?? this._defaultProfileId, undefined);
		return { ...resolved, profile: await this._applyProfileOverride(resolved.profile, origin.profileOverride) };
	}

	/**
	 * A session with no profile reference cannot be resumed at all: nothing else
	 * records what the agent was, and guessing would resume the branch as
	 * something it never ran as.
	 */
	private async _resolveResumeProfile(agentId: AgentId, metadata: JsonlSessionMetadata): Promise<ResolvedAgentProfile> {
		const reference = parseAgentProfileReference(metadata.metadata?.profile);
		if (!reference) {
			throw new OrchestratorError({
				severity: "error",
				code: "profile.resolution_failed",
				message: `Cannot resume agent ${agentId}: session metadata does not contain a profile reference.`,
				agentId,
			});
		}
		return await this._resolveProfileById(reference.id, agentId);
	}

	private async _resolveProfileById(profileId: string, agentId: AgentId | undefined): Promise<ResolvedAgentProfile> {
		const result = await this.profileRegistry.resolveProfile(profileId);
		await this._publishDiagnostics(result.diagnostics);
		if (!result.ok) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.resolution_failed",
					message: `Cannot resolve profile ${profileId}: ${result.reason}.`,
					agentId,
				}),
			);
		}
		if (!this._isProfileEnabled(result.profile.id)) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.disabled",
					message: `Profile is disabled by runtime policy: ${result.profile.id}`,
					agentId,
				}),
			);
		}
		return { profile: result.profile, source: result.source, entryId: result.entryId };
	}

	/**
	 * An override may not change the id, and a persistent profile may not have its
	 * recoverable fields overridden: a resume re-resolves those from the registry,
	 * so such a session could never be reopened as the agent that wrote it.
	 */
	private async _applyProfileOverride(
		profile: AgentProfile,
		override: AgentProfileOverride | undefined,
	): Promise<AgentProfile> {
		if (!override) return profile;
		if ("id" in override) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.override_invalid",
					message: `Profile override cannot change profile id: ${profile.id}.`,
				}),
			);
		}
		const merged: AgentProfile = { ...profile, ...override };
		if (merged.persist && changesRecoverableProfileFields(override)) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.override_not_persistable",
					message: `Profile '${profile.id}' override changes recoverable profile fields and cannot create a persistent session.`,
				}),
			);
		}
		return merged;
	}

	/**
	 * A recorded model that is no longer registered is an error, not a silent
	 * fallback: the branch was produced by that model, and reopening it under
	 * another changes what the conversation is without saying so.
	 */
	private _resolveResumeModel(
		contextModel: { readonly provider: string; readonly modelId: string } | null,
	): RuntimeModel {
		if (!contextModel) return this._requireDefaultModel();
		const model = this.modelRegistry.find(contextModel.provider, contextModel.modelId);
		if (!model) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.not_available",
				message: `Cannot resume model ${contextModel.provider}/${contextModel.modelId}: it is not registered.`,
			});
		}
		return model;
	}

	/**
	 * The settings the harness cannot answer after construction. Read fresh per
	 * spawn rather than inherited: an agent created after the user changed a
	 * setting should run under the setting now in force.
	 */
	private _captureAgentSettings(): AgentSettings {
		return {
			retry: this.settingManager.getRetrySettings(),
			providerRetry: this.settingManager.getProviderRetrySettings(),
			compaction: this.settingManager.getCompactionSettings(),
			blockImages: this.settingManager.getImageSettings().blockImages,
		};
	}

	getAgentModel(agentId: AgentId): RuntimeModel {
		return this._requireLiveAgent(agentId).harness.getModel();
	}

	async setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void> {
		await this._requireLiveAgent(agentId).harness.setModel(model);
		// The cached measurement names the previous model and its window.
		await this._context.invalidate(agentId);
	}

	/**
	 * The roles a new agent can be opened as. Same briefs the model sees through
	 * `list_agents`, so a profile the runtime policy disabled is offered to
	 * neither.
	 */
	async listAgentProfileCandidates(): Promise<AgentProfileCandidateListResult> {
		const briefs = await this._listProfileBriefs();
		return {
			profiles: briefs.map((brief) => {
				// whenToUse is the sentence written to help a caller choose; the
				// description only says what the role is.
				const description = brief.whenToUse ?? brief.description;
				return { value: brief.id, label: brief.label, ...(description === undefined ? undefined : { description }) };
			}),
		};
	}

	async listAvailableModelCandidates(): Promise<AgentModelCandidateListResult> {
		const models = await this.modelRegistry.getAvailable();
		return {
			models: models.map((model) => ({
				value: modelReference(model),
				label: model.name,
				description: modelReference(model),
			})),
		};
	}

	async resolveModelByReference(reference: string): Promise<RuntimeModel> {
		return await this._resolveModelByReference(reference);
	}

	async setAgentModelByReference(agentId: AgentId, reference: string): Promise<RuntimeModel> {
		const model = await this._resolveModelByReference(reference, agentId);
		await this.setAgentModel(agentId, model);
		return model;
	}

	/** A `provider/id` reference against the registered models, or a refusal. */
	private async _resolveModelByReference(reference: string, agentId?: AgentId): Promise<RuntimeModel> {
		const parsed = parseModelReference(reference);
		if (!parsed) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.reference_invalid",
				message: `Model reference must use provider/model syntax: ${reference}`,
				...(agentId === undefined ? undefined : { agentId }),
			});
		}
		const models = await this.modelRegistry.getAvailable();
		const model = models.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId);
		if (!model) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.not_available",
				message: `Model is not available: ${parsed.provider}/${parsed.modelId}`,
				...(agentId === undefined ? undefined : { agentId }),
			});
		}
		return model;
	}

	listAuthProviderCandidates(): AuthProviderCandidateListResult {
		return this._auth.listProviders();
	}

	async listAuthCredentialCandidates(): Promise<AuthCredentialCandidateListResult> {
		return await this._auth.listCredentials();
	}

	async loginAuthProvider(
		providerId: string,
		options?: { readonly agentId?: AgentId },
	): Promise<AuthProviderLoginResult> {
		return await this._auth.login(providerId, options);
	}

	async logoutAuthProvider(providerId: string): Promise<AuthProviderLogoutResult> {
		return await this._auth.logout(providerId);
	}

	listAgentThinkingLevelCandidates(agentId: AgentId): AgentThinkingLevelCandidateListResult {
		const { harness } = this._requireLiveAgent(agentId);
		return { levels: this._thinkingLevelCandidates(agentId, harness.getModel()) };
	}

	getAgentThinkingLevel(agentId: AgentId): ThinkingLevel {
		return this._requireLiveAgent(agentId).harness.getThinkingLevel();
	}

	async setAgentThinkingLevel(agentId: AgentId, level: ThinkingLevel): Promise<void> {
		const { harness } = this._requireLiveAgent(agentId);
		const model = harness.getModel();
		const supported = this._thinkingLevelCandidates(agentId, model);
		if (!supported.some((candidate) => candidate.value === level)) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_level_not_supported",
				message: `Thinking level ${level} is not supported by model ${model.provider}/${model.id}.`,
				agentId,
			});
		}
		await harness.setThinkingLevel(level);
	}

	async setAgentThinkingLevelByName(agentId: AgentId, levelName: string): Promise<AgentThinkingLevelResult> {
		const level = parseThinkingLevel(levelName);
		if (!level) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_level_invalid",
				message: `Invalid thinking level: ${levelName}. Supported levels: ${THINKING_LEVELS.join(", ")}.`,
				agentId,
			});
		}
		await this.setAgentThinkingLevel(agentId, level);
		return { level };
	}

	/**
	 * A model with no reasoning throws rather than returning an empty list: "none
	 * available" and "not a thinking model" are different answers.
	 */
	private _thinkingLevelCandidates(agentId: AgentId, model: RuntimeModel): readonly CandidateItem[] {
		if (!model.reasoning) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_not_supported",
				message: `Model ${model.provider}/${model.id} does not support thinking levels.`,
				agentId,
			});
		}
		return getSupportedThinkingLevels(model).map((level) => ({ value: level, label: level }));
	}

	async listAgentPromptTemplateCandidates(agentId: AgentId): Promise<AgentPromptTemplateCandidateListResult> {
		return {
			templates: (await this._loadAgentPromptTemplates(agentId)).map((template) => ({
				value: template.name,
				label: template.name,
				...(template.description === undefined ? undefined : { description: template.description }),
			})),
		};
	}

	async getAgentPromptTemplate(agentId: AgentId, name: string): Promise<PromptTemplate> {
		const templates = await this._loadAgentPromptTemplates(agentId);
		const template = templates.find((candidate) => candidate.name === name);
		if (!template) {
			throw new OrchestratorError({
				severity: "error",
				code: "prompt_template.not_found",
				message: `Prompt template not found: ${name}`,
				agentId,
			});
		}
		return template;
	}

	/** Reloaded per listing: a template the user just edited should be usable at once. */
	private async _loadAgentPromptTemplates(agentId: AgentId): Promise<readonly PromptTemplate[]> {
		const { workspace } = this._requireLiveAgent(agentId);
		const loaded = await workspace.resourceLoader.loadPromptTemplates();
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) => ({
				severity: "warning" as const,
				code: `resource.prompt_template.${diagnostic.code}`,
				message: `${diagnostic.message} (${diagnostic.path})`,
				agentId,
			})),
		);
		return loaded.promptTemplates.map(({ promptTemplate }) => promptTemplate);
	}

	async listAgentSkillCandidates(agentId: AgentId): Promise<AgentSkillCandidateListResult> {
		return {
			skills: (await this._loadAgentSkills(agentId)).map((skill) => ({
				value: skill.name,
				label: skill.name,
				...(skill.description === undefined ? undefined : { description: skill.description }),
			})),
		};
	}

	async getAgentSkill(agentId: AgentId, name: string): Promise<Skill> {
		const skills = await this._loadAgentSkills(agentId);
		const skill = skills.find((candidate) => candidate.name === name);
		if (!skill) {
			throw new OrchestratorError({
				severity: "error",
				code: "skill.not_found",
				message: `Skill not found: ${name}`,
				agentId,
			});
		}
		return skill;
	}

	/** Same freshness rule as prompt templates, narrowed by the agent's profile. */
	private async _loadAgentSkills(agentId: AgentId): Promise<readonly Skill[]> {
		const { resolvedProfile, workspace } = this._requireLiveAgent(agentId);
		const loaded = await workspace.resourceLoader.loadSkills(resolvedProfile.skills);
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) => ({
				severity: "warning" as const,
				code: `resource.skill.${diagnostic.code}`,
				message: `${diagnostic.message} (${diagnostic.path})`,
				agentId,
			})),
		);
		return loaded.skills.map(({ skill }) => skill);
	}

	// -----------------------------------------------------------------------
	// Sessions
	//
	// Reads go straight to the SessionManager. The one write goes through the
	// harness, which owns the session file while an operation is running.
	// -----------------------------------------------------------------------

	/** Top-level sessions of one workspace; the startup one when none is named. */
	async listAgentSessions(cwd?: string): Promise<AgentSessionListResult> {
		return { sessions: await this.sessionManager.listAgentSessionCandidates(cwd ?? this.workspaces.startup.cwd) };
	}

	async getAgentSession(agentId: AgentId): Promise<AgentSessionSnapshot> {
		this._requireLiveAgent(agentId);
		return await this.sessionManager.getAgentSessionSnapshot(agentId);
	}

	async getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot> {
		this._requireLiveAgent(agentId);
		return await this.sessionManager.getAgentSessionTree(agentId);
	}

	async getAgentSessionName(agentId: AgentId): Promise<string | undefined> {
		return (await this.getAgentSession(agentId)).name;
	}

	/**
	 * **Session write.** Metadata rather than branch content, but it takes the
	 * same route: `harness.setSessionName` serializes behind whatever the harness
	 * has already buffered instead of racing it.
	 */
	async setAgentSessionName(agentId: AgentId, name: string): Promise<void> {
		await this._requireLiveAgent(agentId).harness.setSessionName(name);
		await this._emit({ type: "agent_session_info_changed", agentId, name, changedAt: now() });
	}

	// -----------------------------------------------------------------------
	// Branch state
	//
	// A branch is the register of what every persistence namespace holds, and
	// only the harness may write one. So the modules that own such state never
	// reach for the branch: they ask through a port bound to their own namespace
	// and this class does the writing.
	// `notes/develop/ZH/persistence-ref-writer.md` is why the split runs exactly here.
	// -----------------------------------------------------------------------

	/** Persistence reports in its own vocabulary; the codes are republished as they are. */
	private async _publishPersistenceDiagnostics(
		agentId: AgentId,
		diagnostics: readonly PersistenceDiagnostic[],
	): Promise<void> {
		await this._publishDiagnostics(
			diagnostics.map((entry) => ({ severity: entry.severity, code: entry.code, message: entry.message, agentId })),
		);
	}

	// -----------------------------------------------------------------------
	// Human requests, clients, and events
	// -----------------------------------------------------------------------

	async requestHuman(request: HumanRequest): Promise<HumanResponse> {
		return await this._humanRequests.request(request);
	}

	/**
	 * The agentId is a separate argument because it decides cancellation scope,
	 * and that must not be forgeable through the request's own `source`.
	 */
	private async _requestHumanForAgent(agentId: AgentId, request: HumanRequest): Promise<HumanResponse> {
		return await this._humanRequests.request(request, { agentId });
	}

	async cancelHumanRequest(requestId: string, reason?: string): Promise<boolean> {
		return await this._humanRequests.cancel(requestId, reason);
	}

	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void {
		return this._events.registerClient(client);
	}

	subscribe(listener: OrchestratorEventListener): () => void {
		return this._events.subscribe(listener);
	}

	subscribeAgent(agentId: AgentId, listener: OrchestratorEventListener): () => void {
		return this._events.subscribeAgent(agentId, listener);
	}

	/**
	 * Broadcast, once, that an exit is intended. Nothing is torn down here; the
	 * host decides what to do about it.
	 *
	 * The dispatch order is a deliberate exception to `_emit`: a host listener may
	 * start `disposeAll` the instant it sees the request, so extension observers
	 * get their final persistence work in first.
	 */
	async requestShutdown(request: RuntimeShutdownRequest): Promise<void> {
		if (this._shutdownRequested) return;
		this._shutdownRequested = true;
		const event: Extract<OrchestratorEvent, { type: "runtime_shutdown_requested" }> = Object.freeze({
			type: "runtime_shutdown_requested",
			requestedBy: request.requestedBy,
			requestedByAgentId: request.requestedByAgentId,
			...(request.reason === undefined ? undefined : { reason: request.reason }),
			createdAt: now(),
		});
		await this._dispatchExtensionObservedEvent(event);
		await this._emit(event, { observeExtensions: false });
	}

	/**
	 * The bus owns listeners and clients; extension observers are a runner
	 * lifecycle concern composed here rather than inside the bus, which knows
	 * nothing about extensions. `observeExtensions: false` is how a fact an
	 * extension produced avoids feeding straight back into it.
	 */
	private async _emit(
		event: OrchestratorEvent,
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		await this._events.publish(event, options);
		if (options.observeExtensions === false) return;
		if (!isExtensionObservedEvent(event)) return;
		if (this._isExtensionCaused(event)) return;
		await this._dispatchExtensionObservedEvent(event);
	}

	/**
	 * Whether an extension is the reason this event exists, and so must not
	 * receive it: handing it back closes a cycle where the handler's own effect
	 * re-triggers the handler.
	 *
	 * Two detectors because neither covers the other. The scope catches an effect
	 * still on the observer's call stack - a spawn, a rename, a message - and
	 * loses it wherever the runtime defers work onto another stack. A buffered
	 * session write is exactly that case, and it stays recognisable because the
	 * entry type travels with it.
	 */
	private _isExtensionCaused(event: OrchestratorEvent): boolean {
		if (this._extensionCausedScope.getStore()) return true;
		return event.type === "agent_harness_event" && isExtensionCausedWrite(event.event);
	}

	private async _publishDiagnostic(
		diagnostic: OrchestratorDiagnostic,
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		await this._emit({ type: "diagnostic", diagnostic, createdAt: now() }, options);
	}

	private async _publishDiagnostics(
		diagnostics: readonly OrchestratorDiagnostic[],
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		for (const diagnostic of diagnostics) {
			await this._publishDiagnostic(diagnostic, options);
		}
	}

	/** Publish a diagnostic and hand it back, for the throw-after-publish paths. */
	private async _publishAndReturn(diagnostic: OrchestratorDiagnostic): Promise<OrchestratorDiagnostic> {
		await this._publishDiagnostic(diagnostic);
		return diagnostic;
	}

	/** Drained rather than read, so a second call does not republish the same warnings. */
	private _drainCoreDiagnostics(): readonly OrchestratorDiagnostic[] {
		return [
			...this.settingManager.drainDiagnostics(),
			...this.modelRegistry.authStorage.drainDiagnostics(),
			...this.modelRegistry.drainDiagnostics(),
		];
	}

	/**
	 * Always a warning and never re-thrown: these are reported from teardown and
	 * observer paths where no caller is left to handle a rejection.
	 */
	private async _recordAgentLifecycleFailure(agentId: AgentId, code: string, message: string): Promise<void> {
		const diagnostic: OrchestratorDiagnostic = { severity: "warning", code, message, agentId };
		this._addAgentDiagnostics(agentId, [diagnostic]);
		await this._publishDiagnostic(diagnostic);
	}

	/**
	 * One subscription, not two: the activity observer and the session-write
	 * observer need the same event and the same run signal, and splitting them
	 * would double every dispatch and let the two views drift on ordering.
	 */
	private async _bindHarness(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
	): Promise<() => Promise<void>> {
		const unsubscribe = harness.subscribe((event, signal) => {
			void this._handleHarnessEvent(agentId, generation, event, signal);
		});
		return async () => {
			unsubscribe();
		};
	}

	/**
	 * The run signal is installed before the observers run and cleared after
	 * `settled`, but only if it is still this run's signal: a queued next turn may
	 * have installed its own while dispatch was pending.
	 *
	 * `agent_harness_event` is published before the session-write observer so a
	 * client sees the persisted user message before the presentation entry that
	 * names it.
	 */
	private async _handleHarnessEvent(
		agentId: AgentId,
		generation: number,
		event: AgentHarnessEvent,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (signal) this._agentRunSignals.set(agentId, signal);
		try {
			await this._observeHarnessActivity(agentId, generation, event);
			await this._emit({ type: "agent_harness_event", agentId, event });
			if (event.type === "session_write") {
				await this._observeSessionWrite(agentId, event.entryId, event.write);
			}
		} finally {
			if (event.type === "settled" && this._agentRunSignals.get(agentId) === signal) {
				this._agentRunSignals.delete(agentId);
			}
		}
	}

	/** Append to this agent's diagnostics history, which the snapshot reads. */
	private _addAgentDiagnostics(agentId: AgentId, diagnostics: readonly OrchestratorDiagnostic[]): void {
		if (diagnostics.length === 0) return;
		const history = this._agentDiagnostics.get(agentId) ?? [];
		history.push(...diagnostics);
		this._agentDiagnostics.set(agentId, history);
	}
}

/** How long a dispose waits for `shutdown()`; the wait is otherwise unbounded. */
const AGENT_SHUTDOWN_TIMEOUT_MS = 10_000;

async function withTimeout(work: Promise<void>, timeoutMs: number, message: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		// The abandoned work still settles; it must not surface as unhandled.
		work.catch(() => {});
	}
}

/**
 * Whether this event reports a session entry that exists because an extension
 * asked for it.
 *
 * Two shapes, one rule. An extension's own entries carry the provenance in the
 * type, stamped by the single funnel every one of them goes through. The
 * core-owned types below carry it in the payload instead - they are core's
 * record of something an extension published - so they have to be named here.
 * The namespace test alone would let `publishMessage` keep the cycle open.
 */
function isExtensionCausedWrite(event: AgentHarnessEvent): boolean {
	if (event.type !== "session_write" || event.write.type !== "custom") return false;
	return (
		isExtensionCustomType(event.write.customType) || EXTENSION_CAUSED_CORE_CUSTOM_TYPES.has(event.write.customType)
	);
}

/** Core-owned entry types the orchestrator writes only on an extension's behalf. */
const EXTENSION_CAUSED_CORE_CUSTOM_TYPES: ReadonlySet<string> = new Set([EXTENSION_MESSAGE_CUSTOM_TYPE]);

function toActivitySnapshot(phase: AgentHarnessPhase): AgentActivitySnapshot {
	const maintenance = maintenanceKindOf(phase);
	if (maintenance) return { activity: "running", maintenance };
	return { activity: phase === "idle" ? "idle" : "running" };
}

/** Everything handed to a harness that it has not read yet. */
function queuedMessageCount(harness: WidiAgentHarness): number {
	const counts = harness.getQueuedMessageCounts();
	return counts.steer + counts.followUp + counts.nextTurn;
}

/** Four base36 characters: the half of an agent id that does not repeat across runs. */
function randomAgentIdSuffix(): string {
	return Math.floor(Math.random() * 36 ** 4)
		.toString(36)
		.padStart(4, "0");
}

/** Model-visible summary of one live agent, for the collaboration tools. */
function describeAgentForTools(liveAgent: LiveAgent): AgentBrief {
	const { reference } = liveAgent.profile;
	return {
		agentId: liveAgent.agentId,
		profileId: reference.id,
		...(reference.label === undefined ? undefined : { label: reference.label }),
		activity: toActivitySnapshot(liveAgent.harness.getPhase()).activity,
	};
}

/**
 * Widen a host origin into the orchestrator's own. The two differ only in what
 * a `new` origin may carry: the host form has no profile override, so an agent
 * chooses its child's role from the profile directory rather than assembling
 * one out of fields.
 */
function toSpawnAgentOrigin(origin: AgentSpawnOrigin): SpawnAgentOrigin {
	switch (origin.kind) {
		case "new":
			return { kind: "new", ...(origin.profileId === undefined ? undefined : { profileId: origin.profileId }) };
		case "resume":
			return { kind: "resume", reference: origin.reference };
		case "fork":
			return {
				kind: "fork",
				sourceAgentId: origin.sourceAgentId,
				...(origin.entryId === undefined ? undefined : { entryId: origin.entryId }),
			};
	}
}

/**
 * Widen an extension origin into the orchestrator's own. It carries the profile
 * override an agent's does not: an extension is installed code, so building a
 * role out of fields is a decision the installation already made.
 *
 * `resume` narrows the other way - a ref string, never a `PersistedSessionInfo`
 * - because refs are what the extension session API hands out.
 */
function toExtensionSpawnAgentOrigin(origin: ExtensionSpawnOrigin): SpawnAgentOrigin {
	switch (origin.kind) {
		case "new":
			return {
				kind: "new",
				...(origin.profileId === undefined ? undefined : { profileId: origin.profileId }),
				...(origin.profileOverride === undefined ? undefined : { profileOverride: origin.profileOverride }),
			};
		case "resume":
			return { kind: "resume", reference: origin.reference };
		case "fork":
			return {
				kind: "fork",
				sourceAgentId: origin.sourceAgentId,
				...(origin.entryId === undefined ? undefined : { entryId: origin.entryId }),
			};
	}
}

/** Text parts of one assistant message, joined; empty for a tool-only turn. */
function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * Narrow requested active tools to the installed ones, reporting each rejection
 * rather than failing the call. Deliberately not the registry's own resolution:
 * this validates against the harness's live tool set, the only set that can be
 * activated, and never re-derives the installed tools as a side effect.
 */
function selectActiveToolNames(
	toolNames: readonly string[],
	installedNames: ReadonlySet<string>,
	agentId: AgentId,
): { readonly activeToolNames: string[]; readonly diagnostics: readonly OrchestratorDiagnostic[] } {
	const activeToolNames: string[] = [];
	const diagnostics: OrchestratorDiagnostic[] = [];
	const seen = new Set<string>();
	for (const rawName of toolNames) {
		const name = rawName.trim();
		if (!name) {
			diagnostics.push({
				severity: "error",
				code: "tool.invalid_name",
				message: "Tool name list contains an empty name.",
				agentId,
			});
			continue;
		}
		if (seen.has(name)) {
			diagnostics.push({
				severity: "warning",
				code: "tool.active_duplicate",
				message: `Tool name '${name}' is listed more than once; keeping the first occurrence.`,
				agentId,
			});
			continue;
		}
		seen.add(name);
		if (!installedNames.has(name)) {
			diagnostics.push({
				severity: "warning",
				code: "tool.active_missing",
				message: `Active tool '${name}' is not in the agent's installed tool set.`,
				agentId,
			});
			continue;
		}
		activeToolNames.push(name);
	}
	return { activeToolNames, diagnostics };
}

/**
 * Profile fields a resume re-resolves from the registry. Overriding one of them
 * on a persistent profile would produce a session that could never be reopened
 * as the agent that wrote it.
 */
function changesRecoverableProfileFields(override: AgentProfileOverride): boolean {
	return (
		override.systemPrompt !== undefined ||
		override.tools !== undefined ||
		override.skills !== undefined ||
		override.projectContext !== undefined ||
		override.includeCwd !== undefined ||
		override.skillsListing !== undefined ||
		override.appendSystemPrompt !== undefined ||
		override.persist !== undefined
	);
}

/** Which orchestrator events extension runners are allowed to observe. */
function isExtensionObservedEvent(event: OrchestratorEvent): event is ExtensionObservedEvent {
	return Object.hasOwn(EXTENSION_OBSERVED_EVENT_NAMES, event.type);
}

/**
 * The extension-facing shape: identity and conversation, no filesystem layout.
 * An ephemeral session owns no persisted file and therefore has no ref.
 */
function toExtensionSessionSnapshot(
	snapshot: AgentSessionSnapshot,
	sessions: SessionManager,
): ExtensionSessionSnapshot {
	return {
		...(snapshot.ref === undefined ? undefined : { ref: sessions.toSessionHandle(snapshot.ref) }),
		id: snapshot.metadata.id,
		...(snapshot.name === undefined ? undefined : { name: snapshot.name }),
		leafId: snapshot.leafId,
		pathToRoot: cloneSessionEntries(snapshot.pathToRoot),
	};
}

function toExtensionSessionTree(snapshot: AgentSessionTreeSnapshot, sessions: SessionManager): ExtensionSessionTree {
	return { ...toExtensionSessionSnapshot(snapshot, sessions), entries: cloneSessionEntries(snapshot.entries) };
}

function cloneSessionEntries(entries: readonly SessionTreeEntry[]): readonly SessionTreeEntry[] {
	return structuredClone(entries);
}

/**
 * Every config-value channel in a provider config: the provider api key, and
 * the provider- and model-level request headers.
 */
function hasCommandConfigValues(config: ProviderConfigInput, resolver: ConfigValueResolver): boolean {
	const values = [
		config.apiKey,
		...Object.values(config.headers ?? {}),
		...(config.models ?? []).flatMap((model) => Object.values(model.headers ?? {})),
	];
	return values.some((value) => value !== undefined && resolver.isCommandConfigValue(value));
}

/**
 * Severity is the whole test: a warning describes a degraded extension, an error
 * one the agent cannot run without.
 */
function isBlockedExtensionDiagnostic(diagnostic: OrchestratorDiagnostic): boolean {
	return diagnostic.severity === "error";
}

/** A thinking level recorded in a session, rejected rather than coerced. */
function resolveThinkingLevel(level: string): ThinkingLevel | undefined {
	const parsed = parseThinkingLevel(level);
	return parsed === level ? parsed : undefined;
}

/**
 * Resolve a request against the sink it came through. The source is the
 * request's if it named one, the sink's otherwise; the policy is always the
 * sink's.
 */
function toMessageDraft(request: MessageRequest, binding: MessageSinkBinding): MessageDraft {
	return { ...request, source: request.source ?? binding.source, binding };
}

/**
 * The message the harness persists for one delivery.
 *
 * A request with no entry is the shell's own human input and stays a bare user
 * message - existing sessions read back unchanged, and carrying no type at all
 * is what says the user typed it. Everything else becomes a custom message, so
 * the branch records who wrote it. Either way the model reads the same text:
 * `convertToLlm` maps `role:"custom"` to `role:"user"` with the content verbatim.
 */
function toHarnessInput(request: MessageDeliveryRequest): string | AgentMessage {
	if (request.entry === undefined) return request.text;
	const content =
		request.images === undefined ? request.text : [{ type: "text" as const, text: request.text }, ...request.images];
	return createCustomMessage(request.entry.customType, content, true, request.entry.details, now());
}

function now(): string {
	return new Date().toISOString();
}
