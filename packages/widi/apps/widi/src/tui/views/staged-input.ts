import { type Component, getKeybindings, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { formatKeyLabel } from "../keybindings.ts";
import { activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

const MAX_VISIBLE_MESSAGES = 3;

/**
 * Text staged for the active agent, shown above the editor. A read-only mirror
 * of `agent.staged`, the same way QueuedInputView mirrors the core queue: if
 * the buffer ever moves into core, this component does not change.
 */
export class StagedInputView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent || agent.staged.length === 0) return [];
		const editKey = getKeybindings().getKeys("app.staged.edit")[0];
		// Only offered with an empty editor, which is also the only state the
		// edit path accepts: it takes the draft out of the buffer and into the
		// editor, and there is nowhere to put a draft the human is mid-way
		// through typing.
		const editHint = editKey && agent.stagedEditing === undefined ? ` · ${formatKeyLabel(editKey)} edit` : "";
		const count = agent.staged.length;
		const lines = [
			theme.dim(`staged · ${count} ${count === 1 ? "message" : "messages"} (sent before your next input)${editHint}`),
		];
		for (const draft of agent.staged.slice(-MAX_VISIBLE_MESSAGES)) {
			lines.push(`${theme.dim("↳")} ${theme.dim(singleLine(draft.text, 400))}`);
		}
		if (count > MAX_VISIBLE_MESSAGES) {
			lines.push(theme.dim(`… +${count - MAX_VISIBLE_MESSAGES} more`));
		}
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
