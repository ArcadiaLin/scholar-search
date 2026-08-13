import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createAskHumanToolDefinition } from "./ask-human.ts";

const coreBuiltinToolSource: ToolSource = { kind: "core", id: "builtin" };

/**
 * Register the core built-in interaction tools: controlled agent-to-human
 * requests routed through the orchestrator human-request broker. They are a
 * separate group from the coding tools so profiles can grant filesystem/shell
 * access and human interaction independently.
 */
export function registerCoreInteractionTools(registry: ToolRegistry): void {
	registry.defineTool(createAskHumanToolDefinition(), coreBuiltinToolSource);
}
