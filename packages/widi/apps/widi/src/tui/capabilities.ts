/**
 * The control surfaces the application publishes for other runtimes.
 *
 * The layout registry answers "what is on screen and where"; this answers "what
 * can be done to it". They are two tables on purpose - the command engine and
 * the theme are capabilities with no slot, and a decorative widget is a slot
 * with no capability - but where both exist they share one key, so the name an
 * extension wraps is the name it controls.
 *
 * What goes in a capability is product vocabulary, never an internal method
 * promoted to public. `application.ts` has thirty-odd private methods and most
 * of them are paint bookkeeping (`updateEditorAvailability`,
 * `expireNotification`); publishing those would make every refactor a breaking
 * change and leave extension authors unable to tell a capability from an
 * implementation detail. A capability is written by hand, one layer above.
 *
 * **Writes are deferred, reads are not.** Every mutating method schedules its
 * effect for after the current frame, so a capability call from inside a
 * component's render can never re-enter the paint it was called from. This is
 * why there is no "you may not call this during render" rule to learn: the
 * shape makes the hazard unreachable instead of reporting it.
 */

import type { HumanRequestEnvelope } from "../core/human-request.ts";
import type { CandidateItem } from "../core/types.ts";
import type { CommandView } from "./commands/types.ts";
import type { Segment } from "./segments.ts";
import type { AgentViewStatus } from "./state.ts";
import type { HumanRequestPresenter } from "./views/human-request.ts";

/** Text access to the editor. Submitting is deliberately absent - see below. */
export interface EditorCapability {
	getText(): string;
	/**
	 * Replace the draft. Deferred to after the current frame.
	 *
	 * There is no submit. Not because an extension cannot be trusted with one,
	 * but because of attribution: a submitted draft lands on the branch as a
	 * human message, and it would not be one. `stage` is the designed answer -
	 * the extension puts the words up, the human reads them, may rewrite them,
	 * and presses enter themselves, and the entry records both facts.
	 */
	setText(text: string): void;
	/** Insert at the cursor, keeping the rest of the draft. Deferred. */
	insertAtCursor(text: string): void;
	/** Drop the draft. Deferred. */
	clear(): void;
}

/** What `CommandsCapability.run` did with the input. */
export type CommandRunOutcome =
	| { readonly kind: "executed"; readonly name: string; readonly value: unknown; readonly display?: string }
	| { readonly kind: "failed"; readonly name: string; readonly error: string }
	/**
	 * A prompt command ran and produced text. It is handed back rather than
	 * sent, for the same reason the editor has no submit: the message would land
	 * on the branch as the human's. Put it in the editor and let them press
	 * enter.
	 */
	| { readonly kind: "expanded"; readonly text: string }
	/**
	 * The command wants an argument it was not given. The candidates are the
	 * ones the picker would have shown; choose one and run the command again
	 * with it. Nothing was opened on screen.
	 */
	| { readonly kind: "needs-argument"; readonly name: string; readonly candidates: readonly CandidateItem[] }
	| { readonly kind: "not-a-command" };

/** The command engine, as an extension sees it. */
export interface CommandsCapability {
	/** Every registered command, availability computed against the visible agent. */
	list(): readonly CommandView[];
	/**
	 * Run `/name argument` against the visible agent. Deferred to after the
	 * current frame; the promise settles when the command does.
	 *
	 * A command runs with the same transcript trace a typed one leaves, and
	 * commands that switch agents switch this one too. What it will not do is
	 * materialize a pending agent or send anything to the model.
	 */
	run(input: string): Promise<CommandRunOutcome>;
}

/** Who a scoped capability attributes its writes to when nobody said. */
export const APPLICATION_CALLER = "widi";

/** One row of the agent strip. */
export interface AgentBrief {
	readonly agentId: string;
	readonly label: string;
	/** 0 for a top-level agent, +1 per spawn generation below it. */
	readonly depth: number;
	readonly status: AgentViewStatus;
	/** The agent whose tool spawned this one; unset for user-side spawns. */
	readonly spawnedBy?: string;
	readonly unreadCount: number;
}

/**
 * The agent strip: which agents exist, which one the transcript is showing,
 * and how to change that.
 *
 * There is no spawn. Creating an agent is core's, and a TUI half that wants
 * one asks its core half to spawn it - the strip picks the new agent up from
 * the runtime event either way, and `switchTo` brings it on screen. A second
 * spawn path here would only be a copy of the pending-session state machine
 * that drifts from it.
 */
export interface AgentStripCapability {
	/** Every live agent in strip order: each one followed by its subtree. */
	list(): readonly AgentBrief[];
	/** The agent the transcript is showing; undefined while a session is pending. */
	visibleAgentId(): string | undefined;
	/** Bring an agent on screen. Deferred to after the current frame. */
	switchTo(agentId: string): void;
	/**
	 * Close an agent, leaving its session file behind, and move on to a
	 * sensible neighbour. Deferred; the promise settles once it is gone.
	 */
	dispose(agentId: string): Promise<void>;
	/**
	 * Fires whenever the visible agent changes, with the new one (undefined
	 * while a session is pending). Returns the detach.
	 *
	 * This is what makes the event bus usable from a TUI half: an envelope
	 * carries the agent it came from, and a core half that lives in every agent
	 * emits from all of them at once. Knowing which one is on screen is how the
	 * TUI half tells its own instance's traffic from the rest.
	 */
	onVisibleAgentChanged(listener: (agentId: string | undefined) => void): () => void;
}

/**
 * Rows in an agent's transcript.
 *
 * Ephemeral is the whole surface, and that is a boundary rather than a
 * shortcoming. A durable entry is one the model reads on every resume and
 * every fork inherits; putting one there is a decision about the branch, the
 * branch belongs to core, and the way to it is the core half's
 * `publishMessage`. What is left here is what the terminal is for: saying
 * something to the person looking at it.
 */
export interface ChatCapability {
	/**
	 * Add a row, or replace the one already under this id. The id is namespaced
	 * to the caller, so two extensions cannot overwrite each other. Defaults to
	 * the visible agent. Deferred to after the current frame.
	 */
	insert(id: string, text: string, options?: { readonly agentId?: string }): void;
	/** Remove a row this caller inserted. Deferred; an unknown id does nothing. */
	remove(id: string, options?: { readonly agentId?: string }): void;
	/**
	 * Show a row this caller inserted in full, or back to its bounded preview.
	 * Deferred; an unknown id does nothing. It survives a re-insert under the
	 * same id, so replacing the text does not collapse the row under a reader.
	 *
	 * This is the producer's own switch, deliberately not the global tool-output
	 * toggle: an extension's row is not tool output, and one key deciding for
	 * both would hide one of them from whoever wanted the other.
	 */
	setExpanded(id: string, expanded: boolean, options?: { readonly agentId?: string }): void;
}

/** One item in the staging buffer. */
export interface StagedInputEntry {
	readonly id: number;
	readonly text: string;
	/** Who staged it; absent when the text is the human's own. */
	readonly extensionId?: string;
	/** A human took it into the editor and changed it before it landed. */
	readonly editedByHuman?: true;
	/** A human is rewriting it right now, so it is out of the buffer until they finish. */
	readonly heldInEditor?: true;
}

/**
 * The staging buffer of the visible agent: text held back from the branch until
 * the next human-initiated turn.
 *
 * Only the visible agent, because that is what staging is about - the turn the
 * person at the keyboard is about to start. Text meant for an agent they are
 * not looking at has no such turn coming and belongs on that branch directly,
 * through the core half.
 *
 * Reads see the whole buffer, writes only this caller's own entries. The buffer
 * is one queue and its order decides what lands first, so a producer that could
 * not see the rest could not judge what to add - but rewriting someone else's
 * staged text would file words on the branch under a producer who never wrote
 * them, which is the one thing the attribution here exists to prevent.
 */
export interface StagedInputCapability {
	/** The buffer in landing order, whoever staged each entry. */
	list(): readonly StagedInputEntry[];
	/**
	 * Stage text at the end of the buffer. Deferred; resolves with the id it
	 * took, or undefined when the text was blank or no agent was visible.
	 */
	add(text: string): Promise<number | undefined>;
	/** Rewrite an entry this caller staged. Deferred; ignores anything else. */
	update(id: number, text: string): void;
	/** Drop an entry this caller staged. Deferred; ignores anything else. */
	remove(id: number): void;
}

/**
 * Named text in one of the composed rows - the header, the footer, the hint
 * line, the status panel, the working line. Published under all five keys, one
 * interface, because those five differ in how they paint a row and not at all
 * in what they are being handed.
 *
 * Where a segment lands in its row, and what a narrow terminal drops first, is
 * the component's decision and not the caller's. The header appends after the
 * model; the footer joins the queue counters; the status panel gives each one a
 * row; the working line puts them ahead of the keys, because the keys are named
 * again under the footer and a segment is not.
 */
export interface SegmentsCapability {
	/**
	 * Add or replace one piece of text. The id is namespaced to the caller.
	 * Replacing keeps the position it first took. Deferred to after the frame.
	 */
	set(id: string, text: string, options?: { readonly order?: number }): void;
	/** Take one away. Deferred; an unknown id does nothing. */
	remove(id: string): void;
	/** This caller's segments in this row, in the order they render. */
	list(): readonly Segment[];
}

/** What an agent has waiting, as the queued-input row shows it. */
export interface QueuedInput {
	/** Text that interrupts the run at the next turn boundary. */
	readonly steer: readonly string[];
	/** Text core consumes when the run ends. */
	readonly followUp: readonly string[];
	/**
	 * Follow-ups this shell has accepted but core has not acknowledged yet.
	 * Separate because `steer` cannot move them: they are not in the queue it
	 * promotes, they are on their way to it.
	 */
	readonly unacknowledged: readonly string[];
}

/**
 * The input queue of a running agent.
 *
 * Read-only apart from the promotion, and that is core's boundary rather than a
 * choice made here: the queue lives in core and its entries are plain text with
 * no identity, so there is nothing to address a single removal or reorder to.
 */
export interface QueuedInputCapability {
	list(options?: { readonly agentId?: string }): QueuedInput;
	/**
	 * Turn every queued follow-up into steering, read at the next turn boundary
	 * instead of after the run. Deferred; resolves with how many moved, and
	 * rejects if the agent is not in a state that can be steered.
	 *
	 * Nothing is said to the human about it: the queue row empties on its own,
	 * and what else is worth telling them is the caller's to decide.
	 */
	steer(options?: { readonly agentId?: string }): Promise<number>;
}

/** One row of a docked selection. */
export interface SelectorChoice {
	readonly value: string;
	/** Shown instead of the value. */
	readonly label?: string;
	/** Dim text beside the label. */
	readonly description?: string;
}

export interface SelectorRequest {
	readonly title: string;
	readonly choices: readonly SelectorChoice[];
	/** What the choice is for, shown in the hint line under the editor. */
	readonly description?: string;
	/** Pre-filled filter text. */
	readonly filter?: string;
}

/**
 * The place a selection takes the editor's own, at the bottom of the screen.
 *
 * Not a slot to put a view in - the layout registry is where a runtime replaces
 * what a selection looks like. This is the other direction: asking for one and
 * waiting for the answer, the way a command that needs an argument does.
 */
export interface SelectorDockCapability {
	/** Whether anything is docked, this caller's selection or a command's. */
	isOpen(): boolean;
	/**
	 * Dock a list and wait. Deferred; resolves with the chosen value, or
	 * undefined when the human cancelled or the selection was taken down some
	 * other way.
	 *
	 * One at a time, and an occupied dock rejects rather than evicting what is
	 * there: the human is in the middle of answering it, and a cancel they never
	 * made is not a fact worth reporting to either caller.
	 */
	open(request: SelectorRequest): Promise<string | undefined>;
	/** Take down a selection this caller opened, resolving it as a cancel. Deferred. */
	close(): void;
}

/**
 * The panel a human answers questions in.
 *
 * Answering is not here and will not be: the panel exists because a person is
 * the one being asked, and a runtime that could answer for them would make
 * every request a lie about who decided.
 */
export interface HumanRequestsCapability {
	/** Requests waiting on an answer right now, in arrival order. */
	list(): readonly HumanRequestEnvelope[];
	/**
	 * Show something of your own inside a request, under its message and above
	 * its options - the diff an edit approval is about, the file a question
	 * names. Returns the detach.
	 *
	 * The presenter is handed every request and decides which ones it has
	 * anything to say about. `source.kind === "tool"` carries the `toolName` and
	 * `toolCallId` an approval is about, which is what makes that decidable
	 * rather than guesswork over the title.
	 *
	 * It runs inside the panel's own render, so it reads and paints and does
	 * nothing else; a throwing presenter is dropped from that frame and reported
	 * once.
	 */
	present(presenter: HumanRequestPresenter): () => void;
}

/** The notice area above the transcript. */
export interface NoticesCapability {
	/**
	 * Post a notice, or replace the one already under this id. Notices expire on
	 * their own; pass `ttlMs: 0` for one that stays until it is dismissed.
	 * Deferred to after the current frame.
	 */
	post(id: string, text: string, options?: { readonly ttlMs?: number }): void;
	/** Take a notice down early. Deferred; an unknown id does nothing. */
	dismiss(id: string): void;
}

/**
 * The built-in capability keys and what each one hands back.
 *
 * Extensions may publish nothing here: the map is the application's own
 * vocabulary, and a key outside it reads back as `unknown` so the caller has to
 * narrow it themselves rather than assert a shape nobody promised.
 */
export interface TuiCapabilityMap {
	readonly editor: EditorCapability;
	readonly commands: CommandsCapability;
	readonly agentStrip: AgentStripCapability;
	readonly chat: ChatCapability;
	readonly stagedInput: StagedInputCapability;
	readonly queuedInput: QueuedInputCapability;
	readonly selectorDock: SelectorDockCapability;
	readonly humanRequests: HumanRequestsCapability;
	readonly notices: NoticesCapability;
	readonly header: SegmentsCapability;
	readonly footer: SegmentsCapability;
	readonly operationHint: SegmentsCapability;
	readonly status: SegmentsCapability;
	readonly workingLine: SegmentsCapability;
}

/** The five keys that take named text; `SEGMENT_SLOTS[i]` is a layout key. */
export const SEGMENT_SLOTS = ["header", "footer", "operationHint", "status", "workingLine"] as const;

export type SegmentSlot = (typeof SEGMENT_SLOTS)[number];

export type TuiCapabilityKey = keyof TuiCapabilityMap;

/**
 * The published set. One instance per application; the application fills it
 * during construction and never removes an entry, so a capability held from
 * activation stays valid for the life of the process.
 */
export class TuiCapabilityRegistry {
	private readonly published = new Map<string, object>();
	private readonly binders = new Map<string, (caller: string) => object>();
	private readonly bound = new Map<string, object>();

	publish<TKey extends TuiCapabilityKey>(key: TKey, capability: TuiCapabilityMap[TKey]): void {
		this.published.set(key, capability);
	}

	/**
	 * Publish a capability whose writes carry the caller's name - a transcript
	 * row and a notice both say who put them there, and asking the caller to
	 * pass its own id would make that a claim rather than a fact. One instance
	 * per caller, so a handle held from activation keeps working.
	 */
	publishScoped<TKey extends TuiCapabilityKey>(key: TKey, bind: (caller: string) => TuiCapabilityMap[TKey]): void {
		this.binders.set(key, bind);
	}

	get<TKey extends TuiCapabilityKey>(key: TKey, caller?: string): TuiCapabilityMap[TKey] | undefined;
	get(key: string, caller?: string): unknown;
	get(key: string, caller = APPLICATION_CALLER): unknown {
		const bind = this.binders.get(key);
		if (!bind) return this.published.get(key);
		const boundKey = `${key} ${caller}`;
		const existing = this.bound.get(boundKey);
		if (existing) return existing;
		const capability = bind(caller);
		this.bound.set(boundKey, capability);
		return capability;
	}

	/** Published keys, for `/layout` and the drill coverage ledger. */
	keys(): readonly string[] {
		return [...this.published.keys(), ...this.binders.keys()];
	}
}
