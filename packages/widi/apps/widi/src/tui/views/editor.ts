import { Editor, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Esc within this window of a completion keystroke cancels the completion. */
const COMPLETION_KEY_SWALLOW_MS = 250;

export class WidiEditor extends Editor {
	onOpenAgents?: () => void;
	onInterrupt?: () => void;
	onExit?: () => void;
	onToggleToolOutput?: () => void;
	onSteer?: () => void;
	onOpenRequests?: () => void;
	onOpenTree?: () => void;
	onViewSystemPrompt?: () => void;
	onEditStaged?: () => void;
	/** Extension shortcut dispatch; returning true consumes the input. */
	onExtensionShortcut?: (data: string) => boolean;

	private argumentHintProvider?: (text: string) => string | undefined;
	private commandRecognizer?: (name: string) => boolean;
	private lastCompletionKeyAt = 0;

	setArgumentHintProvider(provider: (text: string) => string | undefined): void {
		this.argumentHintProvider = provider;
	}

	/** Decides whether a typed `/name` is a command that exists. */
	setCommandRecognizer(recognizer: (name: string) => boolean): void {
		this.commandRecognizer = recognizer;
	}

	override render(width: number): string[] {
		const text = this.getText();
		// Slash-command context gets the active rule color; everything else
		// stays on the subdued rule color. pi-tui paints its horizontal rules
		// with this.borderColor during super.render.
		this.borderColor = text.trimStart().startsWith("/") ? theme.borderActive : theme.border;
		const rendered = super.render(width);
		if (rendered.length >= 3) {
			this.applyCommandHighlight(rendered);
			this.applyArgumentHint(rendered, width, text);
		}
		return rendered;
	}

	/**
	 * Paint the leading `/name` once it names a command that exists, so a typo
	 * is the absence of color rather than an error after Enter.
	 *
	 * pi-tui renders the draft as plain text with an inverse cursor spliced in,
	 * so this repaints the token in the rendered line. The pattern cannot match
	 * across that escape sequence, which is what keeps the highlight off a token
	 * the cursor is standing inside - it would otherwise paint half of one.
	 */
	private applyCommandHighlight(rendered: string[]): void {
		const line = rendered[1];
		if (line === undefined) return;
		const match = /^(\s*)(\/[A-Za-z][\w-]*)/u.exec(line);
		if (!match || !this.commandRecognizer?.(match[2].slice(1))) return;
		rendered[1] = `${match[1]}${theme.bold(theme.command(match[2]))}${line.slice(match[0].length)}`;
	}

	private applyArgumentHint(rendered: string[], width: number, text: string): void {
		if (text.includes("\n") || !/^\/\S+\s*$/.test(text)) return;
		const hint = this.argumentHintProvider?.(text);
		if (!hint) return;
		const index = 1;
		const line = (rendered[index] ?? "").replace(/ +$/u, "");
		const available = width - visibleWidth(line) - 1;
		if (available < 2) return;
		const hintText = visibleWidth(hint) > available ? truncateToWidth(hint, available, "…") : hint;
		const padding = " ".repeat(Math.max(0, width - visibleWidth(line) - 1 - visibleWidth(hintText)));
		rendered[index] = `${line} ${theme.dim(hintText)}${padding}`;
	}

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.expand")) {
			this.onToggleToolOutput?.();
			return;
		}
		if (keybindings.matches(data, "app.prompt.view")) {
			this.onViewSystemPrompt?.();
			return;
		}
		if (keybindings.matches(data, "app.staged.edit")) {
			this.onEditStaged?.();
			return;
		}
		if (keybindings.matches(data, "app.steer")) {
			this.onSteer?.();
			return;
		}
		if (keybindings.matches(data, "app.request.open")) {
			this.onOpenRequests?.();
			return;
		}
		if (keybindings.matches(data, "app.tree.open") && !this.isShowingAutocomplete()) {
			// The draft stays in the editor; the docked selector only covers it.
			this.onOpenTree?.();
			return;
		}
		if (keybindings.matches(data, "app.agents.open") && !this.isShowingAutocomplete() && this.isAtDraftEnd()) {
			this.onOpenAgents?.();
			return;
		}
		if (keybindings.matches(data, "app.interrupt")) {
			if (this.isShowingAutocomplete()) {
				this.passToSuper(data);
			} else if (Date.now() - this.lastCompletionKeyAt < COMPLETION_KEY_SWALLOW_MS) {
				// Esc right after a completion keystroke cancels the in-flight
				// completion, not the agent.
			} else {
				this.onInterrupt?.();
			}
			return;
		}
		if (keybindings.matches(data, "app.exit") && this.getText().length === 0) {
			this.onExit?.();
			return;
		}
		// Extension shortcuts lose to the built-ins above: a default key that
		// collides with an app action keeps the app's behavior, and the user
		// resolves the overlap in keybindings.json.
		if (this.onExtensionShortcut?.(data)) {
			return;
		}
		this.noteCompletionKey(data);
		this.passToSuper(data);
	}

	/**
	 * Down at the very end of the current draft is a pi-tui no-op (it would
	 * only jump to the line end the cursor is already at), so that position is
	 * the way out to the agent panel below. While browsing prompt history the
	 * same key still recalls the newer entry; the history index is a pi-tui
	 * private, read through a typed view to keep the vendor package untouched.
	 */
	private isAtDraftEnd(): boolean {
		const internals = this as unknown as { historyIndex: number };
		if (internals.historyIndex !== -1) return false;
		const lines = this.getLines();
		const cursor = this.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line] ?? "").length;
	}

	/** Timestamp printable keystrokes inside a completion context. */
	private noteCompletionKey(data: string): void {
		if (data.length !== 1 || data.charCodeAt(0) < 32) return;
		const cursor = this.getCursor();
		const before = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		if (/^\/\S*(\s\S*)?$/.test(before) || /(?:^|\s)@\S*$/.test(before)) {
			this.lastCompletionKeyAt = Date.now();
		}
	}

	private passToSuper(data: string): void {
		const wasShowing = this.isShowingAutocomplete();
		super.handleInput(data);
		// The differential renderer leaves the editor "floating" where the
		// taller menu pushed it; force a full redraw when the menu closes.
		if (wasShowing && !this.isShowingAutocomplete()) {
			this.tui.requestRender(true);
		}
	}
}
