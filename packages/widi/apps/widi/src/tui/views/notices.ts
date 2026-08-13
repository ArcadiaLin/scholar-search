import { type Component, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText, singleLine } from "../format.ts";
import { diagnosticGlyph } from "../labels.ts";
import type { TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

export class NoticeView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const startup = this.state.globalNotices.filter((notice) => notice.kind === "startup");
		const transient = this.state.globalNotices.filter((notice) => notice.kind !== "startup").slice(-4);
		const notices = [...startup, ...transient];
		if (notices.length === 0) return [];
		// The expand toggle means one thing everywhere: a collapsed notice is a
		// collapsed detail like any other, and the startup help lives here.
		const expanded = this.state.toolOutputExpanded;
		const collapse = (text: string, max?: number) =>
			expanded ? sanitizeTerminalText(text) : max === undefined ? singleLine(text) : singleLine(text, max);
		const lines = notices.map((notice) => {
			if (notice.kind === "startup") {
				return theme.dim(collapse(notice.text, 400));
			}
			const attribution = [
				notice.agentId && `agent:${notice.agentId}`,
				notice.extensionId && `extension:${notice.extensionId}`,
			]
				.filter(Boolean)
				.join(" · ");
			if (notice.diagnostic) {
				const color = theme.severityPaint(notice.diagnostic.severity);
				return color(`${diagnosticGlyph(notice.diagnostic)} ${notice.diagnostic.code}: ${collapse(notice.text)}`);
			}
			const text = notice.textMode === "full" ? sanitizeTerminalText(notice.text) : collapse(notice.text);
			return theme.info(`✱${attribution ? ` ${attribution}` : ""} ${text}`);
		});
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
