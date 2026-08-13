import { type Static, Type } from "typebox";
import { AgentGoneError, type AgentStop, type AgentToOrchestratorHost } from "../../host.ts";
import type { AgentNotice } from "../../message.ts";
import type { AgentId } from "../../types.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

/**
 * `taken` means another agent already watches the target: a stop has exactly
 * one reader. The rest mirror the dispose vocabulary.
 */
export type AgentWatchOutcome = "watching" | "not_watching" | "taken" | "outside_tree" | "self" | "unknown";

/**
 * One agent's claim on another's stops.
 *
 * `pending` is the difference between waiting on an agent and merely keeping an
 * eye on it. It is set when work is handed over and cleared by the report that
 * answers it, which is what lets a watcher's own stop be judged: an agent that
 * is waiting on a subagent has not stopped in any sense its own watcher cares
 * about.
 */
interface AgentWatch {
	readonly watcherAgentId: AgentId;
	pending: boolean;
}

/**
 * Who is watching whom, and the reporting that follows from it.
 *
 * The runtime answers three questions - has this agent stopped, what did it
 * say, put this text in my inbox - and every judgement built on those answers
 * is here: which idles count as a stop, that a stop has one reader, and what
 * the report says.
 *
 * A watch is standing, not spent on one stop. It ends when the watched agent is
 * disposed, when the watcher is disposed, or when the watcher drops it - and
 * nothing else, so a watcher that has not let go always knows what is happening
 * over there. One table per runtime, since exclusivity is a claim on the
 * target. In memory only - a resume brings back no subagents to watch.
 */
export class AgentWatches {
	private readonly _watches = new Map<AgentId, AgentWatch>();

	/**
	 * Claim the target's stops, or re-arm a claim already held: calling this as
	 * work is handed over is what marks the watcher as waiting rather than just
	 * listening.
	 */
	start(host: AgentToOrchestratorHost, targetAgentId: AgentId): AgentWatchOutcome {
		if (targetAgentId === host.agentId) return "self";
		if (!host.describe(targetAgentId)) return "unknown";
		if (!host.sharesTree(targetAgentId)) return "outside_tree";
		const current = this._watches.get(targetAgentId);
		if (current && current.watcherAgentId !== host.agentId) return "taken";
		if (current) {
			current.pending = true;
			return "watching";
		}
		this._watches.set(targetAgentId, { watcherAgentId: host.agentId, pending: true });
		void this._report(host, targetAgentId);
		return "watching";
	}

	/** Never fails: whatever the reason, the caller is not watching afterwards. */
	stop(host: AgentToOrchestratorHost, targetAgentId: AgentId): AgentWatchOutcome {
		if (this.isWatchedBy(targetAgentId, host.agentId)) this._watches.delete(targetAgentId);
		return "not_watching";
	}

	isWatchedBy(targetAgentId: AgentId, watcherAgentId: AgentId): boolean {
		return this._watches.get(targetAgentId)?.watcherAgentId === watcherAgentId;
	}

	/** Whether this agent is itself waiting on a subagent that has not reported. */
	private _awaitsSubagent(agentId: AgentId): boolean {
		for (const watch of this._watches.values()) {
			if (watch.watcherAgentId === agentId && watch.pending) return true;
		}
		return false;
	}

	/**
	 * Report every stop worth reporting for as long as the watch stands. Looping
	 * is what keeps the gates below simple: an idle that is not the agent stopping
	 * is skipped rather than needing a rule about when to re-register.
	 */
	private async _report(host: AgentToOrchestratorHost, targetAgentId: AgentId): Promise<void> {
		for (;;) {
			let stop: AgentStop;
			try {
				stop = await host.waitForAgentStop(targetAgentId);
			} catch (error) {
				const ended = this._watches.get(targetAgentId);
				if (ended?.watcherAgentId !== host.agentId) return;
				this._watches.delete(targetAgentId);
				// A watcher that is gone has no turn left to read anything in.
				if (error instanceof AgentGoneError && error.agentId === targetAgentId && ended.pending) {
					await this._deliver(host, targetAgentId, { status: "gone" }, true);
				}
				return;
			}
			const watch = this._watches.get(targetAgentId);
			if (watch?.watcherAgentId !== host.agentId) return;
			// `ready` and `maintenance` have no turn behind them; an unanswered
			// delegation means it is waiting on work that will wake it.
			if (stop.reason === "ready" || stop.reason === "maintenance") continue;
			if (this._awaitsSubagent(targetAgentId)) continue;
			const awaited = watch.pending;
			// A human taking the agent over answers nothing the watcher handed it, so
			// the delegation is still outstanding after the report.
			if (stop.abortedBy !== "human") watch.pending = false;
			await this._deliver(
				host,
				targetAgentId,
				{
					status: "idle",
					reason: stop.reason,
					...(stop.abortedBy === undefined ? undefined : { abortedBy: stop.abortedBy }),
				},
				awaited,
			);
		}
	}

	/**
	 * `awaited` is what decides the urgency. Work the watcher handed over and has
	 * not heard back on reaches the turn it is in: that is the answer it delegated
	 * for, and finishing a long turn before reading it is how a watcher keeps
	 * working on something the report would have changed. A stop it was merely
	 * keeping an eye on waits for that turn to end.
	 *
	 * Failure is swallowed because the party that would be told is the one that
	 * could not be reached.
	 */
	private async _deliver(
		host: AgentToOrchestratorHost,
		targetAgentId: AgentId,
		notice: AgentNotice,
		awaited: boolean,
	): Promise<void> {
		const report = await host.readAgentReport(targetAgentId).catch(() => undefined);
		try {
			await host.notifySelf({
				aboutAgentId: targetAgentId,
				notice,
				body: formatNoticeBody(targetAgentId, notice, report),
				mode: awaited ? "interrupt" : "next_turn",
			});
		} catch {
			return;
		}
	}
}

const watchAgentSchema = Type.Object({
	agentId: Type.String({ description: "Id of the agent to start or stop watching." }),
	watching: Type.Boolean({
		description: "true starts watching that agent; false stops watching one you already watch.",
	}),
});

export type WatchAgentInput = Static<typeof watchAgentSchema>;

export interface WatchAgentDetails {
	readonly agentId: string;
	readonly outcome: AgentWatchOutcome;
}

/**
 * Changing your mind about an agent already running.
 *
 * `spawn_agent` and `send_message` subscribe as they hand over the work, which
 * is the ordering that cannot miss a stop; this tool exists for the case that
 * has no message attached - stop listening to something you no longer care
 * about, or start listening to an agent someone else told you about.
 */
export function createWatchAgentToolDefinition(
	watches: AgentWatches,
): ToolDefinition<typeof watchAgentSchema, WatchAgentDetails> {
	return {
		name: "watch_agent",
		label: "watch_agent",
		description:
			"Start or stop watching an agent. While you watch one you are told every time it stops, and the notification carries what it last said, so you always know where that agent stands. Watching continues until you turn it off or the agent is disposed. An agent has one watcher at a time. Prefer the watch parameter on spawn_agent and send_message, which starts watching before the work is handed over; use this tool when there is no message to send.",
		promptSnippet: "Start or stop being told when an agent stops",
		promptGuidelines: [
			"Being told is the only reliable signal that an agent finished. Do not poll it with send_message and do not infer from silence that it is still working.",
			"Turn a watch off once you are done with that agent. It keeps reporting otherwise, and a report you have no use for still costs you a turn.",
		],
		parameters: watchAgentSchema,
		execute: async (_toolCallId, { agentId, watching }, context) => {
			const host = requireAgentHost(context);
			const targetAgentId = agentId.trim();
			if (!targetAgentId) {
				throw new Error("watch_agent requires a non-empty agentId.");
			}
			const outcome = watching ? watches.start(host, targetAgentId) : watches.stop(host, targetAgentId);
			// A refused subscription that read as success is the failure this whole
			// mechanism exists to remove: the caller would end its turn waiting for a
			// notification nobody is going to send. Dropping one never fails that way
			// - whatever the reason, the caller is not watching the agent afterwards.
			if (watching && outcome !== "watching") {
				throw new Error(`${describeOutcome(targetAgentId, outcome)} You are not watching it.`);
			}
			return {
				content: [{ type: "text", text: describeOutcome(targetAgentId, outcome) }],
				details: { agentId: targetAgentId, outcome },
			};
		},
	};
}

export function describeOutcome(agentId: string, outcome: AgentWatchOutcome): string {
	switch (outcome) {
		case "watching":
			return `You are watching agent ${agentId}. It reports to you every time it stops, until you stop watching it.`;
		case "not_watching":
			return `You are not watching agent ${agentId}; nothing will be reported to you when it stops.`;
		case "taken":
			return `Agent ${agentId} is already watched by another agent, and a stop has exactly one reader.`;
		case "outside_tree":
			return `Agent ${agentId} belongs to another tree, so you cannot watch it. You can still send it messages.`;
		case "self":
			return "An agent cannot watch itself.";
		default:
			return `Unknown agent: ${agentId}.`;
	}
}

/**
 * The body of a lifecycle notice: what the agent last said, then what the
 * watcher can do about it.
 *
 * The closing lines are here rather than in a system prompt because this is
 * where the decision is made. A prompt was read before the context filled up;
 * this text arrives in the turn that has to act on it.
 */
function formatNoticeBody(agentId: AgentId, notice: AgentNotice, report: string | undefined): string {
	if (notice.status === "gone") {
		const closing = `${agentId} was disposed and will not report. You are no longer watching it.`;
		return report ? `${report}\n\n${closing}` : closing;
	}
	return [
		// A run that ended without a word is a fact the watcher has to be told, not
		// a reason to stay silent: it is exactly the case the old voluntary report
		// lost, and an empty notification body would read as a delivery bug.
		report ?? `${agentId} stopped without a closing message.`,
		formatNoticeClosing(agentId, notice),
	].join("\n\n");
}

function formatNoticeClosing(agentId: AgentId, notice: AgentNotice): string {
	if (notice.abortedBy === "human") {
		return `${agentId} was interrupted by a human, who is working with it directly, so it has not finished what you gave it. You are still watching it and will be told when it next stops. A message from you now would land in the middle of their conversation: wait unless you have something that conversation needs, and continue it with send_message once the human hands it back.`;
	}
	if (notice.reason === "aborted") {
		return `${agentId} was interrupted and stopped, so what it said may be a fragment. You are still watching it. Continue it with send_message, or dispose_agent to release it.`;
	}
	return `${agentId} finished a turn and will not continue on its own. You are still watching it, so its next stop reaches you too. Continue it with send_message if the task is not done; carry on with your own work if it is, and dispose_agent releases it.`;
}
