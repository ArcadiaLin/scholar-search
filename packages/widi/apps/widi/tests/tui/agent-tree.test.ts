import { describe, expect, it } from "vitest";
import { agentTreePrefix, buildAgentTree, flattenAgentTree } from "../../src/tui/agent-tree.ts";
import { createTuiApplicationState, ensureAgentProjection, setActiveAgent } from "../../src/tui/state.ts";
import { AgentStripView } from "../../src/tui/views/agent-strip.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("buildAgentTree", () => {
	it("keeps top-level agents in stable insertion order", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "zeta");
		ensureAgentProjection(state, "alpha");
		ensureAgentProjection(state, "mid");

		const tree = buildAgentTree(state);

		expect(tree.topLevel.map((agent) => agent.agentId)).toEqual(["zeta", "alpha", "mid"]);
	});

	it("groups children under their spawner in insertion order", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "parent");
		const first = ensureAgentProjection(state, "child-a");
		first.spawnedBy = "parent";
		const second = ensureAgentProjection(state, "child-b");
		second.spawnedBy = "parent";

		const tree = buildAgentTree(state);

		expect(tree.topLevel.map((agent) => agent.agentId)).toEqual(["parent"]);
		expect(tree.childrenOf.get("parent")?.map((agent) => agent.agentId)).toEqual(["child-a", "child-b"]);
	});

	it("treats a child whose spawner is missing as top-level", () => {
		const state = createTuiApplicationState();
		const orphan = ensureAgentProjection(state, "orphan");
		orphan.spawnedBy = "gone";

		const tree = buildAgentTree(state);

		expect(tree.topLevel.map((agent) => agent.agentId)).toEqual(["orphan"]);
		expect(tree.childrenOf.size).toBe(0);
	});

	it("treats a child whose spawner is disposed as top-level", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "parent", "disposed");
		const child = ensureAgentProjection(state, "child");
		child.spawnedBy = "parent";

		const tree = buildAgentTree(state);

		expect(tree.topLevel.map((agent) => agent.agentId)).toEqual(["child"]);
	});

	it("nests grandchildren under their own parent", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "parent");
		const child = ensureAgentProjection(state, "child");
		child.spawnedBy = "parent";
		const grandchild = ensureAgentProjection(state, "grandchild");
		grandchild.spawnedBy = "child";

		const tree = buildAgentTree(state);

		expect(tree.topLevel.map((agent) => agent.agentId)).toEqual(["parent"]);
		expect(tree.childrenOf.get("parent")?.map((agent) => agent.agentId)).toEqual(["child"]);
		expect(tree.childrenOf.get("child")?.map((agent) => agent.agentId)).toEqual(["grandchild"]);
	});
});

describe("flattenAgentTree", () => {
	it("emits each parent immediately followed by its subtree", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other");
		ensureAgentProjection(state, "parent");
		const childA = ensureAgentProjection(state, "child-a");
		childA.spawnedBy = "parent";
		const grandchild = ensureAgentProjection(state, "grandchild");
		grandchild.spawnedBy = "child-a";
		const childB = ensureAgentProjection(state, "child-b");
		childB.spawnedBy = "parent";

		const entries = flattenAgentTree(buildAgentTree(state));

		expect(entries.map((entry) => [entry.agent.agentId, entry.depth, entry.last])).toEqual([
			["other", 0, false],
			["parent", 0, true],
			["child-a", 1, false],
			["grandchild", 2, true],
			["child-b", 1, true],
		]);
	});
});

describe("agentTreePrefix", () => {
	it("prefixes nested entries with tree lines only", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "parent");
		const childA = ensureAgentProjection(state, "child-a");
		childA.spawnedBy = "parent";
		const grandchild = ensureAgentProjection(state, "grandchild");
		grandchild.spawnedBy = "child-a";
		const childB = ensureAgentProjection(state, "child-b");
		childB.spawnedBy = "parent";

		const entries = flattenAgentTree(buildAgentTree(state));

		expect(entries.map(agentTreePrefix)).toEqual(["", "├── ", "    └── ", "└── "]);
	});
});

describe("agent panel ordering", () => {
	it("lists children right after their parent with tree prefixes", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "parent").status = "idle";
		const childA = ensureAgentProjection(state, "child-a", "idle");
		childA.spawnedBy = "parent";
		const childB = ensureAgentProjection(state, "child-b", "idle");
		childB.spawnedBy = "parent";

		const output = new AgentStripView(state).render(500).join("\n").replace(ANSI_SEQUENCE, "");

		const order = ["other", "parent", "├── ○ child-a", "└── ○ child-b"].map((label) => output.indexOf(label));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});
