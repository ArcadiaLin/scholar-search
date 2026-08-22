import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../../../../packages/widi/apps/widi/src/tui/extension-host/drawing.ts";
import type { WidiTuiExtensionApi } from "../../../../../packages/widi/apps/widi/src/tui/extension-host/index.ts";
import type { AnswerPoolEntry, AnswerPoolSnapshot } from "../core/answer-pool.ts";

type Theme = WidiTuiExtensionApi["theme"];

/** Rows the panel spends on its own chrome: the title, two rules, the key hint. */
const CHROME_ROWS = 4;
/** Rows left to the terminal around the overlay, matching the `margin` it opens with. */
const TERMINAL_MARGIN_ROWS = 4;
const MIN_BODY_ROWS = 3;
const FALLBACK_TERMINAL_ROWS = 24;

/**
 * The answer pool as a page of its own.
 *
 * Every paper is rendered whole - the full `why`, never a preview - because the
 * pool is the episode's answer and the `why` fields are what carry its structure
 * (`core/answer-pool.ts`). A panel that truncated them would show the citations
 * and hide the argument, which is the half a reader opens this for.
 *
 * It scrolls itself rather than mounting a `ScrollView`. Overlays are composited
 * by truncating to `maxHeight` and never go through the layout engine, so a
 * `ScrollView` there is handed a viewport height of zero and renders nothing.
 */
export class AnswerPoolPanel implements Component {
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private snapshot: AnswerPoolSnapshot | undefined;
	private agentLabel: string;
	private scrollTop = 0;
	private cachedWidth = -1;
	private cachedFor: AnswerPoolSnapshot | undefined;
	private cachedBody: string[] = [];

	constructor(options: {
		readonly theme: Theme;
		readonly agentLabel: string;
		readonly snapshot: AnswerPoolSnapshot | undefined;
		readonly onClose: () => void;
	}) {
		this.theme = options.theme;
		this.agentLabel = options.agentLabel;
		this.snapshot = options.snapshot;
		this.onClose = options.onClose;
	}

	/**
	 * Take a newer pool while the panel is open. The scroll position is kept: a
	 * paper landing at the bottom must not yank the reader away from the one they
	 * are in the middle of.
	 */
	update(snapshot: AnswerPoolSnapshot, agentLabel: string): void {
		this.snapshot = snapshot;
		this.agentLabel = agentLabel;
		this.cachedFor = undefined;
	}

	invalidate(): void {
		this.cachedFor = undefined;
		this.cachedWidth = -1;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const page = Math.max(1, this.bodyRows() - 1);
		// Existing configurable actions rather than raw key comparisons, so a user
		// who rebound the arrows in keybindings.json moves this panel with them.
		if (keys.matches(data, "tui.editor.cursorRight")) {
			this.onClose();
			return;
		}
		if (keys.matches(data, "tui.editor.cursorUp")) this.scrollBy(-1);
		else if (keys.matches(data, "tui.editor.cursorDown")) this.scrollBy(1);
		else if (keys.matches(data, "tui.editor.pageUp")) this.scrollBy(-page);
		else if (keys.matches(data, "tui.editor.pageDown")) this.scrollBy(page);
		else if (keys.matches(data, "tui.editor.cursorLineStart")) this.scrollTop = 0;
		else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.scrollTop = Number.MAX_SAFE_INTEGER;
	}

	render(width: number): string[] {
		const body = this.body(width);
		const rows = this.bodyRows();
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, body.length - rows)));
		const window = body.slice(this.scrollTop, this.scrollTop + rows);
		while (window.length < rows) window.push("");
		const rule = this.theme.border("─".repeat(Math.max(0, width)));
		return [this.titleLine(width, body.length, rows), rule, ...window, rule, this.hintLine(width, body.length, rows)];
	}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	/**
	 * How many rows of pool the panel can show. The overlay is composited against
	 * the real terminal, so its height comes from the terminal and not from the
	 * layout engine, which never runs for an overlay.
	 */
	private bodyRows(): number {
		const rows = process.stdout.rows ?? FALLBACK_TERMINAL_ROWS;
		return Math.max(MIN_BODY_ROWS, rows - TERMINAL_MARGIN_ROWS - CHROME_ROWS);
	}

	private titleLine(width: number, total: number, rows: number): string {
		const snapshot = this.snapshot;
		const count = snapshot?.papers.length ?? 0;
		const parts = [`Answer pool · ${this.agentLabel}`, `${count} ${count === 1 ? "paper" : "papers"}`];
		if (snapshot?.updatedAt) parts.push(snapshot.updatedAt.replace("T", " ").replace(/\.\d+Z$/u, "Z"));
		if (total > rows) parts.push(`${Math.min(100, Math.round(((this.scrollTop + rows) / total) * 100))}%`);
		return truncateToWidth(this.theme.title(this.theme.bold(parts.join("  ·  "))), width, "…");
	}

	private hintLine(width: number, total: number, rows: number): string {
		const keys = total > rows ? ["↑/↓ scroll", "PgUp/PgDn page", "→ back"] : ["→ back"];
		return truncateToWidth(this.theme.dim(keys.join("   ")), width, "…");
	}

	private body(width: number): string[] {
		if (this.cachedWidth === width && this.cachedFor === this.snapshot) return this.cachedBody;
		this.cachedWidth = width;
		this.cachedFor = this.snapshot;
		this.cachedBody = this.buildBody(width);
		return this.cachedBody;
	}

	private buildBody(width: number): string[] {
		const snapshot = this.snapshot;
		if (snapshot === undefined) {
			return [
				this.theme.dim("No answer pool for this agent yet."),
				"",
				this.theme.dim("The pool fills as the searching agent calls update_answer_pool."),
			];
		}
		if (snapshot.papers.length === 0) {
			return [
				this.theme.dim("The pool is empty."),
				"",
				this.theme.dim("An episode that ends with an empty pool has produced no answer at all."),
			];
		}
		const lines: string[] = [];
		if (snapshot.note) {
			// The agent's framing of the pool as a whole, which is not any one
			// paper's `why` and would be lost if only the cards were shown.
			for (const line of wrapTextWithAnsi(snapshot.note, Math.max(8, width))) {
				lines.push(this.theme.dim(line));
			}
			lines.push("");
		}
		snapshot.papers.forEach((entry, index) => {
			lines.push(...this.card(entry, index + 1, width));
			lines.push("");
		});
		lines.pop();
		return lines;
	}

	/** One paper, framed like a transcript row so the pool reads as a list of things. */
	private card(entry: AnswerPoolEntry, position: number, width: number): string[] {
		const frame = Math.max(12, width);
		const inner = frame - 4;
		const heading = ` [${position}] ${entry.canonicalId} `;
		const headingWidth = visibleWidth(heading);
		const filler = Math.max(0, frame - 3 - headingWidth);
		const lines = [this.theme.border(`┌─${this.theme.accent(heading)}${"─".repeat(filler)}┐`)];

		const push = (text: string, paint: (value: string) => string): void => {
			for (const line of wrapTextWithAnsi(text, inner)) {
				const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
				lines.push(`${this.theme.border("│")} ${paint(line)}${pad} ${this.theme.border("│")}`);
			}
		};

		push(entry.title || "(no title)", (line) => this.theme.bold(line));
		const meta = [...(entry.authors.length > 0 ? [entry.authors.join(", ")] : [])];
		if (entry.year !== null) meta.push(String(entry.year));
		if (entry.venue) meta.push(entry.venue);
		if (meta.length > 0) push(meta.join(" · "), (line) => this.theme.dim(line));
		if (entry.why) {
			push("", (line) => line);
			push(entry.why, (line) => line);
		}
		lines.push(this.theme.border(`└${"─".repeat(Math.max(0, frame - 2))}┘`));
		return lines;
	}
}
