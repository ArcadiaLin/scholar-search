import { type Static, Type } from "typebox";
import { type HumanQuestionAnswer, type HumanResponse, normalizeHumanRequestOptions } from "../../human-request.ts";
import type { ToolDefinition } from "../types.ts";

const ASK_HUMAN_TOOL_NAME = "ask_human";

const optionSchema = Type.Union([
	Type.String(),
	Type.Object({ label: Type.String(), value: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }),
]);

const askHumanSchema = Type.Object({
	kind: Type.Union(
		[
			Type.Literal("confirm"),
			Type.Literal("select"),
			Type.Literal("multi-select"),
			Type.Literal("questions"),
			Type.Literal("input"),
		],
		{
			description:
				"confirm: yes/no decision. select: pick one option. multi-select: pick any number of options. questions: pose several choice questions at once, answered together. input: free-form text.",
		},
	),
	title: Type.String({
		description:
			"Short heading shown to the human. For kind=questions this is the panel heading; each question carries its own title.",
	}),
	message: Type.Optional(Type.String({ description: "Optional longer context shown below the title." })),
	options: Type.Optional(
		Type.Array(optionSchema, {
			description:
				"Choices for kind=select or kind=multi-select, in display order. A choice is a plain string, or an object {label, value?, description?} where description is shown dimmed beside the label. Required for select/multi-select; invalid for other kinds.",
		}),
	),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String(),
				header: Type.Optional(Type.String()),
				message: Type.Optional(Type.String()),
				multiSelect: Type.Optional(Type.Boolean()),
				options: Type.Array(optionSchema),
			}),
			{
				description:
					"For kind=questions: the ordered batch of questions. Each has {title, header?, message?, multiSelect?, options}. multiSelect=true lets the human pick several. Required for kind=questions; invalid for other kinds.",
			},
		),
	),
	placeholder: Type.Optional(Type.String({ description: "Optional input placeholder for kind=input." })),
	allowFreeInput: Type.Optional(
		Type.Boolean({ description: "For kind=select: also offer a free-form answer besides the options." }),
	),
});

export type AskHumanToolInput = Static<typeof askHumanSchema>;

export interface AskHumanToolDetails {
	kind: AskHumanToolInput["kind"];
	response: HumanResponse;
}

/**
 * Agent-initiated human request. The tool is a thin adapter over the
 * orchestrator human-request broker: routing, events, cancellation, and
 * profile capability gating all live in core, not here.
 */
export function createAskHumanToolDefinition(): ToolDefinition<typeof askHumanSchema, AskHumanToolDetails> {
	return {
		name: ASK_HUMAN_TOOL_NAME,
		label: "ask human",
		description:
			"Ask the human operator a question and wait for the answer. Use confirm for yes/no decisions, select to choose one option, multi-select to choose any number of options, and input for free-form text. Blocks until the human answers or dismisses the request; a dismissal is reported as no answer, not an error.",
		promptSnippet: "Ask the human operator a question and wait for the answer",
		promptGuidelines: [
			"Work autonomously by default; use ask_human only when a decision genuinely needs the human, such as destructive actions or ambiguous requirements.",
			"Prefer ask_human with kind=select and concrete options over open-ended input.",
			"Use kind=multi-select when the human may legitimately pick several options at once; the answer reports every selected option.",
			"Use kind=questions to pose several related choice questions in one prompt; the human answers them together and the reply reports each answer in order.",
		],
		parameters: askHumanSchema,
		// A pending question is modal for the human; never run it concurrently
		// with other tool calls.
		executionMode: "sequential",
		execute: async (toolCallId, input, context) => {
			validateAskHumanInput(input);
			if (!context.human) {
				throw new Error("Human requests are not available in this runtime.");
			}
			const response = await context.human.request({
				// Naming the call is what lets a client tell a question the agent is
				// blocked on from one the runtime or an extension raised on its own.
				tool: { toolCallId, toolName: ASK_HUMAN_TOOL_NAME },
				kind: input.kind,
				title: input.title.trim(),
				message: input.message,
				options: input.options,
				questions: input.questions,
				placeholder: input.placeholder,
				allowFreeInput: input.allowFreeInput,
				signal: context.signal,
			});
			return {
				content: [{ type: "text", text: formatHumanResponse(response, input) }],
				details: { kind: input.kind, response },
			};
		},
	};
}

function validateAskHumanInput(input: AskHumanToolInput): void {
	if (!input.title.trim()) {
		throw new Error("Ask human tool input is invalid. title must not be empty.");
	}
	const optionsKind = input.kind === "select" || input.kind === "multi-select";
	if (optionsKind) {
		if (!input.options || input.options.length === 0) {
			throw new Error(`Ask human tool input is invalid. kind=${input.kind} requires a non-empty options list.`);
		}
		const normalized = normalizeHumanRequestOptions(input.options);
		if (normalized.some((option) => !option.label.trim())) {
			throw new Error("Ask human tool input is invalid. options must not contain empty labels.");
		}
	} else if (input.options !== undefined) {
		throw new Error(
			`Ask human tool input is invalid. options is only valid for kind=select or kind=multi-select, not kind=${input.kind}.`,
		);
	}
	if (input.kind === "questions") {
		if (!input.questions || input.questions.length === 0) {
			throw new Error("Ask human tool input is invalid. kind=questions requires a non-empty questions list.");
		}
		for (const [index, question] of input.questions.entries()) {
			if (!question.title.trim()) {
				throw new Error(`Ask human tool input is invalid. questions[${index}].title must not be empty.`);
			}
			if (question.options.length === 0) {
				throw new Error(`Ask human tool input is invalid. questions[${index}] requires a non-empty options list.`);
			}
			if (normalizeHumanRequestOptions(question.options).some((option) => !option.label.trim())) {
				throw new Error(`Ask human tool input is invalid. questions[${index}] options must not contain empty labels.`);
			}
		}
	} else if (input.questions !== undefined) {
		throw new Error(
			`Ask human tool input is invalid. questions is only valid for kind=questions, not kind=${input.kind}.`,
		);
	}
	if (input.allowFreeInput !== undefined && input.kind !== "select") {
		throw new Error("Ask human tool input is invalid. allowFreeInput is only valid for kind=select.");
	}
}

function formatHumanResponse(response: HumanResponse, input: AskHumanToolInput): string {
	switch (response.kind) {
		case "confirm":
			return response.confirmed ? "The human confirmed." : "The human declined.";
		case "select":
			return response.value === undefined
				? "The human dismissed the request without selecting an option."
				: `The human selected: ${response.value}`;
		case "multi-select":
			return response.values === undefined
				? "The human dismissed the request without selecting any options."
				: response.values.length === 0
					? "The human selected no options."
					: `The human selected: ${response.values.join(", ")}`;
		case "questions":
			return formatQuestionsResponse(response.answers, input.questions ?? []);
		case "input":
			return response.value === undefined
				? "The human dismissed the request without providing input."
				: `The human answered: ${response.value}`;
		case "custom":
			return `The human responded: ${JSON.stringify(response.value)}`;
	}
}

function formatQuestionsResponse(
	answers: readonly HumanQuestionAnswer[],
	questions: NonNullable<AskHumanToolInput["questions"]>,
): string {
	const lines = answers.map((answer, index) => {
		const title = questions[index]?.title ?? `Question ${index + 1}`;
		const value =
			answer.kind === "select"
				? (answer.value ?? "(no answer)")
				: answer.values === undefined || answer.values.length === 0
					? "(no answer)"
					: answer.values.join(", ");
		return `- ${title}: ${value}`;
	});
	if (lines.length === 0) {
		return "The human dismissed the request without answering.";
	}
	return `The human answered:\n${lines.join("\n")}`;
}
