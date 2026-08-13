import type { CommandHost } from "../../src/tui/commands/built-in/index.ts";
import { DiagnosticsLog } from "../../src/tui/diagnostics-log.ts";

/** The application surface commands are built against, with nothing behind it. */
export function stubCommandHost(overrides: Partial<CommandHost> = {}): CommandHost {
	return {
		quit: () => {},
		newAgent: async () => {},
		newSession: async () => {},
		setWorkspace: async (path) => `Staged session will open in ${path}`,
		setPendingModel: (model) => `Staged session will use ${model.provider}/${model.id}`,
		setTheme: (name) => `Theme set to ${name}`,
		disposeAgent: async () => {},
		switchToAgent: async () => {},
		setEditorText: () => {},
		restoreSubmittedText: () => {},
		diagnostics: new DiagnosticsLog(),
		copyText: async () => {},
		...overrides,
	};
}
