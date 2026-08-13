import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createTuiApplicationState, setActiveAgent } from "../../../src/tui/state.ts";
import { FooterView } from "../../../src/tui/views/footer.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("FooterView", () => {
	it("keeps status facts but operation actions out of the footer", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.display.sessionName = "Default Agent";
		agent.display.thinkingLevel = "medium";
		agent.display.model = {
			id: "qwen3.6-35b-a3b",
			name: "Qwen",
			api: "anthropic-messages",
			provider: "vllm",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};

		const [line] = new FooterView(state, "/home/arcadia/projs/widi/apps/widi").render(120);

		const plain = (line ?? "").replace(ANSI_SEQUENCE, "");
		// The model the next prompt runs on sits directly under the editor.
		expect(plain).toContain("vllm · qwen3.6-35b-a3b · thinking medium");
		expect(plain).not.toContain("Default Agent");
		expect(plain).not.toContain("idle");
		expect(plain).not.toContain("← agents");
	});

	it("drops footer qualifiers before the model id and cwd when width runs out", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.display.thinkingLevel = "medium";
		agent.display.model = {
			id: "qwen3.6-35b-a3b",
			name: "Qwen",
			api: "anthropic-messages",
			provider: "vllm",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const footer = new FooterView(state, "/home/arcadia/projs/widi");

		const narrow = (footer.render(40)[0] ?? "").replace(ANSI_SEQUENCE, "");
		expect(narrow).toContain("qwen3.6-35b-a3b");
		expect(narrow).not.toContain("vllm");
		expect(narrow).not.toContain("thinking");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
	});

	it("renders the latest footer-region status as a compact footer segment", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.extensionStatuses.set("watcher old", {
			agentId: "main",
			extensionId: "watcher",
			key: "old",
			status: { text: "Stale status", region: "footer" },
			updatedAt: timestamp(4),
		});
		agent.extensionStatuses.set("watcher new", {
			agentId: "main",
			extensionId: "watcher",
			key: "new",
			status: { text: "Watching files", region: "footer", icon: "◐" },
			updatedAt: timestamp(5),
		});
		agent.extensionStatuses.set("indexer build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Panel only" },
			updatedAt: timestamp(6),
		});

		const line = (new FooterView(state, "/workspace").render(120)[0] ?? "").replace(ANSI_SEQUENCE, "");

		expect(line).toContain("◐ Watching files");
		expect(line).not.toContain("Stale status");
		expect(line).not.toContain("Panel only");
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}

describe("FooterView workspaces", () => {
	it("names the workspace of whatever is on screen, not the one WIDI started in", () => {
		const state = createTuiApplicationState();
		const here = setActiveAgent(state, "here");
		here.display.cwd = "/home/arcadia/projs/widi";
		const there = setActiveAgent(state, "there");
		there.display.cwd = "/home/arcadia/projs/other";
		const view = new FooterView(state, "/home/arcadia/startup");
		const plain = () => (view.render(120)[0] ?? "").replace(ANSI_SEQUENCE, "");

		state.activeAgentId = "here";
		expect(plain()).toContain("widi");
		expect(plain()).not.toContain("other");

		state.activeAgentId = "there";
		expect(plain()).toContain("other");
		expect(plain()).not.toContain("/widi");
	});

	it("falls back to the startup directory before any agent exists", () => {
		const state = createTuiApplicationState();

		const plain = (new FooterView(state, "/home/arcadia/startup").render(120)[0] ?? "").replace(ANSI_SEQUENCE, "");

		expect(plain).toContain("startup");
	});
});
