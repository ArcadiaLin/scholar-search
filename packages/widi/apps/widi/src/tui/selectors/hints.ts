import { actionKeyLabel } from "../keybindings.ts";

/** What an open selector contributes to the operation hint line. */
export interface SelectorHintContext {
	readonly title: string;
	readonly description?: string;
	readonly confirmVerb: "apply" | "switch";
	readonly itemCount: number;
}

export interface SelectorKeyHintOptions {
	/** Include the "type to filter" hint; only selectors with a filter line do. */
	readonly filter?: boolean;
	/** Verb shown for the confirm key; defaults to "select". */
	readonly confirmLabel?: string;
}

/**
 * Bottom key-hint line shared by the selector family: a navigate pair, an
 * optional filter hint, and confirm/cancel, all read from the live keybindings
 * so user remaps show up here.
 */
export function selectorKeyHints(options: SelectorKeyHintOptions = {}): string {
	const confirm = actionKeyLabel("tui.select.confirm");
	const cancel = actionKeyLabel("tui.select.cancel");
	const navigate = [actionKeyLabel("tui.select.up"), actionKeyLabel("tui.select.down")]
		.filter((candidate): candidate is string => candidate !== undefined)
		.join("/");
	const parts = [
		navigate ? `${navigate} navigate` : undefined,
		options.filter ? "type to filter" : undefined,
		confirm && `${confirm} ${options.confirmLabel ?? "select"}`,
		cancel && `${cancel} cancel`,
	];
	return parts.filter((part): part is string => Boolean(part)).join("  ");
}
