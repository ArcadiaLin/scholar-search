import type { AgentHarness, Skill } from "@arcadialin/agent-core";
import type { AgentProfile, AgentProfileSource } from "./agent-profile.js";
import { toAgentProfileReference } from "./agent-profile.js";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type { ExtensionRunner, ExtensionRunnerSnapshot } from "./extension/index.ts";
import type { ResourceSource } from "./resource-loader.js";
import type { AgentSessionMetadata } from "./session-manager.ts";
import type { ProjectContextFile } from "./system-prompt.ts";
import type { ResolvedAgentHarnessTool, ToolAdapterContext } from "./tool-registry.ts";
import type { AgentActivitySnapshot, AgentContextUsage, AgentId, AgentToolsSnapshot, RuntimeModel } from "./types.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The serializable identity of a live agent's profile, for display and for the
 * tree records.
 *
 * `source` and `entryId` are required. They were optional only to support the
 * failure path that built an `unavailable` record from a session's profile
 * reference so the TUI could still show a session it could not open; with
 * `unavailable` gone, every profile here has actually been resolved.
 */
export interface AgentProfileRecordReference {
	readonly reference: { readonly id: string; readonly label?: string };
	readonly source: AgentProfileSource;
	readonly entryId: string;
}

export interface AgentResourceFact {
	readonly name: string;
	readonly source: ResourceSource;
}

export interface AgentResourcesSnapshot {
	readonly skills: readonly AgentResourceFact[];
	readonly promptTemplates: readonly AgentResourceFact[];
}

/** Static facts used to compose the system prompt for every turn. */
export interface AgentSystemPromptFacts {
	readonly basePrompt: string;
	readonly skills: readonly Skill[];
	readonly appendSections: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
	readonly includeSkills?: boolean;
	readonly cwd?: string;
}

/** The concrete AgentHarness instantiation used by every WIDI agent. */
export type WidiAgentHarness = AgentHarness<ToolAdapterContext, ResolvedAgentHarnessTool>;

/**
 * Per-agent settings the harness cannot answer after construction.
 *
 * This is a construction snapshot, not a second SettingManager.
 */
export interface AgentSettings {
	readonly retry: { readonly enabled: boolean; readonly maxRetries: number; readonly baseDelayMs: number };
	readonly providerRetry: {
		readonly timeoutMs?: number;
		readonly maxRetries?: number;
		readonly maxRetryDelayMs: number;
	};
	readonly compaction: { readonly enabled: boolean; readonly reserveTokens: number; readonly keepRecentTokens: number };
	readonly blockImages: boolean;
}

export type AgentActiveToolSelection =
	| { readonly mode: "default_all" }
	| { readonly mode: "explicit"; readonly toolNames: readonly string[] };

/**
 * Declarative tool intent. The harness owns the resolved installed/active
 * tools; this value exists only so extension reload can resolve that intent
 * again against a replacement runner.
 */
export interface AgentToolPolicy {
	readonly requestedToolNames?: readonly string[];
	readonly activeToolSelection: AgentActiveToolSelection;
}

export interface ExtensionRunnerBindings {
	readonly release: () => Promise<void>;
}

/** All in-memory state for one currently routable agent generation. */
export interface LiveAgent {
	readonly agentId: AgentId;
	readonly generation: number;
	/**
	 * Where this agent works. Written once at spawn and never again: a running
	 * agent's paths, its system prompt and its stored session all name this
	 * directory, and there is no way to make them all change together.
	 */
	readonly workspace: Workspace;
	readonly profile: AgentProfileRecordReference;
	readonly resolvedProfile: AgentProfile;
	readonly sessionMetadata?: AgentSessionMetadata;
	/** Address of the persisted session, absent for an ephemeral agent. */
	readonly sessionRef?: string;
	readonly resources: AgentResourcesSnapshot;
	readonly systemPrompt: AgentSystemPromptFacts;
	readonly harness: WidiAgentHarness;
	readonly settings: AgentSettings;
	extensionRunner: ExtensionRunner;
	extensionBindings: ExtensionRunnerBindings;
	toolPolicy: AgentToolPolicy;
	readonly releaseHarnessBindings: () => Promise<void>;
}

/** Public projection of a live agent. Gone agents have no snapshot. */
export interface AgentSnapshot {
	readonly agentId: AgentId;
	readonly generation: number;
	/** The directory this agent's paths, prompt and stored session all name. */
	readonly cwd: string;
	readonly profile: AgentProfileRecordReference;
	readonly spawnedBy?: AgentId;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly sessionRef?: string;
	readonly model: RuntimeModel;
	readonly thinkingLevel: ReturnType<WidiAgentHarness["getThinkingLevel"]>;
	readonly tools: AgentToolsSnapshot;
	readonly activity: AgentActivitySnapshot;
	readonly extensions: ExtensionRunnerSnapshot;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly contextUsage?: AgentContextUsage;
}

export function createAgentProfileRecordReference(resolved: {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
}): AgentProfileRecordReference {
	return { reference: toAgentProfileReference(resolved.profile), source: resolved.source, entryId: resolved.entryId };
}
