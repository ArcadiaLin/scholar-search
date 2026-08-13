/**
 * Inbound frame classification, separate from both the server and the channel.
 *
 * Routing has to work before the server exists: startup can ask a human (the
 * "ask" project-trust policy), so a `human_response` may legitimately arrive
 * while there is still no orchestrator to run commands against. Classifying
 * here lets one reader serve both phases without either side guessing.
 */

import type { RpcCommand, RpcHumanResponseFrame } from "./types.ts";

export type ParsedInbound =
	| { readonly kind: "command"; readonly command: RpcCommand }
	| { readonly kind: "human_response"; readonly frame: RpcHumanResponseFrame }
	| { readonly kind: "invalid"; readonly message: string };

export function parseInbound(line: string): ParsedInbound {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { kind: "invalid", message: `Malformed JSON frame: ${reason}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", message: "A frame must be a JSON object." };
	}

	const frame = parsed as Record<string, unknown>;
	if (frame.type === "human_response") {
		if (typeof frame.requestId !== "string") {
			return { kind: "invalid", message: "A human_response frame must carry a string `requestId`." };
		}
		if (frame.cancelled !== true && frame.response === undefined) {
			return { kind: "invalid", message: "A human_response frame must carry either `response` or `cancelled: true`." };
		}
		return { kind: "human_response", frame: frame as unknown as RpcHumanResponseFrame };
	}
	if (typeof frame.cmd !== "string") {
		return { kind: "invalid", message: "A command frame must carry a string `cmd`." };
	}
	if (frame.id !== undefined && typeof frame.id !== "string") {
		return { kind: "invalid", message: "A command frame's `id` must be a string when present." };
	}
	return { kind: "command", command: frame as unknown as RpcCommand };
}
