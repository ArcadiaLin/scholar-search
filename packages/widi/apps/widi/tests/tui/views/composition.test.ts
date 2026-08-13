import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { widiCommands } from "../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../src/tui/commands/engine.ts";
import { createWidiKeybindings } from "../../../src/tui/keybindings.ts";
import { setSteadyQuip } from "../../../src/tui/quips.ts";
import { createTuiApplicationState, ensureAgentProjection, setActiveAgent } from "../../../src/tui/state.ts";
import { AgentStripView } from "../../../src/tui/views/agent-strip.ts";
import { ChatView } from "../../../src/tui/views/chat.ts";
import { FooterView } from "../../../src/tui/views/footer.ts";
import { HeaderView } from "../../../src/tui/views/header.ts";
import { OperationHintView } from "../../../src/tui/views/operation-hint.ts";
import { StatusView } from "../../../src/tui/views/status.ts";
import { WorkingLineView } from "../../../src/tui/views/working-line.ts";
import { stubCommandHost } from "../../helpers/command-host.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * What the composed layout owes as a whole: no view overflows its width, and
 * an action the user can take is named once across the rows that could name it.
 */
describe("composed views", () => {
	it.each([40, 80, 120])("keeps chat, status, footer, operation hint and agent strip inside %s columns", (width) => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "idle";
		main.display.sessionName = "主代理";
		main.timeline.push(
			{
				type: "user-message",
				id: "user",
				durability: "durable",
				createdAt: timestamp(1),
				text: "请检查这个很长的中文输入，并保证终端宽度不会溢出。",
			},
			{
				type: "assistant-message",
				id: "assistant",
				durability: "durable",
				createdAt: timestamp(2),
				text: "这里是 **Markdown** 响应。\n\n- 第一项\n- 第二项",
				streaming: false,
			},
			{
				type: "extension-output",
				id: "output",
				presentationId: "output",
				durability: "ephemeral",
				createdAt: timestamp(3),
				extensionId: "indexer",
				text: "Scanning a path with a deliberately long output value.",
			},
		);
		main.extensionStatuses.set("indexer\u0000build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Building symbol index", progress: { completed: 418, total: 672 } },
			updatedAt: timestamp(4),
		});
		const worker = ensureAgentProjection(state, "reviewer");
		worker.status = "running";
		worker.unreadCount = 3;
		const failed = ensureAgentProjection(state, "researcher");
		failed.status = "disposed";
		failed.attention = "error";

		const views = [
			new ChatView(state),
			new StatusView(state),
			new FooterView(state, "/home/arcadia/projs/widi"),
			new OperationHintView({
				state,
				engine: new CommandEngine(widiCommands(stubCommandHost())),
				editor: { getText: () => "", isShowingAutocomplete: () => false },
				selectorHint: () => undefined,
			}),
			new AgentStripView(state),
		];
		for (const view of views) {
			for (const line of view.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders the running steer action only once across footer, working line and operation hint", () => {
		setKeybindings(createWidiKeybindings());
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "running";
		agent.runStartedAt = new Date().toISOString();
		setSteadyQuip(agent, "working");
		const engine = new CommandEngine(widiCommands(stubCommandHost()));
		const editor = { getText: () => "", isShowingAutocomplete: () => false };
		const output = [
			...new FooterView(state, "/workspace").render(120),
			...new WorkingLineView({ state, engine, editor }).render(120),
			...new OperationHintView({ state, engine, editor, selectorHint: () => undefined }).render(120),
		]
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output.match(/ctrl\+s steer/giu)).toHaveLength(1);
	});

	it("renders the agent-switch action only once across footer and operation hint", () => {
		setKeybindings(createWidiKeybindings());
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		ensureAgentProjection(state, "worker", "idle");
		const output = [
			...new FooterView(state, "/workspace").render(120),
			...new OperationHintView({
				state,
				engine: new CommandEngine(widiCommands(stubCommandHost())),
				editor: { getText: () => "", isShowingAutocomplete: () => false },
				selectorHint: () => undefined,
			}).render(120),
		]
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("↓ switch agent");
		expect(output.match(/↓/gu)).toHaveLength(1);
	});

	it("renders an empty pending agent without a core projection", () => {
		const state = createTuiApplicationState();
		state.pendingAgent = {
			start: { kind: "default", cwd: "/workspace/project" },
			timeline: [],
			draft: "",
			display: {
				profileId: "widi-dev",
				profileLabel: "Main Agent",
				cwd: "/workspace/project",
				model: {
					id: "pending-model",
					name: "Pending Model",
					api: "anthropic-messages",
					provider: "test",
					baseUrl: "https://example.test",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				thinkingLevel: "medium",
			},
			nextLiveItemId: 1,
		};

		const chat = new ChatView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");
		const header = new HeaderView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");
		const footer = new FooterView(state, "/workspace").render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(chat).toContain("Ask WIDI");
		expect(header).toContain("Main Agent");
		expect(header).toContain("pending-model");
		expect(footer).toContain("thinking medium");
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
