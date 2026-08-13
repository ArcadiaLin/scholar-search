import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getKeybindings,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { CoreDiagnostic } from "../core/diagnostics.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.agents.open": true;
		"app.agents.previous": true;
		"app.agents.next": true;
		"app.interrupt": true;
		"app.exit": true;
		"app.expand": true;
		"app.staged.edit": true;
		"app.prompt.view": true;
		"app.steer": true;
		"app.request.open": true;
		"app.request.previous": true;
		"app.request.next": true;
		"app.request.toggle": true;
		"app.tree.open": true;
		"app.request.option1": true;
		"app.request.option2": true;
		"app.request.option3": true;
		"app.request.option4": true;
		"app.request.option5": true;
		"app.request.option6": true;
		"app.request.option7": true;
		"app.request.option8": true;
		"app.request.option9": true;
	}
}

export const WIDI_KEYBINDINGS = {
	"app.agents.open": {
		defaultKeys: "down",
		description: "Focus the agent panel below when the draft cursor is at the end",
	},
	"app.agents.previous": { defaultKeys: "left", description: "Move to the previous agent in the agent panel" },
	"app.agents.next": { defaultKeys: "right", description: "Move to the next agent in the agent panel" },
	"app.interrupt": { defaultKeys: "escape", description: "Close the current interaction or abort the active agent" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when the editor is empty" },
	"app.expand": { defaultKeys: "ctrl+o", description: "Toggle expanded transcript details" },
	// ctrl+e belongs to pi-tui's cursorLineEnd; taking it would shadow an
	// editing key every emacs-handed user expects.
	"app.staged.edit": { defaultKeys: "ctrl+x", description: "Take the newest staged message back into the editor" },
	"app.prompt.view": { defaultKeys: "ctrl+p", description: "Print the system prompt of the next turn" },
	"app.steer": { defaultKeys: "ctrl+s", description: "Send the editor text as a steer to the running agent" },
	"app.request.open": { defaultKeys: "ctrl+r", description: "Jump to the most recent pending human request" },
	"app.request.previous": { defaultKeys: "left", description: "Focus the previous pending human request" },
	"app.request.next": { defaultKeys: ["right", "tab"], description: "Focus the next request tab" },
	"app.request.toggle": {
		defaultKeys: "space",
		description: "Toggle the highlighted option in a multi-select request",
	},
	"app.tree.open": { defaultKeys: "ctrl+g", description: "Open the session tree without submitting the editor draft" },
	"app.request.option1": { defaultKeys: "1", description: "Choose the first option in a human request" },
	"app.request.option2": { defaultKeys: "2", description: "Choose the second option in a human request" },
	"app.request.option3": { defaultKeys: "3", description: "Choose the third option in a human request" },
	"app.request.option4": { defaultKeys: "4", description: "Choose the fourth option in a human request" },
	"app.request.option5": { defaultKeys: "5", description: "Choose the fifth option in a human request" },
	"app.request.option6": { defaultKeys: "6", description: "Choose the sixth option in a human request" },
	"app.request.option7": { defaultKeys: "7", description: "Choose the seventh option in a human request" },
	"app.request.option8": { defaultKeys: "8", description: "Choose the eighth option in a human request" },
	"app.request.option9": { defaultKeys: "9", description: "Choose the ninth option in a human request" },
} as const satisfies KeybindingDefinitions;

const REQUEST_OPTION_KEYS = [
	"app.request.option1",
	"app.request.option2",
	"app.request.option3",
	"app.request.option4",
	"app.request.option5",
	"app.request.option6",
	"app.request.option7",
	"app.request.option8",
	"app.request.option9",
] as const;

/**
 * The 0-based index of the number key just pressed (1 → 0, 9 → 8), or
 * undefined when the input is not one of the option shortcuts. Callers map the
 * index onto the request's options list themselves.
 */
export function matchRequestOptionIndex(data: string): number | undefined {
	const keybindings = getKeybindings();
	for (let index = 0; index < REQUEST_OPTION_KEYS.length; index++) {
		if (keybindings.matches(data, REQUEST_OPTION_KEYS[index])) return index;
	}
	return undefined;
}

const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);

const KEY_LABELS: Record<string, string> = {
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	escape: "Esc",
	esc: "Esc",
	enter: "Enter",
	return: "Enter",
	tab: "Tab",
	space: "Space",
	backspace: "Backspace",
	delete: "Delete",
	insert: "Insert",
	clear: "Clear",
	home: "Home",
	end: "End",
	pageUp: "PageUp",
	pageDown: "PageDown",
};

/** How a key sequence is written wherever the TUI names one: `Ctrl+S`, `↑`. */
export function formatKeyLabel(key: KeyId): string {
	const modifiers: string[] = [];
	let base: string = key;
	for (;;) {
		const separator = base.indexOf("+");
		if (separator <= 0 || !KEY_MODIFIERS.has(base.slice(0, separator))) break;
		const modifier = base.slice(0, separator);
		modifiers.push(modifier === "ctrl" ? "Ctrl" : modifier[0]?.toUpperCase() + modifier.slice(1));
		base = base.slice(separator + 1);
	}
	return [...modifiers, KEY_LABELS[base] ?? base.toUpperCase()].join("+");
}

/**
 * Label of the first key bound to an action, or undefined when it is unbound.
 * Read live so a user remap shows up wherever the key is named.
 */
export function actionKeyLabel(action: Parameters<KeybindingsManager["getKeys"]>[0]): string | undefined {
	const key = getKeybindings().getKeys(action)[0];
	return key ? formatKeyLabel(key) : undefined;
}

/**
 * Runtime shape check for a pi-tui `KeyId` (the type only exists at compile
 * time): optional modifier prefixes, then a single character or a named
 * special key.
 */
export function isKeyId(value: string): boolean {
	let rest = value;
	for (;;) {
		const separator = rest.indexOf("+");
		if (separator <= 0 || !KEY_MODIFIERS.has(rest.slice(0, separator))) break;
		rest = rest.slice(separator + 1);
		if (rest.length === 0) return false;
	}
	return rest.length === 1 || SPECIAL_KEYS.has(rest);
}

/**
 * Old action names still accepted from keybindings.json, mapped to what they
 * are called now. Dropping one silently would kill a user's binding with an
 * "unknown action" warning that reads like a typo.
 */
const RENAMED_ACTIONS: Record<string, string> = {
	// Renamed once ctrl+o grew past tool output into every collapsed detail.
	"app.tools.expand": "app.expand",
};

export interface UserKeybindingsLoad {
	readonly bindings: KeybindingsConfig;
	readonly diagnostics: CoreDiagnostic[];
}

/**
 * Read `<agentDir>/keybindings.json` (action name → key sequence or list of
 * sequences; an empty list unbinds the action). A missing file is the normal
 * case, not an error. Unreadable files and invalid entries (unknown action,
 * malformed key sequence) are collected as diagnostics and skipped so the TUI
 * still starts on defaults.
 *
 * `extraDefinitions` names actions beyond the built-ins that are valid
 * override targets - the TUI extension host passes its registered shortcut
 * actions, which only exist after extensions activate.
 */
export function loadUserKeybindings(agentDir: string, extraDefinitions?: KeybindingDefinitions): UserKeybindingsLoad {
	const path = join(agentDir, "keybindings.json");
	if (!existsSync(path)) return { bindings: {}, diagnostics: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			bindings: {},
			diagnostics: [
				{
					severity: "error",
					code: "keybindings.read_failed",
					message: `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			bindings: {},
			diagnostics: [
				{
					severity: "error",
					code: "keybindings.read_failed",
					message: `${path} must contain a JSON object mapping action names to key sequences.`,
				},
			],
		};
	}
	const bindings: KeybindingsConfig = {};
	const diagnostics: CoreDiagnostic[] = [];
	for (const [rawAction, value] of Object.entries(raw)) {
		const renamed = RENAMED_ACTIONS[rawAction];
		const action = renamed ?? rawAction;
		if (renamed) {
			diagnostics.push({
				severity: "warning",
				code: "keybindings.renamed_action",
				message: `${path}: "${rawAction}" is now "${renamed}"; the binding was applied under the new name. Rename it to silence this.`,
			});
		}
		if (
			!(action in WIDI_KEYBINDINGS) &&
			!(action in TUI_KEYBINDINGS) &&
			!(extraDefinitions && action in extraDefinitions)
		) {
			diagnostics.push({
				severity: "warning",
				code: "keybindings.invalid_entry",
				message: `${path}: unknown action "${action}"; the entry is ignored.`,
			});
			continue;
		}
		const keys = Array.isArray(value) ? value : [value];
		if (keys.every((key) => typeof key === "string" && isKeyId(key))) {
			bindings[action] = value as KeyId | KeyId[];
			continue;
		}
		diagnostics.push({
			severity: "warning",
			code: "keybindings.invalid_entry",
			message: `${path}: invalid key sequence for "${action}": ${JSON.stringify(value)}; the entry is ignored.`,
		});
	}
	return { bindings, diagnostics };
}

export function createWidiKeybindings(
	userBindings: KeybindingsConfig = {},
	extraDefinitions: KeybindingDefinitions = {},
): KeybindingsManager {
	return new KeybindingsManager({ ...TUI_KEYBINDINGS, ...WIDI_KEYBINDINGS, ...extraDefinitions }, userBindings);
}
