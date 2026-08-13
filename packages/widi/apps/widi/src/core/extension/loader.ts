import type { ExecutionEnv, FileInfo } from "@arcadialin/agent-core";
import { formatError } from "../../utils/errors.ts";
import type { AgentProfile } from "../agent-profile.js";
import type { CoreDiagnostic, DiagnosticSeverity } from "../diagnostics.ts";
import { EXTENSION_API_VERSION, isSupportedExtensionApiVersion, MIN_SUPPORTED_EXTENSION_API_VERSION } from "./api.ts";
import {
	ExtensionDivisionResolver,
	joinDivisionId,
	validateDivisionDeclarations,
	validateDivisionId,
} from "./division.ts";
import { validateExtensionEventName } from "./events.ts";
import { type ExtensionModuleImporter, JitiExtensionModuleImporter } from "./module-importer.ts";
import type {
	ExtensionActivationApi,
	ExtensionDisposeHandler,
	ExtensionDivisionDeclaration,
	ExtensionDivisionSelections,
	ExtensionDivisionSnapshot,
	ExtensionEventHandler,
	ExtensionFactory,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionModule,
	ExtensionObservedEventName,
	ExtensionObserver,
	ExtensionProviderConfig,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;
type ExtensionToolDefinitionPatch = ToolDefinitionPatch;

export interface ExtensionProviderContribution {
	readonly extensionId: string;
	readonly providerName: string;
	readonly config: ExtensionProviderConfig;
	readonly divisionId?: string;
}

/** A role an extension ships, registered for as long as the extension is loaded. */
export interface ExtensionProfileContribution {
	readonly extensionId: string;
	readonly profile: AgentProfile;
	readonly divisionId?: string;
}

/** A section an extension adds to the system prompt, in registration order. */
export interface ExtensionSystemPromptContribution {
	readonly extensionId: string;
	readonly text: string;
	readonly divisionId?: string;
}

export interface ExtensionObserverRegistration {
	extensionId: string;
	eventName: ExtensionObservedEventName;
	handler: ExtensionObserver;
	divisionId?: string;
}

export interface ExtensionInterceptorRegistration<TName extends ExtensionInterceptorName> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionInterceptorFor<TName>;
	divisionId?: string;
}

export interface ExtensionEventRegistration {
	extensionId: string;
	/** Bus event name, as validated at registration time. */
	eventName: string;
	handler: ExtensionEventHandler;
	divisionId?: string;
}

export interface ExtensionDisposeRegistration {
	readonly extensionId: string;
	readonly handler: ExtensionDisposeHandler;
	readonly divisionId?: string;
}

export interface LoadExtensionScopeOptions {
	agentId: string;
	profileId: string;
	/** Extensions to activate for this agent. Nothing loads when it is empty. */
	extensionIds?: readonly string[];
	/**
	 * How to report an id with no registered factory. Only meaningful when the
	 * ids were named by hand: a list derived from what is actually available
	 * cannot name a missing extension.
	 */
	missingExtensionSeverity?: "ignore" | "warning" | "error";
	divisionSelections?: ExtensionDivisionSelections;
}

export type ExtensionSource =
	| { readonly kind: "factory" }
	| { readonly kind: "file"; readonly path: string; readonly resolvedPath: string; readonly root: ExtensionRoot }
	| {
			readonly kind: "package";
			readonly path: string;
			readonly resolvedPath: string;
			readonly entryPath: string;
			readonly root: ExtensionRoot;
	  };

export interface ExtensionIdentity {
	readonly id: string;
	readonly source: ExtensionSource;
	/** Validated division declarations; empty for a plain extension. */
	readonly divisions: readonly ExtensionDivisionDeclaration[];
}

export type ExtensionToolContribution =
	| {
			kind: "define";
			extensionId: string;
			definition: ExtensionToolDefinition;
			source: ToolSource;
			divisionId?: string;
	  }
	| {
			kind: "patch";
			extensionId: string;
			targetToolName: string;
			patch: ExtensionToolDefinitionPatch;
			source: ToolSource;
			divisionId?: string;
	  };

export interface ExtensionRoot {
	readonly kind: "agent_dir" | "cwd" | "settings";
	readonly path: string;
}

export type ExtensionDiscoveryCandidateKind = "directory" | "file";

export interface ExtensionDiscoveryCandidate {
	readonly id: string;
	readonly root: ExtensionRoot;
	readonly path: string;
	readonly kind: ExtensionDiscoveryCandidateKind;
}

export interface ExtensionDiscoveryResult {
	readonly roots: readonly ExtensionRoot[];
	readonly candidates: readonly ExtensionDiscoveryCandidate[];
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface ExtensionLoaderOptions {
	readonly roots?: readonly ExtensionRoot[];
	readonly moduleImporter?: ExtensionModuleImporter;
}

export interface ExtensionLoadAvailableResult {
	readonly discovery: ExtensionDiscoveryResult;
	readonly loaded: readonly ExtensionIdentity[];
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface LoadedExtensionScope {
	agentId: string;
	profileId: string;
	extensionIds: readonly string[];
	extensions: readonly ExtensionIdentity[];
	diagnostics: readonly CoreDiagnostic[];
	toolContributions: readonly ExtensionToolContribution[];
	providerContributions: readonly ExtensionProviderContribution[];
	profileContributions: readonly ExtensionProfileContribution[];
	systemPromptContributions: readonly ExtensionSystemPromptContribution[];
	observerHandlers: ReadonlyMap<ExtensionObservedEventName, readonly ExtensionObserverRegistration[]>;
	interceptorHandlers: ReadonlyMap<
		ExtensionInterceptorName,
		readonly ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
	/** Extension event bus subscriptions, keyed by event name. */
	extensionEventHandlers: ReadonlyMap<string, readonly ExtensionEventRegistration[]>;
	disposeHandlers: readonly ExtensionDisposeRegistration[];
	divisions: readonly ExtensionDivisionSnapshot[];
}

interface IncompatibleExtensionRecord {
	readonly identity: ExtensionIdentity;
	readonly declaredApiVersion: number;
	readonly fromModule: boolean;
}

export class ExtensionLoader {
	private readonly _factories = new Map<string, ExtensionFactory>();
	private readonly _factoryIdentities = new Map<string, ExtensionIdentity>();
	private readonly _incompatible = new Map<string, IncompatibleExtensionRecord>();
	private readonly _moduleFactories = new Map<string, ExtensionFactory>();
	private readonly _divisionIssues = new Map<string, readonly string[]>();
	private readonly _moduleImporter: ExtensionModuleImporter;
	private readonly _roots: readonly ExtensionRoot[];

	constructor(options: ExtensionLoaderOptions = {}) {
		this._roots = options.roots ? [...options.roots] : [];
		this._moduleImporter = options.moduleImporter ?? new JitiExtensionModuleImporter();
	}

	getRoots(): readonly ExtensionRoot[] {
		return [...this._roots];
	}

	/**
	 * Every extension this runtime can activate: discovered from a root or
	 * registered programmatically. This is the whole set an agent loads when
	 * settings name no narrower list, so an incompatible or unreadable extension
	 * is deliberately absent - it never became a factory, and its own load
	 * diagnostic already said so.
	 *
	 * Registration order, not sorted: activation order decides interceptor order,
	 * and the order roots were searched in is a deliberate fact.
	 */
	listAvailableExtensionIds(): readonly string[] {
		return [...this._factories.keys()];
	}

	async discover(executionEnv: ExecutionEnv): Promise<ExtensionDiscoveryResult> {
		const candidates: ExtensionDiscoveryCandidate[] = [];
		const diagnostics: CoreDiagnostic[] = [];

		for (const root of this._roots) {
			const infoResult = await executionEnv.fileInfo(root.path);
			if (!infoResult.ok) {
				if (infoResult.error.code === "not_found" && root.kind !== "settings") {
					continue;
				}
				diagnostics.push(
					createExtensionDiscoveryDiagnostic({
						code: infoResult.error.code === "not_found" ? "extension.source_missing" : "extension.file_info_failed",
						severity: infoResult.error.code === "not_found" ? "warning" : "error",
						message:
							infoResult.error.code === "not_found"
								? `Extension source not found: ${root.path}`
								: `Failed to inspect extension source ${root.path}: ${infoResult.error.message}`,
						root,
					}),
				);
				continue;
			}

			// fileInfo does not follow symlinks, but a symlink is a supported
			// install layout (install.sh links drill from the preset into the
			// agent dir). Resolve to the target so discovery sees the real kind
			// and the entry imports relative to the real location.
			const info = await followSymlink(executionEnv, infoResult.value);
			if (!info) continue;

			if (info.kind === "directory" && (await hasDirectoryEntry(executionEnv, info.path))) {
				candidates.push({ id: basename(info.path), root, path: info.path, kind: "directory" });
				continue;
			}

			if (info.kind === "directory") {
				const result = await discoverDirectory(executionEnv, root, info.path);
				candidates.push(...result.candidates);
				diagnostics.push(...result.diagnostics);
				continue;
			}

			const candidate = await candidateFromFileInfo(executionEnv, root, info);
			if (candidate) {
				candidates.push(candidate);
			}
		}

		// Root order is preserved and only the entries within one directory are
		// sorted. Roots are searched in a deliberate order - settings paths, then
		// the project, then the agent dir - and that order becomes activation
		// order once every available extension loads, which decides the order
		// interceptors, providers, and tool patches apply in.
		return { roots: this.getRoots(), candidates, diagnostics };
	}

	clearExtensionModuleCache(): void {
		this._moduleImporter.clearCache();
	}

	registerExtension(extensionId: string, module: ExtensionModule): () => void {
		const normalizedId = extensionId.trim();
		if (!normalizedId) {
			throw new Error("Extension id must not be empty.");
		}
		const resolved = resolveExtensionModule(module);
		if (!resolved) {
			throw new Error("Extension module must be a factory function or an { apiVersion, activate } definition.");
		}
		const divisions = validateDivisionDeclarations(resolved.divisions);
		const identity: ExtensionIdentity = {
			id: normalizedId,
			source: { kind: "factory" },
			divisions: divisions.divisions,
		};

		if (resolved.declaredApiVersion !== undefined && !isSupportedExtensionApiVersion(resolved.declaredApiVersion)) {
			this._factories.delete(normalizedId);
			this._factoryIdentities.delete(normalizedId);
			this._divisionIssues.delete(normalizedId);
			const record: IncompatibleExtensionRecord = {
				identity,
				declaredApiVersion: resolved.declaredApiVersion,
				fromModule: false,
			};
			this._incompatible.set(normalizedId, record);
			return () => {
				if (this._incompatible.get(normalizedId) === record) {
					this._incompatible.delete(normalizedId);
				}
			};
		}

		this._incompatible.delete(normalizedId);
		const factory = resolved.factory;
		this._factories.set(normalizedId, factory);
		this._factoryIdentities.set(normalizedId, identity);
		this._setDivisionIssues(normalizedId, divisions.issues);
		return () => {
			if (this._factories.get(normalizedId) === factory) {
				this._factories.delete(normalizedId);
				this._factoryIdentities.delete(normalizedId);
				this._divisionIssues.delete(normalizedId);
			}
		};
	}

	async loadAvailableExtensions(executionEnv: ExecutionEnv): Promise<ExtensionLoadAvailableResult> {
		this._removeModuleFactories();
		const discovery = await this.discover(executionEnv);
		const diagnostics: CoreDiagnostic[] = [...discovery.diagnostics];
		const loaded: ExtensionIdentity[] = [];

		for (const candidate of discovery.candidates) {
			const entry = await resolveCandidateEntry(executionEnv, candidate);
			diagnostics.push(...entry.diagnostics);
			if (!entry.entry) continue;

			const registeredIncompatible = this._incompatible.get(candidate.id);
			if (this._factories.has(candidate.id) || (registeredIncompatible && !registeredIncompatible.fromModule)) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.id_conflict",
						severity: "warning",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} conflicts with an already registered factory and was skipped.`,
						extensionId: candidate.id,
					}),
				);
				continue;
			}

			let moduleExport: unknown;
			try {
				moduleExport = await this._moduleImporter.importModule(entry.entry.entryPath);
			} catch (error) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.load_failed",
						severity: "error",
						message: `Failed to load extension '${candidate.id}' from ${entry.entry.entryPath}: ${formatError(error)}`,
						extensionId: candidate.id,
					}),
				);
				continue;
			}

			const resolved = resolveExtensionModule(moduleExport);
			if (!resolved) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.factory_invalid",
						severity: "error",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} does not default-export a factory function or an { apiVersion, activate } definition.`,
						extensionId: candidate.id,
					}),
				);
				continue;
			}

			const divisions = validateDivisionDeclarations(resolved.divisions);
			const identity: ExtensionIdentity = {
				id: candidate.id,
				source: entry.entry.source,
				divisions: divisions.divisions,
			};

			if (resolved.declaredApiVersion !== undefined && !isSupportedExtensionApiVersion(resolved.declaredApiVersion)) {
				this._incompatible.set(candidate.id, {
					identity,
					declaredApiVersion: resolved.declaredApiVersion,
					fromModule: true,
				});
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.version_incompatible",
						severity: "error",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} targets extension API version ${resolved.declaredApiVersion}; this runtime supports ${formatSupportedApiVersions()}.`,
						extensionId: candidate.id,
					}),
				);
				continue;
			}

			this._factories.set(candidate.id, resolved.factory);
			this._moduleFactories.set(candidate.id, resolved.factory);
			this._factoryIdentities.set(candidate.id, identity);
			this._setDivisionIssues(candidate.id, divisions.issues);
			loaded.push(identity);
		}

		return { discovery, loaded, diagnostics };
	}

	async reloadAvailableExtensions(executionEnv: ExecutionEnv): Promise<ExtensionLoadAvailableResult> {
		this.clearExtensionModuleCache();
		return await this.loadAvailableExtensions(executionEnv);
	}

	async loadForAgent(options: LoadExtensionScopeOptions): Promise<LoadedExtensionScope> {
		const diagnostics: CoreDiagnostic[] = [];
		const toolContributions: ExtensionToolContribution[] = [];
		const providerContributions: ExtensionProviderContribution[] = [];
		const profileContributions: ExtensionProfileContribution[] = [];
		const systemPromptContributions: ExtensionSystemPromptContribution[] = [];
		const observerHandlers = new Map<ExtensionObservedEventName, ExtensionObserverRegistration[]>();
		const interceptorHandlers = new Map<
			ExtensionInterceptorName,
			ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
		>();
		const extensionEventHandlers = new Map<string, ExtensionEventRegistration[]>();
		const disposeHandlers: ExtensionDisposeRegistration[] = [];
		const divisions: ExtensionDivisionSnapshot[] = [];
		const extensionIds = normalizeExtensionIds(options.extensionIds ?? []);
		const extensions: ExtensionIdentity[] = [];

		for (const extensionId of extensionIds) {
			const incompatible = this._incompatible.get(extensionId);
			if (incompatible) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.version_incompatible",
						severity: "error",
						message: `Extension '${extensionId}' targets extension API version ${incompatible.declaredApiVersion}; this runtime supports ${formatSupportedApiVersions()}.`,
						extensionId,
						agentId: options.agentId,
					}),
				);
				continue;
			}

			const factory = this._factories.get(extensionId);
			if (!factory) {
				const diagnostic = createMissingFactoryDiagnostic({
					extensionId,
					agentId: options.agentId,
					severity: options.missingExtensionSeverity ?? "warning",
				});
				if (diagnostic) diagnostics.push(diagnostic);
				continue;
			}

			const identity = this._factoryIdentities.get(extensionId) ?? {
				id: extensionId,
				source: { kind: "factory" as const },
				divisions: [],
			};
			extensions.push(identity);

			// Recoverable: the malformed declaration is dropped and the rest of the
			// extension still loads, so this must not be an agent-blocking error.
			for (const issue of this._divisionIssues.get(extensionId) ?? []) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.division_invalid",
						severity: "warning",
						message: `Extension '${extensionId}' declared an invalid division and it was dropped: ${issue}`,
						extensionId,
						agentId: options.agentId,
					}),
				);
			}

			const scope: ExtensionActivationScope = {
				extensionId,
				agentId: options.agentId,
				profileId: options.profileId,
				resolver: new ExtensionDivisionResolver({
					extensionId,
					declarations: identity.divisions,
					selections: options.divisionSelections,
				}),
				pending: [],
				divisionFailures: [],
				divisionDiagnostics: [],
				toolContributions,
				providerContributions,
				profileContributions,
				systemPromptContributions,
				observerHandlers,
				interceptorHandlers,
				extensionEventHandlers,
				disposeHandlers,
			};

			try {
				await factory(createActivationApi(scope));
			} catch (error) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.activation_failed",
						severity: "error",
						message: `Extension '${extensionId}' activation failed: ${formatError(error)}`,
						extensionId,
						agentId: options.agentId,
					}),
				);
			} finally {
				// Drain even when the root factory threw: an unawaited division is
				// still running and would otherwise keep mutating the contribution
				// arrays after this scope was handed out.
				await settlePendingDivisions(scope);
			}

			diagnostics.push(...scope.divisionDiagnostics);
			// A failed division costs that part only; the extension keeps the
			// contributions it already registered, so this stays non-blocking and
			// carries its own code to tell it apart from a whole-extension failure.
			for (const failure of scope.divisionFailures) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.division_activation_failed",
						severity: "warning",
						message: `Extension '${extensionId}' division '${failure.divisionId}' activation failed: ${formatError(failure.error)}`,
						extensionId,
						agentId: options.agentId,
					}),
				);
			}
			for (const divisionId of scope.resolver.listUndeclaredIds()) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.division_undeclared",
						severity: "warning",
						message: `Extension '${extensionId}' used undeclared division '${divisionId}'; it stays enabled unless a rule disables it.`,
						extensionId,
						agentId: options.agentId,
					}),
				);
			}
			for (const divisionId of scope.resolver.listUnknownSelectionIds()) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.division_unknown",
						severity: "warning",
						message: `Division rule '${extensionId}/${divisionId}' does not match any division of extension '${extensionId}' and was ignored.`,
						extensionId,
						agentId: options.agentId,
					}),
				);
			}
			divisions.push(...scope.resolver.snapshots());
		}

		// An incompatible extension nobody asked for by name is simply absent, but
		// it still has to be visible somewhere. A file-sourced one already said so
		// while it was being read; a programmatically registered one has no such
		// moment, so this is its only report. Warning, not error: no configuration
		// named it, so nothing the user asked for went unmet.
		for (const [extensionId, incompatible] of this._incompatible) {
			if (incompatible.fromModule || extensionIds.includes(extensionId)) {
				continue;
			}
			diagnostics.push(
				createExtensionDiagnostic({
					code: "extension.version_incompatible",
					severity: "warning",
					message: `Extension '${extensionId}' was not loaded: it targets extension API version ${incompatible.declaredApiVersion}, and this runtime supports ${formatSupportedApiVersions()}.`,
					extensionId,
					agentId: options.agentId,
				}),
			);
		}

		return {
			agentId: options.agentId,
			profileId: options.profileId,
			extensionIds,
			extensions,
			diagnostics,
			toolContributions,
			providerContributions,
			profileContributions,
			systemPromptContributions,
			observerHandlers,
			interceptorHandlers,
			extensionEventHandlers,
			disposeHandlers,
			divisions,
		};
	}

	private _setDivisionIssues(extensionId: string, issues: readonly string[]): void {
		if (issues.length === 0) {
			this._divisionIssues.delete(extensionId);
			return;
		}
		this._divisionIssues.set(extensionId, [...issues]);
	}

	private _removeModuleFactories(): void {
		for (const [extensionId, factory] of this._moduleFactories) {
			if (this._factories.get(extensionId) === factory) {
				this._factories.delete(extensionId);
				this._factoryIdentities.delete(extensionId);
				this._divisionIssues.delete(extensionId);
			}
		}
		this._moduleFactories.clear();
		for (const [extensionId, record] of this._incompatible) {
			if (record.fromModule) {
				this._incompatible.delete(extensionId);
			}
		}
	}
}

interface ResolvedExtensionModule {
	readonly factory: ExtensionFactory;
	readonly declaredApiVersion?: number;
	/** Unvalidated module data; `validateDivisionDeclarations` narrows it. */
	readonly divisions?: unknown;
}

function resolveExtensionModule(module: unknown): ResolvedExtensionModule | undefined {
	if (typeof module === "function") {
		return { factory: module as ExtensionFactory };
	}
	if (isRecord(module) && typeof module.activate === "function" && typeof module.apiVersion === "number") {
		return {
			factory: module.activate as ExtensionFactory,
			declaredApiVersion: module.apiVersion,
			divisions: module.divisions,
		};
	}
	return undefined;
}

function formatSupportedApiVersions(): string {
	return MIN_SUPPORTED_EXTENSION_API_VERSION === EXTENSION_API_VERSION
		? `version ${EXTENSION_API_VERSION}`
		: `versions ${MIN_SUPPORTED_EXTENSION_API_VERSION} through ${EXTENSION_API_VERSION}`;
}

interface ResolvedExtensionEntry {
	readonly entryPath: string;
	readonly source: ExtensionSource;
}

interface ResolveCandidateEntryResult {
	readonly entry?: ResolvedExtensionEntry;
	readonly diagnostics: readonly CoreDiagnostic[];
}

const EXTENSION_FILE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

async function resolveCandidateEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<ResolveCandidateEntryResult> {
	if (candidate.kind === "file") {
		return {
			entry: {
				entryPath: candidate.path,
				source: { kind: "file", path: candidate.path, resolvedPath: candidate.path, root: candidate.root },
			},
			diagnostics: [],
		};
	}

	const packageEntry = await resolvePackageEntry(executionEnv, candidate);
	if (packageEntry.entry || packageEntry.hasManifest) {
		return { entry: packageEntry.entry, diagnostics: packageEntry.diagnostics };
	}

	const indexEntry = await resolveDirectoryIndexEntry(executionEnv, candidate);
	if (indexEntry) {
		return { entry: indexEntry, diagnostics: [] };
	}

	return {
		diagnostics: [
			createExtensionLoadDiagnostic({
				code: "extension.entry_missing",
				severity: "warning",
				message: `Extension '${candidate.id}' at ${candidate.path} has no package entry or index file.`,
				extensionId: candidate.id,
			}),
		],
	};
}

async function resolvePackageEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<ResolveCandidateEntryResult & { readonly hasManifest: boolean }> {
	const packageJsonPath = joinPath(candidate.path, "package.json");
	const infoResult = await executionEnv.fileInfo(packageJsonPath);
	if (!infoResult.ok || infoResult.value.kind !== "file") {
		return { hasManifest: false, diagnostics: [] };
	}

	const contentResult = await executionEnv.readTextFile(packageJsonPath);
	if (!contentResult.ok) {
		return {
			hasManifest: true,
			diagnostics: [
				createExtensionLoadDiagnostic({
					code: "extension.invalid_manifest",
					severity: "error",
					message: `Failed to read extension manifest ${packageJsonPath}: ${contentResult.error.message}`,
					extensionId: candidate.id,
				}),
			],
		};
	}

	const manifest = parseExtensionPackageManifest(contentResult.value);
	if (!manifest.ok) {
		return {
			hasManifest: true,
			diagnostics: [
				createExtensionLoadDiagnostic({
					code: "extension.invalid_manifest",
					severity: "error",
					message: `Invalid extension manifest ${packageJsonPath}: ${manifest.reason}`,
					extensionId: candidate.id,
				}),
			],
		};
	}

	if (!manifest.entries) {
		return { hasManifest: false, diagnostics: [] };
	}

	const diagnostics: CoreDiagnostic[] = [];
	const [firstEntry, ...extraEntries] = manifest.entries;
	if (!firstEntry) {
		return { hasManifest: true, diagnostics };
	}
	if (extraEntries.length > 0) {
		diagnostics.push(
			createExtensionLoadDiagnostic({
				code: "extension.extra_entries_ignored",
				severity: "warning",
				message: `Extension '${candidate.id}' declares multiple entries; only ${firstEntry} will be used.`,
				extensionId: candidate.id,
			}),
		);
	}

	const entryPath = resolvePath(candidate.path, firstEntry);
	const entryInfo = await executionEnv.fileInfo(entryPath);
	if (!entryInfo.ok || entryInfo.value.kind !== "file") {
		diagnostics.push(
			createExtensionLoadDiagnostic({
				code: "extension.entry_missing",
				severity: "warning",
				message: `Extension '${candidate.id}' entry does not exist: ${entryPath}`,
				extensionId: candidate.id,
			}),
		);
		return { hasManifest: true, diagnostics };
	}

	return {
		hasManifest: true,
		entry: {
			entryPath,
			source: { kind: "package", path: candidate.path, resolvedPath: packageJsonPath, entryPath, root: candidate.root },
		},
		diagnostics,
	};
}

async function resolveDirectoryIndexEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<ResolvedExtensionEntry | undefined> {
	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		const entryPath = joinPath(candidate.path, `index${extension}`);
		const infoResult = await executionEnv.fileInfo(entryPath);
		if (infoResult.ok && infoResult.value.kind === "file") {
			return { entryPath, source: { kind: "file", path: entryPath, resolvedPath: entryPath, root: candidate.root } };
		}
	}
	return undefined;
}

async function hasDirectoryEntry(executionEnv: ExecutionEnv, directoryPath: string): Promise<boolean> {
	const packageInfo = await executionEnv.fileInfo(joinPath(directoryPath, "package.json"));
	if (packageInfo.ok && packageInfo.value.kind === "file") {
		return true;
	}

	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		const indexInfo = await executionEnv.fileInfo(joinPath(directoryPath, `index${extension}`));
		if (indexInfo.ok && indexInfo.value.kind === "file") {
			return true;
		}
	}
	return false;
}

type ManifestParseResult =
	| { readonly ok: true; readonly entries?: readonly string[] }
	| { readonly ok: false; readonly reason: string };

function parseExtensionPackageManifest(content: string): ManifestParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		return { ok: false, reason: formatError(error) };
	}

	if (!isRecord(parsed)) {
		return { ok: false, reason: "package.json must contain an object." };
	}

	const section = isRecord(parsed.widi) ? parsed.widi : isRecord(parsed.pi) ? parsed.pi : undefined;
	if (!section) {
		return { ok: true };
	}

	if (!("extensions" in section)) {
		return { ok: true };
	}
	if (!Array.isArray(section.extensions)) {
		return { ok: false, reason: "extensions must be an array of entry paths." };
	}

	const entries: string[] = [];
	for (const entry of section.extensions) {
		if (typeof entry !== "string") {
			return { ok: false, reason: "extensions must only contain string entry paths." };
		}
		const normalized = entry.trim();
		if (normalized) entries.push(normalized);
	}

	return { ok: true, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ExtensionDivisionFailure {
	readonly divisionId: string;
	readonly error: unknown;
}

/**
 * Mutable per-extension activation state. Every division scope of one
 * extension shares it, so contributions stay in registration order across
 * nested divisions and the loader keeps a single place to settle pending
 * registrations from.
 */
interface ExtensionActivationScope {
	readonly extensionId: string;
	readonly agentId: string;
	readonly profileId: string;
	readonly resolver: ExtensionDivisionResolver;
	readonly pending: Promise<void>[];
	readonly divisionFailures: ExtensionDivisionFailure[];
	readonly divisionDiagnostics: CoreDiagnostic[];
	readonly toolContributions: ExtensionToolContribution[];
	readonly providerContributions: ExtensionProviderContribution[];
	readonly profileContributions: ExtensionProfileContribution[];
	readonly systemPromptContributions: ExtensionSystemPromptContribution[];
	readonly observerHandlers: Map<ExtensionObservedEventName, ExtensionObserverRegistration[]>;
	readonly interceptorHandlers: Map<
		ExtensionInterceptorName,
		ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
	readonly extensionEventHandlers: Map<string, ExtensionEventRegistration[]>;
	readonly disposeHandlers: ExtensionDisposeRegistration[];
}

/**
 * A division's `register` callback can open further divisions, so drain the
 * queue until it stays empty instead of awaiting one generation.
 */
async function settlePendingDivisions(scope: ExtensionActivationScope): Promise<void> {
	while (scope.pending.length > 0) {
		await Promise.all(scope.pending.splice(0));
	}
}

/**
 * Shared gate for `division()` and `isDivisionEnabled()`: an invalid id is
 * never enabled, so an imperative branch cannot run side effects the scoped
 * form would have refused.
 */
function resolveDivisionId(scope: ExtensionActivationScope, divisionId: string): boolean {
	const invalid = validateDivisionId(divisionId);
	if (invalid) {
		scope.divisionDiagnostics.push(
			createExtensionDiagnostic({
				code: "extension.division_invalid",
				severity: "warning",
				message: `Extension '${scope.extensionId}' used an invalid division id and it was skipped: ${invalid}`,
				extensionId: scope.extensionId,
				agentId: scope.agentId,
			}),
		);
		return false;
	}
	return scope.resolver.isEnabled(divisionId);
}

function createActivationApi(scope: ExtensionActivationScope, divisionId?: string): ExtensionActivationApi {
	const extensionId = scope.extensionId;
	return {
		extensionId,
		agentId: scope.agentId,
		profileId: scope.profileId,
		division: async (id, register) => {
			const childId = joinDivisionId(divisionId, id);
			if (!resolveDivisionId(scope, childId)) return;
			// A failing division is recorded rather than rethrown: one broken part
			// of an integration must not abort the parts registered after it, and
			// the loader reports the failure exactly once either way.
			const pending = (async () => {
				try {
					await register(createActivationApi(scope, childId));
				} catch (error) {
					scope.divisionFailures.push({ divisionId: childId, error });
				}
			})();
			scope.pending.push(pending);
			await pending;
		},
		isDivisionEnabled: (id) => resolveDivisionId(scope, joinDivisionId(divisionId, id)),
		registerTool: (tool) => {
			scope.toolContributions.push({
				kind: "define",
				extensionId,
				definition: tool as ExtensionToolDefinition,
				source: { kind: "extension", id: extensionId },
				divisionId,
			});
		},
		patchTool: (targetToolName, patch) => {
			scope.toolContributions.push({
				kind: "patch",
				extensionId,
				targetToolName,
				patch: patch as ExtensionToolDefinitionPatch,
				source: { kind: "extension", id: extensionId },
				divisionId,
			});
		},
		registerProvider: (providerName, config) => {
			const normalized = providerName.trim();
			if (!normalized) {
				throw new Error("Extension provider name must not be empty.");
			}
			scope.providerContributions.push({ extensionId, providerName: normalized, config, divisionId });
		},
		registerProfile: (profile) => {
			const id = profile.id.trim();
			if (!id) {
				throw new Error("Extension profile id must not be empty.");
			}
			if (!profile.systemPrompt.trim()) {
				throw new Error(`Extension profile '${id}' must define a system prompt.`);
			}
			scope.profileContributions.push({ extensionId, profile: { ...profile, id }, divisionId });
		},
		appendSystemPrompt: (text) => {
			const normalized = text.trim();
			if (!normalized) {
				throw new Error("Appended system prompt text must not be empty.");
			}
			scope.systemPromptContributions.push({ extensionId, text: normalized, divisionId });
		},
		observe: (eventName, handler) => {
			const registrations = scope.observerHandlers.get(eventName) ?? [];
			registrations.push({ extensionId, eventName, handler: handler as unknown as ExtensionObserver, divisionId });
			scope.observerHandlers.set(eventName, registrations);
		},
		intercept: (eventName, handler) => {
			const registrations = scope.interceptorHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId,
				eventName,
				handler: handler as unknown as ExtensionInterceptorFor<ExtensionInterceptorName>,
				divisionId,
			});
			scope.interceptorHandlers.set(eventName, registrations);
		},
		onExtensionEvent: (name, handler) => {
			// Validate at registration rather than at delivery: a typo in a
			// subscription is otherwise silent forever, since a name nobody emits
			// looks exactly like one nobody sent yet.
			const eventName = validateExtensionEventName(name);
			const registrations = scope.extensionEventHandlers.get(eventName) ?? [];
			registrations.push({ extensionId, eventName, handler, divisionId });
			scope.extensionEventHandlers.set(eventName, registrations);
		},
		onDispose: (handler) => {
			scope.disposeHandlers.push({ extensionId, handler, divisionId });
		},
	};
}

function normalizeExtensionIds(extensionIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const rawId of extensionIds) {
		const extensionId = rawId.trim();
		if (!extensionId || seen.has(extensionId)) continue;
		seen.add(extensionId);
		normalized.push(extensionId);
	}
	return normalized;
}

async function discoverDirectory(
	executionEnv: ExecutionEnv,
	root: ExtensionRoot,
	directoryPath: string,
): Promise<{
	readonly candidates: readonly ExtensionDiscoveryCandidate[];
	readonly diagnostics: readonly CoreDiagnostic[];
}> {
	const listResult = await executionEnv.listDir(directoryPath);
	if (!listResult.ok) {
		return {
			candidates: [],
			diagnostics: [
				createExtensionDiscoveryDiagnostic({
					code: "extension.list_failed",
					severity: "error",
					message: `Failed to list extension source ${directoryPath}: ${listResult.error.message}`,
					root,
				}),
			],
		};
	}

	// Sorted within the directory so one root's contents load in a stable order;
	// the caller keeps roots in their own order rather than sorting across them.
	const candidates = await Promise.all(
		listResult.value.map((entry) => candidateFromFileInfo(executionEnv, root, entry)),
	);
	return {
		candidates: candidates
			.flatMap((candidate) => (candidate ? [candidate] : []))
			.sort((left, right) => left.path.localeCompare(right.path)),
		diagnostics: [],
	};
}

/**
 * fileInfo does not follow symlinks. A dangling link is not a candidate; a
 * live one is discovered under its real path, so the entry imports relative
 * to where the files actually live.
 */
async function followSymlink(executionEnv: ExecutionEnv, info: FileInfo): Promise<FileInfo | undefined> {
	if (info.kind !== "symlink") return info;
	const canonicalPath = await executionEnv.canonicalPath(info.path);
	if (!canonicalPath.ok) return undefined;
	const target = await executionEnv.fileInfo(canonicalPath.value);
	return target.ok ? target.value : undefined;
}

async function candidateFromFileInfo(
	executionEnv: ExecutionEnv,
	root: ExtensionRoot,
	fileInfo: FileInfo,
): Promise<ExtensionDiscoveryCandidate | undefined> {
	const info = await followSymlink(executionEnv, fileInfo);
	if (!info) return undefined;
	if (info.kind === "directory") {
		return { id: basename(info.path), root, path: info.path, kind: "directory" };
	}
	if (info.kind !== "file") {
		return undefined;
	}

	const id = extensionFileId(info.path);
	if (!id) {
		return undefined;
	}
	return { id, root, path: info.path, kind: "file" };
}

function extensionFileId(path: string): string | undefined {
	const name = basename(path);
	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		if (name.endsWith(extension) && name.length > extension.length) {
			return name.slice(0, -extension.length);
		}
	}
	return undefined;
}

function basename(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? normalized : normalized.slice(index + 1);
}

function joinPath(basePath: string, childPath: string): string {
	return resolvePath(basePath, childPath);
}

function resolvePath(basePath: string, path: string): string {
	if (path.startsWith("/")) return normalizePath(path);
	return normalizePath(`${basePath}/${path}`);
}

function normalizePath(path: string): string {
	const absolute = path.startsWith("/");
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const normalized = segments.join("/");
	if (absolute) return `/${normalized}`.replace(/\/$/, "") || "/";
	return normalized || ".";
}

function createExtensionDiscoveryDiagnostic(options: {
	code: "extension.source_missing" | "extension.file_info_failed" | "extension.list_failed";
	severity: DiagnosticSeverity;
	message: string;
	root: ExtensionRoot;
}): CoreDiagnostic {
	return { code: options.code, severity: options.severity, message: options.message };
}

function createExtensionLoadDiagnostic(options: {
	code:
		| "extension.entry_missing"
		| "extension.extra_entries_ignored"
		| "extension.factory_invalid"
		| "extension.id_conflict"
		| "extension.invalid_manifest"
		| "extension.load_failed"
		| "extension.version_incompatible";
	severity: DiagnosticSeverity;
	message: string;
	extensionId: string;
}): CoreDiagnostic {
	return { code: options.code, severity: options.severity, message: options.message, extensionId: options.extensionId };
}

function createMissingFactoryDiagnostic(options: {
	extensionId: string;
	agentId: string;
	severity: "ignore" | "warning" | "error";
}): CoreDiagnostic | undefined {
	if (options.severity === "ignore") return undefined;
	return createExtensionDiagnostic({
		code: "extension.factory_missing",
		severity: options.severity,
		message: `Extension '${options.extensionId}' is enabled but no factory is registered.`,
		extensionId: options.extensionId,
		agentId: options.agentId,
	});
}

function createExtensionDiagnostic(options: {
	code: string;
	severity: DiagnosticSeverity;
	message: string;
	extensionId: string;
	agentId: string;
}): CoreDiagnostic {
	return {
		code: options.code,
		severity: options.severity,
		message: options.message,
		agentId: options.agentId,
		extensionId: options.extensionId,
	};
}
