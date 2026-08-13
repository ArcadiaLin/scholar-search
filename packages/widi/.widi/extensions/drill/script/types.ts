import type { DrillChapterId, DrillLanguage } from "../protocol.ts";
import type { ScriptedTurn } from "./beats.ts";

/**
 * One beat of the drill: some narration, an optional place to stop, optionally a
 * line to hand the human, and what the fake model does when they send it.
 *
 * The parts have different exits and none of them pretends to be another.
 * `narrate` and `review` are the interface talking and cost no turn. `pause` is
 * the drill waiting on a person rather than on a model - the tour is meant to be
 * read, and a wall of text that scrolls past unread teaches nothing. `say` is the
 * human's own turn, typed into their editor and sent by their own hand. `turns`
 * is the model talking. `watch` is printed for a person to judge with their eyes;
 * there is no assertion behind it and there is not meant to be one.
 */
export interface DrillStep {
	readonly id: string;
	readonly chapter: DrillChapterId;
	/** Printed a line at a time, before anything else in the step happens. */
	readonly narrate: readonly string[];
	/**
	 * Stop here until the human presses the advance key. The text says what they
	 * are invited to do while it waits - look at something, try a key of their
	 * own - so a pause is an invitation rather than a toll.
	 */
	readonly pause?: string;
	/**
	 * Typed into the editor for the human to send, and the fake model's lookup
	 * key. Globally unique within a language's script, or two steps answer to the
	 * same sentence.
	 */
	readonly say?: string;
	/** One entry per provider callback of the turn this step's line starts. */
	readonly turns?: readonly ScriptedTurn[];
	/** Printed once the turn settles. */
	readonly review?: readonly string[];
	/** What a person should be looking at while it happens. Never asserted. */
	readonly watch?: string;
}

/**
 * A line one of the drill's own agents receives, rather than one the human
 * sends.
 *
 * The stage delegates to a helper, and the helper runs on the same scripted
 * model, so its task text needs an answer too. It shares the lookup table with
 * the steps - same key rule, same uniqueness rule - and is kept out of the step
 * list so the director never offers it to a person.
 */
export interface DrillAside {
	readonly line: string;
	readonly turns: readonly ScriptedTurn[];
}

export interface DrillScript {
	readonly language: DrillLanguage;
	/** Shown while the drill is starting up. */
	readonly title: string;
	/** What the opening notice promises, so nobody starts a tour blind. */
	readonly estimatedMinutes: number;
	readonly steps: readonly DrillStep[];
	readonly asides: readonly DrillAside[];
	readonly reportTitle: string;
	readonly reportColumns: readonly string[];
	/** The one durable sentence of the closing frame; the table beside it is computed. */
	readonly closing: string;
}
