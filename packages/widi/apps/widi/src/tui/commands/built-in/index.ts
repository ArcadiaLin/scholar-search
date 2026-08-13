import type { CommandDefinition } from "../types.ts";
import { clearCommand } from "./clear.ts";
import type { CommandHost } from "./command-host.ts";
import { compactCommand } from "./compact.ts";
import { diagnosticsCommand } from "./diagnostics.ts";
import { disposeCommand } from "./dispose.ts";
import { divisionCommand } from "./division.ts";
import { exitCommand } from "./exit.ts";
import { forkCommand } from "./fork.ts";
import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { modelCommand } from "./model.ts";
import { newCommand } from "./new.ts";
import { promptCommand } from "./prompt.ts";
import { reloadCommand } from "./reload.ts";
import { renameCommand } from "./rename.ts";
import { resumeCommand } from "./resume.ts";
import { skillCommand } from "./skill.ts";
import { statusCommand } from "./status.ts";
import { themeCommand } from "./theme.ts";
import { thinkingCommand } from "./thinking.ts";
import { treeCommand } from "./tree.ts";
import { workspaceCommand } from "./workspace.ts";

export type { CommandHost } from "./command-host.ts";

/**
 * Every command WIDI ships, one file each. A command is a plain definition
 * when the orchestrator is all it needs, and a factory over the host when it
 * also has to move the application - that difference is the file's signature
 * rather than which list it was put in.
 */
export function widiCommands(host: CommandHost): readonly CommandDefinition[] {
	return [
		compactCommand,
		forkCommand(host),
		loginCommand,
		logoutCommand,
		modelCommand(host),
		thinkingCommand,
		renameCommand,
		reloadCommand,
		divisionCommand,
		resumeCommand(host),
		statusCommand,
		treeCommand(host),
		promptCommand,
		skillCommand,
		exitCommand(host),
		newCommand(host),
		clearCommand(host),
		diagnosticsCommand(host),
		disposeCommand(host),
		themeCommand(host),
		workspaceCommand(host),
	];
}
