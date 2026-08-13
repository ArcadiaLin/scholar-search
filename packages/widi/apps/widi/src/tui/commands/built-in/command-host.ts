import type { RuntimeModel } from "../../../core/types.ts";
import type { DiagnosticsLog } from "../../diagnostics-log.ts";

/**
 * What the application lends a command: primitives, not per-command wrappers.
 * A command that needs one takes this host at construction and composes the
 * effect itself, so the application never grows a branch on a command's name.
 *
 * quit() must be fire-and-forget: the TUI awaits in-flight submit tasks during
 * shutdown, so awaiting shutdown inside a command's execute would deadlock the
 * submit task that is running the command.
 */
export interface CommandHost {
	quit(): void;
	/** Stage an agent on the named profile (the default one when unnamed), keeping every live agent. */
	newAgent(profileId: string | undefined): Promise<void>;
	/** Close the current agent and stage an empty session on the same profile. */
	newSession(sourceAgentId: string | undefined): Promise<void>;
	/** Move the staged session to another directory; answers with what to show. */
	setWorkspace(path: string): Promise<string>;
	/** Set the staged session's model; answers with what to show. */
	setPendingModel(model: RuntimeModel): string;
	/** Repaint in a registered color scheme and remember it; answers with what to show. */
	setTheme(name: string): string;
	disposeAgent(agentId: string): Promise<void>;
	/** Make an agent the visible one, bringing it into the strip first. */
	switchToAgent(agentId: string): Promise<void>;
	/** Replace what the editor is holding. */
	setEditorText(text: string): void;
	/** Hand the command line that is running back to the editor, as an untaken command. */
	restoreSubmittedText(): void;
	readonly diagnostics: DiagnosticsLog;
	/** Put text on the system clipboard; throws when no clipboard could be reached. */
	copyText(text: string): Promise<void>;
}
