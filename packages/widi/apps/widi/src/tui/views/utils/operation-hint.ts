import type { CommandEngine } from "../../commands/engine.ts";
import { parseLineCommand } from "../../commands/parse.ts";
import { singleLine } from "../../format.ts";
import { actionKeyLabel } from "../../keybindings.ts";
import type { SelectorHintContext } from "../../selectors/hints.ts";
import { activeAgent, type TuiApplicationState } from "../../state.ts";

export interface OperationHintKeys {
	readonly agents?: string;
	readonly agentsPrevious?: string;
	readonly agentsNext?: string;
	readonly interrupt?: string;
	readonly steer?: string;
	readonly requests?: string;
	readonly selectUp?: string;
	readonly selectDown?: string;
	readonly selectConfirm?: string;
	readonly selectCancel?: string;
	readonly inputTab?: string;
	readonly inputSubmit?: string;
}

/** The first bound key for every action the hint can name. */
export function operationHintKeys(): OperationHintKeys {
	return {
		agents: actionKeyLabel("app.agents.open"),
		agentsPrevious: actionKeyLabel("app.agents.previous"),
		agentsNext: actionKeyLabel("app.agents.next"),
		interrupt: actionKeyLabel("app.interrupt"),
		steer: actionKeyLabel("app.steer"),
		requests: actionKeyLabel("app.request.open"),
		selectUp: actionKeyLabel("tui.select.up"),
		selectDown: actionKeyLabel("tui.select.down"),
		selectConfirm: actionKeyLabel("tui.select.confirm"),
		selectCancel: actionKeyLabel("tui.select.cancel"),
		inputTab: actionKeyLabel("tui.input.tab"),
		inputSubmit: actionKeyLabel("tui.input.submit"),
	};
}

export interface ResolveOperationHintOptions {
	readonly state: TuiApplicationState;
	readonly engine: CommandEngine;
	readonly editorText: string;
	readonly editorAutocompleteVisible: boolean;
	readonly selector?: SelectorHintContext;
	readonly keys: OperationHintKeys;
}

/**
 * Which situation the hint is describing. The working line takes the hint over
 * for the two run kinds and prints it next to what the run is doing; everything
 * else stays on the hint line under the footer. Naming the kind is what keeps
 * that split from re-deriving these branches somewhere else.
 */
export type OperationHintKind =
	| "agent-panel"
	| "selector"
	| "autocomplete"
	| "requests"
	| "maintenance"
	| "run"
	| "agents"
	| "pending";

export interface OperationHint {
	readonly kind: OperationHintKind;
	readonly text: string;
}

export function resolveOperationHint(options: ResolveOperationHintOptions): string | undefined {
	return resolveOperationHintDetail(options)?.text;
}

export function resolveOperationHintDetail(options: ResolveOperationHintOptions): OperationHint | undefined {
	if (options.state.mode === "human-request") return undefined;

	if (options.state.mode === "agent-panel") {
		return hint(
			"agent-panel",
			keyAction(options.keys.selectUp, "back"),
			keyPair(options.keys.agentsPrevious, options.keys.agentsNext, "agent"),
			keyAction(options.keys.selectDown, "tree"),
			keyAction(options.keys.selectConfirm, "switch"),
			keyAction(options.keys.selectCancel, "back"),
		);
	}

	const selector = options.selector;
	if (selector) {
		return hint(
			"selector",
			selector.title,
			selector.description,
			keyPair(options.keys.selectUp, options.keys.selectDown, "choose"),
			selector.itemCount > 0 ? keyAction(options.keys.selectConfirm, selector.confirmVerb) : undefined,
			keyAction(options.keys.selectCancel, "cancel"),
		);
	}

	if (options.editorAutocompleteVisible) {
		const parsed = parseLineCommand(options.editorText);
		const command = parsed ? options.engine.get(parsed.name) : undefined;
		const tab = safePart(options.keys.inputTab);
		const confirm = safePart(options.keys.selectConfirm);
		const submit = safePart(options.keys.inputSubmit);
		const controls = [
			keyPair(options.keys.selectUp, options.keys.selectDown, "navigate"),
			keyAction(tab, "complete"),
			confirm && confirm !== tab ? keyAction(confirm, confirm === submit ? "submit" : "complete") : undefined,
			submit && submit !== tab && submit !== confirm ? keyAction(submit, "submit") : undefined,
			keyAction(options.keys.selectCancel, "close"),
		];
		if (command) {
			const usage = command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`;
			return hint("autocomplete", usage, command.description, ...controls);
		}
		return hint("autocomplete", "Commands", ...controls);
	}

	if (options.state.humanRequests.length > 0) {
		return hint("requests", keyAction(options.keys.requests, "open requests"));
	}

	const agent = activeAgent(options.state);
	if (agent?.status === "running") {
		// Maintenance work (compaction, tree navigation) has no agent loop to
		// steer or abort; the only input that applies is the follow-up queue.
		if (agent.maintenance) {
			// Which maintenance it is belongs to the working line, which names the
			// phase next to how long it has been running.
			return hint("maintenance", keyAction(options.keys.inputSubmit, "queue follow-up"));
		}
		// With an empty editor the steer key promotes what enter already queued,
		// so the hint has to say which of the two it would do.
		const steersQueue = options.editorText.trim().length === 0 && agent.queue.followUp.length > 0;
		return hint(
			"run",
			keyAction(options.keys.interrupt, "abort"),
			keyAction(options.keys.steer, steersQueue ? "steer queued" : "steer"),
			keyAction(options.keys.inputSubmit, "queue follow-up"),
		);
	}
	const visibleAgentCount = [...options.state.agents.values()].filter(
		(candidate) => candidate.status !== "disposed",
	).length;
	if (agent && visibleAgentCount > 1) {
		return hint(
			"agents",
			options.editorText.length === 0 ? keyAction(options.keys.agents, "switch agent") : undefined,
			"/dispose close current",
		);
	}
	if (!agent && options.state.pendingAgent) {
		return hint(
			"pending",
			keyAction(options.keys.inputSubmit, "starts session"),
			"/model or /thinking configures before first prompt",
		);
	}
	return undefined;
}

function hint(kind: OperationHintKind, ...parts: Array<string | undefined>): OperationHint | undefined {
	const safeParts = parts.map((part) => safePart(part)).filter((part): part is string => part !== undefined);
	return safeParts.length === 0 ? undefined : { kind, text: safeParts.join(" · ") };
}

function keyAction(key: string | undefined, action: string): string | undefined {
	const safeKey = safePart(key);
	return safeKey ? `${safeKey} ${action}` : undefined;
}

function keyPair(first: string | undefined, second: string | undefined, action: string): string | undefined {
	const keys = [safePart(first), safePart(second)].filter((candidate): candidate is string => candidate !== undefined);
	return keys.length > 0 ? `${keys.join("/")} ${action}` : undefined;
}

function safePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const safe = singleLine(value, value.length);
	return safe || undefined;
}
