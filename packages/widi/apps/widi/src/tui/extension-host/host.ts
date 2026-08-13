import type { Component, KeybindingDefinitions, KeybindingsConfig } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import { validateExtensionEventName } from "../../core/extension/events.ts";
import type { ExtensionIdentity, ExtensionSource } from "../../core/extension/loader.ts";
import { JitiExtensionModuleImporter } from "../../core/extension/module-importer.ts";
import { formatError } from "../../utils/errors.ts";
import type { JsonValue } from "../../utils/json.ts";
import type { TuiCapabilityRegistry } from "../capabilities.ts";
import type { CommandEngine } from "../commands/engine.ts";
import type { CommandDefinition } from "../commands/types.ts";
import type { AppOverlayHandle, ShowOverlayOptions } from "../layout/overlay-stack.ts";
import { EXTENSION_WIDGET_ORDER, type LayoutSlots } from "../layout/slots.ts";
import { getAllThemes, setTheme, theme } from "../theme/theme.ts";
import { registerToolPresenter } from "../tool-presenter.ts";
import {
	registerExtensionEntryRenderer,
	registerExtensionMessageRenderer,
	setExtensionRendererReporter,
	type TuiExtensionEntryRenderer,
	type TuiExtensionMessageRenderer,
	unregisterExtensionEntryRenderer,
	unregisterExtensionMessageRenderer,
} from "./renderers.ts";
import { wrapExtensionComponent, wrapExtensionComponentFactory } from "./safe-component.ts";
import { ExtensionShortcutRegistry } from "./shortcuts.ts";
import {
	TUI_EXTENSION_API_VERSION,
	type TuiExtensionActivate,
	type TuiExtensionComponentFactory,
	type TuiExtensionDispose,
	type TuiExtensionEventBus,
	type TuiExtensionEventHandler,
	type TuiExtensionShortcutOptions,
	type TuiExtensionWidgetOptions,
	type WidiTuiExtensionApi,
} from "./types.ts";

/**
 * Imports the full module namespace of an extension entry: the `tui` named
 * export lives beside the core half's default export, so the default-export
 * importer the core loader uses cannot see it.
 */
export interface TuiExtensionModuleImporter {
	importModuleNamespace(entryPath: string): Promise<unknown>;
}

export interface TuiExtensionHostOptions {
	/**
	 * Extensions the core discovery/load pipeline already resolved - the host
	 * reuses that output (`services.extensionLoad.loaded`, derived from
	 * `ExtensionDiscoveryResult`) instead of walking the file system again.
	 * Programmatically registered factory extensions have no entry file and
	 * cannot carry a `tui` half; they are skipped.
	 */
	readonly identities: readonly ExtensionIdentity[];
	readonly commandEngine: CommandEngine;
	/** The mounted layout the application assembled; widgets join it at runtime. */
	readonly layout: LayoutSlots;
	/** The application overlay stack extension overlays open on. */
	readonly overlays: { show(component: Component, options?: ShowOverlayOptions): AppOverlayHandle };
	/**
	 * The application's published control surfaces. Absent in embeddings that
	 * mount the host without an application behind it, where every lookup misses.
	 */
	readonly capabilities?: TuiCapabilityRegistry;
	readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;
	/** Stages text for the visible agent on behalf of one extension. */
	readonly stageMessage?: (extensionId: string, text: string) => void;
	/**
	 * The runtime extension event bus. Absent in embeddings that have no core
	 * behind them, where emitting rejects and subscriptions never fire.
	 */
	readonly events?: TuiExtensionEventBus;
	/** Repaint request after a visible change (theme switch, overlay, edit). */
	readonly requestRender?: () => void;
	readonly moduleImporter?: TuiExtensionModuleImporter;
}

interface HostDisposer {
	readonly extensionId: string;
	readonly dispose: TuiExtensionDispose;
}

interface EventSubscription {
	readonly extensionId: string;
	readonly handler: TuiExtensionEventHandler;
}

/**
 * Runtime-level singleton that activates the `tui` halves of extensions
 * (host doc §6.1/§6.5). It is a TUI application module, not a core extension:
 * discovery and entry resolution come from the core pipeline's output, import
 * goes through a namespace-reading jiti importer, activation hands each
 * extension the `WidiTuiExtensionApi`, and every failure is isolated to a
 * diagnostic - a broken extension can never abort TUI startup.
 */
export class TuiExtensionHost {
	readonly shortcuts: ExtensionShortcutRegistry;

	private readonly identities: readonly ExtensionIdentity[];
	private readonly commandEngine: CommandEngine;
	private readonly layout: LayoutSlots;
	private readonly overlays: TuiExtensionHostOptions["overlays"];
	private readonly capabilities?: TuiCapabilityRegistry;
	private readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;
	private readonly stageMessage?: (extensionId: string, text: string) => void;
	private readonly requestRender: () => void;
	private readonly moduleImporter: TuiExtensionModuleImporter;
	private readonly disposers: HostDisposer[] = [];
	private readonly events?: TuiExtensionEventBus;
	private readonly eventSubscriptions = new Map<string, EventSubscription[]>();
	private detachFromBus?: () => void;
	private activated = false;

	constructor(options: TuiExtensionHostOptions) {
		this.identities = options.identities;
		this.commandEngine = options.commandEngine;
		this.layout = options.layout;
		this.overlays = options.overlays;
		this.capabilities = options.capabilities;
		this.reportDiagnostic = options.reportDiagnostic;
		this.stageMessage = options.stageMessage;
		this.events = options.events;
		this.requestRender = options.requestRender ?? (() => {});
		this.moduleImporter = options.moduleImporter ?? new JitiExtensionModuleImporter();
		this.shortcuts = new ExtensionShortcutRegistry({ reportDiagnostic: options.reportDiagnostic });
		setExtensionRendererReporter(options.reportDiagnostic);
	}

	/** Shortcut definitions registered so far, for the global keybindings merge. */
	get keybindingDefinitions(): KeybindingDefinitions {
		return this.shortcuts.keybindingDefinitions;
	}

	/** The user's keybindings.json config, once the application has loaded it. */
	setUserKeybindings(bindings: KeybindingsConfig): void {
		this.shortcuts.setUserBindings(bindings);
	}

	/** Editor input hook: consume the keystroke when an extension shortcut claims it. */
	handleShortcut(data: string): boolean {
		return this.shortcuts.dispatch(data);
	}

	async activate(): Promise<void> {
		if (this.activated) return;
		this.activated = true;
		for (const identity of this.identities) {
			await this.activateOne(identity);
		}
	}

	/** Reverse-order dispose; each failure is reported and the rest still run. */
	async dispose(): Promise<void> {
		this.detachFromBus?.();
		this.detachFromBus = undefined;
		this.eventSubscriptions.clear();
		const pending = this.disposers.splice(0).reverse();
		for (const disposer of pending) {
			try {
				await disposer.dispose();
			} catch (error) {
				this.reportDiagnostic({
					severity: "warning",
					code: "tui_extension.dispose_failed",
					message: `Extension '${disposer.extensionId}' dispose failed: ${formatError(error)}`,
					extensionId: disposer.extensionId,
				});
			}
		}
	}

	/**
	 * One bus subscription for the whole host, attached the first time an
	 * extension asks for one. A host whose extensions never subscribe stays off
	 * the bus entirely.
	 */
	private subscribeToBus(extensionId: string, name: string, handler: TuiExtensionEventHandler): void {
		const subscriptions = this.eventSubscriptions.get(name) ?? [];
		subscriptions.push({ extensionId, handler });
		this.eventSubscriptions.set(name, subscriptions);
		if (this.detachFromBus || !this.events) return;
		this.detachFromBus = this.events.subscribe(async (envelope) => {
			for (const subscription of this.eventSubscriptions.get(envelope.name) ?? []) {
				try {
					await subscription.handler(envelope);
				} catch (error) {
					this.reportDiagnostic({
						severity: "warning",
						code: "tui_extension.event_handler_failed",
						message: `Extension '${subscription.extensionId}' failed handling extension event '${envelope.name}': ${formatError(error)}`,
						extensionId: subscription.extensionId,
					});
				}
			}
		});
	}

	private async activateOne(identity: ExtensionIdentity): Promise<void> {
		const entryPath = entryPathOf(identity.source);
		if (!entryPath) return;
		const extensionId = identity.id;

		let module: unknown;
		try {
			module = await this.moduleImporter.importModuleNamespace(entryPath);
		} catch (error) {
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.load_failed",
				message: `Failed to load the TUI half of extension '${extensionId}' from ${entryPath}: ${formatError(error)}`,
				extensionId,
			});
			return;
		}

		const tuiHalf = resolveTuiHalf(module);
		// No `tui` export: a pure core extension, the normal case, no diagnostic.
		if (tuiHalf === undefined) return;
		if (tuiHalf === "invalid") {
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.definition_invalid",
				message: `Extension '${extensionId}' has an invalid 'tui' export; expected an activation function or an { apiVersion, activate } definition.`,
				extensionId,
			});
			return;
		}
		if (tuiHalf.apiVersion !== undefined && tuiHalf.apiVersion !== TUI_EXTENSION_API_VERSION) {
			// Only this half is refused (host doc open question 4): the core half
			// already loaded on its own version terms.
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.version_incompatible",
				message: `Extension '${extensionId}' targets TUI extension API version ${tuiHalf.apiVersion}; this host supports version ${TUI_EXTENSION_API_VERSION}.`,
				extensionId,
			});
			return;
		}

		try {
			const dispose = await tuiHalf.activate(this.createApi(extensionId));
			if (typeof dispose === "function") {
				this.disposers.push({ extensionId, dispose });
			}
		} catch (error) {
			// Disposers the extension registered before throwing stay on the list;
			// their cleanup is still owed at shutdown.
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.activation_failed",
				message: `Extension '${extensionId}' TUI activation failed: ${formatError(error)}`,
				extensionId,
			});
		}
	}

	private createApi(extensionId: string): WidiTuiExtensionApi {
		// Layout keys this extension owns; one cleanup disposer removes them all
		// when the host shuts down.
		const layoutKeys = new Set<string>();
		let layoutCleanupRegistered = false;
		const setLayoutComponent = (
			slot: "header" | "aboveEditor" | "belowEditor" | "footer",
			key: string,
			factory: TuiExtensionComponentFactory | undefined,
		) => {
			if (factory === undefined) {
				layoutKeys.delete(key);
				this.layout.unregister(key);
				return;
			}
			if (!layoutCleanupRegistered) {
				layoutCleanupRegistered = true;
				this.disposers.push({
					extensionId,
					dispose: () => {
						for (const layoutKey of layoutKeys) this.layout.unregister(layoutKey);
					},
				});
			}
			// Re-setting a key replaces the widget; unregister disposes the old one.
			this.layout.unregister(key);
			const safeFactory = wrapExtensionComponentFactory(factory, {
				extensionId,
				label: `${slot} widget '${key}'`,
				reportDiagnostic: this.reportDiagnostic,
			});
			const diagnostic = this.layout.register({
				key,
				slot,
				scope: "global",
				factory: safeFactory,
				order: EXTENSION_WIDGET_ORDER,
			});
			if (diagnostic) {
				this.reportDiagnostic({ ...diagnostic, extensionId });
				return;
			}
			layoutKeys.add(key);
		};
		return {
			extensionId,
			registerCommand: (definition: CommandDefinition) => {
				const diagnostic = this.commandEngine.register(definition);
				if (diagnostic) this.reportDiagnostic({ ...diagnostic, extensionId });
			},
			registerShortcut: (bindingId: string, options: TuiExtensionShortcutOptions) => {
				const diagnostic = this.shortcuts.register(extensionId, bindingId, options);
				if (diagnostic) this.reportDiagnostic(diagnostic);
			},
			registerToolPresenter: (toolName, presenter) => {
				const diagnostic = registerToolPresenter(toolName, presenter);
				if (diagnostic) this.reportDiagnostic({ ...diagnostic, extensionId });
			},
			registerMessageRenderer: (kind: string, render: TuiExtensionMessageRenderer) => {
				const diagnostic = registerExtensionMessageRenderer(extensionId, kind, render);
				if (diagnostic) {
					this.reportDiagnostic(diagnostic);
					return;
				}
				this.disposers.push({
					extensionId,
					dispose: () => {
						unregisterExtensionMessageRenderer(extensionId, kind);
					},
				});
			},
			registerEntryRenderer: (kind: string, render: TuiExtensionEntryRenderer) => {
				const diagnostic = registerExtensionEntryRenderer(extensionId, kind, render);
				if (diagnostic) {
					this.reportDiagnostic(diagnostic);
					return;
				}
				this.disposers.push({
					extensionId,
					dispose: () => {
						unregisterExtensionEntryRenderer(extensionId, kind);
					},
				});
			},
			setWidget: (
				key: string,
				factory: TuiExtensionComponentFactory | undefined,
				options: TuiExtensionWidgetOptions,
			) => {
				const normalizedKey = key.trim();
				if (!normalizedKey || /\s/.test(normalizedKey)) {
					this.reportDiagnostic({
						severity: "warning",
						code: "tui_extension.widget_invalid",
						message: `Extension '${extensionId}' set a widget with an invalid key; it was refused.`,
						extensionId,
					});
					return;
				}
				setLayoutComponent(options.placement, `ext.${extensionId}.${normalizedKey}`, factory);
			},
			setFooter: (factory: TuiExtensionComponentFactory | undefined) => {
				setLayoutComponent("footer", `ext.${extensionId}.footer`, factory);
			},
			setHeader: (factory: TuiExtensionComponentFactory | undefined) => {
				setLayoutComponent("header", `ext.${extensionId}.header`, factory);
			},
			showOverlay: (component, options) => {
				const safeComponent = wrapExtensionComponent(component, {
					extensionId,
					label: "overlay",
					reportDiagnostic: this.reportDiagnostic,
				});
				const handle = this.overlays.show(safeComponent, { dismissible: true, ...options });
				this.disposers.push({
					extensionId,
					dispose: () => {
						if (!handle.closed) handle.close();
					},
				});
				this.requestRender();
				// The stack holds the guarded component; the extension gets its own
				// back, so the handle stays the one it can compare and reuse.
				return {
					component,
					get closed() {
						return handle.closed;
					},
					close: () => handle.close(),
				};
			},
			stage: (text: string) => {
				this.stageMessage?.(extensionId, text);
			},
			emitExtensionEvent: async (name: string, payload?: JsonValue) => {
				if (!this.events) {
					throw new Error(`Extension '${extensionId}' cannot emit '${name}': this host has no extension event bus.`);
				}
				await this.events.emit(extensionId, name, payload);
			},
			onExtensionEvent: (name: string, handler: TuiExtensionEventHandler) => {
				let eventName: string;
				try {
					eventName = validateExtensionEventName(name);
				} catch (error) {
					this.reportDiagnostic({
						severity: "warning",
						code: "tui_extension.event_name_invalid",
						message: `Extension '${extensionId}' subscribed to an invalid extension event name: ${formatError(error)}`,
						extensionId,
					});
					return;
				}
				this.subscribeToBus(extensionId, eventName, handler);
			},
			capability: (key: string) => this.capabilities?.get(key, extensionId),
			getEditorText: () => this.capabilities?.get("editor")?.getText() ?? "",
			setEditorText: (text: string) => this.capabilities?.get("editor")?.setText(text),
			pasteToEditor: (text: string) => this.capabilities?.get("editor")?.insertAtCursor(text),
			theme,
			setTheme: (name: string) => {
				const switched = setTheme(name);
				if (switched) this.requestRender();
				return switched;
			},
			getAllThemes,
			onDispose: (handler) => {
				this.disposers.push({ extensionId, dispose: handler });
			},
		};
	}
}

/** The importable entry of a discovered extension; factory sources have none. */
function entryPathOf(source: ExtensionSource): string | undefined {
	if (source.kind === "package") return source.entryPath;
	if (source.kind === "file") return source.path;
	return undefined;
}

type ResolvedTuiHalf = { readonly activate: TuiExtensionActivate; readonly apiVersion?: number };

function resolveTuiHalf(module: unknown): ResolvedTuiHalf | "invalid" | undefined {
	if (!isRecord(module)) return undefined;
	const tui = module.tui;
	if (tui === undefined) return undefined;
	if (typeof tui === "function") return { activate: tui as TuiExtensionActivate };
	if (isRecord(tui) && typeof tui.activate === "function") {
		const apiVersion = tui.apiVersion;
		if (apiVersion !== undefined && typeof apiVersion !== "number") return "invalid";
		return { activate: tui.activate as TuiExtensionActivate, ...(apiVersion !== undefined ? { apiVersion } : {}) };
	}
	return "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
