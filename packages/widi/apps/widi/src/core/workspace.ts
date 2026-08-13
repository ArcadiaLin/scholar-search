import type { ExecutionEnv } from "@arcadialin/agent-core";
import type { CoreDiagnostic } from "./diagnostics.ts";
import { type ProjectTrustResolution, type ProjectTrustStore, resolveProjectTrust } from "./project-trust.ts";
import { ResourceLoader, type ResourceRoot } from "./resource-loader.ts";
import type { DefaultProjectTrust } from "./setting-manager.ts";

/**
 * One project directory and everything derived from it.
 *
 * Agents in different workspaces share the runtime, the tool table, the model
 * registry and the profile registry. What they do not share is the cwd their
 * paths resolve against, the project's trust decision, and the project-local
 * skills, prompt templates and instruction files that decision gates.
 *
 * Settings are deliberately not here. The runtime bakes the shell path, the
 * ripgrep path and image handling into the tool table once at startup, so a
 * second workspace naming different ones would only half apply - worse than not
 * applying at all. Project settings come from the workspace the process started
 * in, whichever workspace an agent then runs in.
 */
export interface Workspace {
	readonly cwd: string;
	readonly trust: ProjectTrustResolution;
	readonly resourceLoader: ResourceLoader;
}

/**
 * The half of the registry the orchestrator needs: which workspace a top-level
 * agent defaults to, and how to open the one a resumed session names.
 */
export interface WorkspaceResolver {
	readonly startup: Workspace;
	resolve(cwd: string): Promise<Workspace>;
}

/**
 * A resolver over a single directory, for a runtime that has no way to open a
 * second one. Asking it for another workspace is a wiring mistake, so it says
 * so rather than quietly answering with the one it has.
 */
export function singleWorkspaceResolver(workspace: Workspace): WorkspaceResolver {
	return {
		startup: workspace,
		resolve: async (cwd) => {
			if (cwd !== workspace.cwd) {
				throw new Error(`This runtime only has the workspace ${workspace.cwd}; ${cwd} was requested.`);
			}
			return workspace;
		},
	};
}

export interface WorkspaceRegistryOptions {
	readonly executionEnv: ExecutionEnv;
	readonly agentDir: string;
	readonly trustStore: ProjectTrustStore;
	readonly defaultProjectTrust?: DefaultProjectTrust;
	readonly trustOverride?: boolean;
	readonly projectConfigDir?: string;
	/** Settings-declared roots, the same list for every workspace. */
	readonly skillPaths: readonly string[];
	readonly promptTemplatePaths: readonly string[];
	readonly publishDiagnostic: (diagnostic: CoreDiagnostic) => Promise<void>;
}

/**
 * Every workspace this runtime has opened, keyed by absolute cwd. Resolution is
 * memoized because it reads the trust store and the filesystem, and because two
 * agents in the same directory must agree about whether it is trusted.
 */
export class WorkspaceRegistry implements WorkspaceResolver {
	private readonly options: WorkspaceRegistryOptions;
	private readonly workspaces = new Map<string, Workspace>();
	private readonly resolving = new Map<string, Promise<Workspace>>();
	private startupWorkspace: Workspace | undefined;

	/**
	 * Asked once per untrusted workspace whose trust policy is "ask". Whoever
	 * owns a human at the time installs it: the startup path while the boot
	 * prompt is up, the TUI once it is running. Unset means never ask, which
	 * leaves the workspace untrusted rather than blocking on nobody.
	 */
	confirmTrust?: (cwd: string) => Promise<boolean>;

	constructor(options: WorkspaceRegistryOptions) {
		this.options = options;
	}

	/**
	 * The workspace the process started in: what a top-level agent gets when
	 * nobody named one, and the only workspace whose project settings are live.
	 */
	get startup(): Workspace {
		if (!this.startupWorkspace) throw new Error("The startup workspace has not been registered yet.");
		return this.startupWorkspace;
	}

	/**
	 * Take a workspace the caller already resolved. The startup path builds its
	 * own so the loaders below it can be constructed in one pass; handing the
	 * result over keeps the registry from resolving the same directory twice.
	 */
	adopt(workspace: Workspace): void {
		this.workspaces.set(workspace.cwd, workspace);
		this.startupWorkspace ??= workspace;
	}

	/** Already-open workspaces only; never resolves. */
	get(cwd: string): Workspace | undefined {
		return this.workspaces.get(cwd);
	}

	async resolve(cwd: string): Promise<Workspace> {
		const absolute = await absolutePath(this.options.executionEnv, cwd);
		const open = this.workspaces.get(absolute);
		if (open) return open;
		const inFlight = this.resolving.get(absolute);
		if (inFlight) return await inFlight;
		const promise = this.build(absolute);
		this.resolving.set(absolute, promise);
		try {
			const workspace = await promise;
			this.workspaces.set(absolute, workspace);
			return workspace;
		} finally {
			this.resolving.delete(absolute);
		}
	}

	private async build(cwd: string): Promise<Workspace> {
		const trust = await this.resolveTrust(cwd);
		if (trust.diagnostic) await this.options.publishDiagnostic(trust.diagnostic);
		return {
			cwd,
			trust,
			resourceLoader: await createWorkspaceResourceLoader({ ...this.options, cwd, projectTrusted: trust.trusted }),
		};
	}

	private async resolveTrust(cwd: string): Promise<ProjectTrustResolution> {
		const options = {
			cwd,
			executionEnv: this.options.executionEnv,
			trustStore: this.options.trustStore,
			trustOverride: this.options.trustOverride,
			defaultProjectTrust: this.options.defaultProjectTrust,
			projectConfigDir: this.options.projectConfigDir,
		};
		const trust = await resolveProjectTrust(options);
		if (trust.trusted || trust.source !== "settings_default") return trust;
		if ((this.options.defaultProjectTrust ?? "ask") !== "ask" || !this.confirmTrust) return trust;
		if (!(await this.confirmTrust(cwd))) return trust;
		await this.options.trustStore.set(cwd, true);
		return await resolveProjectTrust(options);
	}
}

/**
 * The loader for one workspace. Settings-declared roots come first, the
 * project's own directory only when it is trusted, and the agent dir last: the
 * same order the startup path has always used, applied per directory.
 */
export async function createWorkspaceResourceLoader(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	readonly skillPaths: readonly string[];
	readonly promptTemplatePaths: readonly string[];
}): Promise<ResourceLoader> {
	const roots = async (settingsPaths: readonly string[]): Promise<ResourceRoot[]> => [
		...(await Promise.all(
			settingsPaths.map(async (path) => ({
				kind: "settings" as const,
				path: await absolutePath(options.executionEnv, path),
			})),
		)),
		...(options.projectTrusted ? [{ kind: "cwd" as const, path: options.cwd }] : []),
		{ kind: "agent_dir" as const, path: options.agentDir },
	];
	return new ResourceLoader({
		executionEnv: options.executionEnv,
		cwd: options.cwd,
		agentDir: options.agentDir,
		skillRoots: await roots(options.skillPaths),
		promptTemplateRoots: await roots(options.promptTemplatePaths),
		// Project instruction files are project-local content like any other:
		// an untrusted project contributes none, leaving only the agent dir's.
		contextFileRoots: [
			{ kind: "agent_dir" as const, path: options.agentDir },
			...(options.projectTrusted ? [{ kind: "cwd" as const, path: options.cwd }] : []),
		],
	});
}

async function absolutePath(executionEnv: ExecutionEnv, path: string): Promise<string> {
	const result = await executionEnv.absolutePath(path);
	if (!result.ok) throw new Error(`Cannot resolve path: ${path}`);
	return result.value;
}
