import type { WidiTuiExtensionApi } from "../../../../apps/widi/src/tui/extension-host/index.ts";
import { DrillDirector } from "./director.ts";

/**
 * The TUI half: one instance for the application, and the only thing that
 * decides what happens next.
 *
 * It registers three ways in - the command, and the two keys that drive a beat -
 * and hands all of them to the same director, because a drill with two things
 * able to advance it is a drill with a race in it.
 */
export function activateDrillTui(api: WidiTuiExtensionApi): void {
	const director = new DrillDirector(api);

	// "materialize", not "active": the drill has to be the first thing a person
	// can do, and a staged session that has never spoken is exactly what it wants
	// to build its stage under. Materializing spawns that agent and sends nothing,
	// so nothing is spent to get here.
	api.registerCommand({
		kind: "action",
		agentPolicy: "materialize",
		name: "drill",
		description: "Rehearse WIDI on a temporary agent.",
		execute: async () => await director.run(),
	});

	// Named ids, not raw keys: the defaults below join the configurable
	// keybindings table as `ext.drill.next` and `ext.drill.abort`, and
	// keybindings.json overrides them like any built-in action.
	api.registerShortcut("next", {
		defaultKeys: "ctrl+n",
		description: "Advance the drill past a beat that has nothing to send",
		handler: () => director.advance(),
	});
	api.registerShortcut("abort", {
		defaultKeys: "ctrl+b",
		description: "Stop the drill and go back to your own agent",
		handler: () => director.abort(),
	});
}
