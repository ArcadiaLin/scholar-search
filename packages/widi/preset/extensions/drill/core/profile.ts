import type { ExtensionActivationApi } from "../../../../apps/widi/src/core/extension/api.ts";
import { DRILL_HELPER_PROFILE_ID } from "../script/tour.en.ts";

/**
 * The role the rehearsal delegates to.
 *
 * It has to be registered rather than named, because a script cannot know what
 * profiles a given installation has: the tour runs in whatever directory the
 * person started WIDI in, against whatever roles they wrote. Shipping its own is
 * the only version of this act that works everywhere.
 *
 * No tools: a demonstration agent that could touch the disk would be the one
 * part of the tour that is not safe to run twice. Its session is kept, because
 * the dispose act tells the person their helper's transcript survives being
 * closed - and a tour that says so while quietly discarding it would be
 * teaching the wrong thing about the only claim they can go and check.
 */
export function registerDrillProfile(api: ExtensionActivationApi): void {
	api.registerProfile({
		id: DRILL_HELPER_PROFILE_ID,
		label: "Drill Helper",
		description: "A throwaway agent the rehearsal delegates to.",
		whenToUse: "Only inside a drill. It has no tools, and its session is kept so the tour can point at it.",
		systemPrompt: "You are a helper agent inside a WIDI rehearsal. Do exactly what you are asked, briefly, then stop.",
		persist: true,
		tools: [],
		projectContext: false,
		skillsListing: false,
	});
}
