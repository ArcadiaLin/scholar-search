import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
import type { ExtensionEventEnvelope, ExtensionMessage } from "../../src/core/extension/api.ts";
import type { ExtensionIdentity } from "../../src/core/extension/loader.ts";
import { TuiCapabilityRegistry } from "../../src/tui/capabilities.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import type { CommandDefinition } from "../../src/tui/commands/types.ts";
import {
	resetExtensionRenderers,
	type TuiExtensionEventBus,
	type TuiExtensionEventHandler,
	TuiExtensionHost,
	type TuiExtensionModuleImporter,
	type WidiTuiExtensionApi,
} from "../../src/tui/extension-host/index.ts";
import type { ShowOverlayOptions } from "../../src/tui/layout/overlay-stack.ts";
import { LayoutSlots } from "../../src/tui/layout/slots.ts";
import { createTuiApplicationState, type PersistentMessageItem, type ToolExecutionItem } from "../../src/tui/state.ts";
import { resetThemes } from "../../src/tui/theme/theme.ts";
import { defineLinesPresenter, presentToolExecution, unregisterToolPresenter } from "../../src/tui/tool-presenter.ts";
import { renderTimelineItem, type TimelineRenderContext } from "../../src/tui/views/utils/timeline-item.ts";
import type { JsonValue } from "../../src/utils/json.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(line: string): string {
	return line.replace(ANSI_SEQUENCE, "");
}

function identity(id: string, entryPath: string): ExtensionIdentity {
	return {
		id,
		source: { kind: "file", path: entryPath, resolvedPath: entryPath, root: { kind: "agent_dir", path: "/ext" } },
		divisions: [],
	};
}

function testCommand(name: string, description?: string): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name,
		description: description ?? `test command ${name}`,
		execute: async () => "ok",
	};
}

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "ls",
		status: "completed",
		isError: false,
		...overrides,
	};
}

/**
 * Headless host fixture (host doc open question 5): no terminal, no jiti, no
 * file system. Fake module namespaces sit behind an injected importer; the
 * command engine, shortcut registry, and layout slots are the real ones, and
 * diagnostics are collected into an array. The layout is pre-mounted with the
 * built-in anchors the extension-facing slots attach to.
 */
function createHostFixture() {
	const modules = new Map<string, unknown>();
	const moduleImporter: TuiExtensionModuleImporter = {
		importModuleNamespace: async (entryPath) => {
			if (!modules.has(entryPath)) throw new Error(`no such module: ${entryPath}`);
			return modules.get(entryPath);
		},
	};
	const engine = new CommandEngine();
	const diagnostics: OrchestratorDiagnostic[] = [];
	const shownOverlays: { component: Component; options?: ShowOverlayOptions; closed: boolean }[] = [];
	const overlays = {
		show: (component: Component, options?: ShowOverlayOptions) => {
			const record: { component: Component; options?: ShowOverlayOptions; closed: boolean } = {
				component,
				...(options !== undefined ? { options } : {}),
				closed: false,
			};
			shownOverlays.push(record);
			return {
				component,
				get closed() {
					return record.closed;
				},
				close: () => {
					record.closed = true;
				},
			};
		},
	};
	const editorState = { text: "" };
	let renderRequests = 0;
	const children: Component[] = [];
	const layout = new LayoutSlots();
	const anchors = [
		["header", "header"],
		["queuedInput", "aboveEditor"],
		["editor", "editor"],
		["footer", "footer"],
		["operationHint", "belowFooter"],
	] as const;
	for (const [key, slot] of anchors) {
		layout.register({ key, slot, scope: "global", factory: () => ({ render: () => [key], invalidate: () => {} }) });
	}
	layout.mount(
		{
			addChild: (component) => {
				children.push(component);
			},
			removeChild: (component) => {
				const index = children.indexOf(component);
				if (index >= 0) children.splice(index, 1);
			},
			children,
		},
		createTuiApplicationState(),
	);
	// A loop-back stand-in for the runtime bus: emitting reaches the host's own
	// subscribers, the way core's fan-out does not exclude the sender.
	const emitted: { extensionId: string; name: string; payload?: JsonValue }[] = [];
	const busHandlers: TuiExtensionEventHandler[] = [];
	const events: TuiExtensionEventBus = {
		emit: async (extensionId, name, payload) => {
			emitted.push({ extensionId, name, ...(payload !== undefined ? { payload } : {}) });
			for (const handler of [...busHandlers]) {
				await handler({
					name,
					...(payload !== undefined ? { payload } : {}),
					sourceExtensionId: extensionId,
					sourceAgentId: "agent-1",
					emittedAt: "2026-01-01T00:00:00.000Z",
				});
			}
		},
		subscribe: (handler) => {
			busHandlers.push(handler);
			return () => {
				const index = busHandlers.indexOf(handler);
				if (index >= 0) busHandlers.splice(index, 1);
			};
		},
	};
	const capabilities = new TuiCapabilityRegistry();
	capabilities.publish("editor", {
		getText: () => editorState.text,
		setText: (text) => {
			editorState.text = text;
		},
		insertAtCursor: (text) => {
			editorState.text += text;
		},
		clear: () => {
			editorState.text = "";
		},
	});
	const activate = (
		entries: readonly [string, ExtensionIdentity][],
		options?: { readonly bus?: false; readonly capabilities?: false },
	) =>
		new TuiExtensionHost({
			identities: entries.map(([, id]) => id),
			commandEngine: engine,
			layout,
			...(options?.capabilities === false ? {} : { capabilities }),
			overlays,
			requestRender: () => {
				renderRequests++;
			},
			reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			moduleImporter,
			...(options?.bus === false ? {} : { events }),
		});
	return {
		modules,
		engine,
		diagnostics,
		children,
		shownOverlays,
		editorState,
		activate,
		emitted,
		busSubscriberCount: () => busHandlers.length,
		renderRequests: () => renderRequests,
	};
}

describe("TuiExtensionHost", () => {
	it("runs the full chain: import, activate, register, dispose in reverse order", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: {
				apiVersion: 1,
				activate: (api: {
					registerCommand(d: CommandDefinition): void;
					registerShortcut(id: string, o: unknown): void;
					registerToolPresenter(t: string, p: unknown): void;
					onDispose(h: () => void): void;
					extensionId: string;
				}) => {
					expect(api.extensionId).toBe("alpha");
					api.registerCommand(testCommand("alpha-cmd"));
					api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => calls.push("shortcut") });
					api.registerToolPresenter(
						"alpha-tool",
						defineLinesPresenter({ describe: () => ({ verb: "Poke", target: "it" }) }),
					);
					api.onDispose(() => calls.push("alpha:onDispose"));
					return () => calls.push("alpha:returned");
				},
			},
		});
		fixture.modules.set("/ext/beta/index.ts", { tui: () => () => calls.push("beta:returned") });
		try {
			const host = fixture.activate([
				["alpha", identity("alpha", "/ext/alpha/index.ts")],
				["beta", identity("beta", "/ext/beta/index.ts")],
			]);
			await host.activate();

			expect(fixture.engine.get("alpha-cmd")?.description).toBe("test command alpha-cmd");
			expect(host.handleShortcut("\x18")).toBe(true);
			expect(calls).toEqual(["shortcut"]);
			const lines = presentToolExecution(toolItem({ toolName: "alpha-tool" }), 80).map((line) =>
				line.replace(ANSI_SEQUENCE, "").trimEnd(),
			);
			expect(lines).toEqual(["✓ Poke it"]);
			expect(fixture.diagnostics).toEqual([]);

			await host.dispose();
			// Reverse registration order: beta's returned dispose, then alpha's
			// returned dispose, then alpha's onDispose.
			expect(calls).toEqual(["shortcut", "beta:returned", "alpha:returned", "alpha:onDispose"]);
		} finally {
			unregisterToolPresenter("alpha-tool");
		}
	});

	it("skips extensions without a tui export silently", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/core-only/index.ts", { default: { apiVersion: 1, activate: () => {} } });

		const host = fixture.activate([["core-only", identity("core-only", "/ext/core-only/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics).toEqual([]);
	});

	it("skips factory-sourced identities: no entry file can carry a tui half", async () => {
		const fixture = createHostFixture();
		const factoryIdentity: ExtensionIdentity = { id: "programmatic", source: { kind: "factory" }, divisions: [] };

		const host = fixture.activate([["programmatic", factoryIdentity]]);
		await host.activate();

		expect(fixture.diagnostics).toEqual([]);
	});

	it("isolates a throwing activation and still activates the rest", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/broken/index.ts", {
			tui: {
				apiVersion: 1,
				activate: () => {
					throw new Error("boom");
				},
			},
		});
		fixture.modules.set("/ext/healthy/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) => {
				api.registerCommand(testCommand("healthy-cmd"));
			},
		});

		const host = fixture.activate([
			["broken", identity("broken", "/ext/broken/index.ts")],
			["healthy", identity("healthy", "/ext/healthy/index.ts")],
		]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.activation_failed",
			extensionId: "broken",
		});
		expect(fixture.diagnostics[0]?.message).toContain("boom");
		expect(fixture.engine.get("healthy-cmd")).toBeDefined();
	});

	it("reports a failed import as a diagnostic and moves on", async () => {
		const fixture = createHostFixture();

		const host = fixture.activate([["missing", identity("missing", "/ext/missing/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.load_failed",
			extensionId: "missing",
		});
	});

	it("refuses an unsupported tui apiVersion without touching the extension", async () => {
		const fixture = createHostFixture();
		let activated = false;
		fixture.modules.set("/ext/future/index.ts", {
			tui: {
				apiVersion: 99,
				activate: () => {
					activated = true;
				},
			},
		});

		const host = fixture.activate([["future", identity("future", "/ext/future/index.ts")]]);
		await host.activate();

		expect(activated).toBe(false);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.version_incompatible",
			extensionId: "future",
		});
	});

	it("rejects a malformed tui export", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/malformed/index.ts", { tui: 42 });

		const host = fixture.activate([["malformed", identity("malformed", "/ext/malformed/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.definition_invalid",
			extensionId: "malformed",
		});
	});

	it("projects a command name conflict with the extension id attached", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/first/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) => api.registerCommand(testCommand("same")),
		});
		fixture.modules.set("/ext/second/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) =>
				api.registerCommand(testCommand("same", "second registration")),
		});

		const host = fixture.activate([
			["first", identity("first", "/ext/first/index.ts")],
			["second", identity("second", "/ext/second/index.ts")],
		]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "command.name_conflict",
			extensionId: "second",
		});
		expect(fixture.engine.get("same")?.description).toBe("test command same");
	});

	it("dispatches a shortcut on its default keys and honors user overrides", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: { defaultKeys: string; handler(): void }): void }) => {
				api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => calls.push("poke") });
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(host.keybindingDefinitions["ext.acme.poke"]?.defaultKeys).toBe("ctrl+x");
		expect(host.handleShortcut("\x18")).toBe(true);
		expect(calls).toEqual(["poke"]);

		host.setUserKeybindings({ "ext.acme.poke": "ctrl+g" });
		expect(host.handleShortcut("\x18")).toBe(false);
		expect(host.handleShortcut("\x07")).toBe(true);
		expect(calls).toEqual(["poke", "poke"]);
	});

	it("refuses an invalid binding id and a duplicate action", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: unknown): void }) => {
				api.registerShortcut("  ", { defaultKeys: "ctrl+x", handler: () => {} });
				api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => {} });
				api.registerShortcut("poke", { defaultKeys: "ctrl+g", handler: () => {} });
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"tui_extension.shortcut_invalid",
			"tui_extension.shortcut_conflict",
		]);
	});

	it("contains a throwing shortcut handler", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: unknown): void }) => {
				api.registerShortcut("poke", {
					defaultKeys: "ctrl+x",
					handler: () => {
						throw new Error("handler boom");
					},
				});
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(host.handleShortcut("\x18")).toBe(true);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.shortcut_failed",
			extensionId: "acme",
		});
	});

	it("contains a rejecting async shortcut handler", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.registerShortcut("poke", {
					defaultKeys: "ctrl+x",
					handler: async () => {
						await Promise.resolve();
						throw new Error("async handler boom");
					},
				});
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		// Dispatch returns before the handler settles; the rejection lands later,
		// where an unwatched promise would reach the process instead.
		expect(host.handleShortcut("\x18")).toBe(true);
		expect(fixture.diagnostics).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.shortcut_failed",
			message: expect.stringContaining("async handler boom"),
			extensionId: "acme",
		});
	});

	it("forwards the built-in override diagnostic when a presenter shadows one", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerToolPresenter(t: string, p: unknown): void }) => {
				api.registerToolPresenter("bash", defineLinesPresenter({ describe: () => ({ verb: "Mine", target: "" }) }));
			},
		});
		try {
			const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
			await host.activate();

			expect(fixture.diagnostics[0]).toMatchObject({
				severity: "warning",
				code: "tool_presenter.overridden",
				extensionId: "acme",
			});
			const lines = presentToolExecution(toolItem({ toolName: "bash", args: { command: "ls" } }), 80).map((line) =>
				line.replace(ANSI_SEQUENCE, "").trimEnd(),
			);
			expect(lines).toEqual(["✓ Mine"]);
		} finally {
			unregisterToolPresenter("bash");
		}
	});

	it("reports a throwing disposer and still runs the rest", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/one/index.ts", {
			tui: () => () => {
				throw new Error("dispose boom");
			},
		});
		fixture.modules.set("/ext/two/index.ts", { tui: () => () => calls.push("two") });

		const host = fixture.activate([
			["one", identity("one", "/ext/one/index.ts")],
			["two", identity("two", "/ext/two/index.ts")],
		]);
		await host.activate();
		await host.dispose();

		expect(calls).toEqual(["two"]);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.dispose_failed",
			extensionId: "one",
		});
	});

	it("mounts a widget into its layout slot at runtime", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setWidget("clock", () => ({ render: () => ["acme-clock"], invalidate: () => {} }), {
					placement: "aboveEditor",
				});
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.children.map((component) => component.render(80))).toEqual([
			["header"],
			["queuedInput"],
			["acme-clock"],
			["editor"],
			["footer"],
			["operationHint"],
		]);
		expect(fixture.diagnostics).toEqual([]);
	});

	it("appends footer and header segments after their built-in anchors", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setFooter(() => ({ render: () => ["acme-footer"], invalidate: () => {} }));
				api.setHeader(() => ({ render: () => ["acme-header"], invalidate: () => {} }));
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.children.map((component) => component.render(80))).toEqual([
			["header"],
			["acme-header"],
			["queuedInput"],
			["editor"],
			["footer"],
			["acme-footer"],
			["operationHint"],
		]);
	});

	it("replaces a re-set widget, removes it on a undefined factory, and disposes both", async () => {
		const fixture = createHostFixture();
		const disposed: string[] = [];
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
				hostApi.setWidget(
					"clock",
					() => ({ render: () => ["clock-v1"], invalidate: () => {}, dispose: () => disposed.push("v1") }),
					{ placement: "belowEditor" },
				);
				hostApi.setWidget(
					"clock",
					() => ({ render: () => ["clock-v2"], invalidate: () => {}, dispose: () => disposed.push("v2") }),
					{ placement: "belowEditor" },
				);
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.children.map((component) => component.render(80))).toEqual([
			["header"],
			["queuedInput"],
			["editor"],
			["clock-v2"],
			["footer"],
			["operationHint"],
		]);
		expect(disposed).toEqual(["v1"]);

		api?.setWidget("clock", undefined, { placement: "belowEditor" });
		expect(fixture.children.map((component) => component.render(80))).toEqual([
			["header"],
			["queuedInput"],
			["editor"],
			["footer"],
			["operationHint"],
		]);
		expect(disposed).toEqual(["v1", "v2"]);
	});

	it("removes the extension's layout components when the host disposes", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setWidget("clock", () => ({ render: () => ["acme-clock"], invalidate: () => {} }), {
					placement: "aboveEditor",
				});
				api.setFooter(() => ({ render: () => ["acme-footer"], invalidate: () => {} }));
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();
		await host.dispose();

		expect(fixture.children.map((component) => component.render(80))).toEqual([
			["header"],
			["queuedInput"],
			["editor"],
			["footer"],
			["operationHint"],
		]);
	});

	it("contains a widget that throws while rendering", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setWidget(
					"clock",
					() => ({
						render: () => {
							throw new Error("widget exploded");
						},
						invalidate: () => {},
					}),
					{ placement: "aboveEditor" },
				);
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const rendered = fixture.children.map((component) => component.render(80).map(stripAnsi));
		expect(rendered[2]?.[0]).toContain("widget exploded");
		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.component_failed",
			extensionId: "acme",
		});

		// Every later frame renders the placeholder again without adding a
		// diagnostic per frame.
		fixture.children.map((component) => component.render(80));
		expect(fixture.diagnostics).toHaveLength(1);
	});

	it("contains a widget factory that throws", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setWidget(
					"clock",
					() => {
						throw new Error("factory exploded");
					},
					{ placement: "aboveEditor" },
				);
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const rendered = fixture.children.map((component) => component.render(80).map(stripAnsi));
		expect(rendered[2]?.[0]).toContain("factory exploded");
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.component_failed",
			extensionId: "acme",
		});
	});

	it("contains an overlay that throws while rendering", async () => {
		const fixture = createHostFixture();
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		api?.showOverlay({
			render: () => {
				throw new Error("overlay exploded");
			},
			invalidate: () => {},
		});

		const lines = fixture.shownOverlays[0]?.component.render(40).map(stripAnsi) ?? [];
		expect(lines[0]).toContain("overlay exploded");
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.component_failed",
			extensionId: "acme",
		});
	});

	it("refuses a widget with an invalid key", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.setWidget("  ", () => ({ render: () => ["nope"], invalidate: () => {} }), { placement: "aboveEditor" });
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.widget_invalid",
			extensionId: "acme",
		});
		expect(fixture.children.map((component) => component.render(80))).not.toContainEqual(["nope"]);
	});

	it("shows an overlay as dismissible by default and closes it on dispose", async () => {
		const fixture = createHostFixture();
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const overlay: Component = { render: () => ["overlay"], invalidate: () => {} };
		const handle = api?.showOverlay(overlay);
		expect(fixture.shownOverlays).toHaveLength(1);
		// The stack holds the render-guarded stand-in; the extension's handle
		// still names the component it passed in.
		expect(fixture.shownOverlays[0]?.component.render(80)).toEqual(["overlay"]);
		expect(handle?.component).toBe(overlay);
		expect(fixture.shownOverlays[0]?.options?.dismissible).toBe(true);
		expect(fixture.renderRequests()).toBe(1);
		expect(handle?.closed).toBe(false);

		handle?.close();
		expect(fixture.shownOverlays[0]?.closed).toBe(true);

		const lingering = api?.showOverlay({ render: () => ["second"], invalidate: () => {} });
		expect(lingering?.closed).toBe(false);
		await host.dispose();
		expect(fixture.shownOverlays[1]?.closed).toBe(true);
	});

	it("exposes the theme holder, switches themes by name, and lists them", async () => {
		const fixture = createHostFixture();
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
			},
		});

		try {
			const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
			await host.activate();

			expect(api?.getAllThemes().map((info) => info.name)).toEqual(["default"]);
			expect(api?.setTheme("no-such-theme")).toBe(false);
			expect(fixture.renderRequests()).toBe(0);
			expect(api?.setTheme("default")).toBe(true);
			expect(fixture.renderRequests()).toBe(1);
			// The holder is live: reading a paint through it after a switch hits
			// the new core (covered end-to-end in chat-view.test.ts).
			expect(api?.theme.palette.accent).toBeDefined();
		} finally {
			resetThemes();
		}
	});

	// The three shorthands are the editor capability, not a second path to the
	// editor: whatever timing the capability has, they have.
	it("reads, replaces, and pastes editor text through the editor capability", async () => {
		const fixture = createHostFixture();
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(api?.getEditorText()).toBe("");
		api?.setEditorText("hello");
		expect(fixture.editorState.text).toBe("hello");
		api?.pasteToEditor(" world");
		expect(fixture.editorState.text).toBe("hello world");
		expect(api?.getEditorText()).toBe("hello world");
	});

	it("degrades quietly with no application behind the host", async () => {
		const fixture = createHostFixture();
		let api: WidiTuiExtensionApi | undefined;
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (hostApi: WidiTuiExtensionApi) => {
				api = hostApi;
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]], { capabilities: false });
		await host.activate();

		api?.setEditorText("hello");
		expect(api?.getEditorText()).toBe("");
		expect(api?.capability("editor")).toBeUndefined();
		expect(fixture.diagnostics).toEqual([]);
	});
});

describe("extension renderers (host doc §6.3/§6.5)", () => {
	const renderContext: TimelineRenderContext = {
		liveThinkingIds: new Set(),
		livePreparingAssistantIds: new Set(),
		toolOutputExpanded: false,
	};

	function messageItem(extensionId: string, message: ExtensionMessage): PersistentMessageItem {
		return {
			type: "extension-message",
			id: "ext-1",
			entryId: "ext-1",
			extensionId,
			message,
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
		};
	}

	function plain(lines: string[]): string[] {
		return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trim());
	}

	afterEach(() => {
		resetExtensionRenderers();
	});

	it("replaces the body for the matching (extensionId, kind) pair only", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.registerMessageRenderer("text", (message) => ({
					render: () => [`CUSTOM:${message.kind}`],
					invalidate: () => {},
				}));
			},
		});
		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const own = plain(
			renderTimelineItem(messageItem("acme", { kind: "text", content: "built-in body" }), 60, renderContext),
		);
		expect(own.some((line) => line.includes("CUSTOM:text"))).toBe(true);
		// The built-in frame (title/meta) survives a body-only renderer.
		expect(own.some((line) => line.includes("persistent · acme · text"))).toBe(true);
		expect(own.some((line) => line.includes("built-in body"))).toBe(false);

		const other = plain(
			renderTimelineItem(messageItem("other", { kind: "text", content: "built-in body" }), 60, renderContext),
		);
		expect(other.some((line) => line.includes("CUSTOM:text"))).toBe(false);
		expect(other.some((line) => line.includes("built-in body"))).toBe(true);
		expect(fixture.diagnostics).toEqual([]);
	});

	it("degrades a throwing renderer to the built-in body with one diagnostic", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.registerMessageRenderer("text", () => {
					throw new Error("render boom");
				});
			},
		});
		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const item = messageItem("acme", { kind: "text", content: "built-in body" });
		const first = plain(renderTimelineItem(item, 60, renderContext));
		renderTimelineItem(item, 60, renderContext);

		expect(first.some((line) => line.includes("built-in body"))).toBe(true);
		const failures = fixture.diagnostics.filter((diagnostic) => diagnostic.code === "tui_extension.renderer_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ severity: "warning", extensionId: "acme" });
		expect(failures[0]?.message).toContain("render boom");
	});

	it("wraps the message-renderer body in an entry renderer's frame", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.registerMessageRenderer("text", () => ({ render: () => ["inner body"], invalidate: () => {} }));
				api.registerEntryRenderer("text", (_item, context) => ({
					render: () => [`ENTRY<${context.renderBody().join("/")}>`],
					invalidate: () => {},
				}));
			},
		});
		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		const lines = plain(renderTimelineItem(messageItem("acme", { kind: "text", content: "x" }), 60, renderContext));

		expect(lines).toEqual(["ENTRY<inner body>"]);
	});

	it("refuses a duplicate registration and unregisters on dispose", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.registerMessageRenderer("text", () => ({ render: () => ["first"], invalidate: () => {} }));
				api.registerMessageRenderer("text", () => ({ render: () => ["second"], invalidate: () => {} }));
			},
		});
		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.renderer_conflict",
			extensionId: "acme",
		});
		const item = messageItem("acme", { kind: "text", content: "built-in body" });
		expect(plain(renderTimelineItem(item, 60, renderContext)).some((line) => line.includes("first"))).toBe(true);

		await host.dispose();
		expect(plain(renderTimelineItem(item, 60, renderContext)).some((line) => line.includes("built-in body"))).toBe(
			true,
		);
	});
});

/**
 * The dual-end bus: the one channel between the `tui` half of an extension and
 * everything on the core side, which otherwise never see each other.
 */
describe("TuiExtensionHost extension events", () => {
	it("carries an event from one half to another extension's subscriber", async () => {
		const fixture = createHostFixture();
		const received: ExtensionEventEnvelope[] = [];
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.onExtensionEvent("drill:step", (envelope) => {
					received.push(envelope);
				});
			},
		});
		fixture.modules.set("/ext/beta/index.ts", {
			tui: async (api: WidiTuiExtensionApi) => {
				await api.emitExtensionEvent("drill:step", { index: 1 });
				await api.emitExtensionEvent("drill:other");
			},
		});
		const host = fixture.activate([
			["alpha", identity("alpha", "/ext/alpha/index.ts")],
			["beta", identity("beta", "/ext/beta/index.ts")],
		]);

		await host.activate();

		expect(fixture.emitted).toEqual([
			{ extensionId: "beta", name: "drill:step", payload: { index: 1 } },
			{ extensionId: "beta", name: "drill:other" },
		]);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ name: "drill:step", payload: { index: 1 }, sourceExtensionId: "beta" });
		expect(fixture.diagnostics).toEqual([]);
	});

	// One subscription for the whole host, and only once somebody asks for it.
	it("joins the bus once and leaves it on dispose", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/quiet/index.ts", { tui: () => {} });
		const quiet = fixture.activate([["quiet", identity("quiet", "/ext/quiet/index.ts")]]);
		await quiet.activate();
		expect(fixture.busSubscriberCount()).toBe(0);

		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.onExtensionEvent("one", () => {});
				api.onExtensionEvent("two", () => {});
			},
		});
		const host = fixture.activate([["alpha", identity("alpha", "/ext/alpha/index.ts")]]);
		await host.activate();
		expect(fixture.busSubscriberCount()).toBe(1);

		await host.dispose();
		expect(fixture.busSubscriberCount()).toBe(0);
	});

	it("reports a throwing handler and still reaches the next one", async () => {
		const fixture = createHostFixture();
		const reached: string[] = [];
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.onExtensionEvent("ping", () => {
					throw new Error("handler exploded");
				});
			},
		});
		fixture.modules.set("/ext/beta/index.ts", {
			tui: async (api: WidiTuiExtensionApi) => {
				api.onExtensionEvent("ping", () => {
					reached.push("beta");
				});
				await api.emitExtensionEvent("ping");
			},
		});
		const host = fixture.activate([
			["alpha", identity("alpha", "/ext/alpha/index.ts")],
			["beta", identity("beta", "/ext/beta/index.ts")],
		]);

		await host.activate();

		expect(reached).toEqual(["beta"]);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.event_handler_failed",
			extensionId: "alpha",
		});
		expect(fixture.diagnostics[0]?.message).toContain("handler exploded");
	});

	it("refuses a malformed subscription name at registration", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				api.onExtensionEvent("has space", () => {});
			},
		});
		const host = fixture.activate([["alpha", identity("alpha", "/ext/alpha/index.ts")]]);

		await host.activate();

		expect(fixture.busSubscriberCount()).toBe(0);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.event_name_invalid",
			extensionId: "alpha",
		});
	});

	it("rejects an emit when the host has no bus behind it", async () => {
		const fixture = createHostFixture();
		let failure: unknown;
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: async (api: WidiTuiExtensionApi) => {
				failure = await api.emitExtensionEvent("ping").catch((error: unknown) => error);
			},
		});
		const host = fixture.activate([["alpha", identity("alpha", "/ext/alpha/index.ts")]], { bus: false });

		await host.activate();

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("no extension event bus");
	});
});

/**
 * Capabilities: the second half of "one name, two answers" - the key an
 * extension mounts a widget under is the key it drives the built-in through.
 */
describe("TuiExtensionHost capabilities", () => {
	it("hands an extension the published surface under a layout key", async () => {
		const fixture = createHostFixture();
		let text: string | undefined;
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				const editor = api.capability("editor");
				editor?.setText("from the extension");
				text = editor?.getText();
			},
		});
		const host = fixture.activate([["alpha", identity("alpha", "/ext/alpha/index.ts")]]);

		await host.activate();

		expect(text).toBe("from the extension");
		expect(fixture.diagnostics).toEqual([]);
	});

	it("reads back undefined for a key nobody published", async () => {
		const fixture = createHostFixture();
		let seen: unknown = "unset";
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: (api: WidiTuiExtensionApi) => {
				seen = api.capability("no-such-part");
			},
		});
		const host = fixture.activate([["alpha", identity("alpha", "/ext/alpha/index.ts")]]);

		await host.activate();

		expect(seen).toBeUndefined();
		expect(fixture.diagnostics).toEqual([]);
	});
});
