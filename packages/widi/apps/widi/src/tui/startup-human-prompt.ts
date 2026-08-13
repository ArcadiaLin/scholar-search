import { ProcessTerminal, setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { HumanRequestHandler } from "../core/human-request.ts";
import { createWidiKeybindings } from "./keybindings.ts";
import { createTuiApplicationState } from "./state.ts";
import { HumanRequestMenu } from "./views/human-request.ts";

/**
 * Lazy pre-runtime human-request surface. The project-trust confirmation (and
 * any future startup request) needs a working TUI before the application
 * exists, so the first request boots a throwaway terminal that is torn down
 * before the real application TUI starts. Never requested, never started.
 */
export class StartupHumanPrompt {
	private tui: TUI | undefined;
	private menu: HumanRequestMenu | undefined;

	readonly requestHuman: HumanRequestHandler = (request, signal) => this.ensureMenu().request(request, signal);

	private ensureMenu(): HumanRequestMenu {
		if (this.menu) return this.menu;
		setKeybindings(createWidiKeybindings());
		const tui = new TuiMainScreen(new ProcessTerminal());
		const menu = new HumanRequestMenu({
			host: tui,
			state: createTuiApplicationState(),
			resolveAgentLabel: () => "runtime",
			restoreFocus: () => {},
		});
		tui.addChild(menu);
		tui.setFocus(menu);
		tui.start();
		this.tui = tui;
		this.menu = menu;
		return menu;
	}

	dispose(): void {
		if (!this.tui || !this.menu) return;
		this.menu.close();
		this.tui.stop();
		this.tui = undefined;
		this.menu = undefined;
	}
}
