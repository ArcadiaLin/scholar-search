import type {
	AgentHarnessEvent,
	CompactResult,
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	Session,
	ShellExecOptions,
} from "@arcadialin/agent-core";
import { err, ok, ExecutionError as PiExecutionError, FileError as PiFileError } from "@arcadialin/agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type MockInstance, vi } from "vitest";
import { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	type ExtensionProfileStorageBackend,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { LiveAgent, WidiAgentHarness } from "../../src/core/agent-types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { AgentContextMonitor } from "../../src/core/context-monitor.ts";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
import { type MessageSink, messageBindingFor } from "../../src/core/message.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { PersistenceRegistry } from "../../src/core/persistence/index.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import { type AgentSessionMetadata, SessionManager } from "../../src/core/session-manager.ts";
import { SettingManager } from "../../src/core/setting-manager.ts";
import { ToolRegistry } from "../../src/core/tool-registry.ts";
import { registerCoreCodingTools } from "../../src/core/tools/coding/builtin.ts";
import type { ToolDefinition } from "../../src/core/tools/types.ts";
import type { AgentContextUsage } from "../../src/core/types.ts";
import { singleWorkspaceResolver, type Workspace, type WorkspaceResolver } from "../../src/core/workspace.ts";

export class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);
	cleanupCalls = 0;

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this.normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this.normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(new PiFileError("not_found", `File not found: ${normalized}`, normalized));
		}
		return ok(content);
	}

	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.dirs.add(this.dirname(normalized));
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized) ?? "";
		const next = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, current + next);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			const content = this.files.get(normalized);
			if (content === undefined) {
				return err(new PiFileError("not_found", `Path not found: ${normalized}`, normalized));
			}
			return ok({
				name: normalized.slice(normalized.lastIndexOf("/") + 1),
				path: normalized,
				kind: "file",
				size: content.length,
				mtimeMs: 0,
			});
		}
		if (this.dirs.has(normalized)) {
			return ok({
				name: normalized.slice(normalized.lastIndexOf("/") + 1),
				path: normalized,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return err(new PiFileError("not_found", `Path not found: ${normalized}`, normalized));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(new PiFileError("not_found", `Directory not found: ${dir}`, dir));
		}

		const entries: FileInfo[] = [];
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			entries.push({
				name: directory.slice(directory.lastIndexOf("/") + 1),
				path: directory,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		for (const [filePath, content] of this.files) {
			if (this.dirname(filePath) !== dir) continue;
			entries.push({
				name: filePath.slice(filePath.lastIndexOf("/") + 1),
				path: filePath,
				kind: "file",
				size: content.length,
				mtimeMs: 0,
			});
		}
		return ok(entries);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (options?.recursive === false && !this.dirs.has(this.dirname(normalized))) {
			return err(new PiFileError("not_found", `Parent not found: ${this.dirname(normalized)}`, normalized));
		}

		let current = "";
		for (const segment of normalized.split("/").filter(Boolean)) {
			current = `${current}/${segment}`;
			this.dirs.add(current);
		}
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.files.delete(normalized);
		this.dirs.delete(normalized);
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {
		this.cleanupCalls += 1;
	}
}

/**
 * The model-facing text of one harness input.
 *
 * Since the fork widening, `prompt`/`steer`/`followUp` take a message as well
 * as a string: everything but bare shell input arrives as a `CustomMessage`
 * carrying its source. `content` is what the model reads either way.
 */
export function harnessInputText(input: unknown): string {
	if (typeof input === "string") return input;
	const content = (input as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: unknown }).type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * The harness's own phase transition, so a stubbed operation moves the phase and
 * emits `phase_change` exactly as the real one does. Activity is read from
 * `getPhase()` and published from the event, so a mock that only returns a
 * promise leaves the agent looking idle and every maintenance gate open.
 */
function movePhase(harness: WidiAgentHarness, phase: string): Promise<void> {
	return (harness as unknown as { setPhase: (next: string) => Promise<void> }).setPhase(phase);
}

/** Replace `compact()` with one the test controls. */
export function stubCompaction(harness: WidiAgentHarness): { resolve: (result: CompactResult) => void } {
	let resolve!: (result: CompactResult) => void;
	const promise = new Promise<CompactResult>((done) => {
		resolve = done;
	});
	vi.spyOn(harness, "compact").mockImplementation(async () => {
		await movePhase(harness, "compaction");
		try {
			return await promise;
		} finally {
			await movePhase(harness, "idle");
		}
	});
	return { resolve };
}

/** Replace `prompt()` with one the test controls. */
export function stubPromptRun(harness: WidiAgentHarness): {
	readonly prompt: MockInstance<WidiAgentHarness["prompt"]>;
	readonly resolve: (message: AssistantMessage) => void;
} {
	let resolve!: (message: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>((done) => {
		resolve = done;
	});
	const prompt = vi.spyOn(harness, "prompt").mockImplementation(async () => {
		await movePhase(harness, "turn");
		try {
			return await promise;
		} finally {
			await movePhase(harness, "idle");
		}
	});
	return { prompt, resolve };
}

/** The sink the shell holds on the human's behalf. */
export function humanSink(orchestrator: AgentOrchestrator): MessageSink {
	return orchestrator.messageSinkFor(messageBindingFor({ kind: "human" }));
}

/** The sink a peer agent holds, with its identity already bound in. */
export function agentSink(orchestrator: AgentOrchestrator, senderAgentId: string): MessageSink {
	return orchestrator.messageSinkFor(messageBindingFor({ kind: "agent", senderAgentId }));
}

export const defaultProfile: AgentProfile = {
	id: "main",
	label: "Main Agent",
	systemPrompt: "default prompt",
	persist: true,
};

export const restoredProfile: AgentProfile = {
	id: "worker",
	label: "Worker Agent",
	systemPrompt: "worker prompt",
	persist: true,
};

export const defaultModel: Model<"openai-completions"> = {
	id: "default-model",
	name: "Default Model",
	provider: "test-provider",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

export const restoredModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "restored-model",
	name: "Restored Model",
};

export const reasoningModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "reasoning-model",
	name: "Reasoning Model",
	reasoning: true,
	thinkingLevelMap: { minimal: null, high: "high" },
};

export async function createModelRegistry(env: MemoryExecutionEnv): Promise<ModelRegistry> {
	const configValueResolver = new ConfigValueResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	const registry = await ModelRegistry.inMemory({ executionEnv: env, authStorage, configValueResolver });
	registry.registerProvider("test-provider", {
		baseUrl: "https://example.test/v1",
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: restoredModel.id,
				name: restoredModel.name,
				reasoning: false,
				input: ["text"],
				cost: restoredModel.cost,
				contextWindow: restoredModel.contextWindow,
				maxTokens: restoredModel.maxTokens,
			},
			{
				id: reasoningModel.id,
				name: reasoningModel.name,
				reasoning: true,
				thinkingLevelMap: reasoningModel.thinkingLevelMap,
				input: ["text"],
				cost: reasoningModel.cost,
				contextWindow: reasoningModel.contextWindow,
				maxTokens: reasoningModel.maxTokens,
			},
		],
	});
	return registry;
}

export async function createEmptyModelRegistry(env: MemoryExecutionEnv): Promise<ModelRegistry> {
	const configValueResolver = new ConfigValueResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	return await ModelRegistry.inMemory({ executionEnv: env, authStorage, configValueResolver });
}

/** The single workspace every orchestrator test runs in. */
export function testWorkspaceResolver(env: MemoryExecutionEnv, cwd = "/workspace/project"): WorkspaceResolver {
	return singleWorkspaceResolver({
		cwd,
		trust: { trusted: true, source: "override" },
		resourceLoader: new ResourceLoader({ executionEnv: env, cwd }),
	});
}

/** Opens any directory asked for, so a test can spawn across workspaces. */
export function openWorkspaceResolver(env: MemoryExecutionEnv, startupCwd = "/workspace/project"): WorkspaceResolver {
	const workspace = (cwd: string): Workspace => ({
		cwd,
		trust: { trusted: true, source: "override" },
		resourceLoader: new ResourceLoader({ executionEnv: env, cwd }),
	});
	const opened = new Map<string, Workspace>([[startupCwd, workspace(startupCwd)]]);
	return {
		startup: opened.get(startupCwd) as Workspace,
		resolve: async (cwd) => {
			const existing = opened.get(cwd);
			if (existing) return existing;
			const created = workspace(cwd);
			opened.set(cwd, created);
			return created;
		},
	};
}

export async function createOrchestrator(
	env: MemoryExecutionEnv,
	options: {
		enabledProfileIds?: readonly string[];
		profileRegistry?: AgentProfileRegistry;
		extensionProfiles?: ExtensionProfileStorageBackend;
		defaultProfileId?: string;
		modelRegistry?: ModelRegistry;
		toolRegistry?: ToolRegistry;
		settingManager?: SettingManager;
		workspaces?: WorkspaceResolver;
	} = {},
): Promise<AgentOrchestrator> {
	return new AgentOrchestrator({
		executionEnv: env,
		workspaces: options.workspaces ?? testWorkspaceResolver(env),
		sessionManager: new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
			registry: new PersistenceRegistry(),
		}),
		settingManager: options.settingManager ?? new SettingManager(),
		modelRegistry: options.modelRegistry ?? (await createModelRegistry(env)),
		profileRegistry: options.profileRegistry ?? createProfileRegistry(),
		extensionProfiles: options.extensionProfiles,
		toolRegistry: options.toolRegistry,
		defaultProfileId: options.defaultProfileId ?? defaultProfile.id,
		enabledProfileIds: options.enabledProfileIds,
		defaultModel,
	});
}

export function createProfileRegistry(): AgentProfileRegistry {
	return new AgentProfileRegistry(
		InMemoryProfileStorageBackend.fromProfiles([{ profile: defaultProfile }, { profile: restoredProfile }]),
	);
}

export function createToolDefinition(name: string, text: string = name): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: undefined }),
	};
}

export function createToolRegistry(...tools: ToolDefinition[]): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of tools) {
		registry.defineTool(tool, { kind: "core", id: "test" });
	}
	return registry;
}

export function createCoreCodingToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registerCoreCodingTools(registry);
	return registry;
}

// White-box test helper for driving harness hooks and inspecting live runners.
export function requireLiveAgent(orchestrator: AgentOrchestrator, agentId: string): LiveAgent {
	const liveAgent = (orchestrator as unknown as { _live: Map<string, LiveAgent> })._live.get(agentId);
	if (!liveAgent) throw new Error(`Unknown live agent: ${agentId}`);
	return liveAgent;
}

export function requireAgentHarness(orchestrator: AgentOrchestrator, agentId: string): WidiAgentHarness {
	return requireLiveAgent(orchestrator, agentId).harness;
}

/**
 * Seed the context gauge a live agent projects, which is otherwise only ever
 * produced by measuring a real branch.
 */
export function seedAgentContextUsage(
	orchestrator: AgentOrchestrator,
	agentId: string,
	usage: AgentContextUsage | undefined,
): void {
	const monitor = (orchestrator as unknown as { _context: AgentContextMonitor })._context;
	const projections = (
		monitor as unknown as { _projections: Map<string, { generation: number; usage?: AgentContextUsage }> }
	)._projections;
	projections.set(agentId, {
		generation: requireLiveAgent(orchestrator, agentId).generation,
		...(usage === undefined ? undefined : { usage }),
	});
}

/** Publish extension-sourced diagnostics the way a bound runner would. */
export async function recordExtensionDiagnostics(
	orchestrator: AgentOrchestrator,
	agentId: string,
	diagnostics: readonly OrchestratorDiagnostic[],
): Promise<void> {
	await (
		orchestrator as unknown as {
			_recordAndPublishExtensionDiagnostics(
				agentId: string,
				diagnostics: readonly OrchestratorDiagnostic[],
			): Promise<void>;
		}
	)._recordAndPublishExtensionDiagnostics(agentId, diagnostics);
}

/**
 * Drive a harness event through the orchestrator's own subscription, as the
 * live harness would. The generation is read per call so a resumed agent's
 * events reach its current occupant.
 */
export function harnessEventDriver(
	orchestrator: AgentOrchestrator,
): (agentId: string, event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> {
	return async (agentId, event, signal) => {
		const generation = requireLiveAgent(orchestrator, agentId).generation;
		await (
			orchestrator as unknown as {
				_handleHarnessEvent(
					agentId: string,
					generation: number,
					event: AgentHarnessEvent,
					signal: AbortSignal | undefined,
				): Promise<void>;
			}
		)._handleHarnessEvent(agentId, generation, event, signal);
	};
}

/** The spawn-tree parent the runtime holds in memory for this agent. */
export function spawnParentOf(orchestrator: AgentOrchestrator, agentId: string): string | undefined {
	return (orchestrator as unknown as { _spawnParent: Map<string, string> })._spawnParent.get(agentId);
}

/**
 * Compact the branch at an entry, the way a real compaction checkpoints it: what
 * is behind `firstKeptEntryId` leaves the model's context and stays in the file.
 *
 * Written straight to the session because the harness only ever produces one
 * from a real model run. The agent is idle in these tests, so there is no
 * buffered write for it to race.
 */
export async function appendCompactionCheckpoint(
	orchestrator: AgentOrchestrator,
	agentId: string,
	firstKeptEntryId: string,
): Promise<void> {
	const sessions = (
		orchestrator.sessionManager as unknown as { _agentSessions: Map<string, Session<AgentSessionMetadata>> }
	)._agentSessions;
	const session = sessions.get(agentId);
	if (!session) throw new Error(`Agent ${agentId} has no persisted session.`);
	await session.appendCompaction("Earlier work, summarized.", firstKeptEntryId, 1000);
}
