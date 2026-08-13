import type { DrillLanguage } from "../protocol.ts";
import type { ScriptedTurn } from "./beats.ts";
import { tourEn } from "./tour.en.ts";
import { tourZh } from "./tour.zh.ts";
import type { DrillScript, DrillStep } from "./types.ts";

export type { ScriptedBeat, ScriptedTurn } from "./beats.ts";
export { LAST_SPAWNED_AGENT } from "./beats.ts";
export type { DrillScript, DrillStep } from "./types.ts";

const SCRIPTS: Readonly<Record<DrillLanguage, DrillScript>> = { en: tourEn, zh: tourZh };

export function getScript(language: DrillLanguage): DrillScript {
	return SCRIPTS[language];
}

/** The steps of the enabled chapters, in script order. */
export function stepsFor(language: DrillLanguage, chapters: readonly string[]): readonly DrillStep[] {
	const enabled = new Set(chapters);
	return getScript(language).steps.filter((step) => enabled.has(step.chapter));
}

/**
 * The form a line is compared in.
 *
 * The lookup has to survive the round trip through the editor and the message
 * pipeline, and neither promises to preserve the whitespace a script author
 * typed. Collapsing it is enough: what the two ends have in common is the words.
 */
export function normalizeSay(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** What answers a line: a step the human sends, or an aside a sub-agent receives. */
type LineEntry = { readonly id: string; readonly turns: readonly ScriptedTurn[] | undefined };

const tables = new Map<DrillLanguage, ReadonlyMap<string, LineEntry>>();

function tableFor(language: DrillLanguage): ReadonlyMap<string, LineEntry> {
	const existing = tables.get(language);
	if (existing) return existing;
	const script = getScript(language);
	const table = new Map<string, LineEntry>();
	const add = (line: string, entry: LineEntry) => {
		const key = normalizeSay(line);
		const taken = table.get(key);
		if (taken) {
			// Two entries answering to one sentence is not a case with a sensible
			// resolution: the model would replay whichever came first forever.
			throw new Error(`drill script ${language}: ${taken.id} and ${entry.id} share the line "${key}".`);
		}
		table.set(key, entry);
	};
	for (const step of script.steps) {
		if (step.say !== undefined) add(step.say, { id: step.id, turns: step.turns });
	}
	for (const aside of script.asides) {
		add(aside.line, { id: `aside:${normalizeSay(aside.line)}`, turns: aside.turns });
	}
	tables.set(language, table);
	return table;
}

/**
 * The entry a message answers to.
 *
 * Exact first, then the longest key the message ends with. The suffix rule is
 * there for one real case: a message delivered from another agent arrives with
 * an attribution header in front of it (`[Message from …]`), so the stage's
 * helper never sees the bare task line the script wrote. Matching the end rather
 * than the whole leaves the script authored in plain sentences instead of in
 * whatever prefix the message pipeline happens to add.
 */
function entryFor(language: DrillLanguage, line: string): LineEntry | undefined {
	const table = tableFor(language);
	const normalized = normalizeSay(line);
	const exact = table.get(normalized);
	if (exact) return exact;
	let best: { key: string; entry: LineEntry } | undefined;
	for (const [key, entry] of table) {
		if (!normalized.endsWith(key)) continue;
		if (best === undefined || key.length > best.key.length) best = { key, entry };
	}
	return best?.entry;
}

/**
 * What the model does on the `round`-th provider callback of a line's turn.
 *
 * The round index is why the key is not the line alone. Across a tool round trip
 * the last user message never changes - a tool result is its own kind of message -
 * so a table keyed by text alone would replay the same tool call forever.
 */
export function turnForLine(language: DrillLanguage, line: string, round: number): ScriptedTurn | undefined {
	return entryFor(language, line)?.turns?.[round];
}
