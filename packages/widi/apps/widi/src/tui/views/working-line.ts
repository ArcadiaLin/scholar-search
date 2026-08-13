import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandEngine } from "../commands/engine.ts";
import { formatElapsed } from "../format.ts";
import { maintenanceLabel } from "../labels.ts";
import { currentQuip, QUIP_COLUMN_WIDTH, type Quip } from "../quips.ts";
import { type AgentViewState, activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import type { WidiEditor } from "./editor.ts";
import { operationHintKeys, resolveOperationHintDetail } from "./utils/operation-hint.ts";

/** One full `.` `..` `...` cycle. Slower than the spinner, which at 160ms
 * turns three dots into a blur. */
const DOT_PERIOD_MS = 450;
const DOT_WIDTH = 3;
/** Gap between the three segments. */
const SEGMENT_GAP = 2;
/** How far back to look for the running tool. It is written at the end of the
 * timeline; scanning the whole thing every frame buys nothing. */
const RUNNING_TOOL_SCAN = 50;

/**
 * The line that says what is happening right now, in three segments: a quip,
 * the facts behind it, and the keys that apply.
 *
 * The quip column is pinned to the widest line the pool can produce. Anything
 * else and the two segments to its right shift sideways every time the wording
 * changes, which reads as the whole row twitching.
 *
 * Segments drop right to left as the terminal narrows: the keys go first (they
 * are named again under the footer for every state this line does not cover),
 * then the facts lose their subject and keep their duration, then the quip
 * itself degrades to its glyph and the dots.
 */
export class WorkingLineView implements Component {
	private readonly state: TuiApplicationState;
	private readonly engine: CommandEngine;
	private readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;

	constructor(options: {
		readonly state: TuiApplicationState;
		readonly engine: CommandEngine;
		readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
	}) {
		this.state = options.state;
		this.engine = options.engine;
		this.editor = options.editor;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		const now = Date.now();
		const line = currentQuip(agent.quip, now);
		if (!line) return [];

		const quip = renderQuip(line, now);
		const facts = renderFacts(agent, line, now);
		const hint = this.runHint();
		const keys = hint === undefined ? undefined : theme.faint(hint);
		// Ahead of the keys in the drop order: the keys are named again under the
		// footer, and something posted here is not.
		const extra = this.state.segments.texts("workingLine").join(theme.faint(" · "));

		// Text's own left padding is one column; keep one on the right so the
		// line never touches either edge.
		const usable = Math.max(1, width - 2);
		let body = quip.text;
		for (const candidate of [
			joinSegments(quip.text, facts?.full, extra, keys),
			joinSegments(quip.text, facts?.full, extra, undefined),
			joinSegments(quip.text, facts?.full, undefined, undefined),
			joinSegments(quip.text, facts?.compact, undefined, undefined),
			quip.text,
			`${quip.glyph} ${dots(now)}`,
		]) {
			body = candidate;
			if (visibleWidth(candidate) <= usable) break;
		}
		// The blank row is part of this component, not of the transcript above it:
		// it is there only while this line is, so nothing is left behind when the
		// line has nothing to say.
		return ["", ` ${truncateToWidth(body, usable, "…")}`];
	}

	/** The hint only while it is about the run; every other kind stays on the
	 * hint line under the footer. */
	private runHint(): string | undefined {
		const detail = resolveOperationHintDetail({
			state: this.state,
			engine: this.engine,
			editorText: this.editor.getText(),
			editorAutocompleteVisible: this.editor.isShowingAutocomplete(),
			keys: operationHintKeys(),
		});
		return detail && (detail.kind === "run" || detail.kind === "maintenance") ? detail.text : undefined;
	}
}

function joinSegments(
	quip: string,
	facts: string | undefined,
	extra: string | undefined,
	keys: string | undefined,
): string {
	const gap = " ".repeat(SEGMENT_GAP);
	return [quip, facts, extra, keys].filter((part): part is string => part !== undefined && part !== "").join(gap);
}

function dots(now: number): string {
	const count = (Math.floor(now / DOT_PERIOD_MS) % DOT_WIDTH) + 1;
	return `${".".repeat(count)}${" ".repeat(DOT_WIDTH - count)}`;
}

interface RenderedQuip {
	readonly glyph: string;
	readonly text: string;
}

function renderQuip(line: Quip, now: number): RenderedQuip {
	const paint = quipHue(line.state);
	const glyph = theme.bold(paint(quipGlyph(line.state)));
	// Only a state that continues gets a pulse; a moment that already passed
	// would be claiming to still be happening.
	const tail = line.state === "working" || line.state === "poked" ? dots(now) : " ".repeat(DOT_WIDTH);
	const padding = " ".repeat(Math.max(0, QUIP_COLUMN_WIDTH - visibleWidth(line.text)));
	// Italic on the spoken line alone: it is the one part of this row that is a
	// remark rather than a fact.
	return { glyph, text: `${glyph} ${paint(theme.italic(line.text))}${padding}${paint(tail)}` };
}

function quipGlyph(state: Quip["state"]): string {
	switch (state) {
		case "done":
			return "✔ ";
		case "error":
			return "✕ ";
		case "aborted":
		case "aborted-by-human":
		case "aborted-by-extension":
			return "⊘ ";
		default:
			return "⚒ ";
	}
}

/**
 * One hue per state, carried by the glyph, the line and the pulse together, so
 * the row's color alone says how the run is going before a word is read.
 */
function quipHue(state: Quip["state"]): (text: string) => string {
	switch (state) {
		case "working":
			return theme.info;
		case "done":
			return theme.ok;
		case "error":
			return theme.error;
		case "aborted":
		case "aborted-by-human":
		case "aborted-by-extension":
		case "poked":
			return theme.warn;
		default:
			return theme.muted;
	}
}

interface RenderedFacts {
	/** Subject and duration. */
	readonly full: string;
	/** Duration alone: what survives a narrow terminal. */
	readonly compact: string;
}

/**
 * What the quip is talking about. A running agent reports the work in
 * front of it; a run that just ended reports what it cost. Neither is the
 * quip's business, which is why they are separate segments.
 */
function renderFacts(agent: AgentViewState, line: Quip, now: number): RenderedFacts | undefined {
	if (agent.status === "running" && agent.runStartedAt) {
		// Waiting on the model is not a fact worth a segment: the transcript
		// already carries a live "Thinking…" row, and the dots after the quip
		// already say the run has not stopped. Only work with a name reports.
		const subject = agent.maintenance ? maintenanceLabel(agent.maintenance) : activeToolLabel(agent);
		return subject ? facts(subject, formatElapsed(now - Date.parse(agent.runStartedAt))) : undefined;
	}
	const lastRun = agent.lastRun;
	if (!lastRun) return undefined;
	const elapsed = formatElapsed(Date.parse(lastRun.endedAt) - Date.parse(lastRun.startedAt));
	switch (line.state) {
		case "done":
			return facts(lastRun.toolCount > 0 ? `${lastRun.toolCount} tools` : undefined, elapsed);
		case "aborted-by-human":
			return facts("aborted by you", elapsed);
		case "aborted-by-extension":
			return facts("aborted by an extension", elapsed);
		case "aborted":
			return facts("aborted", elapsed);
		default:
			return undefined;
	}
}

function facts(subject: string | undefined, elapsed: string): RenderedFacts {
	// The subject carries the accent the transcript gives a tool call, so the
	// same fact reads the same in both places; the duration stays quieter.
	const compact = theme.muted(elapsed);
	return { full: subject ? `${theme.accent(subject)} ${theme.faint("·")} ${compact}` : compact, compact };
}

/**
 * The tool the agent is inside, or undefined while it is only waiting on the
 * model. Read off the timeline rather than `display.activeToolNames`, which is
 * the set of tools the agent may call, not the one it is calling.
 */
function activeToolLabel(agent: AgentViewState): string | undefined {
	const timeline = agent.timeline;
	const floor = Math.max(0, timeline.length - RUNNING_TOOL_SCAN);
	for (let index = timeline.length - 1; index >= floor; index--) {
		const item = timeline[index];
		if (item?.type === "tool-execution" && (item.status === "running" || item.status === "preparing")) {
			return item.toolName;
		}
	}
	return undefined;
}
