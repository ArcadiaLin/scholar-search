/**
 * What the fake model does inside one provider callback.
 *
 * Data only. Turning a beat into an `AssistantMessageEvent` sequence is the
 * provider's job (`core/provider.ts`) because that is where the model object and
 * the stream live; keeping the script free of pi-ai imports is what lets both
 * halves read it, the TUI half included, without pulling the model layer into
 * the terminal process.
 */

export type ScriptedBeat =
	| { readonly kind: "thinking"; readonly text: string }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "toolCall"; readonly name: string; readonly arguments: Record<string, unknown> }
	| { readonly kind: "fail"; readonly message: string };

/** One provider callback: the beats it plays, in order. */
export type ScriptedTurn = readonly ScriptedBeat[];

export function thinking(text: string): ScriptedBeat {
	return { kind: "thinking", text };
}

export function text(text: string): ScriptedBeat {
	return { kind: "text", text };
}

/**
 * Stands in for the id of the agent this turn's script spawned earlier.
 *
 * A script is written before the run and an agent id is minted during it, so
 * this is the one argument a static script cannot carry. The provider resolves
 * it from the spawn's own tool result, which is the only place the id exists.
 */
export const LAST_SPAWNED_AGENT = "{{drill:last-spawned-agent}}";

export function toolCall(name: string, args: Record<string, unknown> = {}): ScriptedBeat {
	return { kind: "toolCall", name, arguments: args };
}

export function fail(message: string): ScriptedBeat {
	return { kind: "fail", message };
}
