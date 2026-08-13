import type {
	ExecutionEnv,
	PromptTemplate,
	PromptTemplateDiagnostic,
	Skill,
	SkillDiagnostic,
} from "@arcadialin/agent-core";
import { loadSourcedPromptTemplates, loadSourcedSkills } from "@arcadialin/agent-core";
import type { AgentProfile } from "./agent-profile.js";
import {
	DEFAULT_AGENT_DIR,
	DEFAULT_PROMPT_TEMPLATE_DIR,
	DEFAULT_PROMPT_TEMPLATE_FILE_EXTENSION,
	DEFAULT_SKILL_DIR,
} from "./constants.js";
import type { CoreDiagnostic } from "./diagnostics.ts";
import type { ProjectContextFile } from "./system-prompt.ts";

export type ResourceSource =
	| { readonly kind: "agent_dir"; readonly path: string }
	| { readonly kind: "cwd"; readonly path: string }
	| { readonly kind: "settings"; readonly path: string };
// Future consider to support loading from third-party directories.
// | { readonly kind: "third_party"; readonly path: string; readonly root: string; readonly skillDir: string };

export interface ResourceRoot {
	readonly kind: "agent_dir" | "cwd" | "settings";
	readonly path: string;
}

/**
 * The conventional names of a project's own instruction file, tried in this
 * order when a role does not name its own. Files are inlined into the system
 * prompt agent dir first, then the ancestor chain from the outermost directory
 * down to the cwd, so the most specific file is read last.
 *
 * Names are matched exactly. Enumerating case variants here would only ever
 * cover a few of them - `AGENTS.MD` but not `agents.md` - while doubling the
 * lookups on the case-insensitive filesystems where the variant can never win
 * anyway. A project that spells its file some other way names it in the role's
 * own `projectContext` list.
 */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Guards against a path shape whose parent never reaches a root. */
const MAX_CONTEXT_FILE_ANCESTORS = 128;

/**
 * A resource a profile named explicitly that no root produced. Loading skips
 * missing paths silently, which is right for an absent resource directory but
 * hides a typo or a stale entry in a profile's own list.
 */
export interface MissingResourceDiagnostic {
	readonly type: "warning";
	readonly code: "not_found";
	readonly message: string;
	readonly path: string;
}

interface ResourceInput {
	readonly path: string;
	readonly source: ResourceSource;
	/** The profile-supplied name, absent when loading a whole root. */
	readonly name?: string;
}

/** Everything an agent harness is built with, plus what went wrong loading it. */
export interface LoadedAgentResources {
	readonly skills: readonly { skill: Skill; source: ResourceSource }[];
	readonly promptTemplates: readonly { promptTemplate: PromptTemplate; source: ResourceSource }[];
	/** Empty when the agent's role turned project context off. */
	readonly contextFiles: readonly ProjectContextFile[];
	/** Already carries a `resource.*` code and the offending path. */
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface ResourceLoaderOptions {
	executionEnv: ExecutionEnv;
	cwd: string;
	agentDir?: string;
	skillRoots?: readonly ResourceRoot[];
	promptTemplateRoots?: readonly ResourceRoot[];
	/**
	 * Where to look for project instruction files. Defaults to the agent dir
	 * plus the cwd; the caller drops the cwd root for an untrusted project, the
	 * same way it narrows the other roots.
	 */
	contextFileRoots?: readonly ResourceRoot[];
}

export class ResourceLoader {
	private readonly _executionEnv: ExecutionEnv;
	private readonly _cwd: string;
	private readonly _agentDir!: string;
	private readonly _skillRoots: readonly ResourceRoot[] | undefined;
	private readonly _promptTemplateRoots: readonly ResourceRoot[] | undefined;
	private readonly _contextFileRoots: readonly ResourceRoot[];

	constructor(options: ResourceLoaderOptions) {
		this._executionEnv = options.executionEnv;
		this._cwd = options.cwd;
		this._agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
		this._skillRoots = options.skillRoots ? [...options.skillRoots] : undefined;
		this._promptTemplateRoots = options.promptTemplateRoots ? [...options.promptTemplateRoots] : undefined;
		this._contextFileRoots = options.contextFileRoots
			? [...options.contextFileRoots]
			: [
					{ kind: "agent_dir", path: this._agentDir },
					{ kind: "cwd", path: this._cwd },
				];
	}

	/** The project directory every root and relative path is resolved against. */
	getCwd(): string {
		return this._cwd;
	}

	getSkillRoots(): readonly ResourceRoot[] {
		return [...(this._skillRoots ?? [])];
	}

	getPromptTemplateRoots(): readonly ResourceRoot[] {
		return [...(this._promptTemplateRoots ?? [])];
	}

	getContextFileRoots(): readonly ResourceRoot[] {
		return [...this._contextFileRoots];
	}

	/**
	 * Load everything an agent's harness needs, in the resource layer's own
	 * vocabulary: the profile narrows skills to the ones it names, while prompt
	 * templates are the user's and always load whole.
	 *
	 * Diagnostics come back namespaced and path-annotated so the caller only has
	 * to attach the agent id and publish them.
	 */
	async loadAgentResources(profile: AgentProfile): Promise<LoadedAgentResources> {
		// The role is the only authority on its project context: an unset field
		// means the conventional file names, a list means those names instead.
		const projectContext = profile.projectContext ?? true;
		const [skills, promptTemplates, contextFiles] = await Promise.all([
			this.loadSkills(profile.skills),
			this.loadPromptTemplates(),
			projectContext === false
				? Promise.resolve({ contextFiles: [], diagnostics: [] })
				: this.loadContextFiles(projectContext === true ? undefined : projectContext),
		]);
		return {
			skills: skills.skills,
			promptTemplates: promptTemplates.promptTemplates,
			contextFiles: contextFiles.contextFiles,
			diagnostics: [
				...toResourceDiagnostics("skill", skills.diagnostics),
				...toResourceDiagnostics("prompt_template", promptTemplates.diagnostics),
				...contextFiles.diagnostics,
			],
		};
	}

	/**
	 * Load the project's own instruction files. A `cwd` root walks its ancestors
	 * up to the filesystem root, so a repository's AGENTS.md still applies when
	 * the agent starts in a subdirectory.
	 *
	 * Without names, each directory contributes at most one file - the first
	 * conventional name that exists there - because AGENTS.md and CLAUDE.md are
	 * the same instructions under two conventions. Names given by a role are the
	 * role's own choice, so every one of them that exists is loaded.
	 *
	 * A missing file is the ordinary case and stays silent; a file that exists
	 * but cannot be read is reported, because that is a project instruction the
	 * agent is running without.
	 */
	async loadContextFiles(
		fileNames?: readonly string[],
	): Promise<{ contextFiles: ProjectContextFile[]; diagnostics: CoreDiagnostic[] }> {
		const contextFiles: ProjectContextFile[] = [];
		const diagnostics: CoreDiagnostic[] = [];
		const seenPaths = new Set<string>();

		for (const root of this._contextFileRoots) {
			const rootPath = await this._absolutePath(root.path);
			const directories = root.kind === "cwd" ? ancestorPaths(rootPath) : [rootPath];
			// Ancestors come back nearest-first; the outermost instructions are
			// the most general, so they go in first.
			for (const directory of [...directories].reverse()) {
				const files = await this._loadContextFilesFromDir(directory, fileNames, diagnostics);
				for (const file of files) {
					if (seenPaths.has(file.path)) continue;
					seenPaths.add(file.path);
					contextFiles.push(file);
				}
			}
		}

		return { contextFiles, diagnostics };
	}

	/**
	 * Names are tried in order and an unreadable one falls through to the next.
	 * Conventional names stop at the first hit; named files do not.
	 */
	private async _loadContextFilesFromDir(
		directory: string,
		fileNames: readonly string[] | undefined,
		diagnostics: CoreDiagnostic[],
	): Promise<ProjectContextFile[]> {
		const files: ProjectContextFile[] = [];
		for (const name of fileNames ?? CONTEXT_FILE_NAMES) {
			const path = await this._joinPath(directory, name);
			const info = await this._executionEnv.fileInfo(path);
			if (!info.ok) {
				if (info.error.code !== "not_found") {
					diagnostics.push({
						severity: "warning",
						code: "resource.context_file.file_info_failed",
						message: `${info.error.message} (${path})`,
					});
				}
				continue;
			}
			const content = await this._executionEnv.readTextFile(path);
			if (!content.ok) {
				diagnostics.push({
					severity: "warning",
					code: "resource.context_file.read_failed",
					message: `${content.error.message} (${path})`,
				});
				continue;
			}
			files.push({ path, content: content.value });
			if (fileNames === undefined) break;
		}
		return files;
	}

	/**
	 * Expected usage: `loadSkills(profile.skills)`.
	 * Empty or missing names load every skill under each `.widi/skills` root.
	 */
	async loadSkills(
		skillNames: readonly string[] = [],
		skillDir: string = DEFAULT_SKILL_DIR,
	): Promise<{
		skills: Array<{ skill: Skill; source: ResourceSource }>;
		diagnostics: Array<(SkillDiagnostic | MissingResourceDiagnostic) & { source: ResourceSource }>;
	}> {
		const inputs = await this._resolveResourceNames(skillDir, skillNames);
		const loaded = await loadSourcedSkills(this._executionEnv, inputs);
		return {
			skills: loaded.skills,
			diagnostics: [
				...loaded.diagnostics,
				...missingNameDiagnostics(
					skillNames,
					inputs,
					loaded.skills.map(({ source }) => source),
				),
			],
		};
	}

	/**
	 * Empty or missing names load every prompt template under each
	 * `.widi/prompts` root, which is the ordinary case: prompt templates are the
	 * user's own slash commands, not a per-role resource.
	 */
	async loadPromptTemplates(
		promptTemplateNames: readonly string[] = [],
	): Promise<{
		promptTemplates: Array<{ promptTemplate: PromptTemplate; source: ResourceSource }>;
		diagnostics: Array<(PromptTemplateDiagnostic | MissingResourceDiagnostic) & { source: ResourceSource }>;
	}> {
		const inputs = await this._resolveResourceNames(DEFAULT_PROMPT_TEMPLATE_DIR, promptTemplateNames, {
			fileExtension: DEFAULT_PROMPT_TEMPLATE_FILE_EXTENSION,
		});
		const loaded = await loadSourcedPromptTemplates(this._executionEnv, inputs);
		return {
			promptTemplates: loaded.promptTemplates,
			diagnostics: [
				...loaded.diagnostics,
				...missingNameDiagnostics(
					promptTemplateNames,
					inputs,
					loaded.promptTemplates.map(({ source }) => source),
				),
			],
		};
	}

	private async _resolveResourceNames(
		resourceDirName: string,
		names: readonly string[],
		options?: { fileExtension: string },
	): Promise<ResourceInput[]> {
		const roots = this._getRoots(resourceDirName);
		const resolved: ResourceInput[] = [];
		// The agent dir may itself be the cwd's .widi directory; without dedupe
		// every resource loads twice and appears as duplicate candidates.
		const seenRoots = new Set<string>();

		for (const root of roots) {
			// For "cwd", we load from a subdirectory (e.g. ".widi/skills") to avoid potential conflicts with user files. For "agent_dir", we load directly from the specified directory to allow flexible project structures.
			const resourceRoot =
				root.kind === "settings"
					? root.path
					: await this._joinPath(
							root.kind === "cwd" ? await this._joinPath(root.path, DEFAULT_AGENT_DIR) : root.path,
							resourceDirName,
						);
			if (seenRoots.has(resourceRoot)) continue;
			seenRoots.add(resourceRoot);
			// Empty names mean "load the whole resource directory". Otherwise each name is resolved as a direct child.
			// future skill meybe support namespace like "namespace/skill_name", then we need to resolve each part of the path.
			const entries =
				names.length === 0
					? [{ path: resourceRoot, name: undefined }]
					: await Promise.all(
							names.map(async (name) => ({
								path: await this._joinPath(resourceRoot, this._withFileExtension(name, options?.fileExtension)),
								name,
							})),
						);

			for (const entry of entries) {
				resolved.push({ path: entry.path, name: entry.name, source: { kind: root.kind, path: entry.path } });
			}
		}

		return resolved;
	}

	private _getRoots(resourceDirName: string): readonly ResourceRoot[] {
		if (resourceDirName === DEFAULT_SKILL_DIR && this._skillRoots) {
			return this._skillRoots;
		}
		if (resourceDirName === DEFAULT_PROMPT_TEMPLATE_DIR && this._promptTemplateRoots) {
			return this._promptTemplateRoots;
		}
		return [
			...(this._agentDir ? [{ kind: "agent_dir" as const, path: this._agentDir }] : []),
			{ kind: "cwd" as const, path: this._cwd },
		];
	}

	// extension name such as load prompttemplate from ".md" file
	private _withFileExtension(name: string, extension?: string): string {
		if (!extension || name.endsWith(extension)) {
			return name;
		}
		return `${name}${extension}`;
	}

	// private _withNamespace

	private async _joinPath(...parts: string[]): Promise<string> {
		const result = await this._executionEnv.joinPath(parts);
		if (!result.ok) {
			throw result.error;
		}
		return result.value;
	}

	private async _absolutePath(path: string): Promise<string> {
		const result = await this._executionEnv.absolutePath(path);
		if (!result.ok) {
			throw result.error;
		}
		return result.value;
	}
}

/**
 * The directory itself followed by each ancestor, nearest first.
 *
 * Done by string rather than through the execution env: `ExecutionEnv` has no
 * dirname, and joining `".."` is not resolved by every implementation. Both
 * separators are handled because addressed paths keep their platform's shape
 * (`basenameEnvPath` in agent-profile.ts makes the same trade).
 */
function ancestorPaths(path: string): string[] {
	const paths: string[] = [];
	let current = path.replace(/[/\\]+$/, "");
	if (current === "") {
		return path === "" ? [] : [path.slice(0, 1)];
	}
	while (current && paths.length < MAX_CONTEXT_FILE_ANCESTORS) {
		paths.push(current);
		const separatorIndex = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
		if (separatorIndex < 0) break;
		const parent = current.slice(0, separatorIndex);
		// A path directly under a posix root slices down to "": that root is the
		// last directory to visit, and it has no parent of its own.
		if (parent === "") {
			paths.push(current.slice(0, separatorIndex + 1));
			break;
		}
		if (parent === current) break;
		current = parent;
	}
	return paths;
}

function toResourceDiagnostics(
	kind: "skill" | "prompt_template",
	diagnostics: readonly { type: "warning"; code: string; message: string; path: string }[],
): CoreDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		severity: diagnostic.type,
		code: `resource.${kind}.${diagnostic.code}`,
		message: `${diagnostic.message} (${diagnostic.path})`,
	}));
}

/**
 * Report every explicitly named resource that no root produced. A name is
 * tried once per root, so it only counts as missing when all of its candidate
 * paths came back empty. Loading a whole root (no names) reports nothing.
 */
function missingNameDiagnostics(
	names: readonly string[],
	inputs: readonly ResourceInput[],
	loadedSources: readonly ResourceSource[],
): Array<MissingResourceDiagnostic & { source: ResourceSource }> {
	if (names.length === 0) return [];
	const loadedPaths = new Set(loadedSources.map((source) => source.path));
	const diagnostics: Array<MissingResourceDiagnostic & { source: ResourceSource }> = [];
	for (const name of names) {
		const candidates = inputs.filter((input) => input.name === name);
		if (candidates.length === 0) continue;
		if (candidates.some((candidate) => loadedPaths.has(candidate.path))) {
			continue;
		}
		const tried = candidates.map((candidate) => candidate.path).join(", ");
		diagnostics.push({
			type: "warning",
			code: "not_found",
			message: `"${name}" was not found in any resource root (tried ${tried})`,
			path: candidates[0]?.path ?? name,
			source: candidates[0]?.source ?? { kind: "cwd", path: name },
		});
	}
	return diagnostics;
}
