import type { WidiTuiExtensionApi } from "../../../../apps/widi/src/tui/extension-host/index.ts";
import {
	DRILL_EVENT,
	type DrillChapterState,
	type DrillLanguage,
	readFailed,
	readObserved,
	readReady,
	readRuntime,
	readTurnSettled,
} from "../protocol.ts";
import { getScript, stepsFor } from "../script/index.ts";
import { delay, Narrator } from "./narration.ts";
import { buildReportRows } from "./report.ts";

/**
 * The director: one instance for the whole application, belonging to no agent.
 *
 * That singularity is the shape of the design. There is one core runtime per
 * agent and they all hear everything on the bus, so nothing over there can own a
 * cursor without racing its own copies. The cursor lives here, where there is
 * only ever one of it, and the core halves stay sensors and hands.
 *
 * The director never sends a message either. It writes the line into the editor
 * and stops; the human reads it and presses Enter themselves. Everything the
 * drill claims to demonstrate about a turn is therefore true of a turn a person
 * actually started.
 */

/** Long enough for every runtime in the process to answer, short enough not to stall. */
const RUNTIME_ROLL_CALL_MS = 400;
const READY_TIMEOUT_MS = 15_000;

// The default bindings registered in `tui/index.ts`. Printed rather than acted
// on: a user who rebound them sees their own keys, and these are only the words
// in the prose.
const ADVANCE_KEY = "ctrl+n";
const ABORT_KEY = "ctrl+b";

export class DrillDirector {
	private readonly api: WidiTuiExtensionApi;
	private readonly narrator: Narrator;

	private running = false;
	private aborted = false;
	private language: DrillLanguage = "en";
	/** The agent under rehearsal: the one the human was already on. */
	private agentId: string | undefined;
	private chapters: readonly DrillChapterState[] = [];
	/** Observed event names, per agent. Only the drilling agent's column is reported. */
	private readonly observed = new Map<string, Set<string>>();
	/** Capability keys this run actually drove, for the closing table. */
	private readonly exercised = new Set<string>();

	private resolveBeat: (() => void) | undefined;
	private resolveReady: ((agentId: string | undefined) => void) | undefined;

	constructor(api: WidiTuiExtensionApi) {
		this.api = api;
		this.narrator = new Narrator(api);
		this.subscribe();
		// Quitting mid-tour must not be the one thing a person cannot do. Every
		// wait here settles, the rehearsal is handed back, and the command that has
		// been pending since they typed `/drill` finally returns.
		this.api.onDispose(async () => await this.abort());
	}

	private subscribe(): void {
		this.api.onExtensionEvent(DRILL_EVENT.runtime, (envelope) => {
			const runtime = readRuntime(envelope.payload);
			// The visible agent's runtime is the one whose chapters decide the run:
			// it is the agent the drill will be performed on.
			if (runtime && runtime.agentId === this.api.capability("agentStrip")?.visibleAgentId()) {
				this.chapters = runtime.chapters;
			}
		});
		this.api.onExtensionEvent(DRILL_EVENT.ready, (envelope) => {
			const ready = readReady(envelope.payload);
			if (ready) this.settleReady(ready.agentId);
		});
		this.api.onExtensionEvent(DRILL_EVENT.failed, (envelope) => {
			const failed = readFailed(envelope.payload);
			if (failed) {
				this.narrator.notice(`drill could not start: ${failed.reason}`);
				this.settleReady(undefined);
			}
		});
		this.api.onExtensionEvent(DRILL_EVENT.observed, (envelope) => {
			const seen = readObserved(envelope.payload);
			if (!seen) return;
			const names = this.observed.get(seen.agentId) ?? new Set<string>();
			names.add(seen.event);
			this.observed.set(seen.agentId, names);
		});
		this.api.onExtensionEvent(DRILL_EVENT.turnSettled, (envelope) => {
			if (readTurnSettled(envelope.payload)?.agentId === this.agentId) this.settleBeat();
		});
	}

	/** The key bound to `drill.next`, and the way out of a beat with nothing to send. */
	advance(): void {
		this.settleBeat();
	}

	/**
	 * The key bound to `drill.abort`. It leaves through the same door as a
	 * finished run - the agent comes out of rehearsal, the report is simply
	 * shorter. A tour must not be a one-way door.
	 */
	async abort(): Promise<void> {
		if (!this.running) return;
		this.aborted = true;
		this.settleReady(undefined);
		this.settleBeat();
		// One turn of the loop for the run to notice and unwind through its own
		// finally, which is what hands the agent back.
		await delay(0);
	}

	async run(): Promise<string> {
		if (this.running) return "A drill is already running.";
		const agentId = this.api.capability("agentStrip")?.visibleAgentId();
		if (agentId === undefined) {
			return "No agent is open yet, so there is nothing to rehearse on.";
		}

		this.running = true;
		this.aborted = false;
		this.observed.clear();
		this.exercised.clear();
		try {
			const language = await this.chooseLanguage();
			if (language === undefined) return "Cancelled.";
			this.language = language;

			const enabled = await this.rollCall();
			if (enabled.length === 0) return "Every drill chapter is switched off; enable one with /division.";

			if ((await this.begin()) === undefined) return "The drill could not start.";
			this.agentId = agentId;

			await this.perform(enabled);
			await this.close();
			return this.aborted ? "Drill stopped; your agent is back to normal." : "Drill finished.";
		} finally {
			await this.finish();
		}
	}

	private async chooseLanguage(): Promise<DrillLanguage | undefined> {
		const dock = this.api.capability("selectorDock");
		if (!dock) return "en";
		this.exercised.add("selectorDock");
		const chosen = await dock.open({
			title: "drill",
			description: "Which language should the tour speak?",
			choices: [
				{ value: "en", label: "English" },
				{ value: "zh", label: "中文" },
			],
		});
		return chosen === "en" || chosen === "zh" ? chosen : undefined;
	}

	/**
	 * Ask every core runtime which chapters it has on.
	 *
	 * The TUI half cannot read division state - that is core's resolution of the
	 * user's settings - so it is answered rather than inspected. One round of
	 * hello, a short wait, and whatever came back.
	 */
	private async rollCall(): Promise<readonly string[]> {
		this.chapters = [];
		await this.api.emitExtensionEvent(DRILL_EVENT.hello, {});
		await delay(RUNTIME_ROLL_CALL_MS);
		return this.chapters.filter((chapter) => chapter.enabled).map((chapter) => chapter.id);
	}

	private async begin(): Promise<string | undefined> {
		const script = getScript(this.language);
		this.narrator.notice(`${script.title} - about ${script.estimatedMinutes} minutes.`, 10_000);
		this.exercised.add("notices");
		const settled = new Promise<string | undefined>((resolve) => {
			this.resolveReady = resolve;
		});
		// Attributed to the visible agent, which is exactly the addressing the core
		// half matches on: one runtime in the process, and the right one.
		await this.api.emitExtensionEvent(DRILL_EVENT.begin, { language: this.language });
		const ready = await Promise.race([settled, delay(READY_TIMEOUT_MS).then(() => undefined)]);
		this.resolveReady = undefined;
		return ready;
	}

	/**
	 * Walk the steps, stopping wherever the script says to stop.
	 *
	 * The order inside a step is the whole of the pacing rule: say what is about
	 * to happen, wait for the person if the script asked to, only then put the
	 * line in front of them. A tour that explains after the fact is a transcript,
	 * not a tour.
	 */
	private async perform(chapters: readonly string[]): Promise<void> {
		const steps = stepsFor(this.language, chapters);
		this.narrator.keys(`drill ${ADVANCE_KEY} next · ${ABORT_KEY} stop`);
		this.exercised.add("footer");
		for (const [index, step] of steps.entries()) {
			if (this.aborted) return;
			this.narrator.progress(`drill ${index + 1}/${steps.length} · ${step.chapter}`);
			this.exercised.add("workingLine");
			this.exercised.add("chat");
			await this.narrator.say(step.narrate);
			if (this.aborted) return;

			if (step.pause !== undefined) {
				await this.narrator.say([`${step.pause}  (${ADVANCE_KEY})`]);
				await this.waitForBeat();
				if (this.aborted) return;
			}

			if (step.say !== undefined) {
				this.api.setEditorText(step.say);
				this.exercised.add("editor");
				await this.waitForBeat();
				if (this.aborted) return;
			}

			if (step.review) await this.narrator.say(step.review);
			if (step.watch) await this.narrator.watch(step.watch);
		}
	}

	private async close(): Promise<void> {
		const script = getScript(this.language);
		const agentId = this.agentId;
		if (agentId === undefined) return;
		await this.api.emitExtensionEvent(DRILL_EVENT.report, {
			agentId,
			title: script.reportTitle,
			columns: [...script.reportColumns],
			rows: buildReportRows({
				seen: this.observed.get(agentId) ?? new Set<string>(),
				exercised: this.exercised,
				chapters: this.chapters,
				aborted: this.aborted,
			}),
		});
		await this.narrator.say([script.closing]);
	}

	/**
	 * Hand the agent back, whatever ended the run.
	 *
	 * In a `finally` because the ways out are not all happy: the tour finishes,
	 * the human presses the abort key, the terminal is quitting under it. An agent
	 * left on the scripted model would answer their next real question with a
	 * rehearsal line, so this is the one part that must run every time.
	 */
	private async finish(): Promise<void> {
		const agentId = this.agentId;
		this.agentId = undefined;
		this.running = false;
		this.narrator.clear();
		if (agentId === undefined) return;
		try {
			await this.api.emitExtensionEvent(DRILL_EVENT.end, { agentId });
			this.narrator.notice("Rehearsal over. Your model and tools are back to what they were.");
		} catch {
			// The bus is gone, which means the process is going with it.
		}
	}

	private waitForBeat(): Promise<void> {
		return new Promise((resolve) => {
			this.resolveBeat = resolve;
		});
	}

	private settleBeat(): void {
		const resolve = this.resolveBeat;
		this.resolveBeat = undefined;
		resolve?.();
	}

	private settleReady(agentId: string | undefined): void {
		const resolve = this.resolveReady;
		this.resolveReady = undefined;
		resolve?.(agentId);
	}
}
