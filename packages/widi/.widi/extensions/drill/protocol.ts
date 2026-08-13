/**
 * The whole contract between drill's two halves.
 *
 * The halves never import each other: the core half runs inside an agent
 * runtime, the TUI half runs in the terminal process outside every agent, and
 * the only thing they share is this file plus the script. Everything they say
 * to each other goes through `emitExtensionEvent` under a name declared here.
 *
 * Payloads are declared as type aliases rather than interfaces on purpose: an
 * object-literal type alias is assignable to the bus's `JsonValue`, an
 * interface is not, and that is what keeps the emit sites free of casts.
 *
 * Every payload has a reader beside it. A reader parses rather than validates -
 * it answers `undefined` for a shape it cannot use instead of throwing - because
 * a malformed envelope means the other half is a different build, and a drill
 * that crashes on that teaches nobody anything.
 */

export const DRILL_EXTENSION_ID = "drill";

/** The fake provider, and the model reference the stage agent runs on. */
export const DRILL_PROVIDER = "drill";
export const DRILL_MODEL_ID = "scripted";
export const DRILL_MODEL_REFERENCE = `${DRILL_PROVIDER}/${DRILL_MODEL_ID}`;

export const DRILL_EVENT = {
	/** TUI -> every core runtime: who is out there, and which chapters are on. */
	hello: "drill:hello",
	runtime: "drill:runtime",
	/**
	 * TUI -> the visible agent's runtime alone: put this agent into rehearsal.
	 *
	 * The drill runs on the agent the person is already on. It does not build one
	 * of its own: `/drill` from a cold start has already materialised an empty
	 * agent, and moving the human to a second one would teach them a switch that
	 * has nothing to do with what they came to learn.
	 */
	begin: "drill:begin",
	ready: "drill:ready",
	failed: "drill:failed",
	/** core -> TUI: this observed event name has now been seen at least once. */
	observed: "drill:observed",
	/** core -> TUI: the agent went idle, so the beat is over. */
	turnSettled: "drill:turn-settled",
	/** TUI -> the drilling agent's runtime: publish the closing table. */
	report: "drill:report",
	/** TUI -> the drilling agent's runtime: put the model and tools back. */
	end: "drill:end",
} as const;

export type DrillLanguage = "en" | "zh";

/**
 * One chapter, and for now the only one.
 *
 * The five developer chapters the design sketched were declared before anything
 * filled them, and a division that registers nothing is a switch with no wire
 * behind it. They come back when they have steps.
 */
export type DrillChapterId = "tour";

export type DrillChapterState = { readonly id: string; readonly enabled: boolean };

export type DrillRuntimePayload = { readonly agentId: string; readonly chapters: readonly DrillChapterState[] };

export type DrillBeginPayload = { readonly language: DrillLanguage };

export type DrillReadyPayload = { readonly agentId: string };

export type DrillFailedPayload = { readonly reason: string };

export type DrillObservedPayload = { readonly agentId: string; readonly event: string };

export type DrillTurnSettledPayload = { readonly agentId: string };

export type DrillReportPayload = {
	readonly agentId: string;
	readonly title: string;
	readonly columns: readonly string[];
	readonly rows: readonly (readonly string[])[];
};

export type DrillEndPayload = { readonly agentId: string };

type UnknownRecord = { readonly [key: string]: unknown };

function record(payload: unknown): UnknownRecord | undefined {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload)
		? (payload as UnknownRecord)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textList(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

export function readRuntime(payload: unknown): DrillRuntimePayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	if (agentId === undefined || !Array.isArray(fields?.chapters)) return undefined;
	const chapters: DrillChapterState[] = [];
	for (const entry of fields.chapters) {
		const chapter = record(entry);
		const id = text(chapter?.id);
		if (id === undefined) return undefined;
		chapters.push({ id, enabled: chapter?.enabled === true });
	}
	return { agentId, chapters };
}

export function readBegin(payload: unknown): DrillBeginPayload | undefined {
	const language = record(payload)?.language;
	return language === "en" || language === "zh" ? { language } : undefined;
}

export function readReady(payload: unknown): DrillReadyPayload | undefined {
	const agentId = text(record(payload)?.agentId);
	return agentId === undefined ? undefined : { agentId };
}

export function readFailed(payload: unknown): DrillFailedPayload | undefined {
	const reason = text(record(payload)?.reason);
	return reason === undefined ? undefined : { reason };
}

export function readObserved(payload: unknown): DrillObservedPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	const event = text(fields?.event);
	return agentId === undefined || event === undefined ? undefined : { agentId, event };
}

export function readTurnSettled(payload: unknown): DrillTurnSettledPayload | undefined {
	const agentId = text(record(payload)?.agentId);
	return agentId === undefined ? undefined : { agentId };
}

export function readReport(payload: unknown): DrillReportPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	const title = text(fields?.title);
	const columns = textList(fields?.columns);
	if (agentId === undefined || title === undefined || columns === undefined) return undefined;
	if (!Array.isArray(fields?.rows)) return undefined;
	const rows: string[][] = [];
	for (const entry of fields.rows) {
		const row = textList(entry);
		if (row === undefined || row.length !== columns.length) return undefined;
		rows.push([...row]);
	}
	return { agentId, title, columns, rows };
}

export function readEnd(payload: unknown): DrillEndPayload | undefined {
	const agentId = text(record(payload)?.agentId);
	return agentId === undefined ? undefined : { agentId };
}
