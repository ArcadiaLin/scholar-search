import type { AgentId } from "../core/types.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";

export interface AgentTree {
	/** Visible agents without a visible spawner, in projection insertion order. */
	topLevel: AgentViewState[];
	/** Direct visible children per visible parent, in insertion order. */
	childrenOf: Map<AgentId, AgentViewState[]>;
}

export interface AgentTreeEntry {
	agent: AgentViewState;
	/** 0 for top-level agents, +1 per spawn generation below. */
	depth: number;
	/** Whether the entry is the last among its siblings (└── vs ├──). */
	last: boolean;
}

/**
 * Groups visible agents by their spawner. `spawnedBy` only links a child to a
 * parent that is itself visible; a child whose spawner was never projected or
 * is already disposed renders as top-level (there is nothing to hang it
 * under). Both collections keep Map insertion order, so the tree is stable
 * across renders.
 */
export function buildAgentTree(state: TuiApplicationState): AgentTree {
	const visible = [...state.agents.values()].filter((agent) => agent.status !== "disposed");
	const visibleIds = new Set(visible.map((agent) => agent.agentId));
	const topLevel: AgentViewState[] = [];
	const childrenOf = new Map<AgentId, AgentViewState[]>();
	for (const agent of visible) {
		const parentId = agent.spawnedBy;
		if (!parentId || !visibleIds.has(parentId)) {
			topLevel.push(agent);
			continue;
		}
		const siblings = childrenOf.get(parentId) ?? [];
		siblings.push(agent);
		childrenOf.set(parentId, siblings);
	}
	return { topLevel, childrenOf };
}

/** Preorder flattening: each agent is immediately followed by its subtree. */
export function flattenAgentTree(tree: AgentTree): AgentTreeEntry[] {
	const entries: AgentTreeEntry[] = [];
	const visit = (agents: readonly AgentViewState[], depth: number): void => {
		for (const [index, agent] of agents.entries()) {
			entries.push({ agent, depth, last: index === agents.length - 1 });
			visit(tree.childrenOf.get(agent.agentId) ?? [], depth + 1);
		}
	};
	visit(tree.topLevel, 0);
	return entries;
}

/** Tree-line label prefix for nested entries; empty for top-level agents. */
export function agentTreePrefix(entry: AgentTreeEntry): string {
	if (entry.depth === 0) return "";
	return `${"    ".repeat(entry.depth - 1)}${entry.last ? "└── " : "├── "}`;
}
