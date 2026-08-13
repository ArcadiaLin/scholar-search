import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import type { SessionOrigin } from "../../src/core/persistence/index.ts";
import { agentIdentityLabel, forkSourceAgentId } from "../../src/tui/agent-identity.ts";
import { createTuiApplicationState, ensureAgentProjection } from "../../src/tui/state.ts";

describe("agent identity", () => {
	// The id the strip prints is the id `send_message` and `dispose_agent` take,
	// with nothing removed: a shortened form still reads as an id while
	// resolving to nothing.
	it("names an agent by its whole id", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		source.snapshot = snapshot("widi-dev-0ovu", "source-dir");

		expect(agentIdentityLabel(state, source)).toBe("widi-dev-0ovu");
	});

	it("marks a fork with the id it was forked from", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		source.snapshot = snapshot("widi-dev-0ovu", "source-dir");
		const fork = ensureAgentProjection(state, "widi-dev-3c8o", "idle");
		fork.snapshot = snapshot(fork.agentId, "fork-dir", { forkedFrom: "source-dir" });
		fork.display.forkedFromAgentId = source.agentId;

		expect(agentIdentityLabel(state, source)).toBe("widi-dev-0ovu");
		expect(agentIdentityLabel(state, fork)).toBe("widi-dev-3c8o ← widi-dev-0ovu");
	});

	// The header records where the history was copied from, so a fork taken by an
	// earlier runtime still reads as a fork after both sides are resumed.
	it("recovers the fork source from the persisted session origin without a fork event", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		source.snapshot = snapshot("widi-dev-0ovu", "source-dir");
		const fork = ensureAgentProjection(state, "widi-dev-3c8o", "idle");
		fork.snapshot = snapshot(fork.agentId, "fork-dir", { forkedFrom: "source-dir" });

		expect(fork.display.forkedFromAgentId).toBeUndefined();
		expect(forkSourceAgentId(state, fork)).toBe("widi-dev-0ovu");
		expect(agentIdentityLabel(state, fork)).toBe("widi-dev-3c8o ← widi-dev-0ovu");
	});

	// Being spawned by another agent is not being forked from it: every subagent
	// has a parent session, and none of them is a fork.
	it("does not read a spawning session as a fork source", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		source.snapshot = snapshot("widi-dev-0ovu", "source-dir");
		const child = ensureAgentProjection(state, "explore-ycfk", "idle");
		child.snapshot = snapshot(child.agentId, "source-dir/child-dir", { spawnedBy: "source-dir" });

		expect(forkSourceAgentId(state, child)).toBeUndefined();
		expect(agentIdentityLabel(state, child)).toBe("explore-ycfk");
	});

	it("shows the direct source for a nested fork", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		source.snapshot = snapshot("widi-dev-0ovu", "source-dir");
		const fork = ensureAgentProjection(state, "widi-dev-3c8o", "idle");
		fork.snapshot = snapshot(fork.agentId, "fork-dir", { forkedFrom: "source-dir" });
		fork.display.forkedFromAgentId = source.agentId;
		const nested = ensureAgentProjection(state, "widi-dev-12ab", "idle");
		nested.snapshot = snapshot(nested.agentId, "nested-dir", { forkedFrom: "fork-dir" });
		nested.display.forkedFromAgentId = fork.agentId;

		expect(forkSourceAgentId(state, nested)).toBe("widi-dev-3c8o");
		expect(agentIdentityLabel(state, nested)).toBe("widi-dev-12ab ← widi-dev-3c8o");
	});

	// The arrow names an id; with no source projected there is no id to name,
	// and "forked from something" is not worth a column in the strip.
	it("falls back to the plain id when the fork source is absent", () => {
		const state = createTuiApplicationState();
		const existing = ensureAgentProjection(state, "other-1234", "idle");
		existing.snapshot = snapshot("other-1234", "other-dir");
		const fork = ensureAgentProjection(state, "widi-dev-3c8o", "idle");
		fork.snapshot = snapshot(fork.agentId, "fork-dir", { forkedFrom: "missing-dir" });

		expect(agentIdentityLabel(state, fork)).toBe("widi-dev-3c8o");
	});

	// A name set with /rename belongs to the header. The strip stays addressable.
	it("keeps a session name out of the strip label", () => {
		const state = createTuiApplicationState();
		const agent = ensureAgentProjection(state, "widi-dev-0ovu", "idle");
		agent.snapshot = snapshot("widi-dev-0ovu", "source-dir");
		agent.display.sessionName = "我的重构会话";

		expect(agentIdentityLabel(state, agent)).toBe("widi-dev-0ovu");
	});

	it("sanitizes an agent id carrying terminal control sequences", () => {
		const state = createTuiApplicationState();
		const agent = ensureAgentProjection(state, "\u001b]0;owned\u0007widi-dev\n0ovu\u001b[2J", "idle");
		agent.snapshot = snapshot(agent.agentId, "source-dir");

		expect(agentIdentityLabel(state, agent)).toBe("widi-dev 0ovu");
	});
});

function snapshot(agentId: string, sessionRef: string, origin?: SessionOrigin): AgentSnapshot {
	return {
		agentId,
		generation: 1,
		cwd: "/workspace/project",
		profile: {
			reference: { id: "widi-dev", label: "WIDI Dev" },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		sessionRef,
		sessionMetadata: {
			id: agentId,
			createdAt: new Date(0).toISOString(),
			cwd: "/workspace",
			path: `/sessions/${sessionRef}/session.jsonl`,
			metadata: origin === undefined ? undefined : { origin },
		},
		model: {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
		thinkingLevel: "off",
		tools: { toolNames: [], activeToolNames: [] },
		activity: { activity: "idle" },
		extensions: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			systemPromptContributions: [],
			divisions: [],
			stale: { stale: false },
		},
		diagnostics: [],
	};
}
