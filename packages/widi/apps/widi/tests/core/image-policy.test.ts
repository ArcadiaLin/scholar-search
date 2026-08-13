import type { Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { describe, expect, it } from "vitest";
import { BLOCKED_IMAGE_PLACEHOLDER, stripImagesFromMessages } from "../../src/core/image-policy.ts";

function makeUserMessage(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function makeToolResultMessage(content: ToolResultMessage["content"]): ToolResultMessage {
	return { role: "toolResult", toolCallId: "call-1", toolName: "read", content, isError: false, timestamp: 1 };
}

const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
const text = { type: "text" as const, text: "hello" };

describe("blockImages policy filter", () => {
	it("replaces images in user messages with the placeholder", () => {
		const [message] = stripImagesFromMessages([makeUserMessage([text, image])]);
		if (message?.role !== "user") throw new Error("Expected a user message.");
		expect(message.content).toEqual([text, { type: "text", text: BLOCKED_IMAGE_PLACEHOLDER }]);
	});

	it("replaces images in tool result messages with the placeholder", () => {
		const [message] = stripImagesFromMessages([makeToolResultMessage([text, image, image])]);
		if (message?.role !== "toolResult") {
			throw new Error("Expected a tool result message.");
		}
		expect(message.content).toEqual([
			text,
			{ type: "text", text: BLOCKED_IMAGE_PLACEHOLDER },
			{ type: "text", text: BLOCKED_IMAGE_PLACEHOLDER },
		]);
	});

	it("returns messages without images unchanged", () => {
		const userWithString = makeUserMessage("plain prompt");
		const userWithText = makeUserMessage([text]);
		const toolResult = makeToolResultMessage([text]);
		const stripped = stripImagesFromMessages([userWithString, userWithText, toolResult]);
		expect(stripped[0]).toBe(userWithString);
		expect(stripped[1]).toBe(userWithText);
		expect(stripped[2]).toBe(toolResult);
	});
});

// Characterization of vendor behavior the slice relies on: pi-ai downgrades
// image blocks to text placeholders for models without image input, so the
// read tool does not need the current model in its execution context.
describe("pi-ai transformMessages image downgrade", () => {
	const textOnlyModel = {
		id: "text-only",
		provider: "test",
		api: "anthropic-messages",
		input: ["text"],
	} as unknown as Model<"anthropic-messages">;
	const visionModel = {
		id: "vision",
		provider: "test",
		api: "anthropic-messages",
		input: ["text", "image"],
	} as unknown as Model<"anthropic-messages">;

	it("replaces user and tool result images for non-vision models", () => {
		const messages: Message[] = [makeUserMessage([text, image]), makeToolResultMessage([text, image])];
		const transformed = transformMessages(messages, textOnlyModel);
		const [user, toolResult] = transformed;
		if (user?.role !== "user" || toolResult?.role !== "toolResult") {
			throw new Error("Expected user and tool result messages.");
		}
		expect(user.content).toEqual([text, { type: "text", text: "(image omitted: model does not support images)" }]);
		expect(toolResult.content).toEqual([
			text,
			{ type: "text", text: "(tool image omitted: model does not support images)" },
		]);
	});

	it("keeps images for vision models", () => {
		const messages: Message[] = [makeToolResultMessage([text, image])];
		const [toolResult] = transformMessages(messages, visionModel);
		if (toolResult?.role !== "toolResult") {
			throw new Error("Expected a tool result message.");
		}
		expect(toolResult.content).toEqual([text, image]);
	});
});
