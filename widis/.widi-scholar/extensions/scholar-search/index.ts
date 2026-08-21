/**
 * scholar-search: the WIDI Core-half extension carrying $T^M$, the Main Search
 * Agent's tool set (`docs/design.md` §4, `docs/prototype.md` §7.1).
 *
 * Registered so far:
 *
 *   list_providers    runtime capability table + quota, from the Search Service
 *   search_metadata   the main retrieval call: ranked candidates + process account
 *   get_paper         one record by stable id
 *   provider_query    passthrough for a provider's own query syntax
 *   expand_citations  bounded citation-graph walk
 *   facet_probe       result distribution, before paying for recall
 *   rank_candidates   rank-only; issues no provider call
 *   search_fulltext   body sections of named papers; adds no papers
 *   get_budget        the bounds in force, and what has been spent
 *
 * That is the nine of $T^M$. Three of them are deliberately incapable of adding
 * a candidate - `facet_probe`, `rank_candidates` and `search_fulltext` - because
 * "the agent looked", "the agent re-ordered" and "the agent searched again" have
 * to stay distinguishable in the trajectory.
 *
 * A tenth is registered alongside them but is not one of the nine:
 *
 *   update_answer_pool  the episode's answer, as data rather than as prose
 *
 * The nine are retrieval tools; this one is the output mechanism, which is a
 * different category and the reason $T^M$ going from nine to ten is acceptable
 * where going to twelve would not be (`docs/develop/decisions.md` D-08).
 *
 * `list_providers` comes first because it is the precondition for every other
 * tool that lets the agent write a provider-native query: the agent cannot pick
 * a source, a syntax or a field before it knows what exists and what is left of
 * the quota (`docs/prototype.md` §7.1, "provider 语法的载体"). For the same
 * reason `provider_query` is one tool with the provider as a parameter rather
 * than one tool per source: adding a source must be a registry entry, not a
 * change to the tool set (`docs/search-service.md` §2.1). No tool description
 * here carries a provider's query syntax - that is what `list_providers`
 * reports at runtime, narrowed to what the current configuration allows.
 *
 * Retrieval logic lives in `core/` as pure functions; this file only adapts them
 * to the WIDI tool contract. Parameter schemas are hand-written JSON Schema:
 * jiti cannot resolve a bare "typebox" import from `widis/`, and WIDI treats the
 * schema as plain JSON Schema anyway (typebox's `TSchema` is structurally empty
 * in the pinned version).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTENSION_API_VERSION,
	type ExtensionContext,
	type ExtensionDefinition,
} from "../../../../packages/widi/apps/widi/src/core/extension/api.ts";
import {
	type AnswerPool,
	type AnswerPoolSnapshot,
	createAnswerPool,
	renderPoolSummary,
} from "./core/answer-pool.ts";
import {
	ADVICE_ACTIONS,
	type Advice,
	type AdviceGate,
	createAdviceGate,
	type DetectedCondition,
	type DetectorThresholds,
	detectConditions,
	FALLBACK_THRESHOLDS,
	renderTraceForReviewer,
} from "./core/review.ts";
import {
	createServiceClient,
	type PaperSummary,
	type ProviderRecord,
	resolveServiceBaseUrl,
	SERVICE_URL_ENV_VAR,
	type SearchStateRecord,
	type ServiceClient,
	ServiceRequestError,
} from "./core/service-client.ts";
import { createTraceCollector, type PublicSearchTrace, type TraceCollector } from "./core/trajectory.ts";

/**
 * Tools bound their own output size: a candidate list or a capability table that
 * grows with the corpus must not decide how much of the agent's context is left
 * (`docs/design.md` §4.1). The full record still travels in `details`, which the
 * trajectory and the UI read but the model's context does not.
 */
const MAX_FIELDS_PER_PROVIDER = 12;
const MAX_OUTPUT_CHARS = 6_000;
/**
 * How many candidates get a full entry in the tool text. The rest are still in
 * `details`, and the text says how many were elided: a truncation the agent
 * cannot see is a truncation it will reason past.
 */
const MAX_LISTED_PAPERS = 20;
const MAX_ABSTRACT_CHARS_IN_LIST = 280;
const MAX_PASSTHROUGH_CHARS = 4_000;
const MAX_FACET_BUCKETS = 15;
const MAX_FULLTEXT_CHARS_PER_SECTION = 700;

function readParams<T>(params: unknown): T {
	return params as T;
}

/** Resolved per call, not at activation: the address is environment. */
function clientFromEnv(): ServiceClient {
	return createServiceClient({ baseUrl: resolveServiceBaseUrl(process.env) });
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function formatCost(record: ProviderRecord): string {
	const endpoints = Object.entries(record.costModel);
	if (endpoints.length === 0) return "cost: not declared";
	const parts = endpoints.map(([endpoint, cost]) => {
		const quota = cost.dailyQuota === null ? "no daily quota" : `${cost.dailyQuota}/day`;
		return `${endpoint} ($${cost.usdPerCall}/call, ${quota}, ${cost.rateLimitRps} rps)`;
	});
	return `cost: ${parts.join("; ")}`;
}

function formatQuota(record: ProviderRecord): string {
	const entries = Object.entries(record.quotaRemaining);
	if (entries.length === 0) return "quota remaining: not tracked by the service";
	const parts = entries.map(([key, remaining]) => `${key}=${remaining === null ? "unknown" : remaining}`);
	return `quota remaining: ${parts.join(", ")}`;
}

/**
 * The unified field names this provider can populate. Reported as the unified
 * vocabulary rather than the provider's own keys because that is the vocabulary
 * every other tool in $T^M$ speaks.
 */
function formatFields(record: ProviderRecord): string {
	const unified = [...new Set(Object.values(record.fieldMap))].sort();
	if (unified.length === 0) return "fields: not declared";
	const shown = unified.slice(0, MAX_FIELDS_PER_PROVIDER);
	const omitted = unified.length - shown.length;
	return `fields: ${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function formatProvider(record: ProviderRecord): string {
	const capabilities =
		record.enabledCapabilities.length === 0 ? "none advertised" : record.enabledCapabilities.join(", ");
	return [
		`- ${record.name} [${record.enabled ? "enabled" : "disabled"}]`,
		`  capabilities: ${capabilities}`,
		`  ${formatFields(record)}`,
		`  ${formatCost(record)}`,
		`  ${formatQuota(record)}`,
	].join("\n");
}

/**
 * Turn a client-side failure into something the agent can act on rather than
 * retry blindly: which service was dialled, what kind of failure it was, and
 * which knob changes the answer.
 */
function describeFailure(error: ServiceRequestError): string {
	const where = `Search Service at ${error.url}`;
	const hint = `Set ${SERVICE_URL_ENV_VAR} if the service is somewhere else.`;
	switch (error.kind) {
		case "network":
			return `${error.message} The ${where} is unreachable - it may not be running. ${hint}`;
		case "timeout":
			return `${error.message} The ${where} accepted the connection but did not answer in time.`;
		case "http":
			return describeHttpFailure(error);
		case "parse":
			return `${error.message} This is a service/extension contract mismatch, not something to retry.`;
	}
}

/**
 * Turn the service's refusal into a next move.
 *
 * A rejected field or syntax has to say which field, and where the answer lives
 * (`docs/prototype.md` §7.1, third interface contract). "HTTP 501" tells the
 * agent nothing; "this provider does not advertise native queries, check
 * list_providers" tells it what to do instead.
 */
function describeHttpFailure(error: ServiceRequestError): string {
	const detail = error.detail ?? error.bodySnippet ?? "no detail given";
	switch (error.status) {
		case 400:
		case 422:
			return (
				`The Search Service rejected the request: ${detail} ` +
				"Fix the named parameter rather than retrying the same call."
			);
		case 404:
			return `${detail} Call list_providers to see which sources are configured, and check the identifier.`;
		case 501:
			return (
				`${detail} This is a capability limit, not a transient error: ` +
				"call list_providers and pick a source that advertises what you need."
			);
		case 502:
			return describeUpstreamFailure(error, detail);
		default:
			return `${error.message} ${detail}`;
	}
}

/**
 * Report a total upstream failure with its classification and a next move that is
 * true.
 *
 * The previous wording appended "Another source may still be able to answer" to
 * every 502. When the run had exactly one usable source that sentence sent the
 * agent looking for a second one that does not exist, and it retried blindly for
 * three minutes instead (`docs/develop/backlog.md` F-2). So the alternatives come
 * from the service, which is the only side that knows the registry, and the
 * classification is reported rather than summarised: "rate limited until
 * tomorrow", "no results" and "the source is broken" are three different
 * situations that used to arrive as one string.
 */
function describeUpstreamFailure(error: ServiceRequestError, detail: string): string {
	const lines = [`The provider failed behind the service: ${detail}`];
	if (error.failures.length > 0) {
		lines.push(
			`failures (${error.failures.length}):`,
			...error.failures.map(
				(failure) => `  - ${failure.source ?? "service"} [${failure.errorType}] ${failure.message}`,
			),
		);
		if (error.failures.every((failure) => failure.errorType === "rate_limit")) {
			lines.push(
				"Every failure above is a quota limit, so retrying the same call cannot succeed until the quota resets.",
			);
		}
	}
	const alternatives = error.alternativeSources;
	lines.push(
		alternatives.length > 0
			? `Sources not tried on this call that could serve it: ${alternatives.join(", ")}.`
			: "No other configured source advertises what this call needs, so switching source is not an option here.",
	);
	return lines.join("\n");
}

/** One candidate as a citation line plus an abstract view, never the whole record. */
function formatPaper(paper: PaperSummary, index: number): string {
	const authors =
		paper.authors.length === 0
			? "authors unknown"
			: paper.authors.join(", ") + (paper.authorCount > paper.authors.length ? " et al." : "");
	const identity = [
		paper.doi === null ? null : `doi:${paper.doi}`,
		paper.arxivId === null ? null : `arXiv:${paper.arxivId}`,
		paper.openalexId === null ? null : `openalex:${paper.openalexId}`,
	]
		.filter((part): part is string => part !== null)
		.join(" | ");
	const facts = [
		paper.year === null ? null : `${paper.year}`,
		paper.venue,
		paper.citationCount === null ? "citations unknown" : `${paper.citationCount} citations`,
	]
		.filter((part): part is string => part !== null && part !== "")
		.join(" | ");

	const lines = [
		`${index + 1}. ${paper.title}`,
		`   id: ${paper.paperId}${identity === "" ? "" : `  (${identity})`}`,
		`   ${authors}`,
		`   ${facts}  [sources: ${paper.sources.join(", ") || "unknown"}]`,
	];
	if (paper.abstract !== null) lines.push(`   abstract: ${truncate(paper.abstract, MAX_ABSTRACT_CHARS_IN_LIST)}`);
	return lines.join("\n");
}

/**
 * The service's process account, rendered for the agent.
 *
 * Failures are reported even when the search succeeded: "12 results" and
 * "12 results, and arXiv timed out" support different next moves.
 */
function formatSearchState(state: SearchStateRecord): string {
	const lines = [
		`sources queried: ${state.selectedSources.join(", ") || "none"}`,
		`queries issued: ${state.issuedQueries.length} | candidates recalled: ${state.recalled} | returned: ${state.returned}`,
	];
	// A provider that rewrites the query says so here. Reporting only the wording
	// the caller chose hid an arXiv rewrite that turned every multi-word query into
	// an OR bag (`docs/develop/backlog.md` F-1).
	const rewritten = state.issuedQueries.filter(
		(issued) => issued.nativeQuery !== null && issued.nativeQuery !== issued.query,
	);
	if (rewritten.length > 0) {
		lines.push(
			"queries as actually sent to the provider:",
			...rewritten.map((issued) => `  - ${issued.provider}: ${issued.nativeQuery}`),
		);
	}
	const filterKeys = Object.keys(state.filters);
	if (filterKeys.length > 0) lines.push(`filters applied: ${JSON.stringify(state.filters)}`);
	if (state.failures.length > 0) {
		const failures = state.failures.map(
			(failure) => `  - ${failure.source ?? "service"} [${failure.errorType}] ${failure.message}`,
		);
		lines.push(`failures (${state.failures.length}):`, ...failures);
	}
	return lines.join("\n");
}

/**
 * This extension's own version, reported through `get_budget`.
 *
 * WIDI's `inspect` names the loaded extensions but carries no version for them,
 * and an evaluation run has to record which tool set produced its numbers
 * (`AGENTS.md` §5.3). Bump it whenever the registered tools or their contracts
 * change - a run recorded against `1` must mean the same nine tools next month.
 *
 * `2`: `update_answer_pool` registered (S10); `search_metadata`'s `query`
 * contract changed from a natural-language statement to AND-combined terms, and
 * `SearchState.issued_queries` gained `native_query` (F-1). A run recorded
 * against `1` is not comparable to one recorded against `2` on retrieval
 * behaviour or on call composition.
 */
export const EXTENSION_VERSION = "2";

export const TRACE_DIR_ENV_VAR = "SCHOLAR_TRACE_DIR";
/**
 * The sidecar is off unless asked for.
 *
 * It costs a second model and it changes the Main Agent's context, so it must be
 * a deliberate choice rather than something a search silently acquires. The M-axis
 * experiment needs both arms anyway (`docs/prototype.md` §6.5), which means the
 * switch has to exist regardless.
 */
export const REVIEWER_ENV_VAR = "SCHOLAR_REVIEWER";
/**
 * Which model reviews, as `provider/id`.
 *
 * Needed rather than optional in practice: a spawned agent takes the runtime's
 * default model, and this namespace's default is deliberately left as the user's
 * own preference - which may well be a model with no credentials configured. A
 * Reviewer spawned on an unavailable model completes its turn having produced
 * nothing at all, which looks exactly like a Reviewer with no advice to give.
 *
 * It is also the knob the M-axis experiment needs: the reviewing model is a
 * variable of that experiment, not a property of the search.
 */
export const REVIEWER_MODEL_ENV_VAR = "SCHOLAR_REVIEWER_MODEL";
export const REVIEWER_PROFILE_ID = "reviewer";
/** The profile whose agents get a Reviewer attached. */
export const SUBJECT_PROFILE_ID = "search";
/**
 * How many reviews may be in flight or waiting for one subject.
 *
 * `prompt` refuses a busy agent rather than queueing, so two triggers arriving
 * close together would lose the second one silently - and a silently dropped
 * trigger is indistinguishable from a trigger that never happened
 * (`docs/reviewer-design.md` §8, first risk). So deliveries are serialised per
 * subject, one in flight and one waiting; anything beyond that is dropped *and
 * written into the review journal*, which is the part that matters.
 *
 * There is deliberately no cap on how many reviews an episode may run
 * (`MAX_REVIEWS_PER_AGENT` is gone, D-14). Observation has no quota; only
 * intervention does, and that cap lives on the gate.
 */
const MAX_QUEUED_REVIEWS_PER_SUBJECT = 2;

function reviewerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	const value = env[REVIEWER_ENV_VAR];
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}
/** Archived traces are one of the three things allowed to outlive an episode (`search-service.md` §5.3). */
const DEFAULT_TRACE_SUBDIR = join("runs", "trajectories");

function resolveTraceDir(env: Readonly<Record<string, string | undefined>>, cwd: string): string {
	const configured = env[TRACE_DIR_ENV_VAR];
	if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
	return join(cwd, DEFAULT_TRACE_SUBDIR);
}

/**
 * Write the trace out where a human or a Reviewer can read it.
 *
 * Deliberately not a tool: the Main Agent must not be able to read its own
 * public trace, or "what the Reviewer can see" becomes something the agent can
 * manage. The Reviewer channel that consumes this is S8.
 */
async function writeTrace(trace: PublicSearchTrace, cwd: string): Promise<string | undefined> {
	try {
		const directory = resolveTraceDir(process.env, cwd);
		await mkdir(directory, { recursive: true });
		const path = join(directory, `${trace.agentId}.json`);
		await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
		return path;
	} catch {
		// A trace that cannot be written must not break the search it describes.
		return undefined;
	}
}

/**
 * Persist the answer pool next to the trace, under the same agent-scoped name.
 *
 * On disk rather than only in memory because this file *is* the deliverable the
 * benchmark reads: the scorer opens `${agentId}.answer.json` and computes
 * Recall@k from it, and an episode whose pool never reached disk is an episode
 * with no answer (`docs/develop/plan.md` §3.4). Written on every change rather
 * than at the end, so a run that dies mid-episode still leaves what it had.
 */
async function writeAnswerPool(snapshot: AnswerPoolSnapshot, cwd: string): Promise<string | undefined> {
	try {
		const directory = resolveTraceDir(process.env, cwd);
		await mkdir(directory, { recursive: true });
		const path = join(directory, `${snapshot.agentId}.answer.json`);
		await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
		return path;
	} catch {
		// Unlike the trace, this failure is worth surfacing to the caller, so the
		// tool checks the return value rather than this swallowing it silently.
		return undefined;
	}
}

/**
 * Archive what the review did, including what the gate refused.
 *
 * The refusals are the interesting half: they are the record of what the sidecar
 * tried to say and was not allowed to, which is what separates "the reviewer had
 * nothing to add" from "the reviewer repeated itself six times".
 */
/**
 * The Reviewer's own answer, bounded.
 *
 * Recorded so "it had nothing to add" can be told apart from "it never answered"
 * and from "it answered in prose without registering a verdict". Those three are
 * the same empty advice list, and only one of them means the channel worked.
 */
function summariseOutcome(outcome: unknown): string {
	if (outcome === undefined || outcome === null) return "(no outcome recorded)";
	if (typeof outcome !== "object") return String(outcome).slice(0, 600);
	const record = outcome as Record<string, unknown>;
	if (typeof record.failed === "string") return `prompt failed: ${record.failed.slice(0, 400)}`;
	const message = record.message as Record<string, unknown> | undefined;
	const content = message?.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
			.filter((part) => part.type === "text")
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("\n")
			.trim();
		if (text !== "") return text.slice(0, 1_500);
	}
	const kind = typeof record.kind === "string" ? record.kind : "unknown";
	return `(no text; outcome kind: ${kind})`;
}

/**
 * One entry in the review journal: a trigger, what it found, and what became of it.
 *
 * The journal exists because of one failure mode: a trigger that was dropped
 * because the Reviewer was busy looks exactly like a trigger that never fired,
 * and so does a Reviewer that answered in prose without calling the tool. Three
 * different situations, one empty advice list (`docs/reviewer-design.md` §8).
 */
interface ReviewJournalEntry {
	readonly at: string;
	readonly trigger: "answer_pool" | "detector" | "attach";
	readonly conditions: readonly string[];
	readonly delivered: boolean;
	readonly note: string;
	/**
	 * How far the search had got when this happened, in tool calls and in searches.
	 *
	 * Recorded because it is the only way to check the property that matters: a
	 * review whose advice arrives after the last search cannot have changed the
	 * search it reviewed, which is exactly the gap G-1 records. Wall-clock time
	 * would not settle it; the position in the call sequence does.
	 */
	readonly atCall?: number;
	readonly atSearch?: number;
}

/**
 * One piece of advice that actually reached Main, and where in the search it did.
 *
 * `atSearch` against the episode's total search count is what answers "could this
 * advice have changed the search it was about" - the question S8's acceptance
 * criteria did not ask, which is how G-1 got through.
 */
interface DeliveredAdvice {
	readonly advice: Advice;
	readonly atCall: number;
	readonly atSearch: number;
}

async function writeReview(
	subjectAgentId: string,
	reviewerAgentId: string,
	gate: AdviceGate | undefined,
	cwd: string,
	journal: readonly ReviewJournalEntry[],
	deliveredAdvice: readonly DeliveredAdvice[],
): Promise<void> {
	try {
		const directory = resolveTraceDir(process.env, cwd);
		await mkdir(directory, { recursive: true });
		const payload = {
			subjectAgentId,
			reviewerAgentId,
			admitted: gate?.admitted() ?? [],
			refusals: gate?.refusals() ?? [],
			// What actually reached Main, as against what the gate admitted. They are
			// the same list unless delivery failed, and that difference is the only
			// evidence that it did.
			delivered: deliveredAdvice,
			// Every trigger, including the ones that produced nothing.
			journal,
		};
		await writeFile(join(directory, `${subjectAgentId}.review.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch {
		// As with the trace: a review that cannot be archived must not break anything.
	}
}

/** Read the service's thresholds, falling back per key rather than wholesale. */
function thresholdsFrom(reported: Readonly<Record<string, number>>): DetectorThresholds {
	const pick = (key: string, fallback: number): number => {
		const value = reported[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	return {
		minSearchesBeforeFacetProbe: pick("min_searches_before_facet_probe", FALLBACK_THRESHOLDS.minSearchesBeforeFacetProbe),
		subqueryJaccardCeiling: pick("subquery_jaccard_ceiling", FALLBACK_THRESHOLDS.subqueryJaccardCeiling),
		minSubqueriesForMonotony: pick("min_subqueries_for_monotony", FALLBACK_THRESHOLDS.minSubqueriesForMonotony),
		minEvidenceBeforeExpansion: pick("min_evidence_before_expansion", FALLBACK_THRESHOLDS.minEvidenceBeforeExpansion),
		maxFailuresPerSource: pick("max_failures_per_source", FALLBACK_THRESHOLDS.maxFailuresPerSource),
		maxFetchPerSearchRatio: pick("max_fetch_per_search_ratio", FALLBACK_THRESHOLDS.maxFetchPerSearchRatio),
		softCallBudget: pick("soft_call_budget", FALLBACK_THRESHOLDS.softCallBudget),
	};
}

/** One piece of advice, as Main reads it. */
function renderAdvice(advice: Advice): string {
	return [
		"Sidecar review of your search in progress (unsolicited; you did not request it and cannot):",
		`[${advice.action}] target: ${advice.target || "(none)"}`,
		`  ${advice.instructions}`,
		`  expected effect: ${advice.expectedEffect || "(not stated)"}`,
		`  evidence: ${advice.evidenceIds.join(", ") || "(none cited)"}`,
	].join("\n");
}

/**
 * Per-agent state for the trace and the Reviewer channel, at module scope.
 *
 * Module scope rather than the activation closure: an extension activates
 * **once per agent**, so the Reviewer gets its own activation with its own
 * closure. Holding this state there meant the Reviewer looked up its own review
 * and found an empty map, because the trace had been recorded in the subject
 * agent's activation. Keyed by agent id, which is what actually scopes an
 * episode.
 */
const collectors = new Map<string, TraceCollector>();
/**
 * One answer pool per agent, for the same reason the collector is per agent.
 *
 * Per agent rather than per session is the whole point: the eval runner spawns a
 * fresh agent per query inside one session precisely so query N cannot see query
 * N-1's results (`experiments/eval-runner/run.mjs`). A session-scoped pool would
 * collapse every query's answer into one, and each query's number would stop
 * meaning anything (`docs/develop/plan.md` §3.2).
 */
const answerPools = new Map<string, AnswerPool>();
const gates = new Map<string, AdviceGate>();
const tracesUnderReview = new Map<string, PublicSearchTrace>();
const reviewerToSubject = new Map<string, string>();
/**
 * Subject -> its resident Reviewer, and the claim that stops a second one.
 *
 * Two maps rather than one because the claim has to be made **synchronously**,
 * before the first `await`: `agent_spawned` broadcasts to the whole tree, so the
 * same spawn can reach two activations, and both would otherwise get past a
 * `has()` check on a map that is only filled after `spawnAgent` resolves.
 */
const subjectToReviewer = new Map<string, string>();
const reviewerClaimed = new Set<string>();
const thresholdsBySubject = new Map<string, DetectorThresholds>();
/**
 * Which detector conditions have already been delivered for a subject.
 *
 * A detector fires on the transition from "not holding" to "holding", once. That
 * is what bounds the number of review rounds without capping observation
 * (D-14): R1-R7 can each contribute at most one trigger.
 */
const firedConditions = new Map<string, Set<string>>();
const reviewJournals = new Map<string, ReviewJournalEntry[]>();
const deliveredAdvice = new Map<string, DeliveredAdvice[]>();
/** Per-subject serialisation of deliveries; see `MAX_QUEUED_REVIEWS_PER_SUBJECT`. */
const reviewChains = new Map<string, Promise<void>>();
const reviewQueueDepth = new Map<string, number>();

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => {
		// One collector per agent: the trace is an episode-scoped artefact, and an
		// agent tree can hold several agents at once.
		const collectorFor = (agentId: string): TraceCollector => {
			const existing = collectors.get(agentId);
			if (existing) return existing;
			const created = createTraceCollector({ agentId, profileId: api.profileId });
			collectors.set(agentId, created);
			return created;
		};

		const journalFor = (subjectAgentId: string): ReviewJournalEntry[] => {
			const existing = reviewJournals.get(subjectAgentId);
			if (existing) return existing;
			const created: ReviewJournalEntry[] = [];
			reviewJournals.set(subjectAgentId, created);
			return created;
		};

		const note = (subjectAgentId: string, entry: Omit<ReviewJournalEntry, "at" | "atCall" | "atSearch">): void => {
			const trace = collectors.get(subjectAgentId)?.snapshot();
			journalFor(subjectAgentId).push({
				at: new Date().toISOString(),
				...(trace === undefined
					? {}
					: { atCall: trace.budget.totalCalls, atSearch: trace.budget.callsByTool.search_metadata ?? 0 }),
				...entry,
			});
		};

		/**
		 * Attach a resident Reviewer to one search agent, once.
		 *
		 * The extension spawns it, not the Main Agent. That is what makes the
		 * channel a bypass: `profiles/search.md` lists neither `spawn_agent` nor
		 * `send_message`, so Main has no way to reach a Reviewer even if it wanted
		 * one. "Main cannot ask for help" is a property of the tool set, not a rule
		 * in a prompt (`docs/design.md` §3).
		 *
		 * Resident rather than one-per-checkpoint (D-10): $C^R_t$ carries a $t$
		 * subscript, so a Reviewer that remembers having already raised diversity is
		 * closer to the formalisation than one that starts from nothing each time and
		 * relies on the gate's novelty key to deduplicate. It also makes the Reviewer
		 * something the user can switch to in the agent strip and talk to, which is
		 * where $NP_0$ seeds come from (`docs/reviewer-design.md` §3, §5.2b).
		 */
		async function ensureReviewer(subjectAgentId: string, context: ExtensionContext): Promise<string | undefined> {
			if (!reviewerEnabled(process.env)) return undefined;
			// Claimed synchronously, before any await: `agent_spawned` broadcasts to
			// the tree, so two activations can reach this for the same subject.
			if (reviewerClaimed.has(subjectAgentId)) return subjectToReviewer.get(subjectAgentId);
			reviewerClaimed.add(subjectAgentId);

			// Thresholds are $HP_k$ and the service is their author (D-15). One call
			// per episode, and a failure degrades to the placeholders rather than
			// leaving every detector comparing against nothing.
			let thresholds = FALLBACK_THRESHOLDS;
			try {
				const reported = await clientFromEnv().getReviewConfig();
				thresholds = thresholdsFrom(reported.thresholds);
			} catch (error) {
				note(subjectAgentId, {
					trigger: "attach",
					conditions: [],
					delivered: false,
					note:
						"could not read the review thresholds from the Search Service, using the extension's " +
						`placeholders: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			thresholdsBySubject.set(subjectAgentId, thresholds);

			const reviewerModel = process.env[REVIEWER_MODEL_ENV_VAR]?.trim();
			let reviewerId: string;
			try {
				reviewerId = await context.actions.spawnAgent({
					origin: { kind: "new", profileId: REVIEWER_PROFILE_ID },
					...(reviewerModel ? { model: reviewerModel } : {}),
				});
			} catch (error) {
				// A Reviewer that could not start is a fact about the configuration, and
				// it has to be recorded: an absent review file is indistinguishable from
				// a review that ran and found nothing.
				note(subjectAgentId, {
					trigger: "attach",
					conditions: [],
					delivered: false,
					note: `spawnAgent failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				await writeReview(
					subjectAgentId,
					"(not spawned)",
					undefined,
					process.cwd(),
					journalFor(subjectAgentId),
					[],
				);
				return undefined;
			}

			reviewerToSubject.set(reviewerId, subjectAgentId);
			subjectToReviewer.set(subjectAgentId, reviewerId);
			gates.set(reviewerId, createAdviceGate());
			note(subjectAgentId, { trigger: "attach", conditions: [], delivered: false, note: `reviewer ${reviewerId} attached` });
			return reviewerId;
		}

		/**
		 * Hand the current trace to the resident Reviewer.
		 *
		 * Serialised per subject because `prompt` refuses a busy target rather than
		 * queueing, and a refused delivery would be indistinguishable from a trigger
		 * that never fired (`docs/reviewer-design.md` §8). Beyond one in flight and
		 * one waiting, the trigger is dropped **and journalled**.
		 */
		function scheduleReview(
			subjectAgentId: string,
			reviewerId: string,
			trigger: "answer_pool" | "detector",
			conditions: readonly DetectedCondition[],
			context: ExtensionContext,
		): void {
			const depth = reviewQueueDepth.get(subjectAgentId) ?? 0;
			if (depth >= MAX_QUEUED_REVIEWS_PER_SUBJECT) {
				note(subjectAgentId, {
					trigger,
					conditions: conditions.map((condition) => condition.id),
					delivered: false,
					note: `dropped: ${depth} review(s) already in flight or queued for this subject`,
				});
				return;
			}
			reviewQueueDepth.set(subjectAgentId, depth + 1);
			const previous = reviewChains.get(subjectAgentId) ?? Promise.resolve();
			const next = previous
				.then(() => deliverReview(subjectAgentId, reviewerId, trigger, conditions, context))
				.catch(() => {
					// A failed delivery is already journalled inside `deliverReview`.
				})
				.finally(() => {
					reviewQueueDepth.set(subjectAgentId, Math.max(0, (reviewQueueDepth.get(subjectAgentId) ?? 1) - 1));
				});
			reviewChains.set(subjectAgentId, next);
		}

		async function deliverReview(
			subjectAgentId: string,
			reviewerId: string,
			trigger: "answer_pool" | "detector",
			conditions: readonly DetectedCondition[],
			context: ExtensionContext,
		): Promise<void> {
			const collector = collectors.get(subjectAgentId);
			if (!collector) return;
			// Snapshotted here rather than at trigger time: a queued delivery should
			// carry the trace as it is when it goes out, not as it was when queued.
			const trace = collector.snapshot();
			tracesUnderReview.set(reviewerId, trace);

			let outcome: unknown;
			try {
				outcome = await context.actions.prompt(
					`${renderTraceForReviewer(trace, { conditions })}\n\n` +
						"This search is still running. Advise on anything that should change while it still can - " +
						"call provide_advice for each point, citing evidence ids from the trace above, or a single " +
						"`stop` if the search looks sound. Each accepted piece is delivered to the searching agent " +
						"immediately, so send one point at a time rather than a summary. Do not answer in prose alone: " +
						"a verdict not recorded through the tool is not part of the trajectory and cannot be attributed.",
					// Rendered as a human turn rather than as an extension notice. The
					// label is provenance only, but it decides how the message reaches
					// the model, and an extension-labelled message left this model
					// answering with empty content: a conversation whose last turn is
					// not a user turn is not one it replies to.
					{ target: reviewerId, source: { kind: "human", label: "public search trace" } },
				);
				note(subjectAgentId, {
					trigger,
					conditions: conditions.map((condition) => condition.id),
					delivered: true,
					note: summariseOutcome(outcome).slice(0, 600),
				});
			} catch (error) {
				// A Reviewer that failed to answer is a missing review, not a failure of
				// the search it was reviewing. Recorded either way.
				note(subjectAgentId, {
					trigger,
					conditions: conditions.map((condition) => condition.id),
					delivered: false,
					note: `prompt failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}

			await writeReview(
				subjectAgentId,
				reviewerId,
				gates.get(reviewerId),
				process.cwd(),
				journalFor(subjectAgentId),
				deliveredAdvice.get(subjectAgentId) ?? [],
			);
		}

		/**
		 * Trigger source two: the detectors, re-run after every tool call.
		 *
		 * A condition delivers once, on the transition from not holding to holding.
		 * That is what keeps the number of rounds finite without capping observation
		 * (D-14), and it is why the gate's novelty key still matters: the same
		 * condition seen again is stopped here, and a Reviewer repeating itself about
		 * a different condition is stopped there.
		 */
		function reviewOnDetectors(subjectAgentId: string, context: ExtensionContext): void {
			const reviewerId = subjectToReviewer.get(subjectAgentId);
			if (reviewerId === undefined) return;
			const collector = collectors.get(subjectAgentId);
			if (!collector) return;
			const trace = collector.snapshot();
			if (trace.calls.length === 0) return;
			const conditions = detectConditions(trace, thresholdsBySubject.get(subjectAgentId) ?? FALLBACK_THRESHOLDS);
			const seen = firedConditions.get(subjectAgentId) ?? new Set<string>();
			firedConditions.set(subjectAgentId, seen);
			const fresh = conditions.filter((condition) => !seen.has(condition.id));
			if (fresh.length === 0) return;
			for (const condition of fresh) seen.add(condition.id);
			scheduleReview(subjectAgentId, reviewerId, "detector", fresh, context);
		}

		/**
		 * Trigger source one: the answer pool changed (D-11).
		 *
		 * Kept alongside the detectors rather than instead of them. If the pool were
		 * the only source, Main would indirectly control the intervention rate -
		 * never write to the pool, never be reviewed - and $\Delta_{\mathrm{sidecar}}$
		 * would become endogenous again, which is exactly what `mapping.md` §3.4
		 * rejected. The detectors are the floor.
		 */
		function reviewOnAnswerPool(subjectAgentId: string, context: ExtensionContext): void {
			const reviewerId = subjectToReviewer.get(subjectAgentId);
			if (reviewerId === undefined) return;
			const trace = collectors.get(subjectAgentId)?.snapshot();
			const conditions =
				trace === undefined
					? []
					: detectConditions(trace, thresholdsBySubject.get(subjectAgentId) ?? FALLBACK_THRESHOLDS);
			scheduleReview(subjectAgentId, reviewerId, "answer_pool", conditions, context);
		}

		// $\bar{\tau}_t$ is built by filtering this stream, never by transcribing it.
		// `core/trajectory.ts` holds the allow-list; the handler only routes.
		api.observe("agent_harness_event", async (event, context) => {
			collectorFor(event.agentId).record(event.event);
			// A Reviewer only ever watches a search agent, and never itself.
			if (api.profileId !== SUBJECT_PROFILE_ID) return;
			const inner = event.event as { type?: unknown; toolName?: unknown };
			if (inner?.type !== "tool_execution_end") return;
			// Second entry point for attaching. `agent_spawned` broadcasts to the tree,
			// but nothing guarantees it reaches an activation that can act on it - the
			// subject may be the tree root, spawned before this extension activated.
			// Both paths run the same idempotent claim, so whichever arrives first wins.
			await ensureReviewer(event.agentId, context);
			if (inner.toolName === "update_answer_pool") reviewOnAnswerPool(event.agentId, context);
			reviewOnDetectors(event.agentId, context);
		});

		// A search agent is created; give it a Reviewer. Stateless in the ordering
		// sense: the condition is the profile id, not a table this handler filled in
		// earlier, so an event arriving out of order cannot defeat it. Recursion is
		// blocked by the same condition - a Reviewer's own spawn has profile id
		// `reviewer` (`docs/reviewer-design.md` §5.2b).
		api.observe("agent_spawned", async (event, context) => {
			if (event.profile.id !== SUBJECT_PROFILE_ID) return;
			await ensureReviewer(event.agentId, context);
		});

		// An idle agent has finished its turn, which is when the trace is worth
		// publishing. It is **not** when a review is worth running: a review at idle
		// arrives after the final answer and cannot change the search it reviewed,
		// which is precisely the gap G-1 records.
		api.observe("agent_idle", async (event, context) => {
			const collector = collectors.get(event.agentId);
			if (!collector) return;
			const trace = collector.snapshot();
			if (trace.calls.length === 0) return;
			await writeTrace(trace, process.cwd());
			try {
				await context.actions.emitExtensionEvent("scholar-search:trace", JSON.parse(JSON.stringify(trace)));
			} catch {
				// A bus with no listener is the normal case; the trace is still on disk.
			}
		});

		// The Reviewer's lifetime is the episode, not the session. The eval runner
		// spawns a fresh Main per query, and a Reviewer surviving across queries would
		// carry query N-1's trace into query N - breaking the isolation that runner
		// exists to preserve (`docs/reviewer-design.md` §5.2b, third constraint).
		api.observe("agent_disposed", async (event, context) => {
			const reviewerId = subjectToReviewer.get(event.agentId);
			if (reviewerId === undefined) return;
			subjectToReviewer.delete(event.agentId);
			reviewerToSubject.delete(reviewerId);
			tracesUnderReview.delete(reviewerId);
			try {
				await context.actions.disposeAgent(reviewerId, {
					scope: "agent",
					reason: "the search it reviewed was disposed",
				});
			} catch {
				// A Reviewer that outlives its subject is untidy, not incorrect: it has
				// no trace to review and no subject to advise.
			}
		});

		api.registerTool({
			name: "provide_advice",
			label: "Provide Advice",
			description:
				"Offer one piece of actionable advice about the search you are reviewing. " +
				"`action` must come from the fixed set; `evidence_ids` must be ids from the trace you were given; " +
				"`novelty_key` is how repeats are detected. Advice is capped per episode, and a refusal comes back " +
				"with its reason - read it rather than re-sending the same point.",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: [...ADVICE_ACTIONS],
						description: "What the searching agent should do differently.",
					},
					target: { type: "string", description: "What the advice is about: a query, a source, a paper id, a facet." },
					instructions: { type: "string", description: "What to do, concretely enough to act on." },
					evidence_ids: {
						type: "array",
						items: { type: "string" },
						description: "Ids from the trace that support this. Ids not in the trace are refused.",
					},
					confidence: { type: "number", minimum: 0, maximum: 1, description: "How confident you are." },
					expected_effect: { type: "string", description: "What should change if this advice is followed." },
					novelty_key: { type: "string", description: "Short key describing what is new here; repeats are dropped." },
				},
				required: ["action", "instructions", "novelty_key"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const reviewerId = context.extension?.host?.agentId;
				const gate = reviewerId === undefined ? undefined : gates.get(reviewerId);
				const trace = reviewerId === undefined ? undefined : tracesUnderReview.get(reviewerId);
				if (gate === undefined || trace === undefined) {
					throw new Error(
						"provide_advice is only available to a Reviewer that was given a trace to review. " +
							"There is no review in progress for this agent.",
					);
				}

				const evidenceIds = new Set<string>([
					...trace.evidence.map((item) => item.paperId),
					...trace.calls.map((call) => call.toolCallId),
				]);
				const result = gate.admit(params, { evidenceIds });
				if (!result.admitted) {
					// A refusal is a tool result, not a thrown error: the Reviewer should
					// read the reason and decide, not treat it as a broken tool.
					const text = `Advice refused (${result.refusal}): ${result.reason}`;
					return { content: [{ type: "text", text }], details: { admitted: false, refusal: result.refusal } };
				}
				// Delivered here, one piece per message, at the moment it is admitted.
				//
				// The alternative - collecting `gate.admitted()` and pushing the whole
				// list at the end of each review - is what the previous implementation
				// did, and it was safe only because each Reviewer was new and so was its
				// gate. With one resident gate per episode, `admitted()` is cumulative:
				// the third checkpoint would re-deliver the first two pieces, the sixth
				// would deliver six. Main's observed response to repeated content is to
				// restate it rather than act on it (`docs/reviewer-design.md` §2.3,
				// §5.2d), so re-delivery is not merely wasteful.
				//
				// `precede`, not `prompt` or `followUp`: advice is context for work not
				// yet started, and alone among the four it can never be refused or
				// deferred - so this direction has none of the busy-target problem the
				// extension -> Reviewer direction has.
				const advice = result.advice;
				const subjectAgentId = reviewerToSubject.get(reviewerId ?? "");
				let deliveryNote = "";
				if (advice !== undefined && subjectAgentId !== undefined) {
					const actions = context.extension?.host?.actions;
					if (actions === undefined) {
						deliveryNote = " It could not be delivered: this runtime gave the tool no action surface.";
					} else {
						try {
							await actions.precede(renderAdvice(advice), { target: subjectAgentId });
							const delivered = deliveredAdvice.get(subjectAgentId) ?? [];
							const at = collectors.get(subjectAgentId)?.snapshot();
							delivered.push({
								advice,
								atCall: at?.budget.totalCalls ?? -1,
								atSearch: at?.budget.callsByTool.search_metadata ?? -1,
							});
							deliveredAdvice.set(subjectAgentId, delivered);
							deliveryNote = " It has been delivered to the searching agent, which will read it on its next turn.";
						} catch (error) {
							// Delivery failing leaves the advice in the gate's admitted list,
							// and the difference between admitted and delivered is the only
							// record that it happened.
							deliveryNote = ` It could not be delivered: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
				}
				const text =
					`Advice accepted (${advice?.action}). ` +
					`${gate.admitted().length} of the episode's advice budget used.${deliveryNote}`;
				return {
					content: [{ type: "text", text }],
					details: { admitted: true, advice, delivered: deliveryNote.includes("has been delivered") },
				};
			},
		});

		api.registerTool({
			name: "inspect_evidence",
			label: "Inspect Evidence",
			description:
				"Look up evidence ids from the trace you are reviewing. Read-only, and limited to the trace - it " +
				"cannot fetch anything the search did not already find.",
			parameters: {
				type: "object",
				properties: {
					evidence_ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Ids to look up." },
				},
				required: ["evidence_ids"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const reviewerId = context.extension?.host?.agentId;
				const trace = reviewerId === undefined ? undefined : tracesUnderReview.get(reviewerId);
				if (trace === undefined) throw new Error("inspect_evidence needs a trace under review; there is none.");

				const input = readParams<{ evidence_ids: string[] }>(params);
				const wanted = new Set(Array.isArray(input.evidence_ids) ? input.evidence_ids : []);
				const found = trace.evidence.filter((item) => wanted.has(item.paperId));
				const calls = trace.calls.filter((call) => wanted.has(call.toolCallId));
				const missing = [...wanted].filter(
					(id) => !found.some((item) => item.paperId === id) && !calls.some((call) => call.toolCallId === id),
				);

				const lines = [`${found.length} paper(s) and ${calls.length} call(s) matched.`];
				for (const item of found)
					lines.push(`  ${item.paperId} :: ${item.title} [sources: ${item.sources.join(", ")}]`);
				for (const call of calls) {
					lines.push(
						`  ${call.toolCallId} :: ${call.toolName}${call.failed ? " FAILED" : ""} ${JSON.stringify(call.args)}`,
					);
				}
				// Naming the misses matters: it is how the Reviewer learns an id it was
				// about to cite is not citable.
				if (missing.length > 0) lines.push(`  not in this trace: ${missing.join(", ")}`);

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { found, calls, missing } };
			},
		});

		api.registerTool({
			name: "get_ranking_features",
			label: "Get Ranking Features",
			description:
				"Report the ranking features and reason recorded for papers in the trace you are reviewing. " +
				"Read-only. This service build records rank and score only; richer features do not exist yet, " +
				"and the answer says so rather than inventing them.",
			parameters: {
				type: "object",
				properties: {
					paper_ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Papers to report on." },
				},
				required: ["paper_ids"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const reviewerId = context.extension?.host?.agentId;
				const trace = reviewerId === undefined ? undefined : tracesUnderReview.get(reviewerId);
				if (trace === undefined) throw new Error("get_ranking_features needs a trace under review; there is none.");

				const input = readParams<{ paper_ids: string[] }>(params);
				const wanted = new Set(Array.isArray(input.paper_ids) ? input.paper_ids : []);
				const known = trace.evidence.filter((item) => wanted.has(item.paperId));
				const lines = [
					"This build records no per-paper ranking features. What the trace holds is which call surfaced " +
						"each paper and which source supplied it; treat any claim about feature weights as unsupported.",
				];
				for (const item of known) {
					lines.push(`  ${item.paperId}: found by ${item.foundBy}, sources ${item.sources.join(", ") || "unknown"}`);
				}
				const missing = [...wanted].filter((id) => !known.some((item) => item.paperId === id));
				if (missing.length > 0) lines.push(`  not in this trace: ${missing.join(", ")}`);

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { features: known, rankReason: "not recorded in this build", missing },
				};
			},
		});

		api.registerTool({
			name: "list_providers",
			label: "List Providers",
			description:
				"List every search provider the Search Service has configured, with the capabilities it advertises, " +
				"the unified fields it can populate, its cost model and its remaining quota. " +
				"This is the runtime source of truth for what the sources can do: call it before choosing a source " +
				"or writing a provider-native query, and do not assume a capability that is not listed here.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute(_toolCallId, _params, context) {
				context.signal?.throwIfAborted();
				// Resolved per call, not captured at activation: the address is
				// environment, and a tool that cached it would keep dialling a service
				// the user has since moved.
				const client = clientFromEnv();

				let providers: readonly ProviderRecord[];
				try {
					providers = await client.listProviders({ signal: context.signal ?? undefined });
				} catch (error) {
					// A failed tool throws: swallowing it here would show the agent an
					// empty provider list, which reads as "there are no sources".
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				if (providers.length === 0) {
					const text =
						`The Search Service at ${client.baseUrl} is reachable but has no providers configured. ` +
						"No source-backed retrieval is possible until one is enabled.";
					return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, providers: [] } };
				}

				const enabled = providers.filter((provider) => provider.enabled);
				const header =
					`${providers.length} provider(s) configured at ${client.baseUrl}, ` +
					`${enabled.length} enabled. Disabled providers cannot serve a query.`;
				let text = `${header}\n\n${providers.map(formatProvider).join("\n")}`;
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;

				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, providers } };
			},
		});

		api.registerTool({
			name: "search_metadata",
			label: "Search Metadata",
			description:
				"Search the configured academic sources for papers matching a research question and return a ranked " +
				"candidate list with citations, abstracts and the process account of what the search did. " +
				"This is the main retrieval tool. `subqueries` runs additional phrasings or facets alongside the main " +
				"query and fuses all of them into one ranking, so a paper found by several of them ranks higher. " +
				"`end_date` bounds publication date and must carry the research question's date boundary whenever it " +
				"has one. Results are a reference view, not full records: use get_paper for one paper's detail.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"The main query. Terms are combined with AND, so every term must appear: send the concepts that " +
							"define the paper you want, not a sentence. Wrap a multi-word term in double quotes to keep it a " +
							'phrase, e.g. \'"active learning" "semantic segmentation" superpixel\'. More terms means narrower; ' +
							"send a second phrasing through `subqueries` rather than piling terms into one query.",
					},
					subqueries: {
						type: "array",
						items: { type: "string" },
						maxItems: 8,
						description:
							"Additional queries run alongside `query` and fused into one ranking. " +
							"Each one costs a call to every selected source, so send only decompositions that ask something different.",
					},
					intent: {
						type: "string",
						description:
							"What the caller is trying to do with the results, recorded on the call for later analysis. " +
							"It does not change ranking in this service build.",
					},
					top_k: {
						type: "integer",
						minimum: 1,
						maximum: 200,
						description: "How many ranked results to return (default 20).",
					},
					end_date: {
						type: "string",
						description:
							"Exclusive upper bound on publication date, as YYYY-MM-DD or YYYY. Omit only if the question has no boundary.",
					},
					sources: {
						type: "array",
						items: { type: "string" },
						description:
							"Restrict to these providers. Omit to use every enabled source; see list_providers for the names.",
					},
					judge_level: {
						type: "string",
						enum: ["off", "auto", "l3a", "l3b", "l3c"],
						description:
							"How much relevance judging to spend on the candidates. " +
							"This service build implements no judge, so anything but 'off' is reported back as unsupported rather than silently ignored.",
					},
				},
				required: ["query"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{
					query: string;
					subqueries?: string[];
					intent?: string;
					top_k?: number;
					end_date?: string;
					sources?: string[];
					judge_level?: string;
				}>(params);
				if (typeof input.query !== "string" || input.query.trim() === "") {
					throw new Error("search_metadata requires a non-empty query.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["searchMetadata"]>>;
				try {
					result = await client.searchMetadata(
						{
							query: input.query,
							subqueries: input.subqueries,
							topK: input.top_k,
							endDate: input.end_date,
							sources: input.sources,
						},
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				// Unsupported knobs are reported, never dropped in silence: an agent
				// that thinks it bought judging would misread the candidate list.
				const notes: string[] = [];
				if (input.judge_level !== undefined && input.judge_level !== "off") {
					notes.push(
						`judge_level='${input.judge_level}' was requested but this Search Service build implements no ` +
							"relevance judge, so the candidates below are unjudged. Treat the ranking as recall order, not relevance.",
					);
				}
				if (input.intent !== undefined) {
					notes.push(`intent='${input.intent}' was recorded on the call but does not affect ranking in this build.`);
				}

				const shown = result.papers.slice(0, MAX_LISTED_PAPERS);
				const elided = result.papers.length - shown.length;
				const sections = [
					`${result.papers.length} result(s) in ${result.elapsedMs}ms for "${input.query}".`,
					formatSearchState(result.searchState),
					...notes,
					result.papers.length === 0
						? "No candidates. Widen the query, drop a filter, or check list_providers for what the sources support."
						: shown.map(formatPaper).join("\n"),
				];
				if (elided > 0) {
					sections.push(`[${elided} further result(s) not listed here; they are in this call's structured details.]`);
				}

				let text = sections.filter((section) => section !== "").join("\n\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return {
					content: [{ type: "text", text }],
					details: {
						baseUrl: client.baseUrl,
						query: input.query,
						subqueries: input.subqueries ?? [],
						intent: input.intent ?? null,
						judgeLevel: input.judge_level ?? "off",
						judgeSupported: false,
						papers: result.papers,
						searchState: result.searchState,
						elapsedMs: result.elapsedMs,
					},
				};
			},
		});

		api.registerTool({
			name: "get_paper",
			label: "Get Paper",
			description:
				"Fetch one paper's record by its stable identifier - the `id` field of a search_metadata result, a DOI, " +
				"an arXiv id or an OpenAlex id. Use it to inspect a specific candidate instead of re-running a search. " +
				"Reports which source answered, so a thin record can be attributed.",
			parameters: {
				type: "object",
				properties: {
					paper_id: {
						type: "string",
						description: "Stable identifier: a search_metadata `id`, a DOI, an arXiv id, or an OpenAlex id.",
					},
				},
				required: ["paper_id"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ paper_id: string }>(params);
				if (typeof input.paper_id !== "string" || input.paper_id.trim() === "") {
					throw new Error("get_paper requires a non-empty paper_id.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["getPaper"]>>;
				try {
					result = await client.getPaper(input.paper_id.trim(), { signal: context.signal ?? undefined });
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const lines = [`Resolved by ${result.source} (tried: ${result.triedSources.join(" -> ")}).`];
				if (result.failures.length > 0) {
					lines.push(
						`Sources that failed first: ${result.failures
							.map((failure) => `${failure.source ?? "unknown"} [${failure.errorType}] ${failure.message}`)
							.join("; ")}`,
					);
				}
				lines.push(formatPaper(result.paper, 0));
				if (result.paper.url !== null) lines.push(`   url: ${result.paper.url}`);

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, ...result } };
			},
		});

		api.registerTool({
			name: "provider_query",
			label: "Provider Query",
			description:
				"Send a query written in one provider's own syntax straight to that provider and return its raw " +
				"response, unrewritten. Use it when the unified search cannot express the constraint you need. " +
				"Call list_providers first: it reports which providers accept native queries, which fields are " +
				"currently available, and the syntax for each. Do not guess a syntax or a field name from memory - " +
				"a rejected field comes back as a diagnostic, and the wasted call still costs quota.",
			parameters: {
				type: "object",
				properties: {
					provider: {
						type: "string",
						description:
							"Provider name as reported by list_providers. Only providers advertising native queries will accept this.",
					},
					endpoint: {
						type: "string",
						description:
							"Provider-side entity or endpoint path, where the provider has more than one. Omit for the provider's default.",
					},
					raw: {
						type: "object",
						additionalProperties: true,
						description: "The provider-native query parameters, forwarded verbatim.",
					},
				},
				required: ["provider", "raw"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ provider: string; endpoint?: string; raw?: Record<string, unknown> }>(params);
				if (typeof input.provider !== "string" || input.provider.trim() === "") {
					throw new Error("provider_query requires a provider name; call list_providers for the available names.");
				}
				if (
					input.raw !== undefined &&
					(typeof input.raw !== "object" || input.raw === null || Array.isArray(input.raw))
				) {
					throw new Error("provider_query's `raw` must be an object of provider-native parameters.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["providerQuery"]>>;
				try {
					result = await client.providerQuery(
						{ provider: input.provider.trim(), endpoint: input.endpoint, params: input.raw ?? {} },
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				// The raw response is the deliverable, so it is serialised rather than
				// summarised - but it is still bounded, because a provider page can be
				// far larger than the context it would land in.
				const serialised = JSON.stringify(result.raw, null, 2) ?? "null";
				const text =
					`Raw response from ${result.provider}` +
					`${input.endpoint === undefined ? "" : ` (${input.endpoint})`}:\n` +
					`${truncate(serialised, MAX_PASSTHROUGH_CHARS)}` +
					(serialised.length > MAX_PASSTHROUGH_CHARS
						? "\n[response truncated here; the whole payload is in this call's structured details]"
						: "");

				return {
					content: [{ type: "text", text }],
					details: {
						baseUrl: client.baseUrl,
						provider: result.provider,
						endpoint: input.endpoint ?? null,
						raw: result.raw,
					},
				};
			},
		});

		api.registerTool({
			name: "expand_citations",
			label: "Expand Citations",
			description:
				"Walk the citation graph out from papers you already have. `backward` follows what a seed cites; " +
				"`forward` follows what cites it. Returns the papers reached and the edges traversed. " +
				"Depth and fan-out are bounded by the service's configuration: you may ask for less than the ceiling " +
				"and get it, and if you ask for more the answer says which bounds were reduced. Read that field - a " +
				"clamped walk is not an exhausted graph. Not every source can do this; check list_providers.",
			parameters: {
				type: "object",
				properties: {
					seed_ids: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						description: "Identifiers to expand from, as returned by search_metadata or get_paper.",
					},
					direction: {
						type: "string",
						enum: ["backward", "forward"],
						description: "`backward` = works the seeds cite; `forward` = works citing the seeds. Default backward.",
					},
					depth: { type: "integer", minimum: 1, description: "Hops to walk. Clamped to the configured ceiling." },
					fanout: {
						type: "integer",
						minimum: 1,
						description: "Maximum edges to follow per seed. Clamped to the configured ceiling.",
					},
				},
				required: ["seed_ids"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{
					seed_ids: string[];
					direction?: "backward" | "forward";
					depth?: number;
					fanout?: number;
				}>(params);
				if (!Array.isArray(input.seed_ids) || input.seed_ids.length === 0) {
					throw new Error("expand_citations requires at least one seed_id.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["expandCitations"]>>;
				try {
					result = await client.expandCitations(
						{ seedIds: input.seed_ids, direction: input.direction, depth: input.depth, fanout: input.fanout },
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const lines = [
					`${result.direction} expansion from ${input.seed_ids.length} seed(s): ` +
						`${result.papers.length} paper(s) reached over ${result.edges.length} edge(s), ` +
						`${result.providerCalls} provider call(s).`,
					`bounds in force: ${JSON.stringify(result.effectiveLimits)}`,
				];
				// A clamp the agent cannot see is a clamp it will reason past.
				if (result.clamped.length > 0) {
					lines.push(
						`REDUCED TO THE CONFIGURED CEILING: ${result.clamped.join(", ")}. ` +
							"This walk was cut short by configuration, so a thin result here does not mean a thin literature.",
					);
				}
				if (result.failures.length > 0) {
					lines.push(
						`failures (${result.failures.length}):`,
						...result.failures.map(
							(failure) => `  - ${failure.source ?? "service"} [${failure.errorType}] ${failure.message}`,
						),
					);
				}
				if (result.papers.length === 0) {
					// A rejected identifier and an empty graph are different facts, and
					// the old unconditional wording reported the first as the second -
					// which is what made the agent abandon citation expansion entirely
					// (`docs/develop/backlog.md` F-10).
					const badIds = result.failures.filter((failure) => failure.errorType === "bad_id");
					lines.push(
						badIds.length > 0
							? `No papers reached, and ${badIds.length} seed(s) were rejected as identifiers rather than searched. ` +
									"Fix those ids and call again; this is not a statement about the citation graph."
							: "No papers reached. The seeds were accepted as identifiers, so either they have no edges in " +
									"this direction or no enabled source holds them.",
					);
				} else {
					const shown = result.papers.slice(0, MAX_LISTED_PAPERS);
					lines.push("", shown.map(formatPaper).join("\n"));
					const elided = result.papers.length - shown.length;
					if (elided > 0) lines.push(`[${elided} further paper(s) in this call's structured details.]`);
				}

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, ...result } };
			},
		});

		api.registerTool({
			name: "facet_probe",
			label: "Facet Probe",
			description:
				"Ask how a query's results are distributed before paying to recall them - by year, by venue, by topic, " +
				"or whatever grouping fields the sources expose. Use it to find out whether a query is too broad, " +
				"too narrow, or landing in an unexpected field, without pulling the candidates first. " +
				"The available grouping fields come from list_providers, not from memory.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Query whose result distribution you want to see." },
					group_by: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						description:
							"Provider field names to group by. Bounded by configuration; see list_providers for the names.",
					},
				},
				required: ["query", "group_by"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ query: string; group_by: string[] }>(params);
				if (typeof input.query !== "string" || input.query.trim() === "") {
					throw new Error("facet_probe requires a non-empty query.");
				}
				if (!Array.isArray(input.group_by) || input.group_by.length === 0) {
					throw new Error("facet_probe requires at least one group_by field; call list_providers for the field names.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["facetProbe"]>>;
				try {
					result = await client.facetProbe(
						{ query: input.query, groupBy: input.group_by },
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const lines = [`Distribution for "${result.query}" (from ${result.source}):`];
				for (const [field, entries] of Object.entries(result.groups)) {
					const shown = entries.slice(0, MAX_FACET_BUCKETS);
					const rendered = shown.map((entry) => {
						const key = entry.key_display_name ?? entry.key ?? "(unknown)";
						return `    ${String(key)}: ${String(entry.count ?? "?")}`;
					});
					lines.push(`  ${field} (${entries.length} bucket(s)):`, ...rendered);
					if (entries.length > shown.length) lines.push(`    ... ${entries.length - shown.length} more bucket(s)`);
				}
				if (Object.keys(result.groups).length === 0) lines.push("  (the provider returned no groups for these fields)");

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, ...result } };
			},
		});

		api.registerTool({
			name: "rank_candidates",
			label: "Rank Candidates",
			description:
				"Re-rank candidates you already have against a query. This is rank-only: it scores and orders what you " +
				"give it and issues no search, so it can never add a paper you had not already found. " +
				"Pass the candidate records from a previous call's results. Use it to re-order after you have gathered " +
				"from several directions; use search_metadata when you need new candidates.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Query the candidates are ranked against." },
					candidates: {
						type: "array",
						items: { type: "object", additionalProperties: true },
						minItems: 1,
						description: "Candidate records to rank, as returned by a previous retrieval call.",
					},
					top_k: { type: "integer", minimum: 1, maximum: 200, description: "How many ranked results to return." },
				},
				required: ["query", "candidates"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ query: string; candidates: Record<string, unknown>[]; top_k?: number }>(params);
				if (typeof input.query !== "string" || input.query.trim() === "") {
					throw new Error("rank_candidates requires a non-empty query.");
				}
				if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
					throw new Error("rank_candidates requires at least one candidate record.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["rankCandidates"]>>;
				try {
					result = await client.rankCandidates(
						{ query: input.query, candidates: input.candidates, topK: input.top_k },
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const lines = [
					`Ranked ${result.scored} candidate(s) against "${input.query}". ` +
						`${result.providerCalls} provider call(s) - ranking adds no recall.`,
				];
				if (result.skipped > 0) {
					lines.push(`${result.skipped} record(s) could not be parsed as papers and were not ranked.`);
				}
				const shown = result.papers.slice(0, MAX_LISTED_PAPERS);
				lines.push("", shown.map(formatPaper).join("\n"));
				const elided = result.papers.length - shown.length;
				if (elided > 0) lines.push(`[${elided} further result(s) in this call's structured details.]`);

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, ...result } };
			},
		});

		api.registerTool({
			name: "search_fulltext",
			label: "Search Fulltext",
			description:
				"Fetch the body sections of papers you name, so a claim can be checked against the text rather than the " +
				"abstract. `query` filters and ranks those papers' sections by how well they match; it does NOT find " +
				"new papers - this tool never adds a paper you did not name. Use search_metadata for recall. " +
				"Full text is not available for every paper, and a paper without it comes back saying so, which is a " +
				"fact about coverage rather than an error.",
			parameters: {
				type: "object",
				properties: {
					paper_ids: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						description: "Papers whose full text to fetch. Bounded by configuration.",
					},
					query: {
						type: "string",
						description: "Return only sections matching this, most-matching first. Omit for all sections.",
					},
					sections: {
						type: "array",
						items: { type: "string" },
						description: "Section-heading filters, e.g. ['related work','method']. Omit for all sections.",
					},
				},
				required: ["paper_ids"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ paper_ids: string[]; query?: string; sections?: string[] }>(params);
				if (!Array.isArray(input.paper_ids) || input.paper_ids.length === 0) {
					throw new Error("search_fulltext requires at least one paper_id.");
				}

				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["searchFulltext"]>>;
				try {
					result = await client.searchFulltext(
						{ paperIds: input.paper_ids, query: input.query, sections: input.sections },
						{ signal: context.signal ?? undefined },
					);
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const available = result.papers.filter((paper) => paper.available && paper.sections.length > 0);
				const lines = [`Full text for ${result.papers.length} paper(s): ${available.length} with usable sections.`];
				if (result.clamped.length > 0) {
					lines.push(`REDUCED TO THE CONFIGURED CEILING: ${result.clamped.join(", ")}.`);
				}
				for (const paper of result.papers) {
					if (!paper.available || paper.sections.length === 0) {
						lines.push(`- ${paper.paperId}: unavailable - ${paper.reason ?? "no reason given"}`);
						continue;
					}
					lines.push(`- ${paper.paperId}: ${paper.sections.length} section(s)`);
					for (const section of paper.sections) {
						const match = section.matchCount > 0 ? ` [${section.matchCount} match(es)]` : "";
						lines.push(`  ## ${section.title}${match}`, `  ${truncate(section.text, MAX_FULLTEXT_CHARS_PER_SECTION)}`);
					}
				}

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, ...result } };
			},
		});

		/**
		 * The pool for the agent this activation belongs to.
		 *
		 * An extension activates once per agent, so `api.agentId` is the episode's
		 * identity - the same reasoning that moved the collector map to module scope.
		 */
		const poolFor = (agentId: string): AnswerPool => {
			const existing = answerPools.get(agentId);
			if (existing) return existing;
			const created = createAnswerPool({ agentId, now: () => new Date().toISOString() });
			answerPools.set(agentId, created);
			return created;
		};

		api.registerTool({
			name: "update_answer_pool",
			label: "Update Answer Pool",
			description:
				"Record which papers answer the question, incrementally. This is where your answer lives: the " +
				"evaluation reads this pool and nothing else, so a paper you only mention in prose does not count, " +
				"and an episode that ends with an empty pool has produced no answer at all. " +
				"Add a paper as soon as you are satisfied it belongs, with `why` saying what it contributes - the " +
				"`why` fields are what carry the structure of your answer. Withdraw a paper when you change your " +
				"mind; `reason` is required, and a withdrawal with its reason is a more useful record than a quiet " +
				"deletion. Adding the same paper twice updates its `why` rather than duplicating it, and identifiers " +
				"from different sources for one paper resolve to one entry. Call it repeatedly; do not batch it to " +
				"the end of the episode.",
			parameters: {
				type: "object",
				properties: {
					add: {
						type: "array",
						maxItems: 25,
						items: {
							type: "object",
							properties: {
								paper_id: {
									type: "string",
									description: "The paper's identifier: a search result `id`, a DOI, an arXiv id or an OpenAlex id.",
								},
								why: {
									type: "string",
									description:
										"What this paper contributes to the answer - the method, the direction, the claim it settles. " +
										"Not a restatement of the title.",
								},
							},
							required: ["paper_id", "why"],
						},
						description: "Papers to commit to.",
					},
					remove: {
						type: "array",
						maxItems: 25,
						items: {
							type: "object",
							properties: {
								paper_id: { type: "string", description: "The identifier you used when you added it." },
								reason: {
									type: "string",
									description: "Why it does not belong after all. Required - an unexplained withdrawal is unusable.",
								},
							},
							required: ["paper_id", "reason"],
						},
						description: "Papers to withdraw.",
					},
					note: {
						type: "string",
						description:
							"A note about the pool as a whole: what it covers, what it is still missing. Replaces the previous note.",
					},
				},
			},
			async execute(toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const agentId = context.extension?.host?.agentId;
				if (agentId === undefined) {
					throw new Error("update_answer_pool needs to know which agent it is recording for; the host reported none.");
				}
				const input = readParams<{
					add?: { paper_id?: unknown; why?: unknown }[];
					remove?: { paper_id?: unknown; reason?: unknown }[];
					note?: unknown;
				}>(params);
				const additions = Array.isArray(input.add) ? input.add : [];
				const removals = Array.isArray(input.remove) ? input.remove : [];
				const note = typeof input.note === "string" ? input.note.trim() : "";
				if (additions.length === 0 && removals.length === 0 && note === "") {
					throw new Error(
						"update_answer_pool needs at least one of `add`, `remove` or `note`. " +
							"To read the pool back without changing it, pass a `note` restating what you believe it covers.",
					);
				}

				const pool = poolFor(agentId);
				const client = clientFromEnv();
				const lines: string[] = [];

				for (const removal of removals) {
					const identifier = typeof removal?.paper_id === "string" ? removal.paper_id.trim() : "";
					const reason = typeof removal?.reason === "string" ? removal.reason.trim() : "";
					if (identifier === "" || reason === "") {
						lines.push(`  ! withdrawal skipped: both paper_id and reason are required (got '${identifier}').`);
						continue;
					}
					const result = pool.remove(identifier, reason, toolCallId);
					lines.push(
						result.outcome === "removed"
							? `  - withdrawn ${result.canonicalId}: ${reason}`
							: `  ! '${identifier}' is not in the pool, so there was nothing to withdraw.`,
					);
				}

				for (const addition of additions) {
					const identifier = typeof addition?.paper_id === "string" ? addition.paper_id.trim() : "";
					const why = typeof addition?.why === "string" ? addition.why.trim() : "";
					if (identifier === "" || why === "") {
						lines.push(`  ! addition skipped: both paper_id and why are required (got '${identifier}').`);
						continue;
					}
					// Resolved through the service, which is the only holder of the
					// identity rule and which returns the bibliographic fields the entry
					// needs anyway - so the extra call is not extra work (D-13).
					let looked: Awaited<ReturnType<ServiceClient["getPaper"]>> | undefined;
					try {
						looked = await client.getPaper(identifier, { signal: context.signal ?? undefined });
					} catch (error) {
						if (!(error instanceof ServiceRequestError)) throw error;
						// A paper the service cannot resolve is still the agent's answer;
						// refusing it would lose a real result over a thin record. It goes in
						// under the identifier as given, and the record says so.
						lines.push(
							`  ~ ${identifier} could not be resolved by the service (${error.detail ?? error.message}); ` +
								"committed under the identifier as given, without normalised identity.",
						);
					}
					const paper = looked?.paper;
					const result = pool.add(
						paper === undefined
							? { canonicalId: null, paperId: identifier }
							: {
									canonicalId: paper.canonicalId,
									paperId: identifier,
									arxivId: paper.arxivId,
									doi: paper.doi,
									openalexId: paper.openalexId,
									title: paper.title,
									authors: paper.authors,
									year: paper.year,
									venue: paper.venue,
									url: paper.url,
								},
						why,
						toolCallId,
					);
					lines.push(
						result.outcome === "added"
							? `  + ${result.entry.canonicalId} :: ${result.entry.title || "(no title)"}`
							: `  = ${result.entry.canonicalId} was already committed; its 'why' is updated.`,
					);
				}

				if (note !== "") pool.setNote(note);

				const snapshot = pool.snapshot();
				// `process.cwd()`, matching `writeTrace`: the pool and the trace must land
				// in one directory or the scorer finds half of an episode.
				const path = await writeAnswerPool(snapshot, process.cwd());
				if (path === undefined) {
					throw new Error(
						"The answer pool could not be written to disk. The evaluation reads that file, so the change " +
							"you just made would not be part of your answer. Check the trace directory is writable.",
					);
				}

				const text = [renderPoolSummary(snapshot), ...(lines.length > 0 ? ["", "this call:", ...lines] : [])].join("\n");
				return {
					content: [{ type: "text", text: truncate(text, MAX_OUTPUT_CHARS) }],
					// `pool` in the details is what the trajectory harvests, which is how a
					// Reviewer sees the pool's current content without a tool of its own.
					details: { baseUrl: client.baseUrl, pool: snapshot, path },
				};
			},
		});

		api.registerTool({
			name: "get_budget",
			label: "Get Budget",
			description:
				"Report the operational bounds you are subject to - expansion depth, fan-out, candidate ceilings, " +
				"per-source quotas - and what has been spent against them. Call it when deciding how much of an " +
				"expansion or how many searches to attempt. Note the `scope` field: spend is currently counted per " +
				"service process, not per request, so it is a floor on what has been used rather than your own usage.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute(_toolCallId, _params, context) {
				context.signal?.throwIfAborted();
				const client = clientFromEnv();
				let result: Awaited<ReturnType<ServiceClient["getBudget"]>>;
				try {
					result = await client.getBudget({ signal: context.signal ?? undefined });
				} catch (error) {
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				const spent = Object.entries(result.spent);
				const lines = [
					`Operational bounds in force (these are configuration; you cannot raise them):`,
					`  ${JSON.stringify(result.limits)}`,
					`Per-source quotas:`,
					`  ${JSON.stringify(result.quotas)}`,
					spent.length === 0
						? "Spent so far: nothing recorded."
						: `Spent so far (scope: ${result.scope}): ${spent.map(([key, value]) => `${key}=${value}`).join(", ")}`,
				];
				if (result.scope === "process") {
					lines.push(
						"`scope: process` means this counts every call the service has served since it started, " +
							"not only yours. Treat it as a lower bound on usage, not as your own budget consumption.",
					);
				}

				let text = lines.join("\n");
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
				return {
					content: [{ type: "text", text }],
					// `extensionVersion` rides along here because this is the tool that
					// reports effective configuration, and an evaluation run has to record
					// which tool set produced its numbers. WIDI's `inspect` names the
					// loaded extensions but carries no version for them.
					details: { baseUrl: client.baseUrl, extensionVersion: EXTENSION_VERSION, ...result },
				};
			},
		});
	},
};

export default extension;
