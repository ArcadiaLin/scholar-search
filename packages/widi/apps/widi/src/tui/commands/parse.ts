export const LINE_COMMAND_TRIGGER = "/";

export interface ParsedLineCommand {
	readonly name: string;
	readonly argument: string;
	/** false for `/name`, true for `/name:`, `/name:arg` and `/name arg`. */
	readonly hasArgument: boolean;
}

export function parseLineCommand(text: string): ParsedLineCommand | undefined {
	const input = text.trimEnd();
	if (!input.startsWith(LINE_COMMAND_TRIGGER)) return undefined;
	const body = input.slice(LINE_COMMAND_TRIGGER.length);
	if (!body) return undefined;
	// The separator is the first ":" or the first whitespace, whichever comes
	// first. Colon syntax keeps the argument verbatim; space syntax skips the
	// separating whitespace itself.
	const colonIndex = body.indexOf(":");
	const whitespaceIndex = /\s/u.exec(body)?.index ?? -1;
	let separatorIndex = -1;
	let colonSyntax = false;
	if (colonIndex !== -1 && (whitespaceIndex === -1 || colonIndex < whitespaceIndex)) {
		separatorIndex = colonIndex;
		colonSyntax = true;
	} else {
		separatorIndex = whitespaceIndex;
	}
	const rawName = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
	if (!isCommandName(rawName)) return undefined;
	const rawArgument = separatorIndex === -1 ? "" : body.slice(separatorIndex + 1);
	return {
		name: rawName,
		hasArgument: separatorIndex !== -1,
		argument: colonSyntax ? rawArgument : rawArgument.replace(/^\s+/u, ""),
	};
}

export function isCommandName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}

/**
 * Split a command argument into its leading name token and the remaining text.
 * The remainder is kept verbatim so free-form trailing instructions survive
 * quoting and whitespace exactly as typed.
 */
export function splitLeadingToken(argument: string): { token: string; rest: string } {
	const separatorIndex = /\s/u.exec(argument)?.index ?? -1;
	if (separatorIndex === -1) return { token: argument, rest: "" };
	return { token: argument.slice(0, separatorIndex), rest: argument.slice(separatorIndex + 1).trim() };
}
