import type { ExtensionStatusSnapshot } from "../../../core/extension/api.ts";
import {
	type ExtensionStatus,
	type ExtensionStatusRegion,
	type ExtensionTone,
	parseExtensionStatus,
} from "../../extension-host/presentation.ts";
import type { AgentViewState } from "../../state.ts";
import { theme } from "../../theme/theme.ts";

/**
 * Map an extension tone onto the theme's status hues. Tones are semantic
 * emphasis, not colors, so this is the one place
 * that pairing is decided; "neutral" (and an unset tone) means no paint.
 */
export function tonePaint(tone: ExtensionTone | undefined): (text: string) => string {
	switch (tone) {
		case "info":
			return theme.info;
		case "success":
			return theme.ok;
		case "warning":
			return theme.warn;
		case "danger":
			return theme.error;
		default:
			return (text) => text;
	}
}

/**
 * One keyed status this TUI could read. Core stores the value opaquely, so the
 * parse happens here and a status this build cannot read is simply not shown -
 * the same degrade a renderer does for a message kind it does not know.
 */
export interface ExtensionStatusView {
	readonly extensionId: string;
	readonly key: string;
	readonly updatedAt: string;
	readonly status: ExtensionStatus;
}

function toStatusView(snapshot: ExtensionStatusSnapshot): ExtensionStatusView | undefined {
	const status = parseExtensionStatus(snapshot.status);
	return status && { extensionId: snapshot.extensionId, key: snapshot.key, updatedAt: snapshot.updatedAt, status };
}

/** Statuses an extension aimed at one region; an unset region means "panel". */
export function extensionStatusesInRegion(agent: AgentViewState, region: ExtensionStatusRegion): ExtensionStatusView[] {
	return [...agent.extensionStatuses.values()].flatMap((snapshot) => {
		const view = toStatusView(snapshot);
		return view && (view.status.region ?? "panel") === region ? [view] : [];
	});
}

/** The freshest status aimed at a region, for clients that show only one. */
export function latestExtensionStatus(
	agent: AgentViewState | undefined,
	region: ExtensionStatusRegion,
): ExtensionStatusView | undefined {
	if (!agent) return undefined;
	let latest: ExtensionStatusView | undefined;
	for (const view of extensionStatusesInRegion(agent, region)) {
		// ISO 8601 timestamps order lexicographically.
		if (!latest || view.updatedAt > latest.updatedAt) latest = view;
	}
	return latest;
}
