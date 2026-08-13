// The extension-author API surface lives in api.ts (the frozen contract, ME
// slice 10); this barrel adds the core-internal binding surface on top.
export * from "./api.ts";
export {
	type ExtensionEventSubscriber,
	freezeExtensionEventEnvelope,
	MAX_EXTENSION_EVENT_DISPATCH_DEPTH,
	validateExtensionEventName,
	validateExtensionEventPayload,
} from "./events.ts";
export {
	type ExtensionDiscoveryCandidate,
	type ExtensionDiscoveryCandidateKind,
	type ExtensionDiscoveryResult,
	type ExtensionEventRegistration,
	type ExtensionIdentity,
	type ExtensionInterceptorRegistration,
	type ExtensionLoadAvailableResult,
	ExtensionLoader,
	type ExtensionObserverRegistration,
	type ExtensionProviderContribution,
	type ExtensionRoot,
	type ExtensionSource,
	type ExtensionSystemPromptContribution,
	type ExtensionToolContribution,
	type LoadExtensionScopeOptions,
	type LoadedExtensionScope,
} from "./loader.ts";
export {
	type ExtensionModuleImporter,
	JitiExtensionModuleImporter,
} from "./module-importer.ts";
export {
	type ExtensionHookSnapshot,
	type ExtensionInputInterceptRun,
	type ExtensionProviderContributionSnapshot,
	ExtensionRunner,
	type ExtensionRunnerOptions,
	type ExtensionRunnerSnapshot,
	type ExtensionSystemPromptContributionSnapshot,
	type ExtensionToolContributionSnapshot,
} from "./runner.ts";
export type {
	ExtensionActionFailure,
	ExtensionContextActions,
	ExtensionCoreActions,
	ExtensionDivisionSelection,
	ExtensionDivisionSelections,
	ExtensionDivisionSnapshot,
	ExtensionDivisionSource,
	ExtensionSessionActions,
} from "./types.ts";
export { EXTENSION_OBSERVED_EVENT_NAMES, EXTENSION_TREE_BROADCAST_EVENT_NAMES } from "./types.ts";
