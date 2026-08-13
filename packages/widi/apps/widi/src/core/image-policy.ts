import type { AgentMessage } from "@arcadialin/agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * Runtime policy for the images.blockImages setting.
 *
 * The read tool already avoids generating image blocks when the setting is
 * on, but session history can still contain images: user input attachments,
 * extension-contributed tool results, or reads performed before the setting
 * changed. This filter runs in the harness context hook, the single funnel
 * every provider request passes through, so no image content reaches a
 * provider payload while the setting is enabled.
 */

export const BLOCKED_IMAGE_PLACEHOLDER =
	"[Image omitted: the images.blockImages setting prevents sending images to model providers.]";

function replaceImages(content: readonly (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	return content.map((block) =>
		block.type === "image" ? { type: "text" as const, text: BLOCKED_IMAGE_PLACEHOLDER } : block,
	);
}

function hasImage(content: readonly (TextContent | ImageContent)[]): boolean {
	return content.some((block) => block.type === "image");
}

/**
 * Replace every image block in user and tool-result messages with a text
 * placeholder. Messages without images are returned unchanged.
 */
export function stripImagesFromMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => {
		if (message.role === "user" && Array.isArray(message.content) && hasImage(message.content)) {
			return { ...message, content: replaceImages(message.content) };
		}
		if (message.role === "toolResult" && hasImage(message.content)) {
			return { ...message, content: replaceImages(message.content) };
		}
		return message;
	});
}
