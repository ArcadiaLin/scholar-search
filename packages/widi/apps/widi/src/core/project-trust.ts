import type { ExecutionEnv } from "@arcadialin/agent-core";
import { AsyncLock } from "../utils/async-lock.ts";
import { unwrapResult } from "../utils/result.ts";
import { DEFAULT_AGENT_DIR } from "./constants.js";
import type { CoreDiagnostic } from "./diagnostics.ts";
import type { DefaultProjectTrust } from "./setting-manager.js";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	readonly path: string;
	readonly decision: boolean;
}

export interface ProjectTrustUpdate {
	readonly path: string;
	readonly decision: ProjectTrustDecision;
}

export type ProjectTrustDecisionSource = "override" | "store" | "settings_default" | "implicit_no_project_resources";

export interface ProjectTrustResolution {
	readonly trusted: boolean;
	readonly source: ProjectTrustDecisionSource;
	readonly diagnostic?: CoreDiagnostic;
}

export interface ResolveProjectTrustOptions {
	readonly cwd: string;
	readonly executionEnv: ExecutionEnv;
	readonly trustStore: ProjectTrustStore;
	readonly trustOverride?: boolean;
	readonly defaultProjectTrust?: DefaultProjectTrust;
	readonly projectConfigDir?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"profiles",
	"extensions",
	"skills",
	"prompts",
	"themes",
] as const;

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function dirname(path: string): string {
	const normalized = normalizePath(path);
	if (normalized === "/") return "/";
	const index = normalized.lastIndexOf("/");
	if (index <= 0) return "/";
	return normalized.slice(0, index);
}

function parseTrustFile(content: string | undefined): TrustFile {
	if (!content) return {};
	const parsed = JSON.parse(content) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid trust store: expected an object");
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[normalizePath(key)] = value;
	}
	return data;
}

function serializeTrustFile(data: TrustFile): string {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	return `${JSON.stringify(sorted, null, 2)}\n`;
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let current = normalizePath(cwd);
	while (true) {
		const decision = data[current];
		if (decision === true || decision === false) {
			return { path: current, decision };
		}

		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export class ProjectTrustStore {
	private readonly executionEnv: ExecutionEnv;
	private readonly agentDir: string;
	private readonly lock = new AsyncLock();
	private trustPath: string | undefined;

	constructor(options: { readonly executionEnv: ExecutionEnv; readonly agentDir?: string }) {
		this.executionEnv = options.executionEnv;
		this.agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
	}

	async get(cwd: string): Promise<ProjectTrustDecision> {
		return (await this.getEntry(cwd))?.decision ?? null;
	}

	async getEntry(cwd: string): Promise<ProjectTrustStoreEntry | null> {
		const normalizedCwd = await this.absolutePath(cwd);
		return await this.withTrustFile(async (data) => findNearestTrustEntry(data, normalizedCwd));
	}

	async set(cwd: string, decision: ProjectTrustDecision): Promise<void> {
		await this.setMany([{ path: cwd, decision }]);
	}

	async setMany(updates: readonly ProjectTrustUpdate[]): Promise<void> {
		const normalizedUpdates = await Promise.all(
			updates.map(async (update) => ({ path: await this.absolutePath(update.path), decision: update.decision })),
		);
		await this.withTrustFile(async (data) => {
			for (const update of normalizedUpdates) {
				if (update.decision === null) {
					delete data[update.path];
				} else {
					data[update.path] = update.decision;
				}
			}
			return undefined;
		});
	}

	private async withTrustFile<T>(fn: (data: TrustFile) => Promise<T> | T): Promise<T> {
		return await this.lock.run(async () => {
			const path = await this.getTrustPath();
			const exists = unwrapResult(await this.executionEnv.exists(path));
			const current = exists ? unwrapResult(await this.executionEnv.readTextFile(path)) : undefined;
			const data = parseTrustFile(current);
			const before = serializeTrustFile(data);
			const result = await fn(data);
			const after = serializeTrustFile(data);
			if (after !== before) {
				unwrapResult(await this.executionEnv.writeFile(path, after));
			}
			return result;
		});
	}

	private async getTrustPath(): Promise<string> {
		if (!this.trustPath) {
			this.trustPath = unwrapResult(await this.executionEnv.joinPath([this.agentDir, "trust.json"]));
		}
		return this.trustPath;
	}

	private async absolutePath(path: string): Promise<string> {
		return normalizePath(unwrapResult(await this.executionEnv.absolutePath(path)));
	}
}

export async function hasTrustRequiringProjectResources(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly projectConfigDir?: string;
}): Promise<boolean> {
	const cwd = unwrapResult(await options.executionEnv.absolutePath(options.cwd));
	const projectConfigDir = options.projectConfigDir ?? DEFAULT_AGENT_DIR;
	const configDir = unwrapResult(await options.executionEnv.joinPath([cwd, projectConfigDir]));

	for (const entry of TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES) {
		const path = unwrapResult(await options.executionEnv.joinPath([configDir, entry]));
		const exists = await options.executionEnv.exists(path);
		if (exists.ok && exists.value) return true;
		if (!exists.ok && exists.error.code !== "not_found") return true;
	}

	return false;
}

export async function createProjectExtensionTrustDiagnostics(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly projectConfigDir?: string;
	readonly projectTrusted: boolean;
}): Promise<CoreDiagnostic[]> {
	if (options.projectTrusted) return [];

	const cwd = unwrapResult(await options.executionEnv.absolutePath(options.cwd));
	const projectConfigDir = options.projectConfigDir ?? DEFAULT_AGENT_DIR;
	const path = unwrapResult(await options.executionEnv.joinPath([cwd, projectConfigDir, "extensions"]));
	const infoResult = await options.executionEnv.fileInfo(path);
	if (!infoResult.ok || infoResult.value.kind !== "directory") {
		return [];
	}

	return [
		{
			severity: "warning",
			code: "extension.project_untrusted",
			message: `Project extensions were skipped because the project is not trusted: ${path}`,
		},
	];
}

export async function resolveProjectTrust(options: ResolveProjectTrustOptions): Promise<ProjectTrustResolution> {
	if (options.trustOverride !== undefined) {
		return { trusted: options.trustOverride, source: "override" };
	}

	if (
		!(await hasTrustRequiringProjectResources({
			executionEnv: options.executionEnv,
			cwd: options.cwd,
			projectConfigDir: options.projectConfigDir,
		}))
	) {
		return { trusted: true, source: "implicit_no_project_resources" };
	}

	const storedDecision = await options.trustStore.get(options.cwd);
	if (storedDecision !== null) {
		return { trusted: storedDecision, source: "store" };
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return { trusted: true, source: "settings_default" };
		case "never":
			return { trusted: false, source: "settings_default" };
		case "ask":
			return {
				trusted: false,
				source: "settings_default",
				diagnostic: {
					severity: "warning",
					code: "project_trust.required",
					message: `Project-local WIDI resources were not loaded because project trust has not been granted: ${options.cwd}`,
				},
			};
	}
}
