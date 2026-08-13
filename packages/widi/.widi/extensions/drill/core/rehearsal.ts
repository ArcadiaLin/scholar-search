import type { AgentToolsSnapshot, ExtensionActivationApi } from "../../../../apps/widi/src/core/extension/api.ts";
import {
	DRILL_EVENT,
	DRILL_MODEL_REFERENCE,
	type DrillChapterId,
	readBegin,
	readEnd,
	readReport,
} from "../protocol.ts";
import { setDrillLanguage } from "./provider.ts";

/**
 * Putting one agent into rehearsal, and taking it back out.
 *
 * The drill runs on the agent the person is already on. It does not build a
 * stage of its own: `/drill` from a cold start has already materialised an empty
 * agent, and moving someone to a second agent before the tour has explained what
 * an agent is teaches a switch instead of the thing they came for.
 *
 * So rehearsal is a mode, not a place. Two things change while it lasts - the
 * model becomes the scripted one, and the tools the script calls are added to
 * whatever the role already had - and both are put back at the end. Everything
 * remembered here is remembered so it can be restored.
 *
 * Every agent runs one of these, so each handler starts by deciding whether it
 * is the one being addressed. `begin` is addressed by the envelope, because the
 * director's events are attributed to the visible agent; everything afterwards
 * is addressed by the agent id `ready` handed back.
 */

const CHAPTERS: readonly DrillChapterId[] = ["tour"];

/**
 * Answer the director's roll call.
 *
 * Outside the division on purpose, and the only thing that is. Everything the
 * drill does lives in `tour`, so with the division off there is nothing to run -
 * but somebody still has to say so, or `/drill` would sit waiting on a reply
 * that is never coming and time out into a worse message than the true one.
 */
export function installDrillRollCall(api: ExtensionActivationApi): void {
	api.onExtensionEvent(DRILL_EVENT.hello, async (_envelope, context) => {
		await context.actions.emitExtensionEvent(DRILL_EVENT.runtime, {
			agentId: context.agentId,
			chapters: CHAPTERS.map((id) => ({ id, enabled: api.isDivisionEnabled(id) })),
		});
	});
}

/**
 * What the tour's script calls for.
 *
 * Added to the role rather than replacing it, and removed again at the end. A
 * tour that failed halfway because the person's own role happens not to carry
 * `spawn_agent` would be blaming them for its own assumption. Nothing here can
 * change anything: reading and delegating only.
 */
const TOUR_TOOLS = ["ls", "list_agents", "spawn_agent", "dispose_agent"] as const;

export function installDrillRehearsal(api: ExtensionActivationApi): void {
	/** Set on the drilling agent's runtime alone, and the whole of what it restores. */
	let restore: { readonly model: string; readonly tools: AgentToolsSnapshot } | undefined;

	api.onExtensionEvent(DRILL_EVENT.begin, async (envelope, context) => {
		// The director belongs to no agent, so core attributes its events to the
		// agent on screen. Comparing against that is the whole of the addressing:
		// exactly one runtime in the process matches, and it is the right one.
		if (envelope.sourceAgentId !== context.agentId || restore !== undefined) return;
		const request = readBegin(envelope.payload);
		if (!request) return;
		setDrillLanguage(request.language);
		try {
			const model = context.actions.getModel();
			const tools = context.actions.getTools();
			restore = { model: `${model.provider}/${model.id}`, tools };
			await context.actions.setModel(DRILL_MODEL_REFERENCE);
			await context.actions.setTools(union(tools.toolNames, TOUR_TOOLS), union(tools.activeToolNames, TOUR_TOOLS));
			await context.actions.emitExtensionEvent(DRILL_EVENT.ready, { agentId: context.agentId });
		} catch (error) {
			await restoreAgent(context.actions, restore);
			restore = undefined;
			await context.actions.emitExtensionEvent(DRILL_EVENT.failed, { reason: String(error) });
		}
	});

	// The director cannot see core events, so this is how it learns a beat is
	// over. Only from the agent being drilled, and only while it is.
	api.observe("agent_idle", async (event, context) => {
		if (restore === undefined || event.agentId !== context.agentId) return;
		await context.actions.emitExtensionEvent(DRILL_EVENT.turnSettled, { agentId: context.agentId });
	});

	api.onExtensionEvent(DRILL_EVENT.report, async (envelope, context) => {
		const report = readReport(envelope.payload);
		if (!report || report.agentId !== context.agentId) return;
		// The one durable write of the whole drill. It lands on the branch the
		// tour ran on, which is where somebody looking for what happened will be.
		await context.actions.publishMessage({
			kind: "table",
			title: report.title,
			columns: report.columns.map((label) => ({ label })),
			rows: report.rows.map((row) => [...row]),
		});
	});

	api.onExtensionEvent(DRILL_EVENT.end, async (envelope, context) => {
		if (readEnd(envelope.payload)?.agentId !== context.agentId) return;
		await restoreAgent(context.actions, restore);
		restore = undefined;
	});
}

function union(current: readonly string[], extra: readonly string[]): string[] {
	return [...new Set([...current, ...extra])];
}

async function restoreAgent(
	actions: {
		setModel(reference: string): Promise<unknown>;
		setTools(names: string[], active?: string[]): Promise<void>;
	},
	restore: { readonly model: string; readonly tools: AgentToolsSnapshot } | undefined,
): Promise<void> {
	if (restore === undefined) return;
	try {
		await actions.setTools([...restore.tools.toolNames], [...restore.tools.activeToolNames]);
		await actions.setModel(restore.model);
	} catch {
		// Best effort: the drill is over either way, and a failed restore is worth
		// less noise than an exception thrown into the bus dispatcher.
	}
}
