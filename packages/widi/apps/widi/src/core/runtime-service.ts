import { isAbsolute } from "node:path";
import type { ExecutionEnv, ThinkingLevel } from "@arcadialin/agent-core";
import { NodeExecutionEnv } from "@arcadialin/agent-core/node";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { formatError } from "../utils/errors.ts";
import { unwrapResult } from "../utils/result.ts";
import { AgentOrchestrator, type AgentOrchestratorConfig } from "./agent-orchestrator.js";
import {
	AgentProfileRegistry,
	type AgentProfileSource,
	BUILTIN_DEFAULT_PROFILE_ID,
	createBuiltinProfileStorageBackend,
	createDefaultProfileRoots,
	ExtensionProfileStorageBackend,
	type FileProfileRoot,
	FileProfileStorageBackend,
	type ProfileStorageBackend,
	type ProfileStorageListResult,
	type ProfileStorageReadResult,
} from "./agent-profile.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_AGENT_DIR, DEFAULT_AGENT_PERSISTENCE_DIR, DEFAULT_MODELSJSON_PATH } from "./constants.js";
import { type CoreDiagnostic, OrchestratorError } from "./diagnostics.ts";
import {
	type ExtensionDiscoveryResult,
	type ExtensionLoadAvailableResult,
	ExtensionLoader,
	type ExtensionModuleImporter,
	type ExtensionRoot,
} from "./extension/index.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./http-dispatcher.ts";
import { HumanRequestBroker, type HumanRequestHandler } from "./human-request.ts";
import { ModelRegistry } from "./model-registry.js";
import { PersistenceRegistry } from "./persistence/index.ts";
import {
	createProjectExtensionTrustDiagnostics,
	type ProjectTrustResolution,
	ProjectTrustStore,
	resolveProjectTrust,
} from "./project-trust.js";
import { ConfigValueResolver } from "./resolve-config-value.js";
import type { ResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingManager } from "./setting-manager.js";
import { ToolRegistry } from "./tool-registry.ts";
import { registerCoreAgentTools } from "./tools/agents/builtin.ts";
import { registerCoreCodingTools } from "./tools/coding/builtin.ts";
import { registerCoreInteractionTools } from "./tools/interaction/builtin.ts";
import type { RuntimeModel } from "./types.ts";
import { createWorkspaceResourceLoader, WorkspaceRegistry } from "./workspace.ts";

export interface CreateWidiRuntimeOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly projectConfigDir?: string;
	readonly executionEnv?: ExecutionEnv;
	readonly trustOverride?: boolean;
	readonly requestHuman?: HumanRequestHandler;
	readonly sessionRoot?: string;
	readonly defaultProfileId?: string;
	readonly defaultModel?: RuntimeModel;
	readonly defaultThinkingLevel?: ThinkingLevel;
	readonly enabledProfileIds?: readonly string[];
	readonly toolRegistry?: ToolRegistry;
	readonly extensionLoader?: ExtensionLoader;
	readonly extensionModuleImporter?: ExtensionModuleImporter;
}

export type RuntimeDefaultProfileSource = "runtime_override" | "settings" | "builtin_fallback";
export type RuntimeDefaultModelSource = "runtime_override" | "settings" | "available_fallback" | "none";
export type RuntimeDefaultThinkingLevelSource = "runtime_override" | "settings" | "builtin_fallback";

export interface RuntimeDefaultProfileResolution {
	readonly id: string;
	readonly source: RuntimeDefaultProfileSource;
	readonly profileSource: AgentProfileSource;
}

export interface RuntimeDefaultModelResolution {
	/** Absent when source is "none": nothing authenticated to name. */
	readonly provider?: string;
	readonly modelId?: string;
	readonly source: RuntimeDefaultModelSource;
}

export interface RuntimeDefaultThinkingLevelResolution {
	readonly level: ThinkingLevel;
	readonly requestedLevel: ThinkingLevel;
	readonly source: RuntimeDefaultThinkingLevelSource;
	readonly clamped: boolean;
}

export interface WidiRuntimeServices {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectConfigDir: string;
	readonly sessionRoot: string;
	readonly projectTrust: ProjectTrustResolution;
	readonly profileRoots: readonly FileProfileRoot[];
	readonly defaultProfile: RuntimeDefaultProfileResolution;
	readonly defaultModel: RuntimeDefaultModelResolution;
	readonly defaultThinkingLevel: RuntimeDefaultThinkingLevelResolution;
	readonly extensionDiscovery: ExtensionDiscoveryResult;
	readonly extensionLoad: ExtensionLoadAvailableResult;
	readonly executionEnv: ExecutionEnv;
	readonly settingManager: SettingManager;
	readonly configValueResolver: ConfigValueResolver;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	/** The workspace the process started in; also `workspaces.startup`. */
	readonly resourceLoader: ResourceLoader;
	readonly workspaces: WorkspaceRegistry;
	readonly sessionManager: SessionManager;
	readonly toolRegistry: ToolRegistry;
	readonly extensionLoader: ExtensionLoader;
}

export interface WidiRuntime {
	readonly services: WidiRuntimeServices;
	readonly orchestrator: AgentOrchestrator;
	readonly diagnostics: readonly CoreDiagnostic[];
}

class CompositeProfileStorageBackend implements ProfileStorageBackend {
	private readonly backends: readonly ProfileStorageBackend[];
	private readonly entries = new Map<string, ProfileStorageBackend>();

	constructor(backends: readonly ProfileStorageBackend[]) {
		this.backends = [...backends];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entries.clear();
		const entries: ProfileStorageListResult["entries"] = [];
		const diagnostics: ProfileStorageListResult["diagnostics"] = [];

		for (const backend of this.backends) {
			const result = await backend.listEntries();
			entries.push(...result.entries);
			diagnostics.push(...result.diagnostics);
			for (const entry of result.entries) {
				this.entries.set(entry.entryId, backend);
			}
		}

		return { entries, diagnostics };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const backend = this.entries.get(entryId);
		if (!backend) {
			return {
				ok: false,
				diagnostic: {
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
				},
			};
		}
		return await backend.readEntry(entryId);
	}
}

async function joinPath(executionEnv: ExecutionEnv, parts: readonly string[]): Promise<string> {
	return unwrapResult(await executionEnv.joinPath([...parts]));
}

async function absolutePath(executionEnv: ExecutionEnv, path: string): Promise<string> {
	return unwrapResult(await executionEnv.absolutePath(path));
}

/**
 * Where the session store lives, when a settings file has an opinion about it.
 *
 * A relative `sessionDir` is resolved against the agent dir rather than the cwd,
 * because sessions are not project files. Resolving against the working
 * directory would give one store per directory anyone ever launched from, each
 * invisible to the others - `/resume` filters by workspace inside a root, so it
 * cannot offer a session that ended up in a different root. The store stays put
 * and the workspace becomes a group inside it.
 *
 * An explicit `--session-root` is not routed through here: it is typed in a
 * shell, and a path typed in a shell means what that shell means by it.
 */
async function resolveSettingsSessionRoot(
	executionEnv: ExecutionEnv,
	agentDir: string,
	sessionDir: string | undefined,
): Promise<string> {
	if (sessionDir === undefined) return await joinPath(executionEnv, [agentDir, DEFAULT_AGENT_PERSISTENCE_DIR]);
	if (isAbsolute(sessionDir)) return sessionDir;
	return await joinPath(executionEnv, [agentDir, sessionDir]);
}

async function createExtensionRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectConfigDir: string;
	readonly projectTrusted: boolean;
	readonly settingsPaths: readonly string[];
}): Promise<ExtensionRoot[]> {
	const settingsRoots = await Promise.all(
		options.settingsPaths.map(async (path) => ({
			kind: "settings" as const,
			path: await absolutePath(options.executionEnv, path),
		})),
	);
	const roots: ExtensionRoot[] = [
		...settingsRoots,
		...(options.projectTrusted
			? [
					{
						kind: "cwd" as const,
						path: await joinPath(options.executionEnv, [options.cwd, options.projectConfigDir, "extensions"]),
					},
				]
			: []),
		{ kind: "agent_dir" as const, path: await joinPath(options.executionEnv, [options.agentDir, "extensions"]) },
	];

	// The agent dir may itself be the cwd's config directory, the way the repo's
	// own dev run points both at the checkout. Discovering the same directory
	// twice makes the second pass report every extension in it as an id conflict
	// against the copy the first pass just registered. Root order is activation
	// order, so the earlier root is the one kept.
	const seenPaths = new Set<string>();
	return roots.filter((root) => {
		if (seenPaths.has(root.path)) return false;
		seenPaths.add(root.path);
		return true;
	});
}

async function createProfileRegistry(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
}): Promise<{
	readonly registry: AgentProfileRegistry;
	readonly extensionProfiles: ExtensionProfileStorageBackend;
	readonly roots: readonly FileProfileRoot[];
}> {
	const roots = await createDefaultProfileRoots({
		executionEnv: options.executionEnv,
		cwd: options.cwd,
		agentDir: options.agentDir,
	});
	const trustedRoots = options.projectTrusted ? roots : roots.filter((root) => root.kind !== "cwd");
	const extensionProfiles = new ExtensionProfileStorageBackend();
	return {
		registry: new AgentProfileRegistry(
			new CompositeProfileStorageBackend([
				new FileProfileStorageBackend(options.executionEnv, trustedRoots),
				extensionProfiles,
				createBuiltinProfileStorageBackend(),
			]),
		),
		extensionProfiles,
		roots: trustedRoots,
	};
}

/**
 * Interactive half of the "ask" trust policy: runs the fixed confirm request
 * through the human-request machinery so clients see the usual envelope.
 * Failures (no handler, abort, timeout) leave the project untrusted; the
 * broker's diagnostic is forwarded to the startup diagnostics.
 */
async function confirmProjectTrustViaHumanRequest(options: {
	readonly cwd: string;
	readonly requestHuman: HumanRequestHandler;
	readonly publishDiagnostic: (diagnostic: CoreDiagnostic) => Promise<void>;
}): Promise<boolean> {
	const broker = new HumanRequestBroker({
		findHumanRequestHandler: () => options.requestHuman,
		// No orchestrator event bus exists this early; request events go nowhere.
		emit: async () => {},
		publishDiagnostic: options.publishDiagnostic,
		recordAgentLifecycleFailure: async () => {},
	});
	try {
		const response = await broker.request({
			source: { kind: "system" },
			kind: "confirm",
			title: "Trust this project?",
			message: `WIDI found project-local configuration in ${options.cwd} (settings, profiles, skills, prompts, extensions). It stays disabled until the project is trusted.\n\nTrust this project and remember the decision?`,
		});
		return response.kind === "confirm" && response.confirmed;
	} catch {
		// The broker already published a diagnostic; stay untrusted.
		return false;
	}
}

async function resolveDefaultProfileId(options: {
	readonly profileRegistry: AgentProfileRegistry;
	readonly explicitDefaultProfileId?: string;
	readonly settingsDefaultProfileId?: string;
}): Promise<{ readonly resolution: RuntimeDefaultProfileResolution; readonly diagnostics: readonly CoreDiagnostic[] }> {
	const profileId = options.explicitDefaultProfileId ?? options.settingsDefaultProfileId ?? BUILTIN_DEFAULT_PROFILE_ID;
	const source: RuntimeDefaultProfileSource =
		options.explicitDefaultProfileId !== undefined
			? "runtime_override"
			: options.settingsDefaultProfileId !== undefined
				? "settings"
				: "builtin_fallback";
	const result = await options.profileRegistry.resolveProfile(profileId);
	if (!result.ok) {
		throw new OrchestratorError({
			severity: "error",
			code: "profile.default_resolution_failed",
			message: `Cannot resolve default profile ${profileId}: ${result.reason}.`,
		});
	}
	const resolution: RuntimeDefaultProfileResolution = { id: result.profile.id, source, profileSource: result.source };
	return { resolution, diagnostics: result.diagnostics };
}

async function resolveDefaultModel(options: {
	readonly modelRegistry: ModelRegistry;
	readonly settingManager: SettingManager;
	readonly explicitDefaultModel?: RuntimeModel;
}): Promise<{
	readonly model: RuntimeModel | undefined;
	readonly resolution: RuntimeDefaultModelResolution;
	readonly diagnostics: readonly CoreDiagnostic[];
}> {
	if (options.explicitDefaultModel) {
		const resolution: RuntimeDefaultModelResolution = {
			provider: options.explicitDefaultModel.provider,
			modelId: options.explicitDefaultModel.id,
			source: "runtime_override",
		};
		return { model: options.explicitDefaultModel, resolution, diagnostics: [] };
	}

	const diagnostics: CoreDiagnostic[] = [];
	const defaultProvider = options.settingManager.getDefaultProvider();
	const defaultModelId = options.settingManager.getDefaultModel();
	if (defaultProvider && defaultModelId) {
		const model = options.modelRegistry.find(defaultProvider, defaultModelId);
		if (model && (await options.modelRegistry.hasConfiguredAuth(model))) {
			const resolution: RuntimeDefaultModelResolution = {
				provider: model.provider,
				modelId: model.id,
				source: "settings",
			};
			return { model, resolution, diagnostics };
		}
		diagnostics.push({
			severity: "warning",
			code: "model.default_unavailable",
			message: `Default model ${defaultProvider}/${defaultModelId} is unavailable: not registered or no auth configured.`,
		});
	}

	const [availableModel] = await options.modelRegistry.getAvailable();
	if (availableModel) {
		const resolution: RuntimeDefaultModelResolution = {
			provider: availableModel.provider,
			modelId: availableModel.id,
			source: "available_fallback",
		};
		return { model: availableModel, resolution, diagnostics };
	}

	// No authenticated model is not fatal: the TUI must still start so the
	// user can /login (OAuth only exists inside it). Spawning refuses later.
	diagnostics.push({
		severity: "warning",
		code: "model.none_available",
		message:
			"No model has configured auth. Log in with /login or set a provider API key, then pick a model with /model.",
	});
	return { model: undefined, resolution: { source: "none" }, diagnostics };
}

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

function resolveDefaultThinkingLevel(options: {
	readonly model: RuntimeModel | undefined;
	readonly explicitDefaultThinkingLevel?: ThinkingLevel;
	readonly settingsDefaultThinkingLevel?: ThinkingLevel;
}): { readonly resolution: RuntimeDefaultThinkingLevelResolution } {
	const requestedLevel =
		options.explicitDefaultThinkingLevel ?? options.settingsDefaultThinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const source: RuntimeDefaultThinkingLevelSource =
		options.explicitDefaultThinkingLevel !== undefined
			? "runtime_override"
			: options.settingsDefaultThinkingLevel !== undefined
				? "settings"
				: "builtin_fallback";
	const level = options.model ? (clampThinkingLevel(options.model, requestedLevel) as ThinkingLevel) : requestedLevel;
	const resolution: RuntimeDefaultThinkingLevelResolution = {
		level,
		requestedLevel,
		source,
		clamped: level !== requestedLevel,
	};
	return { resolution };
}

export async function createWidiRuntime(options: CreateWidiRuntimeOptions): Promise<WidiRuntime> {
	const executionEnv = options.executionEnv ?? new NodeExecutionEnv({ cwd: options.cwd });
	const cwd = await absolutePath(executionEnv, options.cwd);
	const agentDir = await absolutePath(executionEnv, options.agentDir ?? DEFAULT_AGENT_DIR);
	const projectConfigDir = options.projectConfigDir ?? DEFAULT_AGENT_DIR;

	const globalSettingManager = await SettingManager.create(executionEnv, {
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: false,
	});
	const trustStore = new ProjectTrustStore({ executionEnv, agentDir });
	const defaultProjectTrust = globalSettingManager.getDefaultProjectTrust();
	const trustPromptDiagnostics: CoreDiagnostic[] = [];
	let projectTrust = await resolveProjectTrust({
		cwd,
		executionEnv,
		trustStore,
		trustOverride: options.trustOverride,
		defaultProjectTrust,
		projectConfigDir,
	});
	if (
		!projectTrust.trusted &&
		projectTrust.source === "settings_default" &&
		(defaultProjectTrust ?? "ask") === "ask" &&
		options.requestHuman !== undefined
	) {
		// "ask" genuinely asks: a confirmed prompt persists the decision and
		// re-resolves so every loader below sees the project as trusted.
		const confirmed = await confirmProjectTrustViaHumanRequest({
			cwd,
			requestHuman: options.requestHuman,
			publishDiagnostic: async (diagnostic) => {
				trustPromptDiagnostics.push(diagnostic);
			},
		});
		if (confirmed) {
			await trustStore.set(cwd, true);
			projectTrust = await resolveProjectTrust({
				cwd,
				executionEnv,
				trustStore,
				trustOverride: options.trustOverride,
				defaultProjectTrust,
				projectConfigDir,
			});
		}
	}
	const projectExtensionTrustDiagnostics = await createProjectExtensionTrustDiagnostics({
		executionEnv,
		cwd,
		projectConfigDir,
		projectTrusted: projectTrust.trusted,
	});

	const settingManager = await SettingManager.create(executionEnv, {
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: projectTrust.trusted,
	});
	// Settings may name their own proxy and idle timeout. The CLI entry already
	// installed a dispatcher from the environment; this is the settings-aware
	// second pass, and it still has to precede the first provider request.
	const httpDiagnostics: CoreDiagnostic[] = [];
	applyHttpProxySettings(settingManager.getHttpProxy());
	let httpIdleTimeoutMs: number | undefined;
	try {
		httpIdleTimeoutMs = settingManager.getHttpIdleTimeoutMs();
	} catch (error) {
		// A mistyped timeout degrades to the default rather than refusing to start.
		httpDiagnostics.push({
			severity: "warning",
			code: "settings.http_idle_timeout_invalid",
			message: `Ignoring httpIdleTimeoutMs: ${formatError(error)}`,
		});
	}
	configureHttpDispatcher(httpIdleTimeoutMs);

	const configValueResolver = new ConfigValueResolver(executionEnv);
	const authStorage = AuthStorage.create(
		executionEnv,
		{ configValueResolver },
		await joinPath(executionEnv, [agentDir, "auth.json"]),
	);
	const modelRegistry = await ModelRegistry.create({
		executionEnv,
		authStorage,
		configValueResolver,
		modelsJsonPath: await joinPath(executionEnv, [agentDir, DEFAULT_MODELSJSON_PATH]),
	});
	const profileRegistryResult = await createProfileRegistry({
		executionEnv,
		cwd,
		agentDir,
		projectTrusted: projectTrust.trusted,
	});
	const profileRegistry = profileRegistryResult.registry;
	const defaultProfile = await resolveDefaultProfileId({
		profileRegistry,
		explicitDefaultProfileId: options.defaultProfileId,
		settingsDefaultProfileId: settingManager.getDefaultProfile(),
	});
	const defaultModel = await resolveDefaultModel({
		modelRegistry,
		settingManager,
		explicitDefaultModel: options.defaultModel,
	});
	const defaultThinkingLevel = resolveDefaultThinkingLevel({
		model: defaultModel.model,
		explicitDefaultThinkingLevel: options.defaultThinkingLevel,
		settingsDefaultThinkingLevel: settingManager.getDefaultThinkingLevel(),
	});
	const sessionRoot = await absolutePath(
		executionEnv,
		options.sessionRoot ?? (await resolveSettingsSessionRoot(executionEnv, agentDir, settingManager.getSessionDir())),
	);
	const workspaceDiagnostics: CoreDiagnostic[] = [];
	const workspaces = new WorkspaceRegistry({
		executionEnv,
		agentDir,
		trustStore,
		defaultProjectTrust,
		trustOverride: options.trustOverride,
		projectConfigDir,
		skillPaths: settingManager.getSkillPaths(),
		promptTemplatePaths: settingManager.getPromptTemplatePaths(),
		publishDiagnostic: async (diagnostic: CoreDiagnostic) => {
			workspaceDiagnostics.push(diagnostic);
		},
	});
	// The startup workspace is built here rather than through resolve(): its
	// trust was already decided above, including the interactive ask, and the
	// registry must not run that a second time.
	const resourceLoader = await createWorkspaceResourceLoader({
		executionEnv,
		cwd,
		agentDir,
		projectTrusted: projectTrust.trusted,
		skillPaths: settingManager.getSkillPaths(),
		promptTemplatePaths: settingManager.getPromptTemplatePaths(),
	});
	workspaces.adopt({ cwd, trust: projectTrust, resourceLoader });
	const sessionManager = new SessionManager({
		fs: executionEnv,
		cwd,
		sessionsRoot: sessionRoot,
		registry: new PersistenceRegistry(),
	});
	const extensionLoader =
		options.extensionLoader ??
		new ExtensionLoader({
			moduleImporter: options.extensionModuleImporter,
			roots: await createExtensionRoots({
				executionEnv,
				cwd,
				agentDir,
				projectConfigDir,
				projectTrusted: projectTrust.trusted,
				settingsPaths: settingManager.getExtensionPaths(),
			}),
		});
	const extensionLoad = await extensionLoader.loadAvailableExtensions(executionEnv);
	const extensionDiscovery = extensionLoad.discovery;
	const toolRegistry = options.toolRegistry ?? new ToolRegistry();
	const imageSettings = settingManager.getImageSettings();
	registerCoreCodingTools(toolRegistry, {
		shellPath: settingManager.getShellPath(),
		shellCommandPrefix: settingManager.getShellCommandPrefix(),
		rgPath: settingManager.getRgPath(),
		autoResizeImages: imageSettings.autoResize,
		blockImages: imageSettings.blockImages,
	});
	registerCoreInteractionTools(toolRegistry);
	registerCoreAgentTools(toolRegistry);
	const orchestratorConfig: AgentOrchestratorConfig = {
		executionEnv,
		workspaces,
		sessionManager,
		settingManager,
		modelRegistry,
		profileRegistry,
		extensionProfiles: profileRegistryResult.extensionProfiles,
		toolRegistry,
		extensionLoader,
		defaultProfileId: defaultProfile.resolution.id,
		enabledProfileIds: options.enabledProfileIds ?? settingManager.getEnabledProfiles(),
		defaultModel: defaultModel.model,
		defaultThinkingLevel: defaultThinkingLevel.resolution.level,
	};
	const orchestrator = new AgentOrchestrator(orchestratorConfig);
	const services: WidiRuntimeServices = {
		cwd,
		agentDir,
		projectConfigDir,
		sessionRoot,
		projectTrust,
		profileRoots: profileRegistryResult.roots,
		defaultProfile: defaultProfile.resolution,
		defaultModel: defaultModel.resolution,
		defaultThinkingLevel: defaultThinkingLevel.resolution,
		extensionDiscovery,
		extensionLoad,
		executionEnv,
		settingManager,
		configValueResolver,
		authStorage,
		modelRegistry,
		profileRegistry,
		resourceLoader,
		workspaces,
		sessionManager,
		toolRegistry,
		extensionLoader,
	};
	const diagnostics = [
		...globalSettingManager.drainDiagnostics(),
		...(projectTrust.diagnostic ? [projectTrust.diagnostic] : []),
		...trustPromptDiagnostics,
		...settingManager.drainDiagnostics(),
		...httpDiagnostics,
		...authStorage.drainDiagnostics(),
		...modelRegistry.drainDiagnostics(),
		...defaultProfile.diagnostics,
		...defaultModel.diagnostics,
		...projectExtensionTrustDiagnostics,
		...extensionLoad.diagnostics,
		...workspaceDiagnostics,
	];

	return { services, orchestrator, diagnostics };
}
