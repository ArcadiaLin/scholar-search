import { describe, expect, it } from "vitest";
import type { HumanRequestDraft, HumanResponse, ToolHumanHost } from "../../src/core/human-request.ts";
import { type AskHumanToolDetails, createAskHumanToolDefinition } from "../../src/core/tools/interaction/ask-human.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

function makeContext(
	overrides: Partial<ToolExecutionContext<AskHumanToolDetails>> = {},
): ToolExecutionContext<AskHumanToolDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		workspace: { cwd: "/workspace/project" },
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function makeHumanHost(response: HumanResponse): { host: ToolHumanHost; drafts: HumanRequestDraft[] } {
	const drafts: HumanRequestDraft[] = [];
	return {
		host: {
			request: async (draft) => {
				drafts.push(draft);
				return response;
			},
		},
		drafts,
	};
}

describe("ask_human tool", () => {
	const tool = createAskHumanToolDefinition();

	it("routes a confirm question through the human host", async () => {
		const { host, drafts } = makeHumanHost({ kind: "confirm", confirmed: true });
		const abortController = new AbortController();
		const result = await tool.execute(
			"call-1",
			{ kind: "confirm", title: "  Delete the branch?  " },
			makeContext({ human: host, signal: abortController.signal }),
		);
		expect(drafts).toEqual([
			{
				tool: { toolCallId: "call-1", toolName: "ask_human" },
				kind: "confirm",
				title: "Delete the branch?",
				message: undefined,
				options: undefined,
				placeholder: undefined,
				allowFreeInput: undefined,
				signal: abortController.signal,
			},
		]);
		expect(result.content).toEqual([{ type: "text", text: "The human confirmed." }]);
		expect(result.details).toEqual({ kind: "confirm", response: { kind: "confirm", confirmed: true } });
	});

	it("passes select options and reports the selection", async () => {
		const { host, drafts } = makeHumanHost({ kind: "select", value: "green" });
		const result = await tool.execute(
			"call-1",
			{ kind: "select", title: "Pick a color", options: ["red", "green"], allowFreeInput: true },
			makeContext({ human: host }),
		);
		expect(drafts[0]).toMatchObject({ kind: "select", options: ["red", "green"], allowFreeInput: true });
		expect(result.content).toEqual([{ type: "text", text: "The human selected: green" }]);
	});

	it("passes multi-select options and reports every selection", async () => {
		const { host, drafts } = makeHumanHost({ kind: "multi-select", values: ["red", "blue"] });
		const result = await tool.execute(
			"call-1",
			{ kind: "multi-select", title: "Pick colors", options: ["red", "green", "blue"] },
			makeContext({ human: host }),
		);
		expect(drafts[0]).toMatchObject({ kind: "multi-select", options: ["red", "green", "blue"] });
		expect(result.content).toEqual([{ type: "text", text: "The human selected: red, blue" }]);
	});

	it("accepts object-form options with labels and descriptions", async () => {
		const { host, drafts } = makeHumanHost({ kind: "select", value: "r" });
		await tool.execute(
			"call-1",
			{
				kind: "select",
				title: "Pick a color",
				options: [
					{ label: "Red", value: "r", description: "the warm one" },
					{ label: "Green", value: "g" },
				],
			},
			makeContext({ human: host }),
		);
		expect(drafts[0]?.options).toEqual([
			{ label: "Red", value: "r", description: "the warm one" },
			{ label: "Green", value: "g" },
		]);
	});

	it("reports a dismissed multi-select as no answer", async () => {
		const { host } = makeHumanHost({ kind: "multi-select", values: undefined });
		const result = await tool.execute(
			"call-1",
			{ kind: "multi-select", title: "Pick colors", options: ["red"] },
			makeContext({ human: host }),
		);
		expect(result.content).toEqual([
			{ type: "text", text: "The human dismissed the request without selecting any options." },
		]);
	});

	it("rejects a multi-select without options or with free input", async () => {
		const { host } = makeHumanHost({ kind: "multi-select", values: [] });
		const context = makeContext({ human: host });
		await expect(tool.execute("call-1", { kind: "multi-select", title: "Pick" }, context)).rejects.toThrow(
			"kind=multi-select requires a non-empty options list",
		);
		await expect(
			tool.execute("call-1", { kind: "multi-select", title: "Pick", options: ["a"], allowFreeInput: true }, context),
		).rejects.toThrow("allowFreeInput is only valid for kind=select");
		await expect(
			tool.execute("call-1", { kind: "select", title: "Pick", options: [{ label: "   " }] }, context),
		).rejects.toThrow("options must not contain empty labels");
	});

	it("poses a questions batch and reports each answer in order", async () => {
		const { host, drafts } = makeHumanHost({
			kind: "questions",
			answers: [
				{ kind: "select", value: "staging" },
				{ kind: "multi-select", values: ["us", "eu"] },
			],
		});
		const result = await tool.execute(
			"call-1",
			{
				kind: "questions",
				title: "Set up the deploy",
				questions: [
					{ title: "Target", options: ["staging", "prod"] },
					{ title: "Regions", multiSelect: true, options: ["us", "eu", "asia"] },
				],
			},
			makeContext({ human: host }),
		);
		expect(drafts[0]).toMatchObject({
			kind: "questions",
			questions: [
				{ title: "Target", options: ["staging", "prod"] },
				{ title: "Regions", multiSelect: true, options: ["us", "eu", "asia"] },
			],
		});
		expect(result.content).toEqual([
			{ type: "text", text: "The human answered:\n- Target: staging\n- Regions: us, eu" },
		]);
	});

	it("reports unanswered batch questions as (no answer)", async () => {
		const { host } = makeHumanHost({
			kind: "questions",
			answers: [
				{ kind: "select", value: undefined },
				{ kind: "multi-select", values: undefined },
			],
		});
		const result = await tool.execute(
			"call-1",
			{
				kind: "questions",
				title: "Two questions",
				questions: [
					{ title: "First", options: ["a", "b"] },
					{ title: "Second", multiSelect: true, options: ["c", "d"] },
				],
			},
			makeContext({ human: host }),
		);
		expect(result.content).toEqual([
			{ type: "text", text: "The human answered:\n- First: (no answer)\n- Second: (no answer)" },
		]);
	});

	it("rejects a questions batch that is empty or malformed", async () => {
		const { host } = makeHumanHost({ kind: "questions", answers: [] });
		const context = makeContext({ human: host });
		await expect(tool.execute("call-1", { kind: "questions", title: "Q" }, context)).rejects.toThrow(
			"kind=questions requires a non-empty questions list",
		);
		await expect(
			tool.execute("call-1", { kind: "questions", title: "Q", questions: [{ title: "First", options: [] }] }, context),
		).rejects.toThrow("questions[0] requires a non-empty options list");
		await expect(
			tool.execute("call-1", { kind: "select", title: "Q", options: ["a"], questions: [] }, context),
		).rejects.toThrow("questions is only valid for kind=questions");
	});

	it("reports a dismissed request as no answer instead of an error", async () => {
		const { host } = makeHumanHost({ kind: "input", value: undefined });
		const result = await tool.execute(
			"call-1",
			{ kind: "input", title: "Which ticket id?" },
			makeContext({ human: host }),
		);
		expect(result.content).toEqual([
			{ type: "text", text: "The human dismissed the request without providing input." },
		]);
	});

	it("rejects invalid inputs before contacting the human", async () => {
		const { host, drafts } = makeHumanHost({ kind: "confirm", confirmed: true });
		const context = makeContext({ human: host });
		await expect(tool.execute("call-1", { kind: "select", title: "Pick" }, context)).rejects.toThrow(
			"kind=select requires a non-empty options list",
		);
		await expect(
			tool.execute("call-1", { kind: "confirm", title: "Sure?", options: ["yes"] }, context),
		).rejects.toThrow("options is only valid for kind=select");
		await expect(
			tool.execute("call-1", { kind: "input", title: "Name?", allowFreeInput: true }, context),
		).rejects.toThrow("allowFreeInput is only valid for kind=select");
		await expect(tool.execute("call-1", { kind: "confirm", title: "   " }, context)).rejects.toThrow(
			"title must not be empty",
		);
		expect(drafts).toEqual([]);
	});

	it("fails when no human host is available", async () => {
		await expect(tool.execute("call-1", { kind: "confirm", title: "Proceed?" }, makeContext())).rejects.toThrow(
			"Human requests are not available in this runtime.",
		);
	});
});
