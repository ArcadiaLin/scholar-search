import type { ExecutionEnv, FileError, FileInfo } from "@arcadialin/agent-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { formatError } from "../utils/errors.ts";
import { DEFAULT_AGENT_DIR, DEFAULT_PROFILE_DIR, DEFAULT_PROFILE_FILE_EXTENSION } from "./constants.js";
import type { CoreDiagnostic, DiagnosticSeverity } from "./diagnostics.ts";

/**
 * A role: what the agent is told it is, what it may reach for, and whether its
 * session outlives the runtime.
 *
 * Deliberately not here: which extensions load, and which prompt templates
 * exist. Extensions are an installation-wide fact settings owns, and prompt
 * templates are the user's own slash commands - neither is a property of the
 * role the model plays.
 */
export type AgentProfile = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly systemPrompt: string;
	readonly persist: boolean;
	readonly tools?: readonly string[];
	readonly skills?: readonly string[];
	readonly projectContext?: boolean | readonly string[];
	readonly includeCwd?: boolean;
	readonly skillsListing?: boolean;
	readonly appendSystemPrompt?: string;
};

export type AgentProfileOverride = Partial<Omit<AgentProfile, "id">>;

export type AgentProfileReference = { readonly id: string; readonly label?: string };

export type AgentProfileDiagnosticCode =
	| "profile.file_info_failed"
	| "profile.list_failed"
	| "profile.read_failed"
	| "profile.parse_failed"
	| "profile.invalid_metadata"
	| "profile.invalid"
	| "profile.id_filename_mismatch"
	| "profile.duplicate_id"
	| "profile.id_case_conflict"
	| "profile.missing"
	| "profile.disabled"
	| "profile.override_not_persistable";

export type AgentProfileDiagnosticSeverity = DiagnosticSeverity;

export type AgentProfileSourceKind = "cwd" | "agent_dir" | "memory" | "builtin" | "extension";

export type AgentProfileSource = {
	readonly kind: AgentProfileSourceKind;
	readonly priority: number;
	readonly path?: string;
	readonly label?: string;
};

export type AgentProfileDiagnostic = CoreDiagnostic;

export type SourcedAgentProfile = {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
};

export type AgentProfileSummary = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly persist: boolean;
	readonly source: AgentProfileSource;
	readonly entryId: string;
};

export type ProfileCandidateStatus = "available" | "shadowed" | "duplicate" | "invalid" | "parse_failed";

export type ProfileCandidate = {
	readonly entryId: string;
	readonly profileId?: string;
	readonly filenameId?: string;
	readonly label?: string;
	readonly description?: string;
	readonly source: AgentProfileSource;
	readonly status: ProfileCandidateStatus;
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ResolveProfileFailureReason =
	| "profile_missing"
	| "parse_failed"
	| "invalid_profile"
	| "duplicate_profile_id";

export type ResolveProfileResult =
	| {
			readonly ok: true;
			readonly profile: AgentProfile;
			readonly source: AgentProfileSource;
			readonly entryId: string;
			readonly diagnostics: AgentProfileDiagnostic[];
	  }
	| {
			readonly ok: false;
			readonly reason: ResolveProfileFailureReason;
			readonly profileId: string;
			readonly diagnostics: AgentProfileDiagnostic[];
	  };

export type ListProfilesResult = {
	readonly profiles: AgentProfileSummary[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type InspectProfilesResult = {
	readonly candidates: ProfileCandidate[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ProfileStorageEntry = {
	readonly entryId: string;
	readonly source: AgentProfileSource;
	readonly displayName?: string;
	readonly filenameId?: string;
};

export type ProfileStorageListResult = {
	readonly entries: ProfileStorageEntry[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ProfileStorageReadResult =
	| { readonly ok: true; readonly entry: ProfileStorageEntry; readonly content: string }
	| { readonly ok: false; readonly diagnostic: AgentProfileDiagnostic };

export interface ProfileStorageBackend {
	listEntries(): Promise<ProfileStorageListResult>;
	readEntry(entryId: string): Promise<ProfileStorageReadResult>;
}

export type FileProfileRoot = {
	readonly kind: Exclude<AgentProfileSourceKind, "memory" | "builtin">;
	readonly path: string;
	readonly priority: number;
	readonly label?: string;
};

type AgentProfileFrontmatter = {
	readonly id?: unknown;
	readonly label?: unknown;
	readonly description?: unknown;
	readonly whenToUse?: unknown;
	readonly persist?: unknown;
	readonly tools?: unknown;
	readonly skills?: unknown;
	readonly projectContext?: unknown;
	readonly includeCwd?: unknown;
	readonly skillsListing?: unknown;
	readonly appendSystemPrompt?: unknown;
	readonly [key: string]: unknown;
};

type ParsedProfileMarkdown = { readonly frontmatter: AgentProfileFrontmatter; readonly body: string };

type ProfileMetadata = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly persist: boolean;
	readonly filenameId?: string;
};

type ParsedProfileCandidate = {
	readonly entry: ProfileStorageEntry;
	readonly metadata?: ProfileMetadata;
	readonly markdown?: ParsedProfileMarkdown;
	readonly diagnostics: AgentProfileDiagnostic[];
	readonly status: ProfileCandidateStatus;
	readonly blockingProfileId?: string;
};

type ProfileIndex = {
	readonly candidates: ParsedProfileCandidate[];
	readonly candidatesByProfileId: Map<string, ParsedProfileCandidate[]>;
	readonly diagnostics: AgentProfileDiagnostic[];
};

/**
 * The role an agent runs as when nothing named one. It is also the id the
 * shipped `.widi/profiles/main.md` claims, so a distribution's own main profile
 * shadows this one at a higher priority instead of sitting beside it.
 */
export const BUILTIN_DEFAULT_PROFILE_ID = "main";

const BUILTIN_DEFAULT_PROFILE: AgentProfile = {
	id: BUILTIN_DEFAULT_PROFILE_ID,
	label: "Main Agent",
	systemPrompt: "You are WIDI, a helpful assistant.",
	persist: true,
};

export function toAgentProfileReference(profile: Pick<AgentProfile, "id" | "label">): AgentProfileReference {
	return { id: profile.id, label: profile.label };
}

export function parseAgentProfileReference(value: unknown): AgentProfileReference | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { id?: unknown; label?: unknown };
	if (typeof record.id !== "string" || !record.id) return undefined;
	return { id: record.id, label: typeof record.label === "string" ? record.label : undefined };
}

export function createDefaultProfileRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
}): Promise<FileProfileRoot[]> {
	return resolveDefaultProfileRoots(options);
}

export function createBuiltinProfileStorageBackend(
	profile: AgentProfile = BUILTIN_DEFAULT_PROFILE,
	priority = 0,
): InMemoryProfileStorageBackend {
	return InMemoryProfileStorageBackend.fromProfiles([
		{ profile, entryId: `builtin:${profile.id}`, source: { kind: "builtin", priority, label: "builtin" } },
	]);
}

export class FileProfileStorageBackend implements ProfileStorageBackend {
	private readonly executionEnv: ExecutionEnv;
	private readonly roots: readonly FileProfileRoot[];
	private readonly entries: Map<string, ProfileStorageEntry> = new Map();

	constructor(executionEnv: ExecutionEnv, roots: readonly FileProfileRoot[]) {
		this.executionEnv = executionEnv;
		this.roots = [...roots];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entries.clear();
		const entries: ProfileStorageEntry[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];

		for (let index = 0; index < this.roots.length; index += 1) {
			const root = this.roots[index];
			const result = await this.listRoot(root, index);
			entries.push(...result.entries);
			diagnostics.push(...result.diagnostics);
		}

		return { entries: entries.sort((a, b) => a.entryId.localeCompare(b.entryId)), diagnostics };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const entry = this.entries.get(entryId);
		if (!entry?.source.path) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
				}),
			};
		}

		const result = await this.executionEnv.readTextFile(entry.source.path);
		if (!result.ok) {
			return { ok: false, diagnostic: fileErrorDiagnostic("profile.read_failed", result.error, entry.source) };
		}

		return { ok: true, entry, content: result.value };
	}

	private async listRoot(root: FileProfileRoot, rootIndex: number): Promise<ProfileStorageListResult> {
		const source: AgentProfileSource = { kind: root.kind, priority: root.priority, path: root.path, label: root.label };
		const infoResult = await this.executionEnv.fileInfo(root.path);
		if (!infoResult.ok) {
			// A missing conventional root (cwd/agent_dir) is silent; other file
			// info errors surface as diagnostics.
			if (infoResult.error.code === "not_found") {
				return { entries: [], diagnostics: [] };
			}
			return { entries: [], diagnostics: [fileErrorDiagnostic("profile.file_info_failed", infoResult.error, source)] };
		}

		const kind = await this.resolveKind(infoResult.value);
		if (kind === "directory") {
			return await this.listDirectory(infoResult.value.path, source, rootIndex);
		}
		if (kind === "file" && isProfileFileName(infoResult.value.name)) {
			const entry = this.createFileEntry(infoResult.value, source, rootIndex);
			return { entries: [entry], diagnostics: [] };
		}

		return { entries: [], diagnostics: [] };
	}

	private async listDirectory(
		path: string,
		source: AgentProfileSource,
		rootIndex: number,
	): Promise<ProfileStorageListResult> {
		const entriesResult = await this.executionEnv.listDir(path);
		if (!entriesResult.ok) {
			return { entries: [], diagnostics: [fileErrorDiagnostic("profile.list_failed", entriesResult.error, source)] };
		}

		const entries: ProfileStorageEntry[] = [];
		for (const entry of entriesResult.value.sort((a, b) => a.name.localeCompare(b.name))) {
			const kind = await this.resolveKind(entry);
			if (kind !== "file" || !isProfileFileName(entry.name)) continue;
			entries.push(this.createFileEntry(entry, { ...source, path: entry.path }, rootIndex));
		}
		return { entries, diagnostics: [] };
	}

	private createFileEntry(info: FileInfo, source: AgentProfileSource, rootIndex: number): ProfileStorageEntry {
		const entry: ProfileStorageEntry = {
			entryId: `file:${rootIndex}:${info.path}`,
			source: { ...source, path: info.path },
			displayName: info.name,
			filenameId: profileIdFromFileName(basenameEnvPath(info.path)),
		};
		this.entries.set(entry.entryId, entry);
		return entry;
	}

	private async resolveKind(info: FileInfo): Promise<"file" | "directory" | undefined> {
		if (info.kind === "file" || info.kind === "directory") {
			return info.kind;
		}

		const canonicalPath = await this.executionEnv.canonicalPath(info.path);
		if (!canonicalPath.ok) {
			return undefined;
		}
		const target = await this.executionEnv.fileInfo(canonicalPath.value);
		if (!target.ok) {
			return undefined;
		}
		return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
	}
}

export class InMemoryProfileStorageBackend implements ProfileStorageBackend {
	private readonly entries: Map<string, { entry: ProfileStorageEntry; content: string }> = new Map();

	constructor(
		entries: readonly {
			readonly entryId: string;
			readonly content: string;
			readonly source?: AgentProfileSource;
			readonly displayName?: string;
			readonly filenameId?: string;
		}[],
	) {
		for (const item of entries) {
			const entry: ProfileStorageEntry = {
				entryId: item.entryId,
				source: item.source ?? { kind: "memory", priority: 0 },
				displayName: item.displayName,
				filenameId: item.filenameId,
			};
			this.entries.set(item.entryId, { entry, content: item.content });
		}
	}

	static fromProfiles(
		profiles: readonly {
			readonly profile: AgentProfile;
			readonly entryId?: string;
			readonly source?: AgentProfileSource;
		}[],
	): InMemoryProfileStorageBackend {
		return new InMemoryProfileStorageBackend(
			profiles.map(({ profile, entryId, source }) => ({
				entryId: entryId ?? `memory:${profile.id}`,
				source: source ?? { kind: "memory", priority: 0 },
				filenameId: profile.id,
				displayName: `${profile.id}.md`,
				content: serializeProfile(profile),
			})),
		);
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		return { entries: [...this.entries.values()].map(({ entry }) => entry), diagnostics: [] };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const item = this.entries.get(entryId);
		if (!item) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
				}),
			};
		}
		return { ok: true, entry: item.entry, content: item.content };
	}
}

/**
 * Above the built-in default and below anything the user wrote: an extension may
 * ship a role, and a file of the user's with the same id still shadows it.
 */
export const EXTENSION_PROFILE_PRIORITY = 50;

/**
 * Profiles registered by extensions at activation.
 *
 * Leased per agent, exactly like an extension's provider registration: every
 * runtime that activates the extension renews the same entry, and the profile
 * survives until the last of them is gone. That is what makes it usable at all -
 * an agent spawned on the profile activates the extension again and renews the
 * lease it is standing on.
 */
export class ExtensionProfileStorageBackend implements ProfileStorageBackend {
	private readonly entries: Map<string, { entry: ProfileStorageEntry; content: string; holders: Set<string> }> =
		new Map();

	/** Register or renew one profile for one agent; true when the table changed. */
	register(extensionId: string, agentId: string, profile: AgentProfile): boolean {
		const entryId = `extension:${extensionId}:${profile.id}`;
		const content = serializeProfile(profile);
		const existing = this.entries.get(entryId);
		if (existing) {
			const added = !existing.holders.has(agentId);
			existing.holders.add(agentId);
			// A reload can change what the same extension declares, so the content
			// is replaced rather than assumed stable across leases.
			if (existing.content === content) return added;
			this.entries.set(entryId, { entry: existing.entry, content, holders: existing.holders });
			return true;
		}
		this.entries.set(entryId, {
			entry: {
				entryId,
				source: { kind: "extension", priority: EXTENSION_PROFILE_PRIORITY, label: extensionId },
				displayName: `${profile.id}.md`,
				filenameId: profile.id,
			},
			content,
			holders: new Set([agentId]),
		});
		return true;
	}

	/** Drop every lease this agent held; true when the table changed. */
	release(agentId: string): boolean {
		let changed = false;
		for (const [entryId, item] of this.entries) {
			if (!item.holders.delete(agentId)) continue;
			changed = true;
			if (item.holders.size === 0) this.entries.delete(entryId);
		}
		return changed;
	}

	/** Profile ids currently registered, for the enablement ruling. */
	profileIds(): readonly string[] {
		return [...this.entries.values()].map((item) => item.entry.filenameId ?? "").filter((id) => id !== "");
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		return { entries: [...this.entries.values()].map(({ entry }) => entry), diagnostics: [] };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const item = this.entries.get(entryId);
		if (!item) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown extension profile entry: ${entryId}`,
				}),
			};
		}
		return { ok: true, entry: item.entry, content: item.content };
	}
}

export class CompositeProfileStorageBackend implements ProfileStorageBackend {
	private readonly backends: readonly ProfileStorageBackend[];
	private readonly entrySources: Map<string, { backend: ProfileStorageBackend; entryId: string }> = new Map();

	constructor(backends: readonly ProfileStorageBackend[]) {
		this.backends = [...backends];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entrySources.clear();
		const entries: ProfileStorageEntry[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];

		for (let index = 0; index < this.backends.length; index += 1) {
			const backend = this.backends[index];
			const result = await backend.listEntries();
			diagnostics.push(...result.diagnostics);
			for (const entry of result.entries) {
				const compositeEntryId = `${index}:${entry.entryId}`;
				this.entrySources.set(compositeEntryId, { backend, entryId: entry.entryId });
				entries.push({ ...entry, entryId: compositeEntryId });
			}
		}

		return { entries, diagnostics };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const source = this.entrySources.get(entryId);
		if (!source) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
				}),
			};
		}

		const result = await source.backend.readEntry(source.entryId);
		if (!result.ok) {
			return { ok: false, diagnostic: result.diagnostic };
		}
		return { ok: true, entry: { ...result.entry, entryId }, content: result.content };
	}
}

export class AgentProfileRegistry {
	private readonly storage: ProfileStorageBackend;
	private index: ProfileIndex | undefined;
	private readonly rawContent: Map<string, string> = new Map();

	constructor(storage: ProfileStorageBackend) {
		this.storage = storage;
	}

	reload(): void {
		this.index = undefined;
		this.rawContent.clear();
	}

	invalidate(): void {
		this.reload();
	}

	async resolveProfile(profileId: string): Promise<ResolveProfileResult> {
		const normalizedProfileId = profileId.trim();
		const index = await this.ensureIndex();
		const candidates = index.candidatesByProfileId.get(normalizedProfileId) ?? [];
		if (candidates.length === 0) {
			return {
				ok: false,
				reason: "profile_missing",
				profileId: normalizedProfileId,
				diagnostics: [
					...index.diagnostics,
					createProfileDiagnostic({
						severity: "error",
						code: "profile.missing",
						message: `Profile not found: ${normalizedProfileId}`,
					}),
				],
			};
		}

		const selected = selectProfileCandidate(candidates);
		const diagnostics = [
			...index.diagnostics,
			...diagnosticsForProfileSelection(normalizedProfileId, candidates, selected),
		];

		if (selected.status === "duplicate") {
			return { ok: false, reason: "duplicate_profile_id", profileId: normalizedProfileId, diagnostics };
		}
		if (selected.status === "parse_failed") {
			return { ok: false, reason: "parse_failed", profileId: normalizedProfileId, diagnostics };
		}
		if (selected.status === "invalid") {
			return { ok: false, reason: "invalid_profile", profileId: normalizedProfileId, diagnostics };
		}

		const content = this.rawContent.get(selected.entry.entryId);
		if (content === undefined) {
			return { ok: false, reason: "profile_missing", profileId: normalizedProfileId, diagnostics };
		}

		const parsed = parseProfileMarkdown(content);
		if (!parsed.ok) {
			return {
				ok: false,
				reason: "parse_failed",
				profileId: normalizedProfileId,
				diagnostics: [
					...diagnostics,
					diagnosticForEntry(selected.entry, "error", "profile.parse_failed", parsed.error),
				],
			};
		}

		const profileResult = parseAgentProfile(selected.entry, parsed.value, selected.entry.filenameId);
		if (!profileResult.profile) {
			return {
				ok: false,
				reason: "invalid_profile",
				profileId: normalizedProfileId,
				diagnostics: [...diagnostics, ...profileResult.diagnostics],
			};
		}

		return {
			ok: true,
			profile: profileResult.profile,
			source: selected.entry.source,
			entryId: selected.entry.entryId,
			diagnostics: [...diagnostics, ...profileResult.diagnostics],
		};
	}

	async listProfiles(): Promise<ListProfilesResult> {
		const index = await this.ensureIndex();
		const profiles: AgentProfileSummary[] = [];
		const diagnostics = [...index.diagnostics];

		for (const [profileId, candidates] of [...index.candidatesByProfileId].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			const selected = selectProfileCandidate(candidates);
			diagnostics.push(...diagnosticsForProfileSelection(profileId, candidates, selected));
			if (selected.status !== "available" || !selected.metadata) continue;
			profiles.push({
				id: selected.metadata.id,
				label: selected.metadata.label,
				description: selected.metadata.description,
				whenToUse: selected.metadata.whenToUse,
				persist: selected.metadata.persist,
				source: selected.entry.source,
				entryId: selected.entry.entryId,
			});
		}

		return { profiles, diagnostics };
	}

	async inspectProfiles(): Promise<InspectProfilesResult> {
		const index = await this.ensureIndex();
		return {
			candidates: index.candidates.map((candidate) => ({
				entryId: candidate.entry.entryId,
				profileId: candidate.metadata?.id ?? candidate.blockingProfileId,
				filenameId: candidate.entry.filenameId,
				label: candidate.metadata?.label,
				description: candidate.metadata?.description,
				source: candidate.entry.source,
				status: candidate.status,
				diagnostics: candidate.diagnostics,
			})),
			diagnostics: index.diagnostics,
		};
	}

	private async ensureIndex(): Promise<ProfileIndex> {
		if (this.index) {
			return this.index;
		}

		const listResult = await this.storage.listEntries();
		const candidates: ParsedProfileCandidate[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [...listResult.diagnostics];

		for (const entry of listResult.entries) {
			const readResult = await this.storage.readEntry(entry.entryId);
			if (!readResult.ok) {
				diagnostics.push(readResult.diagnostic);
				candidates.push({
					entry,
					status: "parse_failed",
					blockingProfileId: entry.filenameId,
					diagnostics: [readResult.diagnostic],
				});
				continue;
			}

			this.rawContent.set(entry.entryId, readResult.content);
			const parsed = parseProfileMarkdown(readResult.content);
			if (!parsed.ok) {
				const diagnostic = diagnosticForEntry(entry, "error", "profile.parse_failed", parsed.error);
				candidates.push({
					entry,
					status: "parse_failed",
					blockingProfileId: entry.filenameId,
					diagnostics: [diagnostic],
				});
				continue;
			}

			const metadataResult = parseAgentProfileMetadata(entry, parsed.value, entry.filenameId);
			candidates.push({
				entry,
				markdown: parsed.value,
				metadata: metadataResult.metadata,
				status: metadataResult.metadata ? "available" : "invalid",
				blockingProfileId: metadataResult.blockingProfileId,
				diagnostics: metadataResult.diagnostics,
			});
		}

		const candidatesByProfileId = groupCandidatesByProfileId(candidates);
		applyCandidateStatuses(candidatesByProfileId);
		diagnostics.push(...caseConflictDiagnostics(candidatesByProfileId));
		this.index = { candidates, candidatesByProfileId, diagnostics };
		return this.index;
	}
}

async function resolveDefaultProfileRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
}): Promise<FileProfileRoot[]> {
	const roots: FileProfileRoot[] = [];
	const cwdProfilePath = await joinPathOrThrow(options.executionEnv, [
		options.cwd,
		DEFAULT_AGENT_DIR,
		DEFAULT_PROFILE_DIR,
	]);
	roots.push({ kind: "cwd", path: cwdProfilePath, priority: 200 });

	if (options.agentDir) {
		const agentProfilePath = await joinPathOrThrow(options.executionEnv, [options.agentDir, DEFAULT_PROFILE_DIR]);
		roots.push({ kind: "agent_dir", path: agentProfilePath, priority: 100 });
	}

	// The agent dir may itself be the cwd's .widi directory; loading the same
	// root twice makes every profile report a bogus self-override diagnostic.
	const seenPaths = new Set<string>();
	return roots.filter((root) => {
		if (seenPaths.has(root.path)) return false;
		seenPaths.add(root.path);
		return true;
	});
}

function groupCandidatesByProfileId(
	candidates: readonly ParsedProfileCandidate[],
): Map<string, ParsedProfileCandidate[]> {
	const groups = new Map<string, ParsedProfileCandidate[]>();
	for (const candidate of candidates) {
		const profileId = candidate.metadata?.id ?? candidate.blockingProfileId;
		if (!profileId) continue;
		const group = groups.get(profileId) ?? [];
		group.push(candidate);
		groups.set(profileId, group);
	}
	return groups;
}

function applyCandidateStatuses(groups: Map<string, ParsedProfileCandidate[]>): void {
	for (const candidates of groups.values()) {
		const highestPriority = Math.max(...candidates.map(({ entry }) => entry.source.priority));
		const highest = candidates.filter(({ entry }) => entry.source.priority === highestPriority);

		if (highest.length > 1) {
			for (const candidate of highest) {
				mutateCandidateStatus(candidate, "duplicate");
			}
		}

		for (const candidate of candidates) {
			if (candidate.entry.source.priority < highestPriority) {
				mutateCandidateStatus(candidate, "shadowed");
			}
		}
	}
}

function mutateCandidateStatus(candidate: ParsedProfileCandidate, status: ProfileCandidateStatus): void {
	(candidate as { status: ProfileCandidateStatus }).status = status;
}

function selectProfileCandidate(candidates: readonly ParsedProfileCandidate[]): ParsedProfileCandidate {
	const highestPriority = Math.max(...candidates.map(({ entry }) => entry.source.priority));
	return candidates
		.filter(({ entry }) => entry.source.priority === highestPriority)
		.sort((left, right) => left.entry.entryId.localeCompare(right.entry.entryId))[0] as ParsedProfileCandidate;
}

function diagnosticsForProfileSelection(
	profileId: string,
	candidates: readonly ParsedProfileCandidate[],
	selected: ParsedProfileCandidate,
): AgentProfileDiagnostic[] {
	const diagnostics = candidates.flatMap((candidate) => candidate.diagnostics);
	const highestPriority = selected.entry.source.priority;
	const highest = candidates.filter(({ entry }) => entry.source.priority === highestPriority);

	if (highest.length > 1) {
		diagnostics.push(
			createProfileDiagnostic({
				severity: "error",
				code: "profile.duplicate_id",
				message: `Duplicate profile id at the same priority: ${profileId} (${formatSource(selected.entry.source)})`,
			}),
		);
	}

	return diagnostics;
}

function caseConflictDiagnostics(groups: Map<string, ParsedProfileCandidate[]>): AgentProfileDiagnostic[] {
	const byLowercase = new Map<string, string[]>();
	for (const id of groups.keys()) {
		const lowered = id.toLocaleLowerCase();
		const ids = byLowercase.get(lowered) ?? [];
		ids.push(id);
		byLowercase.set(lowered, ids);
	}

	const diagnostics: AgentProfileDiagnostic[] = [];
	for (const ids of byLowercase.values()) {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length <= 1) continue;
		diagnostics.push(
			createProfileDiagnostic({
				severity: "warning",
				code: "profile.id_case_conflict",
				message: `Profile ids differ only by case: ${uniqueIds.join(", ")}`,
			}),
		);
	}
	return diagnostics;
}

function parseAgentProfile(
	entry: ProfileStorageEntry,
	parsed: ParsedProfileMarkdown,
	filenameId: string | undefined,
): { profile: AgentProfile | undefined; diagnostics: AgentProfileDiagnostic[] } {
	const metadataResult = parseAgentProfileMetadata(entry, parsed, filenameId);
	if (!metadataResult.metadata) {
		return { profile: undefined, diagnostics: metadataResult.diagnostics };
	}
	const frontmatter = parsed.frontmatter;
	// Metadata diagnostics already reach the caller through the candidate index;
	// they stay in this array only so an error still blocks the profile, and are
	// sliced back off before a resolved profile reports its own field facts.
	const metadataDiagnosticCount = metadataResult.diagnostics.length;
	const diagnostics = [...metadataResult.diagnostics];
	const tools = readStringArray(frontmatter.tools, "tools", entry, diagnostics);
	const skills = readStringArray(frontmatter.skills, "skills", entry, diagnostics);
	const projectContext = readProjectContext(frontmatter.projectContext, entry, diagnostics);
	const includeCwd = readBoolean(frontmatter.includeCwd, "includeCwd", entry, diagnostics);
	const skillsListing = readBoolean(frontmatter.skillsListing, "skillsListing", entry, diagnostics);
	const appendSystemPrompt = readString(frontmatter.appendSystemPrompt);

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { profile: undefined, diagnostics };
	}

	return {
		profile: {
			id: metadataResult.metadata.id,
			label: metadataResult.metadata.label,
			description: metadataResult.metadata.description,
			whenToUse: metadataResult.metadata.whenToUse,
			systemPrompt: parsed.body,
			persist: metadataResult.metadata.persist,
			tools,
			skills,
			projectContext,
			includeCwd,
			skillsListing,
			appendSystemPrompt,
		},
		diagnostics: diagnostics.slice(metadataDiagnosticCount),
	};
}

function parseAgentProfileMetadata(
	entry: ProfileStorageEntry,
	parsed: ParsedProfileMarkdown,
	filenameId: string | undefined,
): { metadata: ProfileMetadata | undefined; blockingProfileId?: string; diagnostics: AgentProfileDiagnostic[] } {
	const frontmatter = parsed.frontmatter;
	const diagnostics: AgentProfileDiagnostic[] = [];
	const rawId = readString(frontmatter.id);
	const id = rawId ?? filenameId;
	const label = readString(frontmatter.label) ?? id;
	const description = readString(frontmatter.description);
	const whenToUse = readString(frontmatter.whenToUse);
	const persist = readBoolean(frontmatter.persist, "persist", entry, diagnostics) ?? false;

	if (!id) {
		diagnostics.push(diagnosticForEntry(entry, "error", "profile.invalid", "Profile id is missing."));
		return { metadata: undefined, diagnostics };
	}

	const idValidation = validateProfileId(id);
	if (idValidation) {
		diagnostics.push(diagnosticForEntry(entry, "error", "profile.invalid", idValidation));
		return { metadata: undefined, blockingProfileId: filenameId, diagnostics };
	}

	if (rawId && filenameId && rawId !== filenameId) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"warning",
				"profile.id_filename_mismatch",
				`Profile id "${rawId}" does not match filename-derived id "${filenameId}".`,
			),
		);
	}

	if (!parsed.body.trim()) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"warning",
				"profile.invalid_metadata",
				"Profile markdown body is empty; systemPrompt will be empty until the schema is finalized.",
			),
		);
	}

	return { metadata: { id, label: label ?? id, description, whenToUse, persist, filenameId }, diagnostics };
}

function parseProfileMarkdown(
	content: string,
): { ok: true; value: ParsedProfileMarkdown } | { ok: false; error: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { ok: true, value: { frontmatter: {}, body: normalized.trim() } };
	}

	const endIndex = normalized.indexOf("\n---", 4);
	if (endIndex === -1) {
		return { ok: false, error: "Profile frontmatter is missing a closing --- marker." };
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(normalized.slice(4, endIndex));
	} catch (error) {
		return { ok: false, error: `Cannot parse profile frontmatter: ${formatError(error)}` };
	}

	// An empty frontmatter block parses to null, which is a profile with no
	// declared fields rather than a malformed one.
	if (parsed === null || parsed === undefined) {
		return { ok: true, value: { frontmatter: {}, body: normalized.slice(endIndex + 4).trim() } };
	}
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Profile frontmatter must be a mapping of fields." };
	}

	return {
		ok: true,
		value: { frontmatter: parsed as AgentProfileFrontmatter, body: normalized.slice(endIndex + 4).trim() },
	};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(
	value: unknown,
	fieldName: string,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(
		diagnosticForEntry(entry, "error", "profile.invalid_metadata", `Profile field "${fieldName}" must be a boolean.`),
	);
	return undefined;
}

/**
 * `projectContext` is a switch and a file list at once: a boolean answers
 * whether the conventional names apply, a list replaces them with names of the
 * author's own. An empty list names no file, which is what `false` says, so it
 * normalizes to `false` rather than surviving as a list nothing can match.
 */
function readProjectContext(
	value: unknown,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): boolean | string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const fileNames: string[] = [];
		for (const item of value) {
			if (typeof item !== "string" || !item.trim()) {
				diagnostics.push(
					diagnosticForEntry(
						entry,
						"error",
						"profile.invalid_metadata",
						'Profile field "projectContext" must list non-empty file names.',
					),
				);
				return undefined;
			}
			fileNames.push(item.trim());
		}
		return fileNames.length > 0 ? fileNames : false;
	}
	diagnostics.push(
		diagnosticForEntry(
			entry,
			"error",
			"profile.invalid_metadata",
			'Profile field "projectContext" must be a boolean or an array of file names.',
		),
	);
	return undefined;
}

function readStringArray(
	value: unknown,
	fieldName: string,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"error",
				"profile.invalid_metadata",
				`Profile field "${fieldName}" must be an array of strings.`,
			),
		);
		return undefined;
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) {
			diagnostics.push(
				diagnosticForEntry(
					entry,
					"error",
					"profile.invalid_metadata",
					`Profile field "${fieldName}" must be an array of non-empty strings.`,
				),
			);
			return undefined;
		}
		items.push(item.trim());
	}
	return items.length > 0 ? items : undefined;
}

function validateProfileId(id: string): string | undefined {
	if (!id.trim()) {
		return "Profile id must be non-empty.";
	}
	if (id !== id.trim()) {
		return "Profile id must not contain leading or trailing whitespace.";
	}
	if (id.includes("/") || id.includes("\\")) {
		return "Profile id must not contain slash or backslash.";
	}
	if (hasControlCharacter(id)) {
		return "Profile id must not contain control characters.";
	}
	return undefined;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function diagnosticForEntry(
	entry: ProfileStorageEntry,
	severity: AgentProfileDiagnosticSeverity,
	code: AgentProfileDiagnosticCode,
	message: string,
): AgentProfileDiagnostic {
	return createProfileDiagnostic({ severity, code, message: `${message} (${formatSource(entry.source)})` });
}

function fileErrorDiagnostic(
	code: AgentProfileDiagnosticCode,
	error: FileError,
	source: AgentProfileSource,
): AgentProfileDiagnostic {
	return createProfileDiagnostic({ severity: "error", code, message: `${error.message} (${formatSource(source)})` });
}

function createProfileDiagnostic(options: {
	readonly severity: AgentProfileDiagnosticSeverity;
	readonly code: AgentProfileDiagnosticCode;
	readonly message: string;
}): AgentProfileDiagnostic {
	return { severity: options.severity, code: options.code, message: options.message };
}

/**
 * Only the fields a profile actually declared are written back: an absent
 * optional field and one explicitly set to its default mean different things to
 * the reader, and a round trip has to preserve which one this was.
 */
function serializeProfile(profile: AgentProfile): string {
	const frontmatter: Record<string, unknown> = { id: profile.id, label: profile.label, persist: profile.persist };
	if (profile.description) frontmatter.description = profile.description;
	if (profile.whenToUse) frontmatter.whenToUse = profile.whenToUse;
	if (profile.tools) frontmatter.tools = [...profile.tools];
	if (profile.skills) frontmatter.skills = [...profile.skills];
	if (profile.projectContext !== undefined) {
		frontmatter.projectContext =
			typeof profile.projectContext === "boolean" ? profile.projectContext : [...profile.projectContext];
	}
	if (profile.includeCwd !== undefined) {
		frontmatter.includeCwd = profile.includeCwd;
	}
	if (profile.skillsListing !== undefined) {
		frontmatter.skillsListing = profile.skillsListing;
	}
	if (profile.appendSystemPrompt) {
		frontmatter.appendSystemPrompt = profile.appendSystemPrompt;
	}
	return `---\n${stringifyYaml(frontmatter)}---\n${profile.systemPrompt}`;
}

/**
 * Profile files are recognized by an exact extension match. The listing and the
 * id it derives have to agree on that: a name this rejects never reaches
 * `profileIdFromFileName`, so accepting other spellings there would only
 * describe a case that cannot occur.
 */
function isProfileFileName(name: string): boolean {
	return name.endsWith(DEFAULT_PROFILE_FILE_EXTENSION);
}

function profileIdFromFileName(name: string): string {
	return name.slice(0, -DEFAULT_PROFILE_FILE_EXTENSION.length);
}

function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function formatSource(source: AgentProfileSource): string {
	return source.label ?? source.path ?? source.kind;
}

async function joinPathOrThrow(executionEnv: ExecutionEnv, parts: readonly string[]): Promise<string> {
	const result = await executionEnv.joinPath([...parts]);
	if (!result.ok) {
		throw result.error;
	}
	return result.value;
}
