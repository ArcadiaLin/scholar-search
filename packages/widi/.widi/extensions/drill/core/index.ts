import type { ExtensionActivationApi } from "../../../../apps/widi/src/core/extension/api.ts";
import { installDrillLedger } from "./ledger.ts";
import { registerDrillProfile } from "./profile.ts";
import { registerDrillProvider } from "./provider.ts";
import { installDrillRehearsal, installDrillRollCall } from "./rehearsal.ts";

/**
 * The core half: one runtime per agent, and each one is a sensor and a pair of
 * hands.
 *
 * It never drives the drill. There are as many of these as there are agents and
 * they all hear the same bus, so anything holding a cursor here would be racing
 * its own copies. Direction belongs to the TUI half, which exists exactly once.
 *
 * The parts do not overlap, and the separation is what keeps that true: the
 * provider answers turns, the profile is a role it can delegate to, the
 * rehearsal module answers the director, and the ledger only ever reports.
 */
export async function activateDrillCore(api: ExtensionActivationApi): Promise<void> {
	installDrillRollCall(api);
	// Everything else is the `tour` division, so switching it off registers
	// nothing at all rather than registering and then declining to act - which is
	// the difference the tour itself points out in its last act.
	await api.division("tour", (tour) => {
		registerDrillProvider(tour);
		registerDrillProfile(tour);
		installDrillRehearsal(tour);
		installDrillLedger(tour);
	});
}
