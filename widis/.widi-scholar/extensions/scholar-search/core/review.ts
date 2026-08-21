/**
 * The gate every piece of Reviewer advice passes before it can reach the Main
 * Agent.
 *
 * `docs/design.md` §5.2 requires this to exist and lists what it must do. It is
 * not a filter for tidiness: without it the Reviewer can spend Main's budget,
 * cite evidence that was never found, and repeat itself into the context until
 * "the sidecar talked a lot" becomes indistinguishable from "the sidecar
 * helped". Every rejection here is recorded with a reason, because a silently
 * dropped suggestion looks exactly like advice that was never produced.
 *
 * The gate is deliberately a pure function of (advice, trace, history). It runs
 * outside any agent, so both what it admits and why it refuses are testable
 * without a model in the loop.
 */

/** `docs/prototype.md` §7.2: the action space is finite, and that is what makes advice attributable. */
export const ADVICE_ACTIONS = [
	"refine_query",
	"add_source",
	"expand_citation",
	"rerank",
	"increase_diversity",
	"check_constraint",
	/**
	 * Added in S10, and the only extension of this frozen set so far.
	 *
	 * Writing "you must maintain the answer pool" into the profile is a weak
	 * constraint - the 2026-08-21 session described a whole workflow in its opening
	 * turn and then followed none of it over 37 calls (`docs/develop/backlog.md`
	 * B-4). The structural enforcement is that the benchmark reads only the pool;
	 * this is the softer half, for the case where the agent is searching well and
	 * simply has not committed to anything (`docs/develop/plan.md` §3.4).
	 */
	"organize_answer",
	"stop",
] as const;

export type AdviceAction = (typeof ADVICE_ACTIONS)[number];

/**
 * Actions that ask Main to do nothing.
 *
 * §5.2 names these specifically: repeated `stop` / `done` / `no issue` advice
 * must be dropped or merged. One `stop` is a judgement; a second is noise.
 */
const NO_ACTION: ReadonlySet<string> = new Set(["stop"]);

const DEFAULT_MAX_PER_EPISODE = 6;
const DEFAULT_MAX_PER_ACTION = 2;
const DEFAULT_MAX_INSTRUCTION_CHARS = 1_000;

export interface Advice {
	readonly action: string;
	readonly target: string;
	readonly instructions: string;
	readonly evidenceIds: readonly string[];
	readonly confidence: number | null;
	readonly expectedEffect: string;
	readonly noveltyKey: string;
}

export type AdviceRefusal =
	| "unknown_action"
	| "duplicate_novelty_key"
	| "duplicate_action_target"
	| "repeated_no_action"
	| "unknown_evidence"
	| "episode_cap_reached"
	| "action_cap_reached"
	| "missing_fields";

export interface AdmitResult {
	readonly admitted: boolean;
	readonly refusal?: AdviceRefusal;
	/** What to tell the Reviewer. A refusal it cannot understand it will simply repeat. */
	readonly reason?: string;
	readonly advice?: Advice;
}

export interface AdviceGateOptions {
	readonly maxPerEpisode?: number;
	readonly maxPerAction?: number;
	readonly maxInstructionChars?: number;
}

/** What the gate needs to know about the trace to validate a citation. */
export interface GateTraceView {
	readonly evidenceIds: ReadonlySet<string>;
}

export interface AdviceGate {
	admit(candidate: unknown, trace: GateTraceView): AdmitResult;
	/** Everything admitted, in order. This is what may be delivered to Main. */
	admitted(): readonly Advice[];
	/** Every refusal and its reason, for the trajectory. */
	refusals(): readonly { readonly refusal: AdviceRefusal; readonly reason: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxChars: number): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

export function createAdviceGate(options: AdviceGateOptions = {}): AdviceGate {
	const maxPerEpisode = options.maxPerEpisode ?? DEFAULT_MAX_PER_EPISODE;
	const maxPerAction = options.maxPerAction ?? DEFAULT_MAX_PER_ACTION;
	const maxInstructionChars = options.maxInstructionChars ?? DEFAULT_MAX_INSTRUCTION_CHARS;

	const admittedList: Advice[] = [];
	const refusalList: { refusal: AdviceRefusal; reason: string }[] = [];
	const seenNoveltyKeys = new Set<string>();
	const seenActionTargets = new Set<string>();
	const perAction = new Map<string, number>();
	let sawNoAction = false;

	const refuse = (refusal: AdviceRefusal, reason: string): AdmitResult => {
		refusalList.push({ refusal, reason });
		return { admitted: false, refusal, reason };
	};

	return {
		admit(candidate: unknown, trace: GateTraceView): AdmitResult {
			if (!isRecord(candidate)) {
				return refuse("missing_fields", "Advice must be an object with the documented fields.");
			}

			const action = typeof candidate.action === "string" ? candidate.action : "";
			if (!(ADVICE_ACTIONS as readonly string[]).includes(action)) {
				return refuse(
					"unknown_action",
					`'${action}' is not one of the allowed actions (${ADVICE_ACTIONS.join(", ")}). ` +
						"The action space is fixed; advice outside it cannot be attributed to an effect.",
				);
			}

			const instructions = text(candidate.instructions, maxInstructionChars);
			const noveltyKey = text(candidate.noveltyKey ?? candidate.novelty_key, 200);
			const target = text(candidate.target, 200);
			if (instructions === "" || noveltyKey === "") {
				return refuse(
					"missing_fields",
					"Advice needs both `instructions` and `novelty_key`. The novelty key is how repeats are detected.",
				);
			}

			// Budget first: an over-cap suggestion should not consume a novelty key,
			// because the Reviewer may legitimately want to send it in a later episode.
			if (admittedList.length >= maxPerEpisode) {
				return refuse(
					"episode_cap_reached",
					`Already ${admittedList.length} pieces of advice this episode, which is the cap. ` +
						"Further advice is dropped rather than queued.",
				);
			}

			if (seenNoveltyKeys.has(noveltyKey)) {
				return refuse("duplicate_novelty_key", `Advice with novelty key '${noveltyKey}' was already given.`);
			}

			const actionTarget = `${action}|${target}`;
			if (seenActionTargets.has(actionTarget)) {
				return refuse(
					"duplicate_action_target",
					`'${action}' was already advised for target '${target}'. Repeating it cannot change the outcome.`,
				);
			}

			if (NO_ACTION.has(action)) {
				if (sawNoAction) {
					return refuse("repeated_no_action", "A no-action recommendation was already delivered.");
				}
				sawNoAction = true;
			}

			const used = perAction.get(action) ?? 0;
			if (used >= maxPerAction) {
				return refuse(
					"action_cap_reached",
					`'${action}' has already been advised ${used} times, which is its cap for one episode.`,
				);
			}

			// Every cited id must exist in the trace. Advice referencing a paper the
			// search never surfaced is either a hallucination or about another run,
			// and in both cases it is unattributable.
			const evidenceIds = Array.isArray(candidate.evidenceIds ?? candidate.evidence_ids)
				? ((candidate.evidenceIds ?? candidate.evidence_ids) as unknown[]).filter(
						(item): item is string => typeof item === "string",
					)
				: [];
			const unknown = evidenceIds.filter((id) => !trace.evidenceIds.has(id));
			if (unknown.length > 0) {
				return refuse(
					"unknown_evidence",
					`These evidence ids are not in the trace: ${unknown.slice(0, 5).join(", ")}. ` +
						"Cite only ids the search actually produced.",
				);
			}

			const advice: Advice = {
				action,
				target,
				instructions,
				evidenceIds,
				confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
				expectedEffect: text(candidate.expectedEffect ?? candidate.expected_effect, 400),
				noveltyKey,
			};
			seenNoveltyKeys.add(noveltyKey);
			seenActionTargets.add(actionTarget);
			perAction.set(action, used + 1);
			admittedList.push(advice);
			return { admitted: true, advice };
		},

		admitted: () => admittedList,
		refusals: () => refusalList,
	};
}

/**
 * Render the trace for the Reviewer's prompt.
 *
 * This is the whole of what the Reviewer gets to see, so it is built from the
 * trace object rather than from anything the Main Agent said. Keeping the
 * rendering here, next to the gate, makes the boundary auditable in one place:
 * if a field is not in `PublicSearchTrace`, no wording in the Reviewer's prompt
 * can conjure it.
 */
export function renderTraceForReviewer(
	trace: {
		readonly subqueries: readonly string[];
		readonly calls: readonly {
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: Readonly<Record<string, unknown>>;
			readonly failed: boolean;
			readonly errorMessage: string | undefined;
		}[];
		readonly evidence: readonly { readonly paperId: string; readonly title: string; readonly foundBy: string }[];
		readonly answerPool: {
			readonly committed: number;
			readonly withdrawn: number;
			readonly note: string;
			readonly papers: readonly { readonly canonicalId: string; readonly title: string; readonly why: string }[];
			readonly removed: readonly { readonly canonicalId: string; readonly title: string; readonly reason: string }[];
		} | null;
		readonly budget: {
			readonly totalCalls: number;
			readonly failedCalls: number;
			readonly callsByTool: Readonly<Record<string, number>>;
		};
		readonly candidateCounts: { readonly recalled: number; readonly returned: number };
		readonly failures: readonly {
			readonly source: string | null;
			readonly errorType: string;
			readonly message: string;
		}[];
	},
	options: { readonly maxCalls?: number; readonly maxEvidence?: number } = {},
): string {
	const maxCalls = options.maxCalls ?? 40;
	const maxEvidence = options.maxEvidence ?? 60;

	const lines = [
		"PUBLIC SEARCH TRACE",
		"",
		`Tool calls: ${trace.budget.totalCalls} (${trace.budget.failedCalls} failed) - ${JSON.stringify(trace.budget.callsByTool)}`,
		`Candidates: ${trace.candidateCounts.recalled} recalled, ${trace.candidateCounts.returned} returned`,
		`Subqueries issued (${trace.subqueries.length}): ${trace.subqueries.join(" | ") || "(none)"}`,
	];

	if (trace.failures.length > 0) {
		lines.push("", `Source failures (${trace.failures.length}):`);
		for (const failure of trace.failures.slice(0, 20)) {
			lines.push(`  - ${failure.source ?? "service"} [${failure.errorType}] ${failure.message}`);
		}
	}

	// The pool goes before the call list because it is the one section where a
	// coverage gap is visible rather than inferable: a Reviewer reading only the
	// queries has to guess what the agent thinks it found.
	const pool = trace.answerPool;
	if (pool === null) {
		lines.push("", "Answer pool: EMPTY - the agent has not committed to any paper yet.");
	} else {
		lines.push("", `Answer pool: ${pool.committed} committed, ${pool.withdrawn} withdrawn.`);
		if (pool.note !== "") lines.push(`  note: ${pool.note}`);
		for (const entry of pool.papers.slice(0, maxEvidence)) {
			lines.push(`  ${entry.canonicalId} :: ${entry.title.slice(0, 120)}`, `      why: ${entry.why.slice(0, 300)}`);
		}
		for (const entry of pool.removed.slice(0, 20)) {
			lines.push(`  withdrawn ${entry.canonicalId} :: ${entry.title.slice(0, 120)} - ${entry.reason.slice(0, 200)}`);
		}
	}

	lines.push("", "Calls in order:");
	for (const call of trace.calls.slice(0, maxCalls)) {
		const failed = call.failed ? " FAILED" : "";
		lines.push(`  ${call.toolCallId} ${call.toolName}${failed} ${JSON.stringify(call.args)}`);
		if (call.failed && call.errorMessage) lines.push(`    -> ${call.errorMessage.slice(0, 300)}`);
	}
	if (trace.calls.length > maxCalls) lines.push(`  ... ${trace.calls.length - maxCalls} more call(s) not shown`);

	lines.push("", `Evidence found (${trace.evidence.length}) - these ids are the only ones you may cite:`);
	for (const item of trace.evidence.slice(0, maxEvidence)) {
		lines.push(`  ${item.paperId} :: ${item.title.slice(0, 120)} (found by ${item.foundBy})`);
	}
	if (trace.evidence.length > maxEvidence) {
		lines.push(`  ... ${trace.evidence.length - maxEvidence} more not shown; they are still valid ids`);
	}

	return lines.join("\n");
}
