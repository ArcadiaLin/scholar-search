import type { Component, OverlayOptions, OverlayHandle as TuiOverlayHandle } from "@earendil-works/pi-tui";
import {
	pushOverlayFocus,
	removeOverlayFocus,
	type TuiApplicationState,
	type TuiInteractionMode,
	type TuiOverlayFocusEntry,
} from "../state.ts";

/** The slice of pi-tui the stack needs; kept minimal so tests can fake it. */
export interface OverlayStackHost {
	showOverlay(component: Component, options?: OverlayOptions): TuiOverlayHandle;
	setFocus(component: Component | null): void;
	requestRender(): void;
}

export interface ShowOverlayOptions extends OverlayOptions {
	/** Interaction mode contributed to state.mode while the overlay is open. */
	readonly mode?: TuiInteractionMode;
	/** Dismissible overlays are what interrupt closes before anything else. */
	readonly dismissible?: boolean;
}

/**
 * A live overlay on the application stack. close() removes it and restores
 * focus down the chain; it is idempotent.
 */
export interface AppOverlayHandle {
	readonly component: Component;
	readonly closed: boolean;
	close(): void;
}

interface StackEntry {
	readonly stack: OverlayStack;
	readonly component: Component;
	readonly handle: TuiOverlayHandle;
	readonly focusEntry: TuiOverlayFocusEntry;
	readonly dismissible: boolean;
	closed: boolean;
}

/**
 * Application-level overlay stack over tui.showOverlay (parity §4.2). Later
 * overlays sit on top; closing one falls back to the next overlay below, then
 * to the open docked component, then to the editor. Every open overlay is
 * recorded in state.focus, which is what state.mode derives from.
 */
export class OverlayStack {
	private readonly host: OverlayStackHost;
	private readonly state: TuiApplicationState;
	private readonly editor: Component;
	private readonly dockedFocusTarget: () => Component | undefined;
	private readonly entries: StackEntry[] = [];

	constructor(options: {
		readonly host: OverlayStackHost;
		readonly state: TuiApplicationState;
		/** Focus target when neither an overlay nor a docked component wants input. */
		readonly editor: Component;
		/** The open docked component that takes focus when no overlay is up. */
		readonly dockedFocusTarget: () => Component | undefined;
	}) {
		this.host = options.host;
		this.state = options.state;
		this.editor = options.editor;
		this.dockedFocusTarget = options.dockedFocusTarget;
	}

	/** Live handles, bottom to top. */
	list(): readonly AppOverlayHandle[] {
		return this.entries.map(asHandle);
	}

	show(component: Component, options: ShowOverlayOptions = {}): AppOverlayHandle {
		const { mode, dismissible = false, ...overlayOptions } = options;
		const focusEntry = pushOverlayFocus(this.state, mode === undefined ? {} : { mode });
		const entry: StackEntry = {
			stack: this,
			component,
			handle: this.host.showOverlay(component, overlayOptions),
			focusEntry,
			dismissible,
			closed: false,
		};
		this.entries.push(entry);
		return asHandle(entry);
	}

	/**
	 * Close the topmost dismissible overlay; returns whether one was closed.
	 * This is the interrupt path's first step: a selector goes away before the
	 * running agent is aborted. Non-dismissible overlays (the fatal boundary)
	 * are left alone.
	 */
	dismiss(): boolean {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry?.dismissible) {
				this.close(entry);
				return true;
			}
		}
		return false;
	}

	/**
	 * Hand focus to whoever should have it now: the top overlay, then the open
	 * docked component, then the editor.
	 */
	restoreFocus(): void {
		const top = this.entries[this.entries.length - 1];
		if (top) {
			top.handle.focus();
			return;
		}
		this.host.setFocus(this.dockedFocusTarget() ?? this.editor);
		this.host.requestRender();
	}

	/** StackEntry is module-private, so this is only reachable through a handle. */
	close(entry: StackEntry): void {
		if (entry.closed) return;
		entry.closed = true;
		const index = this.entries.indexOf(entry);
		if (index >= 0) this.entries.splice(index, 1);
		removeOverlayFocus(this.state, entry.focusEntry);
		entry.handle.hide();
		this.restoreFocus();
	}
}

function asHandle(entry: StackEntry): AppOverlayHandle {
	return {
		component: entry.component,
		get closed() {
			return entry.closed;
		},
		close: () => entry.stack.close(entry),
	};
}
