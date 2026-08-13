import type { Component, SelectItem } from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../../core/agent-orchestrator.ts";
import type { AgentActivitySnapshot, CandidateItem, RuntimeModel } from "../../core/types.ts";
import type { CommandPresenter } from "../command-presenter.ts";
import type { ListSelectorOperation } from "../selectors/list-selector.ts";

/**
 * Which agent a command needs.
 *
 * - `runtime`: none; it acts on the runtime or the application.
 * - `active`: an agent must be open.
 * - `materialize`: an agent must be open, and a staged session is spawned first.
 * - `pending`: the opposite of `active` - it edits a session that has not been
 *   created yet, so an already-running agent has nothing for it to change.
 */
export type CommandAgentPolicy = "runtime" | "materialize" | "active" | "pending";

export interface CommandContext {
	readonly agentId?: string;
	readonly orchestrator: AgentOrchestrator;
	readonly pendingModel?: RuntimeModel;
	/**
	 * The workspace the command runs in: the open agent's, or the staged
	 * session's. Anything that reads or writes the project - listing sessions,
	 * resuming one - has to say which project it means.
	 */
	readonly workspaceCwd?: string;
}

/**
 * What the application hands a command's dedicated Enter-time selector. It is
 * the request the default ListSelector would have been built from, so a
 * command that only wants to adjust the list can spread it into one.
 */
export interface CommandSelectorRequest {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly operation?: ListSelectorOperation;
	/** Pre-filled filter text (a query the submit path already tried). */
	readonly initialFilter?: string;
	onSelect(item: SelectItem): void;
	onCancel?(): void;
	/**
	 * Hides the host overlay and restores focus. Runs before onSelect/onCancel
	 * so a callback is free to open another selector.
	 */
	onClose(): void;
}

/**
 * Builds the command's Enter-time picker; the shared ListSelector is the default.
 * The context is the same one execute() would get, so a picker may fetch richer
 * data than the flat candidate list (the /tree graph needs the entry tree);
 * returning a promise lets it do so before the overlay opens.
 */
export type SelectorFactory = (
	request: CommandSelectorRequest,
	context: CommandContext,
) => Component | Promise<Component>;

export type ResolveArgumentOutcome =
	| { readonly kind: "resolved"; readonly value: string }
	| { readonly kind: "open-selector"; readonly query: string };

/**
 * Everything a `/name argument` command shares. Commands differ only in what
 * they produce: an action result or prompt text.
 */
interface CommandBase {
	/**
	 * True when the candidates are the whole argument space (`/model`,
	 * `/thinking`, `/login`): accepting a completion lands a complete command,
	 * so the editor submits it right away. Free-text arguments (`/prompt`,
	 * `/skill`, `/rename`, `/steer`) leave it unset and Enter only inserts.
	 */
	readonly argumentCompletes?: boolean;
	readonly agentPolicy: CommandAgentPolicy;
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly requiresArgument?: boolean;
	/** Returns why the current agent activity blocks this command, or undefined. */
	checkActivity?(activity: AgentActivitySnapshot): string | undefined;
	complete?(context: CommandContext, argumentPrefix: string): Promise<readonly CandidateItem[]>;
	/** Enter-time picker; defaults to the shared ListSelector fed with complete() candidates. */
	readonly selector?: SelectorFactory;
	/**
	 * Resolves a submitted argument against the candidates; defaults to the
	 * engine's generic exact-then-unique-prefix matching on candidate values.
	 */
	resolveArgument?(
		context: CommandContext,
		argument: string,
		candidates: readonly CandidateItem[],
	): ResolveArgumentOutcome | Promise<ResolveArgumentOutcome>;
}

/** Performs an action; the returned value is rendered as the command result. */
export interface ActionCommand extends CommandBase {
	readonly kind: "action";
	execute(context: CommandContext, argument: string): Promise<unknown>;
	/**
	 * Optional short human-readable summary of the result. When defined, the
	 * transcript shows it instead of dumping the raw result value. A presenter
	 * takes precedence over this when both are defined.
	 */
	formatResult?(result: unknown): string;
	/**
	 * Renders the completed command-result timeline row (lines or component
	 * form). The engine syncs it into the command presenter registry on
	 * register/unregister, so host commands get the same row path as built-ins.
	 * Absent, the row falls back to formatResult (or the raw result value).
	 */
	readonly presenter?: CommandPresenter;
}

/** Pure expansion: the returned text is submitted as the user prompt. */
export interface PromptCommand extends CommandBase {
	readonly kind: "prompt";
	expand(context: CommandContext, argument: string): Promise<string>;
}

export type CommandDefinition = ActionCommand | PromptCommand;

export interface CommandError {
	readonly message: string;
	readonly cause?: unknown;
}

/** List entry with availability computed against the current agent status. */
export interface CommandView {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly takesArgument: boolean;
	readonly available: boolean;
	readonly unavailableReason?: string;
}

export type EngineOutcome =
	| { readonly kind: "pass" }
	| { readonly kind: "expanded"; readonly text: string }
	| {
			readonly kind: "executed";
			readonly commandId: string;
			readonly name: string;
			readonly value: unknown;
			readonly display?: string;
	  }
	| { readonly kind: "failed"; readonly commandId: string; readonly name: string; readonly error: CommandError }
	| {
			readonly kind: "needs-argument";
			readonly command: CommandDefinition;
			readonly candidates: readonly CandidateItem[];
	  }
	| {
			readonly kind: "open-selector";
			readonly command: CommandDefinition;
			readonly candidates: readonly CandidateItem[];
			readonly query: string;
	  };
