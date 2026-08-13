import type {
	ExtensionActivationApi,
	ExtensionObservedEventName,
} from "../../../../apps/widi/src/core/extension/api.ts";
// The exhaustive list is what makes the ledger's "this never fired" trustworthy,
// so it is imported rather than copied. It is not on the author-facing barrel
// yet; a ledger built by hand would go stale the day core adds an event.
import { EXTENSION_OBSERVED_EVENT_NAMES } from "../../../../apps/widi/src/core/extension/types.ts";
import { DRILL_EVENT } from "../protocol.ts";

/**
 * The sensors: every observed event core defines, reported the first time it
 * fires and never again.
 *
 * First-sighting-only is not an optimisation. `agent_harness_event` alone
 * arrives dozens of times a turn, and forwarding all of it would turn the
 * extension bus into a log pipe. What the ledger is asked is whether a thing
 * happened at all, and one report answers that for good.
 *
 * Every runtime installs one of these, the user's own agent included, so the
 * payload names its agent and the director keeps only the stage's.
 */
export function installDrillLedger(api: ExtensionActivationApi): void {
	const seen = new Set<string>();
	for (const eventName of Object.keys(EXTENSION_OBSERVED_EVENT_NAMES) as ExtensionObservedEventName[]) {
		api.observe(eventName, async (_event, context) => {
			if (seen.has(eventName)) return;
			seen.add(eventName);
			await context.actions.emitExtensionEvent(DRILL_EVENT.observed, { agentId: context.agentId, event: eventName });
		});
	}
}
