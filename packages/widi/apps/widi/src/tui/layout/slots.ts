import { type Component, isFocusable } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type { TuiApplicationState } from "../state.ts";

/**
 * Named positions in the application layout, top to bottom. "chat" and
 * "editor" go beyond the extension-facing slots so the whole mounted sequence
 * lives in one ordered registry; the fixed anchors stay registered entries
 * like everything else.
 *
 * This declaration order *is* the render order: SLOT_ORDER below derives from
 * it and every entry sorts by it, so where a widget lands is a property of its
 * slot, never of when it happened to register.
 */
export const SLOT_ORDER = [
	"header",
	"notices",
	"chat",
	"status",
	"aboveEditor",
	"editor",
	"belowEditor",
	"footer",
	"belowFooter",
	"agentStrip",
] as const;

export type LayoutSlot = (typeof SLOT_ORDER)[number];

const SLOT_RANK = new Map<string, number>(SLOT_ORDER.map((slot, index) => [slot, index]));

/**
 * Order every extension widget registers with, so extension widgets stay after
 * the built-in entries of the same slot however the built-ins are numbered.
 */
export const EXTENSION_WIDGET_ORDER = 100;

export interface LayoutSlotEntry {
	/** Unique within the registry; the handle for unregister(). */
	readonly key: string;
	readonly slot: LayoutSlot;
	readonly factory: () => Component;
	/**
	 * Tie-break within one slot; entries without it sort as 0. Equal order
	 * keeps registration order, so the built-in anchors need no numbers.
	 */
	readonly order?: number;
	/**
	 * Parity §4.2 also defines an "agent" scope (render only while that agent
	 * is visible). No consumer exists yet, so only "global" is implemented;
	 * per-agent visibility is expressible through visible? in the meantime.
	 */
	readonly scope: "global";
	/** Per-render visibility gate; entries without it self-gate in render(). */
	visible?(state: TuiApplicationState): boolean;
}

/**
 * The slice of pi-tui's Container the slots mount into. removeChild/children
 * are what make runtime register/unregister visible after the initial mount;
 * a host without them (a minimal test fake) still mounts the initial sequence.
 */
export interface LayoutSlotHost {
	addChild(component: Component): void;
	removeChild?(component: Component): void;
	/** Live child list, used to insert a runtime entry at its slot position. */
	children?: Component[];
}

export interface LayoutSlotHosts {
	readonly transcript: LayoutSlotHost;
	readonly dock: LayoutSlotHost;
}

interface MountedLayout {
	readonly hosts: LayoutSlotHosts;
	readonly state: TuiApplicationState;
	readonly components: Map<string, Component>;
}

/**
 * Ordered registry of layout entries. The registry is kept sorted by
 * (slot, order, registration), so render order follows SLOT_ORDER whether an
 * entry registered at startup or an hour into the session. Built-in views
 * register through the same path extension widgets will use.
 *
 * After mount() the registry stays live: register() instantiates and inserts
 * the new entry at its slot's position, and unregister() removes the mounted
 * component from the host and disposes it.
 */
export class LayoutSlots {
	private readonly registrations: LayoutSlotEntry[] = [];
	private mounted?: MountedLayout;

	/**
	 * Add an entry. A taken key is a conflict: the registration is refused and
	 * reported, never a silent override (same rule as the command engine). The
	 * caller surfaces the returned diagnostic.
	 */
	register(entry: LayoutSlotEntry): OrchestratorDiagnostic | undefined {
		if (this.registrations.some((existing) => existing.key === entry.key)) {
			return {
				severity: "warning",
				code: "layout.slot_conflict",
				message: `Layout entry "${entry.key}" is already registered; the new registration was refused.`,
			};
		}
		let index = this.registrations.length;
		while (index > 0 && compareEntries(this.registrations[index - 1] as LayoutSlotEntry, entry) > 0) index--;
		this.registrations.splice(index, 0, entry);
		if (!this.mounted) return undefined;
		try {
			this.mountEntry(entry);
		} catch (error) {
			// A factory that throws must not leave a phantom registration behind.
			this.registrations.splice(this.registrations.indexOf(entry), 1);
			throw error;
		}
		return undefined;
	}

	/** Remove an entry by key; returns whether one was registered. */
	unregister(key: string): boolean {
		const index = this.registrations.findIndex((entry) => entry.key === key);
		if (index < 0) return false;
		const [entry] = this.registrations.splice(index, 1);
		const mounted = this.mounted?.components.get(key);
		if (this.mounted && mounted && entry) {
			this.mounted.components.delete(key);
			this.hostFor(entry).removeChild?.(mounted);
			disposeComponent(mounted);
		}
		return true;
	}

	/** Ordered snapshot of the registered entries. */
	entries(): readonly LayoutSlotEntry[] {
		return [...this.registrations];
	}

	/** The mounted component for a key, gate included when the entry has one. */
	component(key: string): Component | undefined {
		return this.mounted?.components.get(key);
	}

	/**
	 * Instantiate every entry in order and mount it into the host. An entry
	 * with a visible? predicate is wrapped in a gate that re-evaluates the
	 * predicate on every render, so state-driven visibility needs no event
	 * subscription of its own.
	 */
	mount(host: LayoutSlotHost | LayoutSlotHosts, state: TuiApplicationState): void {
		const hosts = "addChild" in host ? { transcript: host, dock: host } : host;
		this.mounted = { hosts, state, components: new Map() };
		for (const entry of this.registrations) {
			const component = this.instantiate(entry);
			this.mounted.components.set(entry.key, component);
			this.hostFor(entry).addChild(component);
		}
	}

	/** Mount one runtime-registered entry at its registration position. */
	private mountEntry(entry: LayoutSlotEntry): void {
		const mounted = this.mounted;
		if (!mounted) return;
		const component = this.instantiate(entry);
		mounted.components.set(entry.key, component);
		const host = this.hostFor(entry);
		const anchor = this.nextMountedComponent(entry);
		const siblings = host.children;
		const at = anchor && siblings ? siblings.indexOf(anchor) : -1;
		if (anchor && siblings && at >= 0) {
			siblings.splice(at, 0, component);
			return;
		}
		host.addChild(component);
	}

	private hostFor(entry: LayoutSlotEntry): LayoutSlotHost {
		const hosts = this.mounted?.hosts;
		if (!hosts) throw new Error("Layout slots are not mounted.");
		return isTranscriptSlot(entry.slot) ? hosts.transcript : hosts.dock;
	}

	/** The next mounted component in the same layout region, if any. */
	private nextMountedComponent(entry: LayoutSlotEntry): Component | undefined {
		const index = this.registrations.indexOf(entry);
		const splitHosts = this.mounted?.hosts.transcript !== this.mounted?.hosts.dock;
		for (let i = index + 1; i < this.registrations.length; i++) {
			const candidate = this.registrations[i];
			if (!candidate || (splitHosts && isTranscriptSlot(candidate.slot) !== isTranscriptSlot(entry.slot))) continue;
			const component = this.mounted?.components.get(candidate.key);
			if (component) return component;
		}
		return undefined;
	}

	private instantiate(entry: LayoutSlotEntry): Component {
		const component = entry.factory();
		const mounted = this.mounted;
		return entry.visible && mounted ? new SlotVisibilityGate(component, entry.visible, mounted.state) : component;
	}
}

/**
 * Slot first, then order. An unknown slot sorts to the very end rather than
 * to the top: a JS extension passing garbage should not land above the header.
 */
function isTranscriptSlot(slot: LayoutSlot): boolean {
	return slot === "header" || slot === "notices" || slot === "chat";
}

function compareEntries(left: LayoutSlotEntry, right: LayoutSlotEntry): number {
	const slotDelta = (SLOT_RANK.get(left.slot) ?? SLOT_ORDER.length) - (SLOT_RANK.get(right.slot) ?? SLOT_ORDER.length);
	return slotDelta !== 0 ? slotDelta : (left.order ?? 0) - (right.order ?? 0);
}

/** Run the optional teardown of a layout component (host doc §6.3 factory). */
function disposeComponent(component: Component): void {
	(component as Component & { dispose?(): void }).dispose?.();
}

/**
 * Re-evaluates an entry's visible? predicate per render around a stable child
 * identity. A hidden gated component must not be a focus target: the gate
 * still forwards input and focus to the child, so hiding a focused component
 * is the registrant's bug to avoid.
 */
class SlotVisibilityGate implements Component {
	private readonly inner: Component;
	private readonly visible: (state: TuiApplicationState) => boolean;
	private readonly state: TuiApplicationState;

	constructor(inner: Component, visible: (state: TuiApplicationState) => boolean, state: TuiApplicationState) {
		this.inner = inner;
		this.visible = visible;
		this.state = state;
	}

	get focused(): boolean {
		return isFocusable(this.inner) ? this.inner.focused : false;
	}

	set focused(value: boolean) {
		if (isFocusable(this.inner)) this.inner.focused = value;
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	dispose(): void {
		disposeComponent(this.inner);
	}

	render(width: number): string[] {
		return this.visible(this.state) ? this.inner.render(width) : [];
	}
}
