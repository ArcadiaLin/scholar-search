import { type Component, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { agentLabel } from "../labels.ts";
import { activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

export class HeaderView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const pending = this.state.pendingAgent;
		const label = agent ? agentLabel(agent) : (pending?.display.profileLabel ?? "starting");
		const model = agent?.display.model?.id ?? agent?.snapshot?.model.id ?? pending?.display.model?.id ?? "model";
		const parts = [label, singleLine(model, 120), ...this.state.segments.texts("header")];
		return new Text(`${theme.bold(theme.title("WIDI"))} ${theme.dim(`· ${parts.join(" · ")}`)}`, 1, 1).render(width);
	}
}
