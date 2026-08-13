import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import { formatError } from "../../utils/errors.ts";
import { isKeyId } from "../keybindings.ts";
import type { TuiExtensionShortcutContext, TuiExtensionShortcutOptions } from "./types.ts";

interface ExtensionShortcutRecord {
	readonly extensionId: string;
	readonly definition: {
		readonly defaultKeys: TuiExtensionShortcutOptions["defaultKeys"];
		readonly description?: string;
	};
	readonly handler: TuiExtensionShortcutOptions["handler"];
}

/**
 * Registry behind `WidiTuiExtensionApi.registerShortcut`. An extension names a
 * binding id; the registry namespaces it to `ext.<extensionId>.<bindingId>`,
 * holds the default keys as an ordinary keybinding definition (so the user's
 * keybindings.json overrides apply through the same user-bindings channel as
 * the built-ins), and owns dispatch of matched input to the handler.
 *
 * The registry keeps its own KeybindingsManager for matching so it works
 * headless; `keybindingDefinitions` is what the application additionally
 * merges into the global manager, putting extension actions on the same
 * configurable table as `WIDI_KEYBINDINGS`.
 */
export class ExtensionShortcutRegistry {
	private readonly records = new Map<string, ExtensionShortcutRecord>();
	private userBindings: KeybindingsConfig = {};
	private manager = new KeybindingsManager({});
	private readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;

	constructor(options: { readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void }) {
		this.reportDiagnostic = options.reportDiagnostic;
	}

	register(
		extensionId: string,
		bindingId: string,
		options: TuiExtensionShortcutOptions,
	): OrchestratorDiagnostic | undefined {
		const normalizedId = bindingId.trim();
		if (!normalizedId || /\s/.test(normalizedId)) {
			return {
				severity: "warning",
				code: "tui_extension.shortcut_invalid",
				message: `Extension '${extensionId}' registered a shortcut with an invalid binding id; it was refused.`,
				extensionId,
			};
		}
		const actionId = `ext.${extensionId}.${normalizedId}`;
		if (this.records.has(actionId)) {
			return {
				severity: "warning",
				code: "tui_extension.shortcut_conflict",
				message: `Shortcut action "${actionId}" is already registered; the new registration was refused.`,
				extensionId,
			};
		}
		const keys = Array.isArray(options.defaultKeys) ? options.defaultKeys : [options.defaultKeys];
		if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !isKeyId(key))) {
			return {
				severity: "warning",
				code: "tui_extension.shortcut_invalid",
				message: `Shortcut action "${actionId}" has an invalid default key sequence; it was refused.`,
				extensionId,
			};
		}
		this.records.set(actionId, {
			extensionId,
			definition: {
				defaultKeys: options.defaultKeys,
				...(options.description !== undefined ? { description: options.description } : {}),
			},
			handler: options.handler,
		});
		this.rebuild();
		return undefined;
	}

	/** Definitions to merge into the global keybindings manager. */
	get keybindingDefinitions(): KeybindingDefinitions {
		const definitions: KeybindingDefinitions = {};
		for (const [actionId, record] of this.records) {
			definitions[actionId] = record.definition;
		}
		return definitions;
	}

	/** The user's keybindings.json config; only entries naming extension actions take effect here. */
	setUserBindings(bindings: KeybindingsConfig): void {
		this.userBindings = bindings;
		this.rebuild();
	}

	/** The action id a raw terminal input maps to, if any. */
	matchAction(data: string): string | undefined {
		for (const actionId of this.records.keys()) {
			if (this.manager.matches(data, actionId as Keybinding)) return actionId;
		}
		return undefined;
	}

	/**
	 * Invoke the handler of the matching action. Returns whether the input was
	 * consumed. A failing handler is contained: one broken shortcut must not
	 * take the input path down with it. An async handler is contained too - its
	 * rejection arrives after dispatch has returned, where nothing but the
	 * application's fatal-error boundary would be left to catch it.
	 */
	dispatch(data: string): boolean {
		const actionId = this.matchAction(data);
		const record = actionId ? this.records.get(actionId) : undefined;
		if (!actionId || !record) return false;
		const context: TuiExtensionShortcutContext = { extensionId: record.extensionId, actionId };
		try {
			const result = record.handler(context);
			if (isPromiseLike(result)) {
				void Promise.resolve(result).catch((error: unknown) => this.reportFailure(actionId, record, error));
			}
		} catch (error) {
			this.reportFailure(actionId, record, error);
		}
		return true;
	}

	private reportFailure(actionId: string, record: ExtensionShortcutRecord, error: unknown): void {
		this.reportDiagnostic({
			severity: "warning",
			code: "tui_extension.shortcut_failed",
			message: `Shortcut action "${actionId}" failed: ${formatError(error)}`,
			extensionId: record.extensionId,
		});
	}

	private rebuild(): void {
		this.manager = new KeybindingsManager(this.keybindingDefinitions, this.userBindings);
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}
