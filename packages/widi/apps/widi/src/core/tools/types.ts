import type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@arcadialin/agent-core";
import type { Static, TSchema } from "typebox";
import type { AgentToOrchestratorHost } from "../host.ts";
import type { HumanInterruptWatch } from "../human-interrupt.ts";
import type { ToolHumanHost } from "../human-request.ts";

/**
 * Runtime context passed to a WIDI tool execution function.
 *
 * This is the adapter boundary between resolved WIDI tool definitions and Pi
 * `AgentHarnessTool` projections. Tool-specific backends are captured by the
 * tool definition factory, while the registry adapter combines turn-scoped
 * harness context with per-call facts such as abort, update, extension, and
 * human request handling.
 */
/**
 * The workspace a tool call runs in. Required rather than optional because
 * every tool call happens somewhere: a relative path with no cwd behind it is
 * a wiring mistake, not a capability an execution can go without.
 */
export interface ToolWorkspaceContext {
	readonly cwd: string;
}

export interface ToolExecutionContext<TDetails> {
	/** Abort signal for the current tool call. */
	signal: AbortSignal | undefined;
	/**
	 * Where the agent whose turn is executing works. Read at execution time,
	 * not captured by the tool definition: the tool table is registered once for
	 * the whole runtime while the cwd belongs to the agent.
	 */
	workspace: ToolWorkspaceContext;
	/** Pi-compatible callback for streaming tool updates. */
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
	/** Extension context bound to the tool source currently executing. */
	extension: ToolExtensionContext | undefined;
	/** Host for controlled user interaction from tools. */
	human: ToolHumanHost | undefined;
	/**
	 * Host for controlled agent-to-agent collaboration, bound to the agent whose
	 * turn is executing. Only the collaboration tools read it; everything else
	 * ignores it, and it is absent in runtimes that wire no orchestrator.
	 */
	agents?: AgentToOrchestratorHost;
	/**
	 * Pending human steers for the agent whose turn is executing. Only tools that
	 * deliberately block read it, so the user does not have to wait out a barrier
	 * to be heard; everything else ignores it.
	 */
	humanInterrupts?: HumanInterruptWatch;
}

/**
 * Context visible to extension-contributed tool code.
 *
 * The shape is deliberately small until the extension runner is designed. It
 * identifies the extension and leaves `host` as the future controlled capability
 * surface, rather than exposing core internals directly.
 */
export interface ToolExtensionContext {
	/** Stable id of the extension whose contribution is executing. */
	extensionId: string;
	/** Future extension host/capability object. */
	host?: unknown;
}

/** Execute function implemented by a WIDI tool definition. */
export type ToolExecute<TParamsSchema extends TSchema = TSchema, TDetails = unknown> = (
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

/**
 * Middleware used by tool patches to wrap an existing execute function.
 *
 * This is the preferred extension mechanism for auditing, confirmation,
 * sandboxing, argument rewriting, and backend delegation when the original tool
 * behavior should remain mostly intact.
 */
export type ToolExecuteMiddleware<TParamsSchema extends TSchema = TSchema, TDetails = unknown> = (
	next: ToolExecute<TParamsSchema, TDetails>,
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

/**
 * Partial tool definition applied to an existing tool by the registry.
 *
 * Patches are applied in registration order. They can replace the model-facing
 * description, parameters, strict metadata, or execute function.
 * `aroundExecute` wraps the current execute function instead of replacing it.
 */
export interface ToolDefinitionPatch<TParamsSchema extends TSchema = TSchema, TDetails = unknown> {
	/** Model-visible description passed to Pi AgentTool. */
	description?: string;
	/** TypeBox schema for model arguments. */
	parameters?: TParamsSchema;
	/** Future provider strict-mode flag. Currently retained by WIDI metadata. */
	strict?: boolean;
	/** Replace the tool execute implementation. */
	execute?: ToolExecute<TParamsSchema, TDetails>;
	/** Wrap the current execute implementation. */
	aroundExecute?: ToolExecuteMiddleware<TParamsSchema, TDetails>;
}

/**
 * Stable provenance for a tool registration.
 *
 * Diagnostics and conflict resolution use this to explain where a tool
 * definition or patch came from.
 */
export interface ToolSource {
	/** Registration owner class. */
	kind: "core" | "extension" | "adapter";
	/** Stable owner id within the kind, such as `builtin` or an extension id. */
	id: string;
}

/**
 * WIDI-owned tool definition.
 *
 * This is not Pi's runtime closure directly. It is the declarative/runtime
 * boundary owned by WIDI: the registry can diagnose, patch, filter, and finally
 * project it into a Pi `AgentHarnessTool`. It owns execution metadata and the
 * execute closure only. UI preview/state is derived outside the tool from raw
 * harness events and tool results.
 */
export interface ToolDefinition<TParamsSchema extends TSchema = TSchema, TDetails = unknown> {
	/** Stable model-visible and session-visible tool name. */
	name: string;
	/** Short label for debug/UI surfaces. */
	label: string;
	/** Model-visible description passed to Pi AgentTool. */
	description: string;

	/** Optional system-prompt snippet used when composing tool guidance. */
	promptSnippet?: string;
	/** Optional additional prompt guidance. */
	promptGuidelines?: string[];

	/** TypeBox schema for model arguments. */
	parameters: TParamsSchema;
	/** Future provider strict-mode flag. Currently retained by WIDI metadata. */
	strict?: boolean;
	/** Normalize raw model arguments before execution. */
	prepareArguments?: (args: unknown) => Static<TParamsSchema>;

	/** Pi tool execution scheduling mode. */
	executionMode?: ToolExecutionMode;

	/** Execute the tool after arguments have been prepared and validated. */
	execute: ToolExecute<TParamsSchema, TDetails>;
}
