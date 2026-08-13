import { type Component, isFocusable } from "@earendil-works/pi-tui";
import { clearDockedFocus, setDockedFocus, type TuiApplicationState } from "../state.ts";

/** The slice of TUI the dock needs; kept minimal so tests can fake it. */
export interface SelectorDockHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

/**
 * Docked host for the command selector family (ListSelector, TreeSelector, and
 * custom command selector views). Like pi's showSelector, the open selector
 * takes the editor's place in the layout: the application hides the editor
 * while the dock holds a view, so the selector renders full width in the
 * normal flow instead of floating in a centered overlay box. One view at a
 * time; close() is idempotent and hands focus back down the chain (docked
 * components, then the editor).
 */
export class SelectorDock implements Component {
	private readonly host: SelectorDockHost;
	private readonly state: TuiApplicationState;
	private readonly restoreFocus: () => void;
	private view?: Component;
	private onClosed?: () => void;

	constructor(options: {
		readonly host: SelectorDockHost;
		readonly state: TuiApplicationState;
		readonly restoreFocus: () => void;
	}) {
		this.host = options.host;
		this.state = options.state;
		this.restoreFocus = options.restoreFocus;
	}

	get focused(): boolean {
		return this.view && isFocusable(this.view) ? this.view.focused : false;
	}

	set focused(value: boolean) {
		if (this.view && isFocusable(this.view)) this.view.focused = value;
	}

	get isOpen(): boolean {
		return this.view !== undefined;
	}

	/** The mounted view, for the operation hint's selector context. */
	get current(): Component | undefined {
		return this.view;
	}

	/**
	 * Dock a view. `onClosed` fires whenever that view leaves the dock, by any
	 * path - its own close, a replacement, or an interrupt that never reaches
	 * it - which is what lets a caller waiting on an answer stop waiting.
	 */
	open(view: Component, onClosed?: () => void): void {
		const replaced = this.onClosed;
		this.view = view;
		this.onClosed = onClosed;
		setDockedFocus(this.state, "selector");
		this.host.setFocus(this);
		replaced?.();
		this.host.requestRender();
	}

	close(): void {
		if (!this.view) return;
		const closed = this.onClosed;
		this.view = undefined;
		this.onClosed = undefined;
		clearDockedFocus(this.state, "selector");
		this.restoreFocus();
		closed?.();
		this.host.requestRender();
	}

	handleInput(data: string): void {
		this.view?.handleInput?.(data);
	}

	invalidate(): void {
		this.view?.invalidate();
	}

	render(width: number): string[] {
		return this.view ? this.view.render(width) : [];
	}
}
