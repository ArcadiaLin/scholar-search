import { type Component, getKeybindings, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { formatKeyLabel } from "../keybindings.ts";
import { activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

const MAX_VISIBLE_MESSAGES = 4;

/**
 * Queued follow-up messages of the active agent, shown above the editor.
 * The queue itself lives in core; this view only mirrors the texts carried
 * by queue_update events, so the footer counts and this list share one
 * source of truth.
 */
export class QueuedInputView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		const queued = [...agent.queue.followUp, ...agent.pendingFollowUps.map((pending) => pending.text)];
		if (queued.length === 0) return [];
		// The queue is read only where the run would otherwise stop, so the way
		// out of that wait belongs next to the queue itself. During maintenance
		// (compaction, tree navigation) there is no run to steer into.
		const steerKey = getKeybindings().getKeys("app.steer")[0];
		const steerHint =
			steerKey && agent.status === "running" && !agent.maintenance ? ` · ${formatKeyLabel(steerKey)} steer now` : "";
		const lines = [theme.dim(`queued · follow-up (sent when the agent is ready)${steerHint}`)];
		for (const text of queued.slice(-MAX_VISIBLE_MESSAGES)) {
			lines.push(`${theme.dim("❯")} ${theme.dim(singleLine(text, 400))}`);
		}
		if (queued.length > MAX_VISIBLE_MESSAGES) {
			lines.push(theme.dim(`… +${queued.length - MAX_VISIBLE_MESSAGES} more`));
		}
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
