import { type Component, Text } from "@earendil-works/pi-tui";
import { formatRelativeAge, singleLine } from "../format.ts";
import { activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { extensionStatusesInRegion, tonePaint } from "./utils/extension-status.ts";

export class StatusView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		// The panel is the default region; footer and agent-strip statuses are
		// surfaced by their own components.
		const statuses = extensionStatusesInRegion(agent, "panel");
		const segments = this.state.segments.texts("status");
		if (statuses.length === 0 && segments.length === 0) return [];
		const lines = statuses.slice(0, 4).map((entry) => {
			const paint = tonePaint(entry.status.tone);
			const progress = entry.status.progress;
			let progressText = "";
			if (progress?.total !== undefined) {
				progressText = ` ${progressBar(progress.completed, progress.total, 10)} ${progress.completed}/${progress.total}`;
			} else if (progress) {
				const spinner = ["⠋", "⠙", "⠹", "⠸"][Math.floor(Date.now() / 160) % 4];
				progressText = ` ${spinner} ${progress.completed}/?`;
			}
			// A status is never cleared automatically when a command ends, so its
			// age is the only staleness signal the user gets.
			const age = statusAge(entry.updatedAt);
			const icon = entry.status.icon ? paint(entry.status.icon) : theme.info("✻");
			return `${icon} ${theme.dim(entry.extensionId)} ${paint(singleLine(entry.status.text, 400))}${progressText}${
				age ? theme.dim(` · ${age}`) : ""
			}`;
		});
		if (statuses.length > 4) {
			lines.push(theme.dim(`+${statuses.length - 4} more extension statuses`));
		}
		// A row of its own rather than a suffix: the panel is a list, and a
		// segment here is another entry in it.
		lines.push(...segments);
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}

function statusAge(updatedAt: string): string | undefined {
	const elapsedMs = Date.now() - Date.parse(updatedAt);
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
	return formatRelativeAge(elapsedMs);
}

function progressBar(completed: number, total: number, width: number): string {
	if (total <= 0) return "░".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((completed / total) * width)));
	return `${theme.ok("█".repeat(filled))}${theme.dim("░".repeat(width - filled))}`;
}
