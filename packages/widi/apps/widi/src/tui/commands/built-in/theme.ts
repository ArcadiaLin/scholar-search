import { getAllThemes, getThemeName } from "../../theme/theme.ts";
import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

export function themeCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "theme",
		description: "Switch the color scheme.",
		argumentHint: "[name]",
		requiresArgument: true,
		argumentCompletes: true,
		complete: async () => {
			const active = getThemeName();
			return getAllThemes().map((entry) => ({
				value: entry.name,
				description: entry.name === active ? "active" : entry.sourcePath,
			}));
		},
		execute: async (_context, argument) => host.setTheme(argument.trim()),
	};
}
