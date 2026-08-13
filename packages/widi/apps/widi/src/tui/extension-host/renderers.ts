import type { Component } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type { ExtensionMessage } from "../../core/extension/api.ts";
import { formatError } from "../../utils/errors.ts";
import type { PersistentMessageItem } from "../state.ts";

/**
 * Renderer registry behind `WidiTuiExtensionApi.registerMessageRenderer` and
 * `registerEntryRenderer` (host doc §6.3). Renderers claim one extension's
 * messages by (extensionId, kind) — the pair core stamps on every published
 * message, so two extensions can reuse a kind name without ever seeing each
 * other's content. A message renderer replaces the body of the built-in
 * frame; an entry renderer wraps that body and replaces the whole frame
 * (title, attribution meta, and all).
 *
 * Failure isolation (host doc §6.5): a throwing renderer is contained to its
 * item — the call falls back to the built-in rendering and reports one
 * `tui_extension.renderer_failed` diagnostic per registration, so a broken
 * renderer cannot spam a diagnostic per render frame.
 */

export interface TuiExtensionMessageRenderContext {
	readonly extensionId: string;
	/** Usable body width (the built-in frame's text padding is outside it). */
	readonly width: number;
}

export type TuiExtensionMessageRenderer = (
	message: ExtensionMessage,
	context: TuiExtensionMessageRenderContext,
) => Component;

export interface TuiExtensionEntryRenderContext extends TuiExtensionMessageRenderContext {
	/** The body after message-renderer resolution, or the built-in body. */
	renderBody(): string[];
}

export type TuiExtensionEntryRenderer = (
	item: PersistentMessageItem,
	context: TuiExtensionEntryRenderContext,
) => Component;

interface RendererRegistration<R> {
	readonly extensionId: string;
	readonly kind: string;
	readonly render: R;
}

const messageRenderers = new Map<string, RendererRegistration<TuiExtensionMessageRenderer>>();
const entryRenderers = new Map<string, RendererRegistration<TuiExtensionEntryRenderer>>();
const reportedFailures = new Set<string>();
let reporter: ((diagnostic: OrchestratorDiagnostic) => void) | undefined;

function registryKey(extensionId: string, kind: string): string {
	return `${extensionId}\u0000${kind}`;
}

/** The host wires its diagnostic channel in once at construction. */
export function setExtensionRendererReporter(report: (diagnostic: OrchestratorDiagnostic) => void): void {
	reporter = report;
}

/** Drop every registration and the failure memory. Test support. */
export function resetExtensionRenderers(): void {
	messageRenderers.clear();
	entryRenderers.clear();
	reportedFailures.clear();
	reporter = undefined;
}

function registerRenderer<R>(
	registry: Map<string, RendererRegistration<R>>,
	label: string,
	extensionId: string,
	kind: string,
	render: R,
): OrchestratorDiagnostic | undefined {
	if (!kind.trim() || /\s/.test(kind)) {
		return {
			severity: "warning",
			code: "tui_extension.renderer_invalid",
			message: `Extension '${extensionId}' registered a ${label} renderer with an invalid kind; it was refused.`,
			extensionId,
		};
	}
	const key = registryKey(extensionId, kind);
	if (registry.has(key)) {
		return {
			severity: "warning",
			code: "tui_extension.renderer_conflict",
			message: `A ${label} renderer for kind "${kind}" is already registered for extension '${extensionId}'; the new registration was refused.`,
			extensionId,
		};
	}
	registry.set(key, { extensionId, kind, render });
	reportedFailures.delete(key);
	return undefined;
}

export function registerExtensionMessageRenderer(
	extensionId: string,
	kind: string,
	render: TuiExtensionMessageRenderer,
): OrchestratorDiagnostic | undefined {
	return registerRenderer(messageRenderers, "message", extensionId, kind, render);
}

export function registerExtensionEntryRenderer(
	extensionId: string,
	kind: string,
	render: TuiExtensionEntryRenderer,
): OrchestratorDiagnostic | undefined {
	return registerRenderer(entryRenderers, "entry", extensionId, kind, render);
}

export function unregisterExtensionMessageRenderer(extensionId: string, kind: string): boolean {
	return messageRenderers.delete(registryKey(extensionId, kind));
}

export function unregisterExtensionEntryRenderer(extensionId: string, kind: string): boolean {
	return entryRenderers.delete(registryKey(extensionId, kind));
}

function reportFailure(registration: { extensionId: string; kind: string }, error: unknown): void {
	const key = registryKey(registration.extensionId, registration.kind);
	if (reportedFailures.has(key)) return;
	reportedFailures.add(key);
	reporter?.({
		severity: "warning",
		code: "tui_extension.renderer_failed",
		message: `Extension '${registration.extensionId}' renderer for kind "${registration.kind}" failed: ${formatError(error)}. The built-in rendering is used instead.`,
		extensionId: registration.extensionId,
	});
}

/** Render a renderer-produced component, contained like the factory call. */
function renderComponentSafely(
	registration: { extensionId: string; kind: string },
	create: () => Component,
	width: number,
): string[] | undefined {
	try {
		return create().render(width);
	} catch (error) {
		reportFailure(registration, error);
		return undefined;
	}
}

/**
 * The message-renderer body for the item, or undefined when no renderer
 * claims it or the renderer failed (the caller then uses the built-in body).
 */
export function renderExtensionMessageBody(item: PersistentMessageItem, width: number): string[] | undefined {
	const registration = messageRenderers.get(registryKey(item.extensionId, item.message.kind));
	if (!registration) return undefined;
	return renderComponentSafely(
		registration,
		() => registration.render(item.message, { extensionId: item.extensionId, width }),
		width,
	);
}

/**
 * The entry-renderer frame for the item, or undefined when no entry renderer
 * claims it or it failed. The renderer's renderBody() resolves the message
 * renderer first and the built-in body second, so an entry renderer wraps
 * whichever body the item would have shown.
 */
export function renderExtensionEntry(
	item: PersistentMessageItem,
	width: number,
	builtInBody: (width: number) => string[],
): string[] | undefined {
	const registration = entryRenderers.get(registryKey(item.extensionId, item.message.kind));
	if (!registration) return undefined;
	const renderBody = () => renderExtensionMessageBody(item, width) ?? builtInBody(width);
	return renderComponentSafely(
		registration,
		() => registration.render(item, { extensionId: item.extensionId, width, renderBody }),
		width,
	);
}
