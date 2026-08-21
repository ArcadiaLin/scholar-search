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
 * R1-R7: the conditions that make a review worth delivering.
 *
 * These are pure functions of $\bar{\tau}_t$, and that is the load-bearing part.
 * If whether to intervene depended on the Reviewer model's judgement, the
 * intervention rate would be an endogenous variable and
 * $\Delta_{\mathrm{sidecar}}$ could not be attributed to anything - the same
 * objection that killed the `ask_reviewer` design
 * (`docs/develop/mapping.md` §3.4, `docs/reviewer-design.md` §5.1). So the split
 * is: detectors decide *whether*, the Reviewer decides *what to say*.
 *
 * R1, R3 and R6 are not hypotheses. They name three behaviours measured in the
 * 2026-08-21 sessions: across three episodes `facet_probe`, `rank_candidates` and
 * `search_fulltext` were called zero times, all thirty issued queries were
 * keyword-shaped with not one phrase query, and the fetch-to-search ratio ran
 * above one throughout (`reviewer-design.md` §2.1, §2.2). A detector that cannot
 * recognise those three is not written correctly.
 *
 * Thresholds arrive from the service (`config.yaml`'s `review:` section, D-15).
 * They are not defaults here beyond what makes the module runnable standalone:
 * a threshold hard-coded in this file is a threshold an $HP$ search cannot vary.
 */
export const DETECTOR_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];

export interface DetectorThresholds {
	readonly minSearchesBeforeFacetProbe: number;
	readonly subqueryJaccardCeiling: number;
	readonly minSubqueriesForMonotony: number;
	readonly minEvidenceBeforeExpansion: number;
	readonly maxFailuresPerSource: number;
	readonly maxFetchPerSearchRatio: number;
	readonly softCallBudget: number;
}

/**
 * Placeholders, and only so this module runs without a service.
 *
 * They mirror `config.yaml`'s `review:` section. When the two disagree the
 * service wins, because the service's copy is the one an experiment can vary.
 */
export const FALLBACK_THRESHOLDS: DetectorThresholds = {
	minSearchesBeforeFacetProbe: 3,
	subqueryJaccardCeiling: 0.5,
	minSubqueriesForMonotony: 2,
	minEvidenceBeforeExpansion: 10,
	maxFailuresPerSource: 3,
	maxFetchPerSearchRatio: 1.0,
	softCallBudget: 40,
};

export interface DetectedCondition {
	readonly id: DetectorId;
	/** Which fixed action this condition argues for. No detector invents an action. */
	readonly action: AdviceAction;
	/** What was observed, in numbers, so the Reviewer can quote it rather than paraphrase. */
	readonly observation: string;
	/** Ids from the trace that show it, so advice about this condition can cite something. */
	readonly evidenceIds: readonly string[];
}

/** What the detectors need to see. A structural subset of `PublicSearchTrace`. */
export interface DetectorTraceView {
	readonly subqueries: readonly string[];
	readonly calls: readonly {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly failed: boolean;
	}[];
	readonly evidence: readonly { readonly paperId: string; readonly sources: readonly string[] }[];
	readonly budget: {
		readonly totalCalls: number;
		readonly callsByTool: Readonly<Record<string, number>>;
	};
	readonly failures: readonly { readonly source: string | null; readonly errorType: string }[];
}

/** Content words of a query, lower-cased. Deliberately crude: no stemming, no stop list. */
function terms(query: string): Set<string> {
	return new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9+#.-]+/)
			.filter((token) => token.length > 2),
	);
}

export function jaccard(left: string, right: string): number {
	const a = terms(left);
	const b = terms(right);
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / (a.size + b.size - shared);
}

function callsOf(trace: DetectorTraceView, toolName: string): number {
	return trace.budget.callsByTool[toolName] ?? 0;
}

function callIdsOf(trace: DetectorTraceView, toolName: string): string[] {
	return trace.calls.filter((call) => call.toolName === toolName).map((call) => call.toolCallId);
}

/**
 * Run every detector against the trace and return the conditions that hold.
 *
 * Order is `DETECTOR_IDS` order, which is stable, so a caller can rely on "the
 * first new condition" meaning the same thing across calls.
 */
export function detectConditions(
	trace: DetectorTraceView,
	thresholds: DetectorThresholds = FALLBACK_THRESHOLDS,
): DetectedCondition[] {
	const conditions: DetectedCondition[] = [];
	const searches = callsOf(trace, "search_metadata");
	const searchIds = callIdsOf(trace, "search_metadata");

	// R1 - never probed the distribution. Measured: zero facet_probe calls across
	// three sessions and 139 tool calls.
	if (searches >= thresholds.minSearchesBeforeFacetProbe && callsOf(trace, "facet_probe") === 0) {
		conditions.push({
			id: "R1",
			action: "check_constraint",
			observation:
				`${searches} searches issued and facet_probe never called, so nothing has checked how the ` +
				"results distribute - whether a query is too broad, too narrow, or landing in another field.",
			evidenceIds: searchIds.slice(0, 3),
		});
	}

	// R2 - the queries are one question asked repeatedly. After S10 this is a weak
	// proxy for what the answer pool shows directly (`reviewer-design.md` §5.4);
	// it stays because it fires before the agent has committed to anything.
	if (trace.subqueries.length >= thresholds.minSubqueriesForMonotony) {
		let minimum = 1;
		for (let i = 0; i < trace.subqueries.length; i += 1) {
			for (let j = i + 1; j < trace.subqueries.length; j += 1) {
				minimum = Math.min(minimum, jaccard(trace.subqueries[i] ?? "", trace.subqueries[j] ?? ""));
			}
		}
		if (minimum >= thresholds.subqueryJaccardCeiling) {
			conditions.push({
				id: "R2",
				action: "increase_diversity",
				observation:
					`all ${trace.subqueries.length} subqueries overlap (minimum pairwise Jaccard ` +
					`${minimum.toFixed(2)} >= ${thresholds.subqueryJaccardCeiling}), so they are one reading of the ` +
					"question in different words rather than several readings.",
				evidenceIds: searchIds.slice(0, 3),
			});
		}
	}

	// R3 - not one phrase query. Measured: 30 of 30 queries keyword-shaped, and
	// the agent had stated in that very episode that it would try phrases.
	if (trace.subqueries.length > 0 && !trace.subqueries.some((query) => query.includes('"'))) {
		conditions.push({
			id: "R3",
			action: "refine_query",
			observation:
				`none of the ${trace.subqueries.length} subqueries used a quoted phrase, so every multi-word ` +
				"concept was searched as separate terms.",
			evidenceIds: searchIds.slice(0, 3),
		});
	}

	// R4 - citation expansion absent, or attempted and uniformly failed. The second
	// half is F-10's shape: two failed calls and the agent abandoned the route.
	const expansions = callsOf(trace, "expand_citations");
	const expansionIds = callIdsOf(trace, "expand_citations");
	const failedExpansions = trace.calls.filter((call) => call.toolName === "expand_citations" && call.failed).length;
	if (expansions === 0 && trace.evidence.length >= thresholds.minEvidenceBeforeExpansion) {
		conditions.push({
			id: "R4",
			action: "expand_citation",
			observation:
				`${trace.evidence.length} papers found and expand_citations never called, so the citation graph ` +
				"around them is untouched.",
			evidenceIds: trace.evidence.slice(0, 3).map((item) => item.paperId),
		});
	} else if (expansions > 0 && failedExpansions === expansions) {
		conditions.push({
			id: "R4",
			action: "expand_citation",
			observation:
				`all ${expansions} expand_citations call(s) failed, so the absence of citation edges is a fact ` +
				"about the calls rather than about the literature.",
			evidenceIds: expansionIds.slice(0, 3),
		});
	}

	// R5 - one source is carrying everything, or one source keeps failing.
	const sources = new Set(trace.evidence.flatMap((item) => item.sources));
	const failuresBySource = new Map<string, number>();
	for (const failure of trace.failures) {
		const key = failure.source ?? "service";
		failuresBySource.set(key, (failuresBySource.get(key) ?? 0) + 1);
	}
	const overFailing = [...failuresBySource.entries()].filter(
		([, count]) => count >= thresholds.maxFailuresPerSource,
	);
	if (trace.evidence.length > 0 && sources.size <= 1) {
		conditions.push({
			id: "R5",
			action: "add_source",
			observation:
				`every one of the ${trace.evidence.length} papers found came from ${[...sources][0] ?? "one source"}, ` +
				"so coverage is one source's coverage.",
			evidenceIds: trace.evidence.slice(0, 3).map((item) => item.paperId),
		});
	} else if (overFailing.length > 0) {
		conditions.push({
			id: "R5",
			action: "add_source",
			observation:
				`${overFailing.map(([source, count]) => `${source} failed ${count} time(s)`).join("; ")}, so the gap ` +
				"is operational rather than a fact about the literature.",
			evidenceIds: searchIds.slice(0, 3),
		});
	}

	// R6 - fetching without ever re-reading. Measured: 33 get_paper against 28
	// search_metadata, zero rank_candidates.
	const fetches = callsOf(trace, "get_paper");
	if (searches > 0 && fetches / searches > thresholds.maxFetchPerSearchRatio && callsOf(trace, "rank_candidates") === 0) {
		conditions.push({
			id: "R6",
			action: "rerank",
			observation:
				`${fetches} get_paper calls against ${searches} searches and no rank_candidates call, so the loop is ` +
				"fetch-then-fetch: nothing has re-ordered what was already found.",
			evidenceIds: callIdsOf(trace, "get_paper").slice(0, 3),
		});
	}

	// R7 - the soft call budget is spent. Advisory only; nothing here enforces it.
	if (trace.budget.totalCalls >= thresholds.softCallBudget) {
		conditions.push({
			id: "R7",
			action: "stop",
			observation:
				`${trace.budget.totalCalls} tool calls against a soft budget of ${thresholds.softCallBudget}, so further ` +
				"work is spending past the point this configuration expects.",
			evidenceIds: [],
		});
	}

	return conditions;
}

/**
 * Render detected conditions for the Reviewer's prompt.
 *
 * Deliberately given as observations rather than as instructions. The detector
 * says what the numbers are; whether that is worth a piece of advice, and what
 * the advice should say, is the Reviewer's judgement - which is the only part of
 * this design that a model is allowed to decide (`reviewer-design.md` §5.1).
 */
export function renderConditions(conditions: readonly DetectedCondition[]): string {
	if (conditions.length === 0) {
		return "DETECTED CONDITIONS\n\n  (none - no automatic check found anything to flag on this trace)";
	}
	const lines = ["DETECTED CONDITIONS", ""];
	for (const condition of conditions) {
		lines.push(`  ${condition.id} -> suggests ${condition.action}`);
		lines.push(`     ${condition.observation}`);
		if (condition.evidenceIds.length > 0) lines.push(`     citable: ${condition.evidenceIds.join(", ")}`);
	}
	lines.push(
		"",
		"These are measurements, not instructions. Advise on a condition only if you judge it to matter here, " +
			"and say what you expect to change.",
	);
	return lines.join("\n");
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
			readonly searchState?: {
				readonly judge?: {
					readonly level: string;
					readonly judged: number;
					readonly considered: number;
					readonly rubricVersion: string | null;
					readonly criteriaVersion: string | null;
					readonly modelVersion: string | null;
				};
			};
		}[];
		readonly evidence: readonly {
			readonly paperId: string;
			readonly title: string;
			readonly foundBy: string;
			readonly abstractOpening?: string | null;
			readonly year?: number | null;
		}[];
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
	options: {
		readonly maxCalls?: number;
		readonly maxEvidence?: number;
		/** What the detectors found. Rendered as measurements, never as instructions. */
		readonly conditions?: readonly DetectedCondition[];
	} = {},
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

	// The judge's account, when there was one. A Reviewer told "these are relevance
	// ordered" reads the list differently from one told "these are recall ordered".
	const judged = trace.calls
		.map((call) => call.searchState?.judge)
		.filter((account): account is NonNullable<typeof account> => account !== undefined && account !== null);
	if (judged.length > 0) {
		const latest = judged[judged.length - 1];
		lines.push(
			"",
			`Relevance judging: ${latest?.level} - ${latest?.judged} of ${latest?.considered} candidate(s) judged ` +
				`(rubric ${latest?.rubricVersion ?? "?"}, criteria ${latest?.criteriaVersion ?? "?"}, ` +
				`model ${latest?.modelVersion ?? "?"}).`,
		);
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
		const year = typeof item.year === "number" ? ` ${item.year}` : "";
		lines.push(`  ${item.paperId}${year} :: ${item.title.slice(0, 120)} (found by ${item.foundBy})`);
		// The abstract opening is the §5.2c widening: coverage cannot be judged from
		// titles alone, and a title is no more public than the abstract beside it.
		if (typeof item.abstractOpening === "string" && item.abstractOpening !== "") {
			lines.push(`      ${item.abstractOpening}`);
		}
	}
	if (trace.evidence.length > maxEvidence) {
		lines.push(`  ... ${trace.evidence.length - maxEvidence} more not shown; they are still valid ids`);
	}

	if (options.conditions !== undefined) lines.push("", renderConditions(options.conditions));

	return lines.join("\n");
}
