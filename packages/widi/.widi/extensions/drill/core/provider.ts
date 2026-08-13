import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionActivationApi } from "../../../../apps/widi/src/core/extension/api.ts";
import { DRILL_MODEL_ID, DRILL_PROVIDER, type DrillLanguage } from "../protocol.ts";
import type { ScriptedBeat, ScriptedTurn } from "../script/index.ts";
import { LAST_SPAWNED_AGENT, normalizeSay, turnForLine } from "../script/index.ts";

/**
 * The scripted model.
 *
 * It is a provider like any other from the harness's point of view, which is the
 * whole point: everything upstream of it - the editor, the command engine, the
 * orchestrator, the harness, the tool loop - runs its production code, and only
 * the bytes coming back are written in advance.
 *
 * There is no cursor here and there must not be one. The script cursor lives in
 * the TUI half, this runs inside an agent runtime, and synchronising a
 * per-turn value across the bus would be a race with the turn it is describing.
 * Instead every callback derives its own key from the context it was handed.
 */

/** Chosen because `streamSimple` replaces it entirely; no adapter is ever built. */
const DRILL_API = "openai-completions";

/**
 * One character is one token, emitted on a fixed clock.
 *
 * Not an approximation of a real tokenizer, and deliberately not one: a drill
 * that guessed at token counts would be publishing a number nobody can check.
 * A character is a unit the reader can see, so the gauge on screen and the text
 * in front of them are the same fact. The rate is what makes the tour readable -
 * text that lands all at once reads as a canned screenshot, and streaming is one
 * of the things being demonstrated.
 */
const MS_PER_TOKEN = 22;

/**
 * Set once per drill run, when the stage is built.
 *
 * A per-run value, not a per-turn one, which is what makes it safe to hold here
 * while the cursor is not: the language cannot change under a turn in flight.
 */
let activeLanguage: DrillLanguage = "en";

export function setDrillLanguage(language: DrillLanguage): void {
	activeLanguage = language;
}

export function registerDrillProvider(api: ExtensionActivationApi): void {
	// Re-registration by every agent's runtime is a renewal, not a conflict: the
	// registry keys ownership by extension id and only refuses another owner.
	api.registerProvider(DRILL_PROVIDER, {
		name: "Drill",
		api: DRILL_API,
		// Required for a provider that defines models, and never dialled: the
		// literal api key also keeps this off the config-value trust path.
		baseUrl: "https://drill.invalid",
		apiKey: "drill",
		streamSimple: (model, context, options) => stream(model, context, options),
		models: [
			{
				id: DRILL_MODEL_ID,
				name: "Drill (scripted)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
	});
}

function stream(model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const events = createAssistantMessageEventStream();
	void play(events, model, context, options?.signal);
	return events;
}

/**
 * What the last user message was and how many assistant turns have answered it.
 *
 * Both halves of the key matter. The line alone identifies the step; the round
 * distinguishes the call that asks for a tool from the call that reads its
 * result, and without it a step with a tool call would replay it forever.
 */
function lookupKey(messages: readonly Message[]): { line: string; round: number } | undefined {
	let round = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			round++;
			continue;
		}
		if (message.role === "user") return { line: normalizeSay(userText(message.content)), round };
	}
	return undefined;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/**
 * A line the script does not know is not an error path.
 *
 * It is what a person typing something of their own gets, and the honest answer
 * is to say so rather than to improvise a reply the tour would then be judged on.
 */
function freeModeTurn(line: string): ScriptedTurn {
	return [
		{
			kind: "text",
			text:
				activeLanguage === "zh"
					? `这一句不在剧本里，所以我没有排练过它：\n\n> ${line}\n\n剧本里的下一句还等在输入框里，随时可以继续。`
					: `That line is not in the script, so I have nothing rehearsed for it:\n\n> ${line}\n\nThe next scripted line is still waiting in your editor whenever you want it.`,
		},
	];
}

async function play(
	events: AssistantMessageEventStream,
	model: Model<string>,
	context: Context,
	signal: AbortSignal | undefined,
): Promise<void> {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: countContext(context), output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: emptyCost() },
		stopReason: "pending",
		timestamp: Date.now(),
	};
	partial.usage.totalTokens = partial.usage.input;
	const key = lookupKey(context.messages);
	const turn =
		key === undefined ? freeModeTurn("") : (turnForLine(activeLanguage, key.line, key.round) ?? freeModeTurn(key.line));

	try {
		events.push({ type: "start", partial });
		for (const beat of turn) {
			if (beat.kind === "fail") {
				partial.stopReason = "error";
				partial.errorMessage = beat.message;
				events.push({ type: "error", reason: "error", error: partial });
				events.end(partial);
				return;
			}
			await playBeat(events, partial, beat, context, signal);
		}
		const reason = partial.content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop";
		partial.stopReason = reason;
		events.push({ type: "done", reason, message: partial });
		events.end(partial);
	} catch (error) {
		// An abort is the human pressing the interrupt key, which is a thing the
		// tour is meant to survive; anything else here is a bug in the script.
		const aborted = signal?.aborted === true;
		partial.stopReason = aborted ? "aborted" : "error";
		partial.errorMessage = aborted ? "Interrupted." : String(error);
		events.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
		events.end(partial);
	}
}

async function playBeat(
	events: AssistantMessageEventStream,
	partial: AssistantMessage,
	beat: Exclude<ScriptedBeat, { kind: "fail" }>,
	context: Context,
	signal: AbortSignal | undefined,
): Promise<void> {
	const contentIndex = partial.content.length;
	if (beat.kind === "toolCall") {
		const args = resolveArguments(beat.arguments, context);
		const call: ToolCall = { type: "toolCall", id: nextToolCallId(), name: beat.name, arguments: args };
		partial.content.push(call);
		events.push({ type: "toolcall_start", contentIndex, partial });
		events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial });
		events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
		return;
	}

	if (beat.kind === "thinking") {
		const content: ThinkingContent = { type: "thinking", thinking: "" };
		partial.content.push(content);
		events.push({ type: "thinking_start", contentIndex, partial });
		for (const token of [...beat.text]) {
			throwIfAborted(signal);
			content.thinking += token;
			events.push({ type: "thinking_delta", contentIndex, delta: token, partial });
			countToken(partial);
			await pause();
		}
		events.push({ type: "thinking_end", contentIndex, content: content.thinking, partial });
		return;
	}

	const content: TextContent = { type: "text", text: "" };
	partial.content.push(content);
	events.push({ type: "text_start", contentIndex, partial });
	for (const token of [...beat.text]) {
		throwIfAborted(signal);
		content.text += token;
		events.push({ type: "text_delta", contentIndex, delta: token, partial });
		countToken(partial);
		await pause();
	}
	events.push({ type: "text_end", contentIndex, content: content.text, partial });
}

/**
 * Substitute the run-time facts a written script cannot hold.
 *
 * One today: the id of the agent an earlier beat spawned, read back out of the
 * spawn's own tool result. Deep rather than shallow, because the arguments a
 * tool takes are nested (`{ agents: [{ ... }] }`) and the placeholder can sit
 * anywhere in them.
 */
function resolveArguments(args: Record<string, unknown>, context: Context): Record<string, unknown> {
	const serialized = JSON.stringify(args);
	if (!serialized.includes(LAST_SPAWNED_AGENT)) return args;
	const agentId = lastSpawnedAgentId(context.messages);
	return JSON.parse(serialized.replaceAll(LAST_SPAWNED_AGENT, agentId ?? "unknown-agent")) as Record<string, unknown>;
}

function lastSpawnedAgentId(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult" || message.toolName !== "spawn_agent") continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		// The spawn summary names each agent it created on its own line.
		const match = /^- agent (\S+)/mu.exec(text);
		if (match) return match[1];
	}
	return undefined;
}

/** Count the token as it leaves, so the gauge climbs with the text. */
function countToken(partial: AssistantMessage): void {
	partial.usage.output += 1;
	partial.usage.totalTokens = partial.usage.input + partial.usage.output;
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, MS_PER_TOKEN));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("aborted");
}

let toolCallCounter = 0;

function nextToolCallId(): string {
	toolCallCounter++;
	return `drill_${toolCallCounter}`;
}

function emptyCost(): AssistantMessage["usage"]["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * The context, counted the same way the output is: one character, one token.
 *
 * A drill has no business reporting a number nobody can check, and it has less
 * business inventing one. What is on screen is what was counted.
 */
function countContext(context: Context): number {
	let total = context.systemPrompt?.length ?? 0;
	for (const message of context.messages) total += weigh(message);
	return total;
}

function weigh(message: Message): number {
	if (message.role === "user") return userText(message.content).length;
	if (message.role === "assistant") return message.content.reduce((total, entry) => total + weighContent(entry), 0);
	return message.content.reduce((total, entry) => total + (entry.type === "text" ? entry.text.length : 0), 0);
}

function weighContent(entry: TextContent | ThinkingContent | ToolCall): number {
	if (entry.type === "text") return entry.text.length;
	if (entry.type === "thinking") return entry.thinking.length;
	return JSON.stringify(entry.arguments).length;
}
