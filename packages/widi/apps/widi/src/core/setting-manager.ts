import type { ExecutionEnv, ThinkingLevel } from "@arcadialin/agent-core";
import { AsyncLock } from "../utils/async-lock.ts";
import { unwrapResult } from "../utils/result.ts";
import { DEFAULT_AGENT_DIR } from "./constants.js";
import type { CoreDiagnostic } from "./diagnostics.ts";
import type { ExtensionDivisionSelection } from "./extension/types.ts";

/**
 * Three lines a notch, the step most terminals use for their own scrollback.
 * pi-tui defaults to one, which in a full-screen transcript reads as a stall.
 */
const DEFAULT_WHEEL_SCROLL_LINES = 3;

export interface CompactionSettings {
	/** Default: true. */
	enabled?: boolean;
	/** Default: 16384. Tokens reserved for prompt and model response. */
	reserveTokens?: number;
	/** Default: 20000. Recent context tokens retained during compaction. */
	keepRecentTokens?: number;
}

export interface BranchSummarySettings {
	/** Default: 16384. Tokens reserved for prompt and model response. */
	reserveTokens?: number;
	/** Default: false. When true, skip the branch summary prompt. */
	skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
	/** SDK/provider request timeout in milliseconds. */
	timeoutMs?: number;
	/** SDK/provider retry attempts. */
	maxRetries?: number;
	/** Default: 60000. Maximum provider-requested retry delay before failing. */
	maxRetryDelayMs?: number;
}

export interface RetrySettings {
	/** Default: true. */
	enabled?: boolean;
	/** Default: 3. */
	maxRetries?: number;
	/** Default: 2000. Exponential retry base delay in milliseconds. */
	baseDelayMs?: number;
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	/** Default: true. Only relevant when the terminal supports images. */
	showImages?: boolean;
	/** Default: 60. Preferred inline image width in terminal cells. */
	imageWidthCells?: number;
	/** Default: false. Clear empty rows when content shrinks. */
	clearOnShrink?: boolean;
	/** Default: false. Use terminal progress indicators when supported. */
	showTerminalProgress?: boolean;
	/**
	 * Default: 3. Logical lines the fullscreen viewport moves per mouse-wheel
	 * notch. Read once when the TUI is built, so a change needs a restart.
	 */
	wheelScrollLines?: number;
}

export interface ImageSettings {
	/** Default: true. Resize large images for better model compatibility. */
	autoResize?: boolean;
	/** Default: false. Prevent all images from being sent to model providers. */
	blockImages?: boolean;
}

export interface MarkdownSettings {
	/** Default: "  ". */
	codeBlockIndent?: string;
}

export interface WarningSettings {
	/** Default: true. */
	anthropicExtraUsage?: boolean;
}

export type DefaultProjectTrust = "ask" | "always" | "never";
export type ThinkingLevelSetting = ThinkingLevel;

export type PackageSource =
	| string
	| {
			/** Package, git, local file, or directory source. */
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevelSetting;
	/** Default profile id/name used when creating an agent without an explicit profile. */
	defaultProfile?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string;
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	shellCommandPrefix?: string;
	/** Explicit ripgrep executable path used by the grep and find tools. */
	rgPath?: string;
	npmCommand?: string[];
	packages?: PackageSource[];
	/** Local extension file or directory paths. */
	extensions?: string[];
	/**
	 * Extension ids agents may load. Undefined means every extension the runtime
	 * discovered or registered, which is the default: an installed extension is
	 * an installed extension. An empty array loads none.
	 */
	enabledExtensions?: string[];
	/**
	 * Division rules per extension id, for extensions that split themselves
	 * into switchable parts. Project settings replace a global entry for the
	 * same extension id rather than merging into it.
	 */
	extensionDivisions?: Record<string, ExtensionDivisionSelection>;
	/** Local skill file or directory paths. */
	skills?: string[];
	/** Local prompt template file or directory paths. */
	prompts?: string[];
	/** Local theme file or directory paths. */
	themes?: string[];
	terminal?: TerminalSettings;
	images?: ImageSettings;
	/** Model patterns used by model cycling/selectors. */
	enabledModels?: string[];
	/** Profile ids allowed by runtime policy. Undefined means no restriction. */
	enabledProfiles?: string[];
	/** Default: "tree". */
	doubleEscapeAction?: "fork" | "tree" | "none";
	/** Default: "default". */
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	/** Default: 0. Horizontal padding for input editors. */
	editorPaddingX?: number;
	/** Default: 5. Max visible items in autocomplete dropdowns. */
	autocompleteMaxVisible?: number;
	/** Show terminal cursor while still positioning it for IME. */
	showHardwareCursor?: boolean;
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	/** Custom session storage directory. */
	sessionDir?: string;
	/** Proxy URL applied to runtime-managed HTTP clients. */
	httpProxy?: string;
	/** HTTP header/body idle timeout in milliseconds; 0 disables it. */
	httpIdleTimeoutMs?: number;
	/** WebSocket connect/open handshake timeout in milliseconds; 0 disables it. */
	websocketConnectTimeoutMs?: number;
}

export type SettingsScope = "global" | "project";

export interface SettingManagerCreateOptions {
	projectTrusted?: boolean;
	cwd?: string;
	agentDir?: string;
	projectConfigDir?: string;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

export type SettingsDiagnostic = CoreDiagnostic;

export type SettingsLockResult<T> = { result: T; next?: string };

export interface SettingsStorage {
	withLockAsync<T>(
		scope: SettingsScope,
		fn: (current: string | undefined) => Promise<SettingsLockResult<T>>,
	): Promise<T>;
}

type SettingFileSystem = Pick<ExecutionEnv, "joinPath" | "readTextFile" | "writeFile" | "exists">;

function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];
		if (overrideValue === undefined) continue;

		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = {
				...(baseValue as Record<string, unknown>),
				...(overrideValue as Record<string, unknown>),
			};
		} else {
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function migrateSettings(settings: Record<string, unknown>): Settings {
	if ("queueMode" in settings && !("steeringMode" in settings)) {
		settings.steeringMode = settings.queueMode;
		delete settings.queueMode;
	}

	if (
		"skills" in settings &&
		typeof settings.skills === "object" &&
		settings.skills !== null &&
		!Array.isArray(settings.skills)
	) {
		const skillsSettings = settings.skills as { customDirectories?: unknown };
		if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
			settings.skills = skillsSettings.customDirectories;
		} else {
			delete settings.skills;
		}
	}

	if (
		"retry" in settings &&
		typeof settings.retry === "object" &&
		settings.retry !== null &&
		!Array.isArray(settings.retry)
	) {
		const retrySettings = settings.retry as Record<string, unknown>;
		const providerSettings =
			typeof retrySettings.provider === "object" && retrySettings.provider !== null
				? (retrySettings.provider as Record<string, unknown>)
				: undefined;
		if (
			typeof retrySettings.maxDelayMs === "number" &&
			(providerSettings?.maxRetryDelayMs === undefined || providerSettings.maxRetryDelayMs === null)
		) {
			retrySettings.provider = { ...(providerSettings ?? {}), maxRetryDelayMs: retrySettings.maxDelayMs };
		}
		delete retrySettings.maxDelayMs;
	}

	return settings as Settings;
}

/**
 * File-backed settings storage for global and project settings.
 *
 * Locks are scoped per settings file inside this process. They protect
 * read/merge/write cycles from concurrent callers in the same WIDI runtime, but
 * they do not make one agentDir or project config directory safe for multiple
 * writer processes.
 */
export class FileSettingsStorage implements SettingsStorage {
	private readonly fs: SettingFileSystem;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly projectConfigDir: string;
	private readonly locks: Record<SettingsScope, AsyncLock> = { global: new AsyncLock(), project: new AsyncLock() };
	private globalSettingsPath: string | undefined;
	private projectSettingsPath: string | undefined;

	constructor(executionEnv: SettingFileSystem & { cwd: string }, options: SettingManagerCreateOptions = {}) {
		this.fs = executionEnv;
		this.cwd = options.cwd ?? executionEnv.cwd;
		this.agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
		this.projectConfigDir = options.projectConfigDir ?? DEFAULT_AGENT_DIR;
	}

	async withLockAsync<T>(
		scope: SettingsScope,
		fn: (current: string | undefined) => Promise<SettingsLockResult<T>>,
	): Promise<T> {
		return await this.locks[scope].run(async () => {
			const path = await this.getSettingsPath(scope);
			const exists = unwrapResult(await this.fs.exists(path));
			const current = exists ? unwrapResult(await this.fs.readTextFile(path)) : undefined;
			const { result, next } = await fn(current);
			if (next !== undefined) {
				unwrapResult(await this.fs.writeFile(path, next));
			}
			return result;
		});
	}

	private async getSettingsPath(scope: SettingsScope): Promise<string> {
		if (scope === "global") {
			if (!this.globalSettingsPath) {
				this.globalSettingsPath = unwrapResult(await this.fs.joinPath([this.agentDir, "settings.json"]));
			}
			return this.globalSettingsPath;
		}

		if (!this.projectSettingsPath) {
			this.projectSettingsPath = unwrapResult(
				await this.fs.joinPath([this.cwd, this.projectConfigDir, "settings.json"]),
			);
		}
		return this.projectSettingsPath;
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;
	private readonly locks: Record<SettingsScope, AsyncLock> = { global: new AsyncLock(), project: new AsyncLock() };

	constructor(initialGlobal?: Settings, initialProject?: Settings) {
		if (initialGlobal) {
			this.global = JSON.stringify(migrateSettings(structuredClone(initialGlobal) as Record<string, unknown>), null, 2);
		}
		if (initialProject) {
			this.project = JSON.stringify(
				migrateSettings(structuredClone(initialProject) as Record<string, unknown>),
				null,
				2,
			);
		}
	}

	async withLockAsync<T>(
		scope: SettingsScope,
		fn: (current: string | undefined) => Promise<SettingsLockResult<T>>,
	): Promise<T> {
		return await this.locks[scope].run(async () => {
			const current = scope === "global" ? this.global : this.project;
			const { result, next } = await fn(current);
			if (next !== undefined) {
				if (scope === "global") {
					this.global = next;
				} else {
					this.project = next;
				}
			}
			return result;
		});
	}
}

export class SettingManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private globalSettingsLoadError: Error | null;
	private projectSettingsLoadError: Error | null;
	// Process-local save queue. This preserves mutation order before the storage
	// backend lock runs, but it does not coordinate writes from other WIDI
	// processes.
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private diagnostics: SettingsDiagnostic[];
	private readonly modifiedFields: Set<keyof Settings> = new Set();
	private readonly modifiedNestedFields: Map<keyof Settings, Set<string>> = new Map();
	private readonly modifiedProjectFields: Set<keyof Settings> = new Set();
	private readonly modifiedProjectNestedFields: Map<keyof Settings, Set<string>> = new Map();

	constructor(settings: Partial<Settings> = {}) {
		this.storage = new InMemorySettingsStorage(settings);
		this.globalSettings = migrateSettings(structuredClone(settings) as Record<string, unknown>);
		this.projectSettings = {};
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		this.projectTrusted = true;
		this.globalSettingsLoadError = null;
		this.projectSettingsLoadError = null;
		this.errors = [];
		this.diagnostics = [];
	}

	private static createLoaded(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null,
		projectLoadError: Error | null,
		initialErrors: SettingsError[],
		projectTrusted: boolean,
	): SettingManager {
		const manager = new SettingManager();
		manager.globalSettings = initialGlobal;
		manager.projectSettings = initialProject;
		manager.settings = deepMergeSettings(initialGlobal, initialProject);
		manager.projectTrusted = projectTrusted;
		manager.globalSettingsLoadError = globalLoadError;
		manager.projectSettingsLoadError = projectLoadError;
		manager.errors = [...initialErrors];
		manager.diagnostics = initialErrors.map(({ scope, error }) =>
			createSettingsDiagnostic(scope, "settings.load_failed", error),
		);
		manager.storage = storage;
		return manager;
	}

	static async create(executionEnv: ExecutionEnv, options: SettingManagerCreateOptions = {}): Promise<SettingManager> {
		return await SettingManager.fromStorage(new FileSettingsStorage(executionEnv, options), options);
	}

	static async fromStorage(
		storage: SettingsStorage,
		options: SettingManagerCreateOptions = {},
	): Promise<SettingManager> {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = await SettingManager.tryLoadFromStorage(storage, "global");
		const projectLoad = await SettingManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return SettingManager.createLoaded(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
	}

	static inMemory(settings: Partial<Settings> = {}): SettingManager {
		return new SettingManager(settings);
	}

	private static async loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Promise<Settings> {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		await storage.withLockAsync(scope, async (current) => {
			content = current;
			return { result: undefined };
		});
		if (!content) return {};
		return migrateSettings(JSON.parse(content) as Record<string, unknown>);
	}

	private static async tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): Promise<{ settings: Settings; error: Error | null }> {
		try {
			return { settings: await SettingManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	async setProjectTrusted(trusted: boolean): Promise<void> {
		if (this.projectTrusted === trusted) return;
		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = await SettingManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error, "settings.load_failed");
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = await SettingManager.tryLoadFromStorage(this.storage, "global");
		if (globalLoad.error) {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error, "settings.load_failed");
		} else {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		}

		const projectLoad = await SettingManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (projectLoad.error) {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error, "settings.load_failed");
		} else {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	drainDiagnostics(): SettingsDiagnostic[] {
		const drained = [...this.diagnostics];
		this.diagnostics = [];
		return drained;
	}

	updateGlobalSettings(update: (settings: Settings) => void): void {
		update(this.globalSettings);
		for (const key of Object.keys(this.globalSettings) as (keyof Settings)[]) {
			this.markModified(key);
		}
		this.save();
	}

	updateProjectSettings(update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		for (const key of Object.keys(projectSettings) as (keyof Settings)[]) {
			this.markProjectModified(key);
		}
		this.saveProjectSettings(projectSettings);
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : undefined;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevelSetting | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevelSetting): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getDefaultProfile(): string | undefined {
		return this.settings.defaultProfile;
	}

	setDefaultProfile(profile: string | undefined): void {
		this.globalSettings.defaultProfile = profile;
		this.markModified("defaultProfile");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode ?? "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode ?? "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		return this.settings.theme;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.globalSettings.compaction = { ...(this.globalSettings.compaction ?? {}), enabled };
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.globalSettings.retry = { ...(this.globalSettings.retry ?? {}), enabled };
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getRgPath(): string | undefined {
		return this.settings.rgPath;
	}

	setRgPath(path: string | undefined): void {
		this.globalSettings.rgPath = path;
		this.markModified("rgPath");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getPackages(): PackageSource[] {
		return structuredClone(this.settings.packages ?? []);
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = structuredClone(packages);
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectField("packages", (settings) => {
			settings.packages = structuredClone(packages);
		});
	}

	getEnabledProfiles(): string[] | undefined {
		return this.settings.enabledProfiles ? [...this.settings.enabledProfiles] : undefined;
	}

	setEnabledProfiles(profileIds: string[] | undefined): void {
		this.globalSettings.enabledProfiles = profileIds ? [...new Set(profileIds)] : undefined;
		this.markModified("enabledProfiles");
		this.save();
	}

	setProjectEnabledProfiles(profileIds: string[] | undefined): void {
		this.updateProjectField("enabledProfiles", (settings) => {
			settings.enabledProfiles = profileIds ? [...new Set(profileIds)] : undefined;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = [...paths];
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectField("extensions", (settings) => {
			settings.extensions = [...paths];
		});
	}

	/** Undefined means no restriction: every available extension is enabled. */
	getEnabledExtensions(): string[] | undefined {
		return this.settings.enabledExtensions ? [...this.settings.enabledExtensions] : undefined;
	}

	setEnabledExtensions(extensionIds: string[] | undefined): void {
		this.globalSettings.enabledExtensions = extensionIds ? [...new Set(extensionIds)] : undefined;
		this.markModified("enabledExtensions");
		this.save();
	}

	setProjectEnabledExtensions(extensionIds: string[] | undefined): void {
		this.updateProjectField("enabledExtensions", (settings) => {
			settings.enabledExtensions = extensionIds ? [...new Set(extensionIds)] : undefined;
		});
	}

	getExtensionDivisionSelections(): Record<string, ExtensionDivisionSelection> {
		return structuredClone(this.settings.extensionDivisions ?? {});
	}

	/**
	 * The global layer alone, which is what an editor of global rules must start
	 * from: `getExtensionDivisionSelections` returns the merged view, and writing
	 * that back would copy the project's rules into the global file.
	 */
	getGlobalExtensionDivisionSelections(): Record<string, ExtensionDivisionSelection> {
		return structuredClone(this.globalSettings.extensionDivisions ?? {});
	}

	setExtensionDivisionSelections(selections: Record<string, ExtensionDivisionSelection>): void {
		this.globalSettings.extensionDivisions = structuredClone(selections);
		this.markModified("extensionDivisions");
		this.save();
	}

	setProjectExtensionDivisionSelections(selections: Record<string, ExtensionDivisionSelection>): void {
		this.updateProjectField("extensionDivisions", (settings) => {
			settings.extensionDivisions = structuredClone(selections);
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = [...paths];
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectField("skills", (settings) => {
			settings.skills = [...paths];
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = [...paths];
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectField("prompts", (settings) => {
			settings.prompts = [...paths];
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = [...paths];
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectField("themes", (settings) => {
			settings.themes = [...paths];
		});
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels ? [...this.settings.enabledModels] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns ? [...patterns] : undefined;
		this.markModified("enabledModels");
		this.save();
	}

	getTerminalSettings(): Required<TerminalSettings> {
		return {
			showImages: this.settings.terminal?.showImages ?? true,
			imageWidthCells: this.settings.terminal?.imageWidthCells ?? 60,
			clearOnShrink: this.settings.terminal?.clearOnShrink ?? false,
			showTerminalProgress: this.settings.terminal?.showTerminalProgress ?? false,
			wheelScrollLines: this.settings.terminal?.wheelScrollLines ?? DEFAULT_WHEEL_SCROLL_LINES,
		};
	}

	getImageSettings(): Required<ImageSettings> {
		return {
			autoResize: this.settings.images?.autoResize ?? true,
			blockImages: this.settings.images?.blockImages ?? false,
		};
	}

	getHttpProxy(): string | undefined {
		return this.settings.httpProxy;
	}

	getHttpIdleTimeoutMs(): number | undefined {
		return this.validateTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs");
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		this.globalSettings.httpIdleTimeoutMs = this.validateTimeoutSetting(timeoutMs, "httpIdleTimeoutMs");
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return this.validateTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	private validateTimeoutSetting(value: number | undefined, settingName: string): number | undefined {
		if (value === undefined) return undefined;
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
		}
		return Math.floor(value);
	}

	private updateProjectField(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (!nestedKey) return;
		if (!this.modifiedNestedFields.has(field)) {
			this.modifiedNestedFields.set(field, new Set());
		}
		this.modifiedNestedFields.get(field)?.add(nestedKey);
	}

	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (!nestedKey) return;
		if (!this.modifiedProjectNestedFields.has(field)) {
			this.modifiedProjectNestedFields.set(field, new Set());
		}
		this.modifiedProjectNestedFields.get(field)?.add(nestedKey);
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(
		scope: SettingsScope,
		error: unknown,
		code: "settings.load_failed" | "settings.write_failed",
	): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
		this.diagnostics.push(createSettingsDiagnostic(scope, code, normalizedError));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => Promise<void>): void {
		this.writeQueue = this.writeQueue
			.then(async () => {
				if (scope === "project") this.assertProjectTrustedForWrite();
				await task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error, "settings.write_failed");
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private async persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): Promise<void> {
		await this.storage.withLockAsync(scope, async (current) => {
			const currentFileSettings = current ? migrateSettings(JSON.parse(current) as Record<string, unknown>) : {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null && !Array.isArray(value)) {
					const nestedModified = modifiedNestedFields.get(field);
					const baseNested = (currentFileSettings[field] as Record<string, unknown> | undefined) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified ?? []) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return { result: undefined, next: JSON.stringify(mergedSettings, null, 2) };
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		if (this.globalSettingsLoadError) return;

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);
		this.enqueueWrite("global", async () => {
			await this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		if (this.projectSettingsLoadError) return;

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", async () => {
			await this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}
}

function createSettingsDiagnostic(
	scope: SettingsScope,
	code: "settings.load_failed" | "settings.write_failed",
	error: Error,
): SettingsDiagnostic {
	return { severity: "error", code, message: `${scope} settings: ${error.message}` };
}

export { SettingManager as SettingsManager };
