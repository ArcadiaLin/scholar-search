import { type Component, isFocusable, truncateToWidth } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import { formatError } from "../../utils/errors.ts";
import { theme } from "../theme/theme.ts";

export interface SafeExtensionComponentOptions {
	readonly extensionId: string;
	/** What the component is, for the diagnostic and the placeholder line. */
	readonly label: string;
	readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;
}

/**
 * Containment for extension-authored layout components (host doc §6.5).
 *
 * A widget or overlay lives in the render loop, and the render loop runs from
 * timer and nextTick callbacks with nothing above it: a `render()` that throws
 * escapes as an uncaught error, and since the component stays mounted it does
 * so again on every frame, leaving the application unable to paint at all -
 * not even its own fatal-error overlay. So every call into extension component
 * code is guarded here, the same way message and entry renderers are.
 *
 * A failed component renders one placeholder line instead of its content and
 * reports a single diagnostic; further failures stay quiet rather than filling
 * the transcript with one diagnostic per frame.
 */
export function wrapExtensionComponent(inner: Component, options: SafeExtensionComponentOptions): Component {
	let reported = false;
	let lastError: unknown;

	const fail = (error: unknown): void => {
		lastError = error;
		if (reported) return;
		reported = true;
		options.reportDiagnostic({
			severity: "warning",
			code: "tui_extension.component_failed",
			message: `Extension '${options.extensionId}' ${options.label} failed to render: ${formatError(error)}. A placeholder is shown instead.`,
			extensionId: options.extensionId,
		});
	};

	const guard = (run: () => void): void => {
		try {
			run();
		} catch (error) {
			fail(error);
		}
	};

	const wrapper: Component & { dispose?(): void } = {
		render: (width: number): string[] => {
			try {
				return inner.render(width);
			} catch (error) {
				fail(error);
				return [
					theme.error(
						truncateToWidth(`[${options.extensionId} ${options.label}: ${errorSummary(lastError)}]`, width, "…"),
					),
				];
			}
		},
		invalidate: () => {
			guard(() => inner.invalidate());
		},
		dispose: () => {
			guard(() => (inner as Component & { dispose?(): void }).dispose?.());
		},
	};

	// Forwarded only when the inner component has them: pi-tui treats the
	// presence of `handleInput` as "this component consumes keystrokes" and the
	// presence of `focused` as "this component is a focus target", so adding
	// either one would change how the component behaves, not just how it fails.
	if (inner.handleInput) {
		wrapper.handleInput = (data: string) => {
			guard(() => inner.handleInput?.(data));
		};
	}
	if ("wantsKeyRelease" in inner) {
		Object.defineProperty(wrapper, "wantsKeyRelease", {
			get: () => inner.wantsKeyRelease,
			enumerable: true,
			configurable: true,
		});
	}
	if (isFocusable(inner)) {
		Object.defineProperty(wrapper, "focused", {
			get: () => inner.focused,
			set: (value: boolean) => {
				guard(() => {
					inner.focused = value;
				});
			},
			enumerable: true,
			configurable: true,
		});
	}
	return wrapper;
}

/**
 * A factory whose failure is contained the same way a render failure is: the
 * placeholder takes the component's place so one broken widget cannot abort
 * the layout mount that instantiates every other entry.
 */
export function wrapExtensionComponentFactory(
	factory: () => Component,
	options: SafeExtensionComponentOptions,
): () => Component {
	return () => {
		let inner: Component;
		try {
			inner = factory();
		} catch (error) {
			options.reportDiagnostic({
				severity: "warning",
				code: "tui_extension.component_failed",
				message: `Extension '${options.extensionId}' ${options.label} could not be created: ${formatError(error)}. A placeholder is shown instead.`,
				extensionId: options.extensionId,
			});
			const message = errorSummary(error);
			return {
				render: (width: number) => [
					theme.error(truncateToWidth(`[${options.extensionId} ${options.label}: ${message}]`, width, "…")),
				],
				invalidate: () => {},
			};
		}
		return wrapExtensionComponent(inner, options);
	};
}

function errorSummary(error: unknown): string {
	return formatError(error).split("\n")[0] ?? "failed";
}
