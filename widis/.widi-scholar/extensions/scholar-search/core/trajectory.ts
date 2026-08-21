/**
 * $\bar{\tau}_t$: the public search trace.
 *
 * This is the artefact a Reviewer is allowed to see. It is deliberately **not**
 * a transcript of the Main Agent's context (`docs/design.md` §5.1):
 *
 *   Main Agent : knows why it searched
 *   Reviewer   : knows what the search produced
 *
 * So this module is written as a filter, not as a recorder. Nothing reaches the
 * trace unless it is one of the two event shapes named in `COLLECTED_EVENTS`,
 * and those two carry a tool name, its arguments and its result - never a
 * thinking block, a chain of thought, or an assistant message. An allow-list is
 * the point: a deny-list would let the next event type added upstream leak by
 * default, and the one thing that must never leak is exactly the thing the
 * upstream stream is mostly made of.
 *
 * Two properties the collector has to hold that are easy to get wrong:
 *
 * - **Order is not guaranteed.** Observer events arrive in no particular order
 *   (`SKILL.md` §6), so an `end` can be seen before its `start`. Records are
 *   keyed by tool-call id and merged from either side.
 * - **It is bounded.** A trace that grows with the episode would eventually be
 *   the thing it is meant to summarise.
 */

/** The only two harness event types that may contribute to the trace. */
export const COLLECTED_EVENTS = ["tool_execution_start", "tool_execution_end"] as const;

const DEFAULT_MAX_CALLS = 200;
const DEFAULT_MAX_ARG_CHARS = 2_000;
const DEFAULT_MAX_EVIDENCE = 300;

/** One tool call as the Reviewer sees it. */
export interface TraceCall {
	readonly toolCallId: string;
	readonly toolName: string;
	/** The arguments the agent chose. Allowed by §5.1: issued queries and filter parameters are public. */
	readonly args: Readonly<Record<string, unknown>>;
	readonly failed: boolean;
	/** Present when the tool reported one - the actionable diagnostic, not a stack. */
	readonly errorMessage: string | undefined;
	/** Service-side account of this call, when the tool returned one. */
	readonly searchState: TraceSearchState | undefined;
	/** Arrival index, so a consumer can see the order this runtime observed. */
	readonly seq: number;
}

export interface TraceSearchState {
	readonly issuedQueries: readonly {
		readonly provider: string;
		readonly query: string | null;
		/**
		 * What the provider was actually sent. Required in the trace, not optional:
		 * a Reviewer reading only the agent's wording cannot see a rewrite, and the
		 * one rewrite that mattered turned every query into an OR bag
		 * (`docs/develop/backlog.md` F-1, B-2).
		 */
		readonly nativeQuery: string | null;
	}[];
	readonly selectedSources: readonly string[];
	readonly filters: Readonly<Record<string, unknown>>;
	readonly recalled: number;
	readonly returned: number;
	readonly failures: readonly {
		readonly source: string | null;
		readonly errorType: string;
		readonly message: string;
	}[];
}

/** What the episode cost, in the only currency this system actually meters: calls. */
export interface TraceBudget {
	readonly totalCalls: number;
	readonly failedCalls: number;
	readonly callsByTool: Readonly<Record<string, number>>;
	readonly droppedCalls: number;
}

/**
 * One candidate as a referenceable piece of evidence.
 *
 * `EvidenceState` in `docs/design.md` §5.1 - what the search *found*, as against
 * `SearchState`'s what it *did*. Identity and a title only: a Reviewer needs an
 * id it can cite, and a trace carrying abstracts would grow with the corpus in
 * exactly the way the summary view exists to prevent.
 */
export interface TraceEvidence {
	readonly paperId: string;
	readonly title: string;
	readonly sources: readonly string[];
	/** Which tool call surfaced it, so a claim about coverage can be attributed. */
	readonly foundBy: string;
}

/**
 * The answer pool as the trace carries it.
 *
 * Not a widening of what the Reviewer may see: the pool is written *through a
 * tool call*, so its content is already in the trace as that call's arguments.
 * This is a projection of it into a readable shape, which is what turns
 * "coverage is insufficient" from something a Reviewer has to infer from a list
 * of queries into something it can read off (`docs/develop/plan.md` §3.5, third
 * reason). Eight superpixel papers and no active-learning paper is visible here
 * and nowhere else.
 */
export interface TraceAnswerPool {
	readonly committed: number;
	readonly withdrawn: number;
	readonly note: string;
	readonly papers: readonly { readonly canonicalId: string; readonly title: string; readonly why: string }[];
	readonly removed: readonly { readonly canonicalId: string; readonly title: string; readonly reason: string }[];
	/** The call that last changed it, so a claim about the pool has an address. */
	readonly lastChangedBy: string | null;
}

export interface PublicSearchTrace {
	readonly agentId: string;
	readonly profileId: string;
	/** Every subquery the agent issued across the episode, in arrival order, deduplicated. */
	readonly subqueries: readonly string[];
	readonly calls: readonly TraceCall[];
	/** The evidence ids a Reviewer may cite. Bounded, like everything else here. */
	readonly evidence: readonly TraceEvidence[];
	/** What the agent has committed to as its answer. `null` until it commits to anything. */
	readonly answerPool: TraceAnswerPool | null;
	readonly budget: TraceBudget;
	readonly candidateCounts: { readonly recalled: number; readonly returned: number };
	readonly failures: readonly {
		readonly source: string | null;
		readonly errorType: string;
		readonly message: string;
	}[];
}

export interface TraceCollectorOptions {
	readonly agentId: string;
	readonly profileId: string;
	readonly maxCalls?: number;
	readonly maxArgChars?: number;
	readonly maxEvidence?: number;
}

/**
 * A harness event, as much of it as this module is willing to look at.
 *
 * Typed structurally rather than imported from the agent core: the collector
 * must reject an unknown shape, and depending on the full union would let a
 * future variant type-check its way in.
 */
export interface ObservedHarnessEvent {
	readonly type: string;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly args?: unknown;
	readonly result?: unknown;
	readonly isError?: unknown;
}

export interface TraceCollector {
	/** Returns true when the event contributed to the trace. */
	record(event: unknown): boolean;
	snapshot(): PublicSearchTrace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep the arguments, bounded, and drop anything that is not JSON-ish.
 *
 * Arguments are the agent's issued queries and filters, which §5.1 explicitly
 * allows into the trace. They are still bounded: a `provider_query` payload has
 * no size limit of its own.
 */
function publicArgs(value: unknown, maxChars: number): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") {
			result[key] = item.length > maxChars ? `${item.slice(0, maxChars)}...` : item;
		} else if (typeof item === "number" || typeof item === "boolean" || item === null) {
			result[key] = item;
		} else {
			const serialised = JSON.stringify(item) ?? "null";
			result[key] = serialised.length > maxChars ? `${serialised.slice(0, maxChars)}...` : item;
		}
	}
	return result;
}

function parseTraceSearchState(details: unknown): TraceSearchState | undefined {
	if (!isRecord(details)) return undefined;
	const state = details.searchState;
	if (!isRecord(state)) return undefined;
	const issued: { provider: string; query: string | null; nativeQuery: string | null }[] = [];
	if (Array.isArray(state.issuedQueries)) {
		for (const entry of state.issuedQueries) {
			if (!isRecord(entry)) continue;
			issued.push({
				provider: typeof entry.provider === "string" ? entry.provider : "unknown",
				query: typeof entry.query === "string" ? entry.query : null,
				nativeQuery: typeof entry.nativeQuery === "string" ? entry.nativeQuery : null,
			});
		}
	}
	const failures: { source: string | null; errorType: string; message: string }[] = [];
	if (Array.isArray(state.failures)) {
		for (const entry of state.failures) {
			if (!isRecord(entry)) continue;
			failures.push({
				source: typeof entry.source === "string" ? entry.source : null,
				errorType: typeof entry.errorType === "string" ? entry.errorType : "unknown",
				message: typeof entry.message === "string" ? entry.message : "",
			});
		}
	}
	return {
		issuedQueries: issued,
		selectedSources: Array.isArray(state.selectedSources)
			? state.selectedSources.filter((item): item is string => typeof item === "string")
			: [],
		filters: isRecord(state.filters) ? state.filters : {},
		recalled: typeof state.recalled === "number" ? state.recalled : 0,
		returned: typeof state.returned === "number" ? state.returned : 0,
		failures,
	};
}

/**
 * Harvest referenceable evidence from a tool result.
 *
 * Reads the summary shape every retrieval tool puts in `details`, and takes only
 * identity plus title. Bounded and first-wins: an episode that keeps finding the
 * same paper should not keep growing the trace, and the *first* call that
 * surfaced a paper is the attribution a coverage claim needs.
 */
function collectEvidence(details: unknown, toolCallId: string, into: Map<string, TraceEvidence>, max: number): void {
	if (!isRecord(details)) return;
	const lists: unknown[] = [details.papers];
	if (isRecord(details.paper)) lists.push([details.paper]);
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (into.size >= max) return;
			if (!isRecord(entry)) continue;
			const paperId = typeof entry.paperId === "string" ? entry.paperId : undefined;
			if (paperId === undefined || paperId === "" || into.has(paperId)) continue;
			into.set(paperId, {
				paperId,
				title: typeof entry.title === "string" ? entry.title : "",
				sources: Array.isArray(entry.sources)
					? entry.sources.filter((item): item is string => typeof item === "string")
					: [],
				foundBy: toolCallId,
			});
		}
	}
}

/**
 * Read the answer pool out of an `update_answer_pool` result.
 *
 * Bounded like everything else, and the `why` / `reason` texts are kept because
 * they are the whole informative part: "eight papers" says nothing about coverage,
 * "eight papers, all of them about superpixel segmentation" says the thing a
 * Reviewer is for.
 */
function parseTraceAnswerPool(details: unknown, toolCallId: string, max: number): TraceAnswerPool | undefined {
	if (!isRecord(details)) return undefined;
	const pool = details.pool;
	if (!isRecord(pool)) return undefined;
	const papers: { canonicalId: string; title: string; why: string }[] = [];
	if (Array.isArray(pool.papers)) {
		for (const entry of pool.papers.slice(0, max)) {
			if (!isRecord(entry)) continue;
			papers.push({
				canonicalId: typeof entry.canonicalId === "string" ? entry.canonicalId : "",
				title: typeof entry.title === "string" ? entry.title : "",
				why: typeof entry.why === "string" ? entry.why : "",
			});
		}
	}
	const removed: { canonicalId: string; title: string; reason: string }[] = [];
	if (Array.isArray(pool.removed)) {
		for (const entry of pool.removed.slice(0, max)) {
			if (!isRecord(entry)) continue;
			removed.push({
				canonicalId: typeof entry.canonicalId === "string" ? entry.canonicalId : "",
				title: typeof entry.title === "string" ? entry.title : "",
				reason: typeof entry.reason === "string" ? entry.reason : "",
			});
		}
	}
	return {
		committed: Array.isArray(pool.papers) ? pool.papers.length : 0,
		withdrawn: Array.isArray(pool.removed) ? pool.removed.length : 0,
		note: typeof pool.note === "string" ? pool.note : "",
		papers,
		removed,
		lastChangedBy: toolCallId,
	};
}

/** The tool's own error text, which is the actionable diagnostic the tool threw. */
function errorMessageOf(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const content = result.content;
	if (!Array.isArray(content)) return undefined;
	const texts = content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.filter((text) => text !== "");
	return texts.length === 0 ? undefined : texts.join("\n");
}

export function createTraceCollector(options: TraceCollectorOptions): TraceCollector {
	const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
	const maxArgChars = options.maxArgChars ?? DEFAULT_MAX_ARG_CHARS;
	const maxEvidence = options.maxEvidence ?? DEFAULT_MAX_EVIDENCE;

	// Keyed by tool-call id rather than pushed to an array: `start` and `end` for
	// one call can arrive in either order, and both contribute to one record.
	const byId = new Map<string, { -readonly [K in keyof TraceCall]: TraceCall[K] }>();
	const evidence = new Map<string, TraceEvidence>();
	let arrivals = 0;
	let dropped = 0;
	// The latest pool wins, and "latest" is arrival order rather than sequence
	// number: the pool the tool reported last is the pool that is on disk.
	let answerPool: TraceAnswerPool | null = null;

	return {
		record(event: unknown): boolean {
			if (!isRecord(event)) return false;
			const type = event.type;
			if (typeof type !== "string") return false;
			// The allow-list. Everything else - message_update and its thinking
			// deltas above all - is not merely ignored, it is unreachable.
			if (!(COLLECTED_EVENTS as readonly string[]).includes(type)) return false;

			const observed = event as unknown as ObservedHarnessEvent;
			const toolCallId = typeof observed.toolCallId === "string" ? observed.toolCallId : undefined;
			const toolName = typeof observed.toolName === "string" ? observed.toolName : undefined;
			if (toolCallId === undefined || toolName === undefined) return false;

			const existing = byId.get(toolCallId);
			if (existing === undefined && byId.size >= maxCalls) {
				dropped += 1;
				return false;
			}

			const record =
				existing ??
				(() => {
					arrivals += 1;
					const fresh = {
						toolCallId,
						toolName,
						args: {} as Record<string, unknown>,
						failed: false,
						errorMessage: undefined as string | undefined,
						searchState: undefined as TraceSearchState | undefined,
						seq: arrivals,
					};
					byId.set(toolCallId, fresh);
					return fresh;
				})();

			if (event.args !== undefined) {
				const args = publicArgs(event.args, maxArgChars);
				if (Object.keys(args).length > 0) record.args = args;
			}
			if (type === "tool_execution_end") {
				record.failed = observed.isError === true;
				const details = isRecord(observed.result) ? observed.result.details : undefined;
				const state = parseTraceSearchState(details);
				if (state !== undefined) record.searchState = state;
				if (observed.isError === true) record.errorMessage = errorMessageOf(observed.result);
				collectEvidence(details, toolCallId, evidence, maxEvidence);
				const pool = parseTraceAnswerPool(details, toolCallId, maxEvidence);
				if (pool !== undefined) answerPool = pool;
			}
			return true;
		},

		snapshot(): PublicSearchTrace {
			const calls = [...byId.values()].sort((left, right) => left.seq - right.seq);
			const callsByTool: Record<string, number> = {};
			const subqueries: string[] = [];
			const failures: { source: string | null; errorType: string; message: string }[] = [];
			let recalled = 0;
			let returned = 0;
			let failedCalls = 0;

			for (const call of calls) {
				callsByTool[call.toolName] = (callsByTool[call.toolName] ?? 0) + 1;
				if (call.failed) failedCalls += 1;
				const raw = call.args.subqueries;
				if (Array.isArray(raw)) {
					for (const item of raw) {
						if (typeof item === "string" && !subqueries.includes(item)) subqueries.push(item);
					}
				}
				if (call.searchState !== undefined) {
					recalled += call.searchState.recalled;
					returned += call.searchState.returned;
					failures.push(...call.searchState.failures);
				}
			}

			return {
				agentId: options.agentId,
				profileId: options.profileId,
				subqueries,
				calls,
				evidence: [...evidence.values()],
				answerPool,
				budget: { totalCalls: calls.length, failedCalls, callsByTool, droppedCalls: dropped },
				candidateCounts: { recalled, returned },
				failures,
			};
		},
	};
}
