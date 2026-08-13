import { type Component, getKeybindings, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type HumanQuestionAnswer,
	type HumanRequestEnvelope,
	type HumanResponse,
	type NormalizedHumanRequestOption,
	normalizeHumanRequestOptions,
} from "../../core/human-request.ts";
import { boundedText, singleLine } from "../format.ts";
import { matchRequestOptionIndex } from "../keybindings.ts";
import { clearDockedFocus, setDockedFocus, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

const FREE_INPUT_VALUE = "\x00free-input";
const FREE_INPUT_LABEL = "Chat about this…";
const MAX_VISIBLE_OPTIONS = 8;
const SUBMIT_ACTIONS = ["Submit", "Cancel"] as const;

/**
 * Whether this request's answers wait for the Submit tab.
 *
 * A decision this layer makes, not the asker's: nothing in a request says how
 * much ceremony its answer deserves, and the side that posed the question
 * cannot see the panel.
 *
 * A tool asking is a turn standing still until the answer arrives, so it gets
 * the pass where a misclick can still be taken back - `ask_human` is the only
 * one today, and the tool-scoped source is how it says so. A batch is several
 * answers committed together and has nowhere else to commit them; a
 * multi-select is not finished until the human says it is. Everything else -
 * an extension asking, the auth flow asking - answers on the spot, and picks
 * the kind that suits it.
 */
function defersAnswers(request: HumanRequestEnvelope): boolean {
	return request.source.kind === "tool" || request.kind === "questions" || request.kind === "multi-select";
}

/**
 * One deferred question shown as its own tab. A confirm request becomes a
 * two-option single question; a select/multi-select request becomes a single
 * question; a kind="questions" request becomes several. All selections stay
 * provisional here until the human commits them on the Submit tab.
 */
interface QuestionState {
	readonly kind: "confirm" | "select" | "multi-select";
	/** Empty for a single-question entry (the entry title already heads it). */
	readonly title: string;
	readonly header?: string;
	readonly message?: string;
	readonly options: NormalizedHumanRequestOption[];
	cursor: number;
	/** Chosen value for confirm/select (includes a free-text literal). */
	single?: string;
	/** Chosen values for multi-select. */
	readonly multi: Set<string>;
	/** Committed free-text answer, when the free-input option was used. */
	freeValue?: string;
	/** Inline free-text editor, live only while editing the free option. */
	freeInput?: Input;
	editing: boolean;
}

interface PendingEntry {
	readonly request: HumanRequestEnvelope;
	readonly signal?: AbortSignal;
	readonly resolve: (response: HumanResponse) => void;
	readonly reject: (error: Error) => void;
	abortListener?: () => void;
	settled: boolean;
	/** choice: questions with options. input: an immediate free-text row. */
	mode: "choice" | "input";
	/** Choice answers wait for the Submit tab; see defersAnswers. */
	defers: boolean;
	readonly questions: QuestionState[];
	input?: Input;
}

type Tab =
	| { readonly kind: "question"; readonly entry: number; readonly question: number }
	| { readonly kind: "input"; readonly entry: number }
	| { readonly kind: "submit" };

/**
 * Extra lines shown inside a pending request, under its message and above its
 * options. Returning nothing keeps the presenter out of a request it has
 * nothing to say about.
 */
export type HumanRequestPresenter = (request: HumanRequestEnvelope, width: number) => readonly string[] | undefined;

/** The slice of TUI the menu needs; kept minimal so tests can fake it. */
export interface HumanRequestMenuHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

/**
 * Docked human-request host. Pending choice requests (confirm/select/
 * multi-select and kind="questions" batches) are laid out as a kimi-style
 * panel: every question is a tab, selections are provisional and revisable,
 * left/right/tab switch tabs, and a trailing Submit tab commits every deferred
 * answer at once. Free-form input/custom requests keep an immediate input row
 * outside the Submit flow. Multiple requests — including ones from different
 * background agents — share the same tab strip and Submit.
 */
export class HumanRequestMenu implements Component {
	focused = false;
	private readonly host: HumanRequestMenuHost;
	private readonly state: TuiApplicationState;
	private readonly resolveAgentLabel: (agentId: string | undefined) => string;
	private readonly restoreFocus: () => void;
	private readonly entries: PendingEntry[] = [];
	private readonly presenters = new Set<HumanRequestPresenter>();
	private focusedTab = 0;
	private submitActionIndex = 0;
	private opened = false;
	private closed = false;

	constructor(options: {
		readonly host: HumanRequestMenuHost;
		readonly state: TuiApplicationState;
		readonly resolveAgentLabel: (agentId: string | undefined) => string;
		readonly restoreFocus: () => void;
	}) {
		this.host = options.host;
		this.state = options.state;
		this.resolveAgentLabel = options.resolveAgentLabel;
		this.restoreFocus = options.restoreFocus;
	}

	get isOpen(): boolean {
		return this.opened && this.entries.length > 0;
	}

	get pendingCount(): number {
		return this.entries.length;
	}

	/** The requests waiting on an answer right now, in arrival order. */
	get pending(): readonly HumanRequestEnvelope[] {
		return this.entries.map((entry) => entry.request);
	}

	/**
	 * Let something outside the panel put its own lines inside a request - the
	 * diff an approval is about, the file a question names. Returns the detach.
	 */
	present(presenter: HumanRequestPresenter): () => void {
		this.presenters.add(presenter);
		this.host.requestRender();
		return () => {
			this.presenters.delete(presenter);
			this.host.requestRender();
		};
	}

	request(request: HumanRequestEnvelope, signal?: AbortSignal): Promise<HumanResponse> {
		if (this.closed) {
			return Promise.reject(new Error("TUI human request host is closed."));
		}
		return new Promise((resolve, reject) => {
			const entry = this.buildEntry(request, signal, resolve, reject);
			if (signal?.aborted) {
				entry.settled = true;
				reject(new Error("Human request was aborted."));
				return;
			}
			if (signal) {
				entry.abortListener = () => this.abort(entry);
				signal.addEventListener("abort", entry.abortListener, { once: true });
			}
			this.entries.push(entry);
			// Provisional requests (e.g. the OAuth manual-code fallback) race
			// another completion path. Auto-opening them as a focus-stealing
			// modal invites a reflexive Esc, which resolves the prompt with
			// undefined and aborts the whole flow — leaving the user with a
			// dead authorization link. They stay in the background; the caller
			// withdraws them when the flow settles.
			const foreground =
				(request.agentId === undefined || request.agentId === this.state.activeAgentId) && request.provisional !== true;
			if (this.opened) {
				this.host.requestRender();
			} else if (foreground) {
				this.openEntry(this.entries.length - 1);
			} else {
				// Background request: raise no focus; the pending hint line and the
				// agent strip attention are the only visible signals.
				this.host.requestRender();
			}
		});
	}

	/** app.request.open: open the panel focused on the most recent request. */
	openLatest(): void {
		if (this.entries.length === 0) return;
		this.openEntry(this.entries.length - 1);
	}

	cancelRequest(requestId: string): void {
		const entry = this.entries.find((candidate) => candidate.request.id === requestId);
		if (entry) this.abort(entry);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const pending = [...this.entries];
		this.entries.length = 0;
		this.opened = false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			this.detachAbort(entry);
			entry.reject(new Error("TUI is shutting down."));
		}
	}

	// ── Input ────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.interrupt")) {
			this.dismissAll();
			return;
		}
		const tab = this.currentTab();
		if (!tab) return;
		if (tab.kind === "submit") {
			this.handleSubmitInput(data);
			return;
		}
		const entry = this.entries[tab.entry];
		if (!entry) return;
		if (tab.kind === "input") {
			this.handleInputRow(entry, data);
			return;
		}
		const question = entry.questions[tab.question];
		if (question) this.handleQuestionInput(entry, question, data);
	}

	private handleQuestionInput(entry: PendingEntry, question: QuestionState, data: string): void {
		const keybindings = getKeybindings();
		if (question.editing) {
			this.handleFreeEditInput(question, data);
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveCursor(question, -1);
			this.host.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.moveCursor(question, 1);
			this.host.requestRender();
			return;
		}
		if (this.switchTab(data)) return;
		const index = matchRequestOptionIndex(data);
		if (index !== undefined && index < question.options.length) {
			this.activateOption(entry, question, index);
			this.host.requestRender();
			return;
		}
		if (question.kind === "multi-select" && keybindings.matches(data, "app.request.toggle")) {
			this.activateOption(entry, question, question.cursor);
			this.host.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.activateOption(entry, question, question.cursor);
			this.host.requestRender();
		}
	}

	private handleFreeEditInput(question: QuestionState, data: string): void {
		const keybindings = getKeybindings();
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.down") ||
			this.switchTab(data)
		) {
			// Leaving the field keeps the draft but does not commit an answer.
			question.editing = false;
			this.host.requestRender();
			return;
		}
		const input = question.freeInput;
		if (input) {
			input.focused = this.focused;
			input.handleInput(data);
		}
		this.host.requestRender();
	}

	private handleInputRow(entry: PendingEntry, data: string): void {
		if (this.switchTab(data)) return;
		const input = entry.input;
		if (input) {
			input.focused = this.focused;
			input.handleInput(data);
		}
		this.host.requestRender();
	}

	private handleSubmitInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.submitActionIndex = (this.submitActionIndex + SUBMIT_ACTIONS.length - 1) % SUBMIT_ACTIONS.length;
			this.host.requestRender();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.submitActionIndex = (this.submitActionIndex + 1) % SUBMIT_ACTIONS.length;
			this.host.requestRender();
			return;
		}
		if (this.switchTab(data)) return;
		const index = matchRequestOptionIndex(data);
		if (index !== undefined && index < SUBMIT_ACTIONS.length) {
			this.executeSubmitAction(index);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.executeSubmitAction(this.submitActionIndex);
		}
	}

	/** Consume a left/right/tab tab switch; returns true when it did. */
	private switchTab(data: string): boolean {
		const keybindings = getKeybindings();
		const tabs = this.tabs();
		if (tabs.length <= 1) return false;
		if (keybindings.matches(data, "app.request.previous")) {
			this.gotoTab(this.focusedTab - 1);
			return true;
		}
		if (keybindings.matches(data, "app.request.next")) {
			this.gotoTab(this.focusedTab + 1);
			return true;
		}
		return false;
	}

	private moveCursor(question: QuestionState, delta: number): void {
		const total = question.options.length;
		if (total === 0) return;
		question.cursor = (question.cursor + delta + total) % total;
	}

	private activateOption(entry: PendingEntry, question: QuestionState, index: number): void {
		const option = question.options[index];
		if (!option) return;
		question.cursor = index;
		if (option.value === FREE_INPUT_VALUE) {
			this.enterFreeInput(entry, question);
			return;
		}
		if (question.kind === "multi-select") {
			if (question.multi.has(option.value)) question.multi.delete(option.value);
			else question.multi.add(option.value);
			return;
		}
		question.single = option.value;
		question.freeValue = undefined;
		this.advanceAfterSingle(entry);
	}

	private enterFreeInput(entry: PendingEntry, question: QuestionState): void {
		question.editing = true;
		const input = new Input();
		input.setValue(question.freeValue ?? "");
		input.onSubmit = (value) => this.commitFreeInput(entry, question, value);
		question.freeInput = input;
	}

	private commitFreeInput(entry: PendingEntry, question: QuestionState, rawValue: string): void {
		const value = rawValue.trim();
		question.editing = false;
		if (value.length === 0) {
			question.freeInput = undefined;
			this.host.requestRender();
			return;
		}
		question.freeValue = value;
		// A multi-select's free answer joins its selections; a single answer
		// replaces whatever option was picked.
		if (question.kind === "multi-select") question.multi.add(value);
		else question.single = value;
		question.freeInput = undefined;
		this.advanceAfterSingle(entry);
		this.host.requestRender();
	}

	/**
	 * Move to the next unanswered question, or the Submit tab when none. An
	 * entry that does not defer has no Submit tab to move to and is finished
	 * here instead, as soon as its one question has an answer.
	 */
	private advanceAfterSingle(entry: PendingEntry): void {
		const tabs = this.tabs();
		for (let i = this.focusedTab + 1; i < tabs.length; i++) {
			const tab = tabs[i];
			if (tab?.kind === "question") {
				const question = this.entries[tab.entry]?.questions[tab.question];
				if (question && !this.isAnswered(question)) {
					this.focusedTab = i;
					return;
				}
			}
		}
		if (!entry.defers) {
			if (entry.questions.every((question) => this.isAnswered(question))) {
				this.finish(entry, this.assembleResponse(entry));
			}
			return;
		}
		const submit = tabs.findIndex((tab) => tab.kind === "submit");
		if (submit >= 0) this.focusedTab = submit;
	}

	private executeSubmitAction(index: number): void {
		if (SUBMIT_ACTIONS[index] === "Cancel") {
			this.dismissAll();
			return;
		}
		this.submitAll();
	}

	private submitAll(): void {
		for (const entry of [...this.entries]) {
			if (!this.awaitsSubmit(entry)) continue;
			this.finish(entry, this.assembleResponse(entry));
		}
	}

	private dismissAll(): void {
		for (const entry of [...this.entries]) {
			this.finish(entry, fallbackResponse(entry.request));
		}
	}

	private assembleResponse(entry: PendingEntry): HumanResponse {
		if (entry.request.kind === "questions") {
			return { kind: "questions", answers: entry.questions.map((question) => questionAnswer(question)) };
		}
		const question = entry.questions[0];
		if (!question) return fallbackResponse(entry.request);
		if (question.kind === "confirm") {
			return { kind: "confirm", confirmed: question.single === "yes" };
		}
		if (question.kind === "multi-select") {
			return { kind: "multi-select", values: question.multi.size > 0 ? this.selectedValues(question) : undefined };
		}
		return { kind: "select", value: question.single };
	}

	private selectedValues(question: QuestionState): string[] {
		return question.options.filter((option) => question.multi.has(option.value)).map((option) => option.value);
	}

	private isAnswered(question: QuestionState): boolean {
		return question.kind === "multi-select" ? question.multi.size > 0 : question.single !== undefined;
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	invalidate(): void {
		for (const entry of this.entries) {
			entry.input?.invalidate();
			for (const question of entry.questions) question.freeInput?.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.entries.length === 0) return [];
		if (!this.opened) return this.renderPendingHint(width);
		const tab = this.currentTab();
		if (!tab) return [];
		const lines: string[] = ["", this.rule(width)];
		this.pushTabStrip(lines, width);
		lines.push("");
		if (tab.kind === "submit") {
			this.pushSubmitView(lines, width);
		} else {
			const entry = this.entries[tab.entry];
			if (entry && tab.kind === "input") this.pushInputView(lines, entry, width);
			else if (entry && tab.kind === "question") {
				const question = entry.questions[tab.question];
				if (question) this.pushQuestionView(lines, entry, question, width);
			}
		}
		lines.push(this.rule(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private pushTabStrip(lines: string[], width: number): void {
		const chips: string[] = [];
		this.tabs().forEach((tab, index) => {
			const active = index === this.focusedTab;
			if (tab.kind === "submit") {
				chips.push(active ? theme.selection("● Submit") : theme.dim("○ Submit"));
				return;
			}
			const entry = this.entries[tab.entry];
			if (!entry) return;
			if (tab.kind === "input") {
				const label = `${this.resolveAgentLabel(entry.request.agentId)} · input`;
				chips.push(active ? theme.selection(`● ${singleLine(label, 40)}`) : theme.dim(`○ ${singleLine(label, 40)}`));
				return;
			}
			const question = entry.questions[tab.question];
			if (!question) return;
			const label = singleLine(question.header ?? question.title, 32);
			if (active) chips.push(theme.selection(`● ${label}`));
			else if (this.isAnswered(question)) chips.push(theme.ok(`✓ ${label}`));
			else chips.push(theme.dim(`○ ${label}`));
		});
		const row = chips.join(theme.dim("  "));
		lines.push(visibleWidth(row) > width ? truncateToWidth(row, Math.max(1, width - 1), "…") : row);
	}

	private pushQuestionView(lines: string[], entry: PendingEntry, question: QuestionState, width: number): void {
		this.pushHeading(lines, entry, width);
		// For a batch, each question carries its own title line; a single-question
		// entry is already headed by the request title.
		if (entry.questions.length > 1 && question.title) {
			lines.push(theme.title(` ? ${singleLine(question.title, 200)}`));
		}
		const message = question.message ?? entry.request.message;
		if (message) {
			for (const line of boundedText(message, { maxLines: 12, maxCharacters: 2_000 }).split("\n")) {
				lines.push(theme.dim(truncateToWidth(line, Math.max(1, width - 2), "…")));
			}
		}
		this.pushPresented(lines, entry, width);
		lines.push("");
		const start = windowStart(question.cursor, question.options.length);
		const end = Math.min(start + MAX_VISIBLE_OPTIONS, question.options.length);
		for (let i = start; i < end; i++) {
			const option = question.options[i];
			if (option) {
				lines.push(...this.renderOptionRow(question, option, i, width));
			}
		}
		if (start > 0 || end < question.options.length) {
			lines.push(theme.faint(`   (${question.cursor + 1}/${question.options.length})`));
		}
		lines.push("");
		const numbers = question.options.length <= 1 ? "1" : `1-${question.options.length}`;
		const pick = question.kind === "multi-select" ? "space/# toggle" : `${numbers} choose`;
		lines.push(theme.dim(`↑/↓ move · ${pick} · ←/→ tabs · esc cancel`));
	}

	private renderOptionRow(
		question: QuestionState,
		option: NormalizedHumanRequestOption,
		index: number,
		width: number,
	): string[] {
		const isFreeInput = option.value === FREE_INPUT_VALUE;
		const isCursor = index === question.cursor;
		const isSelected =
			question.kind === "multi-select" ? question.multi.has(option.value) : question.single === option.value;
		let prefix: string;
		// The free row opens an editor rather than toggling a box, so it keeps the
		// arrow form even in a multi-select.
		if (question.kind === "multi-select" && !isFreeInput) {
			prefix = `  [${isSelected ? "✓" : " "}] `;
		} else {
			prefix = isCursor ? `  → [${index + 1}] ` : `    [${index + 1}] `;
		}
		const tone =
			isSelected && isCursor
				? (text: string) => theme.bold(theme.ok(text))
				: isSelected
					? theme.ok
					: isCursor
						? theme.selection
						: theme.dim;
		let label = option.label;
		if (isFreeInput && question.editing && isCursor) {
			const value = question.freeInput?.getValue() ?? "";
			label = `${option.label}: ${value}█`;
		} else if (isFreeInput && question.freeValue) {
			label = `${option.label}: ${question.freeValue}`;
		}
		const room = Math.max(1, width - visibleWidth(prefix) - 1);
		const rows = [tone(`${prefix}${truncateToWidth(singleLine(label, 400), room, "…")}`)];
		if (option.description) {
			rows.push(
				theme.muted(`      ${truncateToWidth(singleLine(option.description, 400), Math.max(1, width - 7), "…")}`),
			);
		}
		return rows;
	}

	private pushSubmitView(lines: string[], width: number): void {
		lines.push(theme.bold(" Review your answers before submit"));
		if (this.hasUnanswered()) {
			lines.push(theme.warn("  Some questions are still unanswered."));
		}
		lines.push("");
		for (const entry of this.entries) {
			if (!this.awaitsSubmit(entry)) continue;
			for (const question of entry.questions) {
				const title = question.title || entry.request.title;
				lines.push(`  ${theme.dim("Q")} ${truncateToWidth(singleLine(title, 400), Math.max(1, width - 5), "…")}`);
				const answer = this.answerSummary(question);
				lines.push(
					answer === undefined
						? `    ${theme.dim("→ Not answered")}`
						: `    ${theme.selection("→")} ${truncateToWidth(singleLine(answer, 400), Math.max(1, width - 7), "…")}`,
				);
			}
		}
		lines.push("");
		SUBMIT_ACTIONS.forEach((label, index) => {
			const active = index === this.submitActionIndex;
			lines.push(active ? theme.selection(`  → [${index + 1}] ${label}`) : theme.dim(`    [${index + 1}] ${label}`));
		});
		lines.push("");
		lines.push(theme.dim("↑/↓ select · 1/2 choose · ↵ confirm · ←/→ tabs"));
	}

	private pushInputView(lines: string[], entry: PendingEntry, width: number): void {
		this.pushHeading(lines, entry, width);
		if (entry.request.message) {
			for (const line of boundedText(entry.request.message, { maxLines: 12, maxCharacters: 2_000 }).split("\n")) {
				lines.push(theme.dim(truncateToWidth(line, Math.max(1, width - 2), "…")));
			}
		}
		this.pushPresented(lines, entry, width);
		if (entry.request.placeholder && !entry.input?.getValue()) {
			lines.push(theme.dim(singleLine(entry.request.placeholder, 200)));
		}
		const input = entry.input;
		if (input) {
			input.focused = this.focused;
			lines.push(...input.render(Math.max(8, width - 2)));
		}
		lines.push(theme.dim("enter submit · ←/→ tabs · esc cancel"));
	}

	/**
	 * Whatever the presenters have to say about this request, each block set off
	 * by a blank line. The panel truncates every line to width at the end, so a
	 * presenter that overruns costs the panel nothing.
	 */
	private pushPresented(lines: string[], entry: PendingEntry, width: number): void {
		for (const presenter of this.presenters) {
			const block = presenter(entry.request, Math.max(8, width - 2));
			if (!block || block.length === 0) continue;
			lines.push("", ...block);
		}
	}

	private pushHeading(lines: string[], entry: PendingEntry, width: number): void {
		const agentLabel = this.resolveAgentLabel(entry.request.agentId);
		const provisional = entry.request.provisional ? " · provisional" : "";
		lines.push(
			truncateToWidth(
				`${theme.title(singleLine(entry.request.title, 200))}${theme.dim(
					` · agent: ${agentLabel} · ${entry.request.kind}${provisional}`,
				)}`,
				Math.max(1, width - 2),
				"…",
			),
		);
	}

	private rule(width: number): string {
		return theme.border("─".repeat(Math.max(1, width)));
	}

	private renderPendingHint(width: number): string[] {
		const keys = getKeybindings().getKeys("app.request.open");
		const count = this.entries.length;
		const hint = `${count} pending request${count > 1 ? "s" : ""}${keys[0] ? ` · ${keys[0]} to answer` : ""}`;
		return [truncateToWidth(theme.warn(`! ${hint}`), width, "…")];
	}

	private answerSummary(question: QuestionState): string | undefined {
		if (question.kind === "multi-select") {
			if (question.multi.size === 0) return undefined;
			return question.options
				.filter((option) => question.multi.has(option.value))
				.map((option) => option.label)
				.join(", ");
		}
		if (question.single === undefined) return undefined;
		if (question.freeValue !== undefined) return question.freeValue;
		return question.options.find((option) => option.value === question.single)?.label ?? question.single;
	}

	private hasUnanswered(): boolean {
		return this.entries.some(
			(entry) => this.awaitsSubmit(entry) && entry.questions.some((question) => !this.isAnswered(question)),
		);
	}

	private awaitsSubmit(entry: PendingEntry): boolean {
		return entry.mode === "choice" && entry.defers;
	}

	// ── Tabs / focus ──────────────────────────────────────────────────────

	private tabs(): Tab[] {
		const tabs: Tab[] = [];
		let hasDeferred = false;
		for (const [entryIndex, entry] of this.entries.entries()) {
			if (entry.mode === "input") {
				tabs.push({ kind: "input", entry: entryIndex });
				continue;
			}
			if (entry.defers) hasDeferred = true;
			for (let question = 0; question < entry.questions.length; question++) {
				tabs.push({ kind: "question", entry: entryIndex, question });
			}
		}
		if (hasDeferred) tabs.push({ kind: "submit" });
		return tabs;
	}

	private currentTab(): Tab | undefined {
		const tabs = this.tabs();
		if (tabs.length === 0) return undefined;
		if (this.focusedTab >= tabs.length) this.focusedTab = tabs.length - 1;
		return tabs[this.focusedTab];
	}

	private gotoTab(target: number): void {
		const total = this.tabs().length;
		if (total === 0) return;
		this.focusedTab = ((target % total) + total) % total;
		if (this.currentTab()?.kind === "submit") this.submitActionIndex = 0;
		this.host.requestRender();
	}

	private openEntry(entryIndex: number): void {
		if (this.closed || this.entries.length === 0) return;
		const tabs = this.tabs();
		const index = tabs.findIndex((tab) => tab.kind !== "submit" && tab.entry === entryIndex);
		this.focusedTab = index >= 0 ? index : 0;
		this.opened = true;
		setDockedFocus(this.state, "human-request");
		this.host.setFocus(this);
		this.host.requestRender();
	}

	private closeMenu(): void {
		this.opened = false;
		clearDockedFocus(this.state, "human-request");
		this.restoreFocus();
		this.host.requestRender();
	}

	// ── Entry lifecycle ────────────────────────────────────────────────────

	private buildEntry(
		request: HumanRequestEnvelope,
		signal: AbortSignal | undefined,
		resolve: (response: HumanResponse) => void,
		reject: (error: Error) => void,
	): PendingEntry {
		// buildInput's onSubmit closes over this exact entry object, so every
		// path must attach the input to it and return it unchanged — never a
		// spread copy, or finish() would target an entry that is not in the list.
		const entry: PendingEntry = {
			request,
			signal,
			resolve,
			reject,
			settled: false,
			mode: "choice",
			defers: defersAnswers(request),
			questions: [],
		};
		if (request.kind === "input" || request.kind === "custom") {
			entry.mode = "input";
			entry.input = this.buildInput(entry);
			return entry;
		}
		if (request.kind === "confirm") {
			entry.questions.push(
				makeQuestion("confirm", request.title, [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				]),
			);
			return entry;
		}
		if (request.kind === "questions") {
			for (const question of request.questions ?? []) {
				const options = normalizeHumanRequestOptions(question.options);
				if (options.length === 0) continue;
				entry.questions.push(
					makeQuestion(question.multiSelect ? "multi-select" : "select", question.title, options, {
						header: question.header,
						message: question.message,
					}),
				);
			}
			if (entry.questions.length === 0) {
				entry.mode = "input";
				entry.input = this.buildInput(entry);
			}
			return entry;
		}
		// select / multi-select
		const options = normalizeHumanRequestOptions(request.options);
		if (options.length === 0) {
			entry.mode = "input";
			entry.input = this.buildInput(entry);
			return entry;
		}
		entry.questions.push(makeQuestion(request.kind, request.title, options));
		return entry;
	}

	private buildInput(entry: PendingEntry): Input {
		const input = new Input();
		input.onSubmit = (value) => {
			const answer = value.trim() || undefined;
			if (entry.request.kind === "custom") {
				this.finish(entry, { kind: "custom", value: answer });
			} else {
				this.finish(entry, { kind: "input", value: answer });
			}
		};
		input.onEscape = () => this.dismissAll();
		return input;
	}

	private finish(entry: PendingEntry, response: HumanResponse): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		this.removeEntry(entry);
		entry.resolve(response);
	}

	private abort(entry: PendingEntry): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		this.removeEntry(entry);
		entry.reject(new Error("Human request was aborted."));
	}

	private removeEntry(entry: PendingEntry): void {
		const index = this.entries.indexOf(entry);
		if (index >= 0) this.entries.splice(index, 1);
		if (this.entries.length === 0) {
			if (this.opened) this.closeMenu();
			else this.host.requestRender();
			return;
		}
		const tabs = this.tabs();
		if (this.focusedTab >= tabs.length) this.focusedTab = tabs.length - 1;
		this.host.requestRender();
	}

	private detachAbort(entry: PendingEntry): void {
		if (entry.signal && entry.abortListener) {
			entry.signal.removeEventListener("abort", entry.abortListener);
		}
		entry.abortListener = undefined;
	}
}

/**
 * A question over options always ends with the free-text one, whatever the
 * request asked for: the options are the asker's guess at the answer space, and
 * a human with a different answer should not have to dismiss the question to
 * give it. `allowFreeInput` on the request therefore changes nothing here - it
 * is already always on.
 *
 * A confirm is the exception, and not by omission. Yes and no are the whole of
 * what it asks, the shape it is answered in holds nothing else, and a question
 * that only has two answers is the one place a third option would be noise.
 */
function makeQuestion(
	kind: QuestionState["kind"],
	title: string,
	options: NormalizedHumanRequestOption[],
	extra: { header?: string; message?: string } = {},
): QuestionState {
	return {
		kind,
		title,
		header: extra.header,
		message: extra.message,
		options: kind === "confirm" ? options : [...options, { value: FREE_INPUT_VALUE, label: FREE_INPUT_LABEL }],
		cursor: 0,
		multi: new Set<string>(),
		editing: false,
	};
}

function questionAnswer(question: QuestionState): HumanQuestionAnswer {
	if (question.kind === "multi-select") {
		if (question.multi.size === 0) {
			return { kind: "multi-select", values: undefined };
		}
		return {
			kind: "multi-select",
			values: question.options.filter((option) => question.multi.has(option.value)).map((option) => option.value),
		};
	}
	return { kind: "select", value: question.single };
}

function windowStart(cursor: number, total: number): number {
	if (total <= MAX_VISIBLE_OPTIONS) return 0;
	return Math.max(0, Math.min(cursor - Math.floor(MAX_VISIBLE_OPTIONS / 2), total - MAX_VISIBLE_OPTIONS));
}

function fallbackResponse(request: HumanRequestEnvelope): HumanResponse {
	switch (request.kind) {
		case "confirm":
			return { kind: "confirm", confirmed: false };
		case "select":
			return { kind: "select", value: undefined };
		case "multi-select":
			return { kind: "multi-select", values: undefined };
		case "questions":
			return {
				kind: "questions",
				answers: (request.questions ?? []).map((question) =>
					question.multiSelect ? { kind: "multi-select", values: undefined } : { kind: "select", value: undefined },
				),
			};
		case "custom":
			return { kind: "custom", value: undefined };
		default:
			return { kind: "input", value: undefined };
	}
}
