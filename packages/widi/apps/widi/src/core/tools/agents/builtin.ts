import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createDisposeAgentToolDefinition } from "./dispose-agent.ts";
import { createListAgentsToolDefinition } from "./list-agents.ts";
import { createSendMessageToolDefinition } from "./send-message.ts";
import { createSpawnAgentToolDefinition } from "./spawn-agent.ts";
import { AgentWatches, createWatchAgentToolDefinition } from "./watch-agent.ts";

const coreBuiltinToolSource: ToolSource = { kind: "core", id: "builtin" };

/**
 * Register the core built-in agent collaboration tools: discovery, creation,
 * messaging, watching, and disposal.
 *
 * They are registered unconditionally, like every other core group. Profile
 * tool visibility decides which collaboration verbs an agent may invoke.
 * Discovery and lifecycle management are additionally scoped to its spawn
 * tree, while exact-id messaging is the deliberate soft cross-tree bridge.
 * A profile that lists no tools grants the full group, including to spawned
 * workers, so worker profiles should still list their tools explicitly.
 *
 * The watch table is created here and closed over by the three tools that read
 * or write it. It is runtime-scoped because exclusivity is a claim on the
 * watched agent, which no single caller's view could settle.
 */
export function registerCoreAgentTools(registry: ToolRegistry): void {
	const watches = new AgentWatches();
	registry.defineTool(createListAgentsToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSpawnAgentToolDefinition(watches), coreBuiltinToolSource);
	registry.defineTool(createSendMessageToolDefinition(watches), coreBuiltinToolSource);
	registry.defineTool(createWatchAgentToolDefinition(watches), coreBuiltinToolSource);
	registry.defineTool(createDisposeAgentToolDefinition(), coreBuiltinToolSource);
}
