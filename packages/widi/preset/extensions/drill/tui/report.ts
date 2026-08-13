import { EXTENSION_OBSERVED_EVENT_NAMES } from "../../../../apps/widi/src/core/extension/types.ts";
import type { DrillChapterState } from "../protocol.ts";

/**
 * The closing table, counted rather than written down.
 *
 * The point of computing it is that it cannot flatter the product. A hand-written
 * "what WIDI can do" rots the week after it is written and starts lying; a table
 * built from what this run actually drove is as honest next year as today, and it
 * grows a row by itself when core grows an event.
 *
 * The event list is core's own exhaustive record, which is what makes "this never
 * fired" a fact rather than an omission.
 */

/** The control surfaces the tour is in a position to drive. */
const AREAS = [
	"editor",
	"chat",
	"notices",
	"selectorDock",
	"agentStrip",
	"workingLine",
	"footer",
	"commands",
	"stagedInput",
	"queuedInput",
	"humanRequests",
] as const;

export interface ReportInput {
	/** Observed event names the stage's runtime reported. */
	readonly seen: ReadonlySet<string>;
	readonly exercised: ReadonlySet<string>;
	readonly chapters: readonly DrillChapterState[];
	readonly aborted: boolean;
}

export function buildReportRows(input: ReportInput): string[][] {
	const events = Object.keys(EXTENSION_OBSERVED_EVENT_NAMES).sort();
	const missed = events.filter((name) => !input.seen.has(name));
	const on = input.chapters.filter((chapter) => chapter.enabled).map((chapter) => chapter.id);
	const off = input.chapters.filter((chapter) => !chapter.enabled).map((chapter) => chapter.id);

	return [
		...AREAS.map((area) => [area, input.exercised.has(area) ? "exercised" : "not this run"]),
		["core events", `${events.length - missed.length} of ${events.length} fired`],
		["never fired", missed.length === 0 ? "none" : missed.join(", ")],
		["chapters on", on.length === 0 ? "none" : on.join(", ")],
		["chapters off", off.length === 0 ? "none" : off.join(", ")],
		["run", input.aborted ? "stopped early" : "completed"],
	];
}
