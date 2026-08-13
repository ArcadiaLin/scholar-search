/**
 * Extension-author API surface (ME slice 10).
 *
 * Everything a third-party extension may depend on is exported from this
 * module, plus the upstream types enumerated by reference in the public
 * contract (docs/zh-CN/core/extensions.md): the Pi typed hook events/results, the
 * raw `AgentHarnessEvent`, `ImageContent`, `ThinkingLevel`,
 * `ShellExecOptions`, `Result`/`ExecutionError`, and typebox `TSchema`.
 *
 * Versioning policy (presentation-protocol ruling): the extension API has no
 * public release yet, so version 1 is still reshaped in place - presentation
 * actions and contract adjustments land on v1 without a bump. The surface
 * freezes at the first public release; from then on breaking changes to it -
 * including breaking changes to those upstream types - bump
 * EXTENSION_API_VERSION.
 */

export const EXTENSION_API_VERSION: number = 1;

export const MIN_SUPPORTED_EXTENSION_API_VERSION: number = 1;

export function isSupportedExtensionApiVersion(version: number): boolean {
	return (
		Number.isInteger(version) && version >= MIN_SUPPORTED_EXTENSION_API_VERSION && version <= EXTENSION_API_VERSION
	);
}

export type { JsonValue } from "../../utils/json.ts";
export type { AgentProfile, AgentProfileOverride, AgentProfileReference } from "../agent-profile.js";
// WIDI core types named in author-facing signatures are re-exported here so
// a third-party extension never imports core internals directly.
export type { CoreDiagnostic, ExtensionDiagnosticDraft } from "../diagnostics.ts";
// The cross-agent vocabulary, shared with the agent host: what a profile looks
// like in a listing, what a live agent looks like, and what a tree walk returns.
export type {
	AgentBrief,
	AgentDisposeScope,
	AgentProfileBrief,
	AgentRequestedDisposeOptions,
	AgentRequestedDisposeOutcome,
	AgentTreeClosedEntry,
	AgentTreeEntry,
	AgentTreeListing,
	AgentTreeRunningEntry,
} from "../host.ts";
export type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
export type {
	AgentContextUsage,
	AgentToolsSnapshot,
	CandidateItem,
	RuntimeModel,
} from "../types.ts";
export type { ExtensionEventEnvelope } from "./events.ts";
export {
	MAX_EXTENSION_EVENT_NAME_BYTES,
	MAX_EXTENSION_EVENT_PAYLOAD_BYTES,
} from "./events.ts";
// A published message is a `kind` plus opaque JSON. The shapes behind a kind
// are a contract between an extension and whoever renders it, so they live with
// the renderer, not here.
export type {
	ExtensionActions,
	ExtensionActivationApi,
	ExtensionCompactionResult,
	ExtensionContext,
	ExtensionCustomEntry,
	ExtensionDefinition,
	ExtensionDisposeHandler,
	ExtensionDivisionDeclaration,
	ExtensionEventHandler,
	ExtensionExecResult,
	ExtensionFactory,
	ExtensionInputEvent,
	ExtensionInputResult,
	ExtensionInterceptorEventFor,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionMessage,
	ExtensionModule,
	ExtensionNavigateTreeOptions,
	ExtensionNavigateTreeResult,
	ExtensionObservedEvent,
	ExtensionObservedEventFor,
	ExtensionObservedEventName,
	ExtensionObserver,
	ExtensionObserverFor,
	ExtensionProviderConfig,
	ExtensionSendOptions,
	ExtensionSessionCandidate,
	ExtensionSessionContext,
	ExtensionSessionSnapshot,
	ExtensionSessionTree,
	ExtensionSpawnOrigin,
	ExtensionSpawnRequest,
	ExtensionStatus,
	ExtensionStatusSnapshot,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecuteMiddleware,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "./types.ts";
export {
	// Exhaustive by construction, and exported so a consumer counting coverage
	// checks against the same list the dispatcher does rather than a copy.
	EXTENSION_OBSERVED_EVENT_NAMES,
	MAX_EXTENSION_MESSAGE_BYTES,
	MAX_EXTENSION_MESSAGE_KIND_BYTES,
	MAX_EXTENSION_NOTIFICATION_BYTES,
	MAX_EXTENSION_OUTPUT_BYTES,
	MAX_EXTENSION_STATUS_BYTES,
	MAX_EXTENSION_STATUS_KEY_BYTES,
	// The admission checks, exported so a client reading a message back off a
	// branch runs the same one core ran to admit it.
	validateExtensionMessage,
	validateExtensionStatus,
} from "./types.ts";
