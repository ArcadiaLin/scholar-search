/**
 * The extension's only door to the Python Search Service (`src/search-service/`).
 *
 * A pure boundary in the sense of `AGENTS.md` §3.2: explicit input and output
 * types, `baseUrl` and `fetch` injected rather than reached for, a hard timeout,
 * bounded retries, and errors that name what failed. No WIDI type appears here,
 * so the client is testable against a local server with no agent runtime around
 * it - and `index.ts` never sees an HTTP detail.
 *
 * Wire payloads are snake_case (FastAPI/pydantic); everything this module hands
 * back is camelCase. Translating at the boundary is the point of having one:
 * a rename on the service side breaks the parser here, loudly, instead of
 * leaking a stale key name into every caller.
 */

/** The slice of `fetch` this client uses, so a test can pass a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const SERVICE_URL_ENV_VAR = "SCHOLAR_SEARCH_SERVICE_URL";

/**
 * Where the service listens when nothing says otherwise: `SEARCH_SERVICE_PORT`
 * defaults to 8000 in `src/search-service/src/search_service/config.py`. Loopback
 * rather than 0.0.0.0 - this is an address to dial, not one to bind.
 */
export const DEFAULT_SERVICE_BASE_URL = "http://127.0.0.1:8000";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 4_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Enough of a failed body to diagnose from, not enough to blow up a tool result. */
const MAX_BODY_SNIPPET_CHARS = 400;
const DEFAULT_MAX_AUTHORS = 5;
const DEFAULT_MAX_ABSTRACT_CHARS = 400;

/** What went wrong, in the vocabulary a caller can actually branch on. */
export type ServiceErrorKind = "http" | "network" | "timeout" | "parse";

/**
 * Every failure leaving this module. It carries the URL and, for an HTTP
 * failure, the status and a body snippet: "the service said 503" and "the
 * service is not running" need different fixes, so they must not arrive as the
 * same opaque string.
 */
export class ServiceRequestError extends Error {
	readonly kind: ServiceErrorKind;
	readonly url: string;
	readonly status: number | undefined;
	readonly bodySnippet: string | undefined;
	/**
	 * The error body parsed as JSON, when it was JSON. FastAPI puts the reason in
	 * `detail`, and the lookup endpoint adds `tried_sources` and `failures`; a
	 * caller turning a failure into advice for the model needs those fields, not
	 * a prefix of their serialisation.
	 */
	readonly bodyJson: Readonly<Record<string, unknown>> | undefined;

	constructor(options: {
		kind: ServiceErrorKind;
		url: string;
		message: string;
		status?: number;
		bodySnippet?: string;
		bodyJson?: Record<string, unknown>;
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ServiceRequestError";
		this.kind = options.kind;
		this.url = options.url;
		this.status = options.status;
		this.bodySnippet = options.bodySnippet;
		this.bodyJson = options.bodyJson;
	}

	/** The service's own explanation, when it gave one. */
	get detail(): string | undefined {
		const detail = this.bodyJson?.detail;
		return typeof detail === "string" ? detail : undefined;
	}

	/**
	 * The classified per-source failures behind this error, when the service sent
	 * them. Total failure is when the caller most needs the classification - a
	 * rate limit, an empty result and a broken source lead to three different next
	 * moves - so an error that carries them must not be flattened to its `detail`.
	 */
	get failures(): readonly FailureRecord[] {
		return parseFailures(this.bodyJson?.failures);
	}

	/**
	 * Sources the service says it did *not* try and that could serve this request.
	 * Empty means switching source is not an option, which is the half the
	 * previous unconditional "another source may still be able to answer" got
	 * wrong (`docs/develop/backlog.md` F-2).
	 */
	get alternativeSources(): readonly string[] {
		return stringList(this.bodyJson?.alternative_sources);
	}
}

/** Cost and quota for one provider endpoint. */
export interface ProviderCostEntry {
	readonly usdPerCall: number;
	readonly dailyQuota: number | null;
	readonly rateLimitRps: number;
}

export interface ProviderReliability {
	readonly p50LatencyMs: number | null;
	readonly p95LatencyMs: number | null;
	readonly errorTaxonomy: readonly string[];
	readonly retryPolicy: string | null;
	readonly maxRetries: number | null;
}

/**
 * One provider's runtime capability record.
 *
 * `capabilities` is kept as the full flag map because the service owns that
 * vocabulary and this client must not silently drop a flag it has not heard of;
 * `enabledCapabilities` is the derived convenience the tool layer formats from.
 */
export interface ProviderRecord {
	readonly name: string;
	readonly enabled: boolean;
	readonly capabilities: Readonly<Record<string, boolean>>;
	readonly enabledCapabilities: readonly string[];
	readonly costModel: Readonly<Record<string, ProviderCostEntry>>;
	readonly fieldMap: Readonly<Record<string, string>>;
	readonly reliability: ProviderReliability;
	readonly quotaRemaining: Readonly<Record<string, number | null>>;
}

/**
 * One candidate as the agent should see it: enough to cite it, judge relevance
 * and ask for more, and nothing else.
 *
 * Deliberately not the service's whole `Paper`. The full record carries
 * `raw`, `field_provenance`, `counts_by_year` and reference lists, and putting
 * those in a tool result would make the agent's context grow with the corpus
 * (`docs/design.md` §4.1 - the agent does not carry the candidate set).
 */
export interface PaperSummary {
	readonly paperId: string;
	/**
	 * The service's identity for this work, normalized across id spaces.
	 *
	 * Carried rather than recomputed: identity is a domain algorithm and it has
	 * exactly one definition, in the service (`docs/develop/decisions.md` D-13).
	 * `null` only when the service did not report one.
	 */
	readonly canonicalId: string | null;
	readonly title: string;
	readonly authors: readonly string[];
	readonly authorCount: number;
	readonly venue: string | null;
	readonly year: number | null;
	readonly published: string | null;
	readonly doi: string | null;
	readonly arxivId: string | null;
	readonly openalexId: string | null;
	readonly citationCount: number | null;
	readonly abstract: string | null;
	readonly url: string | null;
	readonly sources: readonly string[];
	readonly score: number | null;
	readonly rank: number | null;
	readonly tier: string | null;
}

export interface IssuedQueryRecord {
	readonly provider: string;
	readonly mode: string | null;
	readonly query: string | null;
	/**
	 * What the provider was actually sent, when it rewrites the query. `null`
	 * means it sends the query unchanged. Reported separately from `query` because
	 * they were not the same string and nothing showed the difference: arXiv turned
	 * every multi-word query into an OR bag for months (`docs/develop/backlog.md` F-1).
	 */
	readonly nativeQuery: string | null;
	readonly latencyMs: number | null;
}

export interface FailureRecord {
	readonly stage: string | null;
	readonly source: string | null;
	readonly errorType: string;
	readonly message: string;
}

/** The service's account of what the search did - the Service half of the public trajectory. */
export interface SearchStateRecord {
	readonly issuedQueries: readonly IssuedQueryRecord[];
	readonly selectedSources: readonly string[];
	readonly filters: Readonly<Record<string, unknown>>;
	readonly recalled: number;
	readonly returned: number;
	readonly failures: readonly FailureRecord[];
}

export interface SearchResult {
	readonly papers: readonly PaperSummary[];
	readonly searchState: SearchStateRecord;
	readonly elapsedMs: number;
}

export interface SearchMetadataInput {
	readonly query: string;
	readonly subqueries?: readonly string[];
	readonly topK?: number;
	readonly endDate?: string;
	readonly sources?: readonly string[];
	readonly timeoutMs?: number;
	readonly providerParams?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface PaperLookupResult {
	readonly paper: PaperSummary;
	/** Which provider answered, and which were tried and failed on the way. */
	readonly source: string;
	readonly triedSources: readonly string[];
	readonly failures: readonly FailureRecord[];
}

export interface ProviderQueryResult {
	readonly provider: string;
	/** The provider's own response, unrewritten - that is the point of passthrough. */
	readonly raw: unknown;
}

export interface ServiceClient {
	/** The resolved base URL, so a caller can report which service it talked to. */
	readonly baseUrl: string;
	listProviders(options?: { signal?: AbortSignal }): Promise<readonly ProviderRecord[]>;
	searchMetadata(input: SearchMetadataInput, options?: { signal?: AbortSignal }): Promise<SearchResult>;
	getPaper(paperId: string, options?: { signal?: AbortSignal }): Promise<PaperLookupResult>;
	providerQuery(
		input: { provider: string; endpoint?: string; params: Readonly<Record<string, unknown>> },
		options?: { signal?: AbortSignal },
	): Promise<ProviderQueryResult>;
	expandCitations(input: ExpandInput, options?: { signal?: AbortSignal }): Promise<ExpandResult>;
	facetProbe(input: FacetInput, options?: { signal?: AbortSignal }): Promise<FacetResult>;
	rankCandidates(input: RankInput, options?: { signal?: AbortSignal }): Promise<RankResult>;
	searchFulltext(input: FulltextInput, options?: { signal?: AbortSignal }): Promise<FulltextResult>;
	getBudget(options?: { signal?: AbortSignal }): Promise<BudgetResult>;
}

export interface ExpandInput {
	readonly seedIds: readonly string[];
	readonly direction?: "backward" | "forward";
	readonly depth?: number;
	readonly fanout?: number;
}

export interface CitationEdgeRecord {
	readonly sourceId: string;
	readonly targetId: string;
	readonly edgeType: string;
}

/**
 * A bounded walk's result.
 *
 * `effectiveLimits` and `clamped` are not diagnostics: an expansion that used a
 * smaller depth than asked, without saying so, makes a bounded result look like
 * an exhausted graph.
 */
export interface ExpandResult {
	readonly papers: readonly PaperSummary[];
	readonly edges: readonly CitationEdgeRecord[];
	readonly direction: string;
	readonly effectiveLimits: Readonly<Record<string, number>>;
	readonly clamped: readonly string[];
	readonly providerCalls: number;
	readonly failures: readonly FailureRecord[];
}

export interface FacetInput {
	readonly query: string;
	readonly groupBy: readonly string[];
}

export interface FacetResult {
	readonly query: string;
	readonly source: string;
	readonly groups: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
	readonly failures: readonly FailureRecord[];
}

export interface RankInput {
	readonly query: string;
	/** Full records, as the service returned them. Rank needs more than a summary. */
	readonly candidates: readonly Readonly<Record<string, unknown>>[];
	readonly topK?: number;
}

export interface RankResult {
	readonly papers: readonly PaperSummary[];
	readonly scored: number;
	readonly skipped: number;
	/** Always zero. Rank-only issues no provider call, and the service states it. */
	readonly providerCalls: number;
}

export interface FulltextInput {
	readonly paperIds: readonly string[];
	readonly query?: string;
	readonly sections?: readonly string[];
}

export interface FulltextSectionRecord {
	readonly title: string;
	readonly text: string;
	readonly matchCount: number;
}

export interface FulltextPaperRecord {
	readonly paperId: string;
	readonly available: boolean;
	readonly reason: string | null;
	readonly sections: readonly FulltextSectionRecord[];
}

export interface FulltextResult {
	readonly papers: readonly FulltextPaperRecord[];
	readonly effectiveLimits: Readonly<Record<string, number>>;
	readonly clamped: readonly string[];
}

export interface BudgetResult {
	readonly limits: Readonly<Record<string, unknown>>;
	readonly quotas: Readonly<Record<string, unknown>>;
	readonly spent: Readonly<Record<string, number>>;
	/** `process` until an episode-scoped Evidence Store exists. Reported, not assumed. */
	readonly scope: string;
}

export interface ServiceClientOptions {
	readonly baseUrl: string;
	readonly fetch?: FetchLike;
	readonly timeoutMs?: number;
	readonly retries?: number;
	/** How much of a record survives into a `PaperSummary`. See `parsePaperSummary`. */
	readonly maxAuthorsPerPaper?: number;
	readonly maxAbstractChars?: number;
}

/**
 * Read the service address from the environment, falling back to the local
 * default. Takes the environment as an argument instead of reading
 * `process.env` so the resolution rule is testable and so nothing in this
 * module depends on being inside a Node process.
 */
export function resolveServiceBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
	const configured = env[SERVICE_URL_ENV_VAR];
	if (typeof configured !== "string" || configured.trim() === "") return DEFAULT_SERVICE_BASE_URL;
	return stripTrailingSlashes(configured.trim());
}

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Request a JSON document, with a hard timeout and bounded retries. */
async function requestJson(
	url: string,
	options: {
		fetch: FetchLike;
		timeoutMs: number;
		retries: number;
		signal?: AbortSignal;
		method?: "GET" | "POST";
		body?: unknown;
	},
): Promise<unknown> {
	let lastError: ServiceRequestError | undefined;
	const method = options.method ?? "GET";
	const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
	for (let attempt = 0; attempt <= options.retries; attempt += 1) {
		options.signal?.throwIfAborted();
		if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS), options.signal);

		const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
		if (options.signal) signals.push(options.signal);

		let response: Response;
		try {
			response = await options.fetch(url, {
				method,
				headers:
					payload === undefined
						? { Accept: "application/json" }
						: { Accept: "application/json", "Content-Type": "application/json" },
				body: payload,
				signal: AbortSignal.any(signals),
			});
		} catch (error) {
			// A caller-initiated abort is not a service failure; it must surface as
			// the abort it is rather than be retried or relabelled.
			options.signal?.throwIfAborted();
			const timedOut = error instanceof Error && error.name === "TimeoutError";
			lastError = new ServiceRequestError({
				kind: timedOut ? "timeout" : "network",
				url,
				message: timedOut
					? `Search Service did not answer ${url} within ${options.timeoutMs}ms.`
					: `Could not reach the Search Service at ${url}: ${describe(error)}.`,
				cause: error,
			});
			continue;
		}

		if (!response.ok) {
			const body = await readErrorBody(response);
			const failure = new ServiceRequestError({
				kind: "http",
				url,
				status: response.status,
				bodySnippet: body.snippet,
				bodyJson: body.json,
				message: `Search Service returned HTTP ${response.status} for ${url}.`,
			});
			if (!RETRYABLE_STATUSES.has(response.status)) throw failure;
			lastError = failure;
			continue;
		}

		const text = await response.text();
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			// Malformed JSON from a 200 will not become valid on a retry.
			throw new ServiceRequestError({
				kind: "parse",
				url,
				message: `Search Service returned a 200 that is not JSON for ${url}: ${describe(error)}.`,
				bodySnippet: text.slice(0, MAX_BODY_SNIPPET_CHARS),
				cause: error,
			});
		}
	}
	throw (
		lastError ??
		new ServiceRequestError({ kind: "network", url, message: `Request to ${url} failed with no recorded cause.` })
	);
}

async function readErrorBody(
	response: Response,
): Promise<{ snippet: string | undefined; json: Record<string, unknown> | undefined }> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		// A body that cannot be read must not mask the status that mattered.
		return { snippet: undefined, json: undefined };
	}
	if (text === "") return { snippet: undefined, json: undefined };
	let json: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) json = parsed;
	} catch {
		// An error body that is not JSON is still worth quoting.
	}
	return { snippet: text.slice(0, MAX_BODY_SNIPPET_CHARS), json };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseError(url: string, detail: string): ServiceRequestError {
	return new ServiceRequestError({
		kind: "parse",
		url,
		message: `Search Service /providers payload is not in the expected shape: ${detail}.`,
	});
}

function booleanMap(value: unknown): Record<string, boolean> {
	if (!isRecord(value)) return {};
	const result: Record<string, boolean> = {};
	for (const [key, flag] of Object.entries(value)) {
		if (typeof flag === "boolean") result[key] = flag;
	}
	return result;
}

function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, mapped] of Object.entries(value)) {
		if (typeof mapped === "string") result[key] = mapped;
	}
	return result;
}

function nullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseCostModel(value: unknown): Record<string, ProviderCostEntry> {
	if (!isRecord(value)) return {};
	const result: Record<string, ProviderCostEntry> = {};
	for (const [endpoint, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		result[endpoint] = {
			usdPerCall: numberOr(entry.usd_per_call, 0),
			dailyQuota: nullableNumber(entry.daily_quota),
			rateLimitRps: numberOr(entry.rate_limit_rps, 0),
		};
	}
	return result;
}

function parseReliability(value: unknown): ProviderReliability {
	const source = isRecord(value) ? value : {};
	const taxonomy = Array.isArray(source.error_taxonomy)
		? source.error_taxonomy.filter((item): item is string => typeof item === "string")
		: [];
	return {
		p50LatencyMs: nullableNumber(source.p50_latency_ms),
		p95LatencyMs: nullableNumber(source.p95_latency_ms),
		errorTaxonomy: taxonomy,
		retryPolicy: typeof source.retry_policy === "string" ? source.retry_policy : null,
		maxRetries: nullableNumber(source.max_retries),
	};
}

function parseQuotaRemaining(value: unknown): Record<string, number | null> {
	if (!isRecord(value)) return {};
	const result: Record<string, number | null> = {};
	for (const [key, remaining] of Object.entries(value)) {
		if (remaining === null) result[key] = null;
		else if (typeof remaining === "number" && Number.isFinite(remaining)) result[key] = remaining;
	}
	return result;
}

/**
 * Parse `GET /providers`.
 *
 * `name`, `enabled` and `capabilities` are required: a record missing any of
 * them cannot be reasoned about by the agent, and quietly skipping it would
 * present a shorter provider list as if it were the whole one. Everything else
 * is optional and degrades to an empty value.
 */
function parseProviders(url: string, payload: unknown): readonly ProviderRecord[] {
	if (!Array.isArray(payload)) {
		throw parseError(url, `expected a JSON array, got ${payload === null ? "null" : typeof payload}`);
	}
	return payload.map((entry, index) => {
		if (!isRecord(entry)) throw parseError(url, `entry ${index} is not an object`);
		const name = entry.name;
		if (typeof name !== "string" || name === "") throw parseError(url, `entry ${index} has no usable "name"`);
		if (typeof entry.enabled !== "boolean") throw parseError(url, `provider "${name}" has no boolean "enabled"`);
		if (!isRecord(entry.capabilities)) throw parseError(url, `provider "${name}" has no "capabilities" object`);

		const capabilities = booleanMap(entry.capabilities);
		return {
			name,
			enabled: entry.enabled,
			capabilities,
			enabledCapabilities: Object.entries(capabilities)
				.filter(([, flag]) => flag)
				.map(([capability]) => capability)
				.sort(),
			costModel: parseCostModel(entry.cost_model),
			fieldMap: stringMap(entry.field_map),
			reliability: parseReliability(entry.reliability),
			quotaRemaining: parseQuotaRemaining(entry.quota_remaining),
		};
	});
}

/** Author display names only: the service's author objects also carry ORCID, affiliation and h-index. */
function parseAuthors(value: unknown, maxNames: number): { names: string[]; total: number } {
	if (!Array.isArray(value)) return { names: [], total: 0 };
	const names: string[] = [];
	for (const author of value) {
		if (isRecord(author) && typeof author.name === "string") names.push(author.name);
		else if (typeof author === "string") names.push(author);
	}
	return { names: names.slice(0, maxNames), total: names.length };
}

function firstUrl(value: unknown): string | null {
	if (!isRecord(value)) return null;
	for (const key of ["paper", "html", "pdf"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	return null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Project one service `Paper` (or `RankedPaper`) onto the summary view.
 *
 * `maxAuthors` and `maxAbstractChars` are parameters rather than constants so
 * the size of a tool result is decided by the tool, not by this module.
 */
function parsePaperSummary(value: unknown, url: string, maxAuthors: number, maxAbstractChars: number): PaperSummary {
	if (!isRecord(value)) throw parseError(url, "a paper entry is not an object");
	const paperId = value.paper_id;
	const title = value.title;
	if (typeof paperId !== "string" || paperId === "") throw parseError(url, 'a paper entry has no usable "paper_id"');
	if (typeof title !== "string") throw parseError(url, `paper "${paperId}" has no "title"`);

	const authors = parseAuthors(value.authors, maxAuthors);
	const abstract = nullableString(value.abstract);
	return {
		paperId,
		canonicalId: nullableString(value.canonical_id),
		title,
		authors: authors.names,
		authorCount: authors.total,
		venue: nullableString(value.venue),
		year: nullableNumber(value.year),
		published: nullableString(value.published),
		doi: nullableString(value.doi),
		arxivId: nullableString(value.arxiv_id),
		openalexId: nullableString(value.openalex_id),
		citationCount: nullableNumber(value.citation_count),
		abstract:
			abstract === null
				? null
				: abstract.length > maxAbstractChars
					? `${abstract.slice(0, maxAbstractChars)}...`
					: abstract,
		url: firstUrl(value.urls),
		sources: Array.isArray(value.sources)
			? value.sources.filter((item): item is string => typeof item === "string")
			: [],
		score: nullableNumber(value.score),
		rank: nullableNumber(value.rank),
		tier: nullableString(value.tier),
	};
}

/**
 * Put a candidate back into the wire shape the service validates.
 *
 * What the agent has to hand is a `PaperSummary` - camelCase, because that is
 * what every other tool result gave it - while `/rank` validates the service's
 * snake_case `Paper`. Posting the summaries unchanged made the service skip
 * every one of them, so ranking silently returned nothing. Translating here is
 * the same boundary responsibility as translating responses the other way;
 * a record that already speaks the wire shape passes through untouched.
 */
function toWirePaper(candidate: Readonly<Record<string, unknown>>): Record<string, unknown> {
	if ("paper_id" in candidate) return { ...candidate };

	const mapped: Record<string, unknown> = {};
	const rename: Record<string, string> = {
		paperId: "paper_id",
		// The tool text labels the identifier `id:`, so that is the word the agent
		// reaches for when it rebuilds a candidate from what it read. Accepting only
		// `paperId` here made ranking skip every hand-assembled record - which is to
		// say, in practice, all of them.
		id: "paper_id",
		arxivId: "arxiv_id",
		openalexId: "openalex_id",
		citationCount: "citation_count",
		authorCount: "author_count",
	};
	for (const [key, value] of Object.entries(candidate)) {
		if (key === "authors" && Array.isArray(value)) {
			// The summary carries display names; the service wants author objects.
			mapped.authors = value.map((name) => (typeof name === "string" ? { name } : name));
			continue;
		}
		if (key === "url") {
			mapped.urls = typeof value === "string" ? { paper: value } : {};
			continue;
		}
		// Fields the summary derived and the service does not model are dropped
		// rather than sent: an unknown key would fail validation for the whole record.
		if (key === "authorCount" || key === "rank" || key === "tier" || key === "canonicalId") continue;
		mapped[rename[key] ?? key] = value;
	}
	// The service requires a `paper_id`. A record that named only a DOI or an
	// arXiv id is still identifiable, and rejecting it would lose a real candidate
	// over a missing alias.
	if (typeof mapped.paper_id !== "string" || mapped.paper_id === "") {
		const fallback = [mapped.doi, mapped.arxiv_id, mapped.openalex_id].find(
			(value): value is string => typeof value === "string" && value !== "",
		);
		if (fallback !== undefined) mapped.paper_id = fallback;
	}
	return mapped;
}

function numberMap(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const result: Record<string, number> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
	}
	return result;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseFailures(value: unknown): FailureRecord[] {
	if (!Array.isArray(value)) return [];
	const failures: FailureRecord[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		failures.push({
			stage: nullableString(entry.stage),
			source: nullableString(entry.source),
			errorType: typeof entry.error_type === "string" ? entry.error_type : "unknown",
			message: typeof entry.message === "string" ? entry.message : "",
		});
	}
	return failures;
}

function parseSearchState(value: unknown): SearchStateRecord {
	const source = isRecord(value) ? value : {};
	const counts = isRecord(source.candidate_counts) ? source.candidate_counts : {};
	const issued: IssuedQueryRecord[] = [];
	if (Array.isArray(source.issued_queries)) {
		for (const entry of source.issued_queries) {
			if (!isRecord(entry)) continue;
			issued.push({
				provider: typeof entry.provider === "string" ? entry.provider : "unknown",
				mode: nullableString(entry.mode),
				query: nullableString(entry.query),
				nativeQuery: nullableString(entry.native_query),
				latencyMs: nullableNumber(entry.latency_ms),
			});
		}
	}
	return {
		issuedQueries: issued,
		selectedSources: Array.isArray(source.selected_sources)
			? source.selected_sources.filter((item): item is string => typeof item === "string")
			: [],
		filters: isRecord(source.filters) ? source.filters : {},
		recalled: numberOr(counts.recalled, 0),
		returned: numberOr(counts.returned, 0),
		failures: parseFailures(source.failures),
	};
}

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
	const baseUrl = stripTrailingSlashes(options.baseUrl);
	const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? DEFAULT_RETRIES;

	const maxAuthors = options.maxAuthorsPerPaper ?? DEFAULT_MAX_AUTHORS;
	const maxAbstract = options.maxAbstractChars ?? DEFAULT_MAX_ABSTRACT_CHARS;

	return {
		baseUrl,
		async listProviders(callOptions) {
			const url = `${baseUrl}/providers`;
			const payload = await requestJson(url, { fetch: fetchImpl, timeoutMs, retries, signal: callOptions?.signal });
			return parseProviders(url, payload);
		},

		async searchMetadata(input, callOptions) {
			const url = `${baseUrl}/search/metadata`;
			// snake_case on the wire, and only fields the caller actually set:
			// sending `null` for an absent bound would be a different request from
			// not constraining it.
			const body: Record<string, unknown> = { query: input.query };
			if (input.subqueries && input.subqueries.length > 0) body.subqueries = [...input.subqueries];
			if (input.topK !== undefined) body.top_k = input.topK;
			if (input.endDate !== undefined) body.end_date = input.endDate;
			if (input.sources && input.sources.length > 0) body.sources = [...input.sources];
			if (input.timeoutMs !== undefined) body.timeout_ms = input.timeoutMs;
			if (input.providerParams) body.provider_params = input.providerParams;

			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body,
			});
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			if (!Array.isArray(payload.papers)) throw parseError(url, 'the response has no "papers" array');
			return {
				papers: payload.papers.map((paper) => parsePaperSummary(paper, url, maxAuthors, maxAbstract)),
				searchState: parseSearchState(payload.search_state),
				elapsedMs: numberOr(payload.elapsed_ms, 0),
			};
		},

		async getPaper(paperId, callOptions) {
			// The id goes in the path, so it must be encoded: DOIs contain slashes,
			// and an unencoded one would silently address a different route.
			const url = `${baseUrl}/paper/${encodeURIComponent(paperId)}`;
			const payload = await requestJson(url, { fetch: fetchImpl, timeoutMs, retries, signal: callOptions?.signal });
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			if (typeof payload.source !== "string") throw parseError(url, 'the response has no "source"');
			return {
				paper: parsePaperSummary(payload.paper, url, maxAuthors, maxAbstract),
				source: payload.source,
				triedSources: Array.isArray(payload.tried_sources)
					? payload.tried_sources.filter((item): item is string => typeof item === "string")
					: [],
				failures: parseFailures(payload.failures),
			};
		},

		async providerQuery(input, callOptions) {
			const url = `${baseUrl}/provider/${encodeURIComponent(input.provider)}/query`;
			const body: Record<string, unknown> = { params: input.params };
			if (input.endpoint !== undefined) body.endpoint = input.endpoint;
			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body,
			});
			// No shape assertion: passthrough exists so the provider's own response
			// reaches the caller unrewritten, and every provider's differs.
			return { provider: input.provider, raw: payload };
		},

		async expandCitations(input, callOptions) {
			const url = `${baseUrl}/expand/citations`;
			const body: Record<string, unknown> = { seed_ids: [...input.seedIds] };
			if (input.direction !== undefined) body.direction = input.direction;
			if (input.depth !== undefined) body.depth = input.depth;
			if (input.fanout !== undefined) body.fanout = input.fanout;

			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body,
			});
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			if (!Array.isArray(payload.papers)) throw parseError(url, 'the response has no "papers" array');
			const edges: CitationEdgeRecord[] = [];
			if (Array.isArray(payload.edges)) {
				for (const entry of payload.edges) {
					if (!isRecord(entry)) continue;
					edges.push({
						sourceId: typeof entry.source_id === "string" ? entry.source_id : "",
						targetId: typeof entry.target_id === "string" ? entry.target_id : "",
						edgeType: typeof entry.edge_type === "string" ? entry.edge_type : "unknown",
					});
				}
			}
			return {
				papers: payload.papers.map((paper) => parsePaperSummary(paper, url, maxAuthors, maxAbstract)),
				edges,
				direction: typeof payload.direction === "string" ? payload.direction : "backward",
				effectiveLimits: numberMap(payload.effective_limits),
				clamped: stringList(payload.clamped),
				providerCalls: numberOr(payload.provider_calls, 0),
				failures: parseFailures(payload.failures),
			};
		},

		async facetProbe(input, callOptions) {
			const url = `${baseUrl}/facet`;
			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body: { query: input.query, group_by: [...input.groupBy] },
			});
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			const groups: Record<string, Readonly<Record<string, unknown>>[]> = {};
			if (isRecord(payload.groups)) {
				for (const [field, entries] of Object.entries(payload.groups)) {
					if (!Array.isArray(entries)) continue;
					groups[field] = entries.filter((entry): entry is Record<string, unknown> => isRecord(entry));
				}
			}
			return {
				query: typeof payload.query === "string" ? payload.query : input.query,
				source: typeof payload.source === "string" ? payload.source : "unknown",
				groups,
				failures: parseFailures(payload.failures),
			};
		},

		async rankCandidates(input, callOptions) {
			const url = `${baseUrl}/rank`;
			const body: Record<string, unknown> = { query: input.query, candidates: input.candidates.map(toWirePaper) };
			if (input.topK !== undefined) body.top_k = input.topK;
			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body,
			});
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			if (!Array.isArray(payload.papers)) throw parseError(url, 'the response has no "papers" array');
			return {
				papers: payload.papers.map((paper) => parsePaperSummary(paper, url, maxAuthors, maxAbstract)),
				scored: numberOr(payload.scored, 0),
				skipped: numberOr(payload.skipped, 0),
				providerCalls: numberOr(payload.provider_calls, 0),
			};
		},

		async searchFulltext(input, callOptions) {
			const url = `${baseUrl}/fulltext`;
			const body: Record<string, unknown> = { paper_ids: [...input.paperIds] };
			if (input.query !== undefined) body.query = input.query;
			if (input.sections !== undefined && input.sections.length > 0) body.sections = [...input.sections];
			const payload = await requestJson(url, {
				fetch: fetchImpl,
				timeoutMs,
				retries,
				signal: callOptions?.signal,
				method: "POST",
				body,
			});
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			if (!Array.isArray(payload.papers)) throw parseError(url, 'the response has no "papers" array');
			const papers: FulltextPaperRecord[] = [];
			for (const entry of payload.papers) {
				if (!isRecord(entry)) continue;
				const sections: FulltextSectionRecord[] = [];
				if (Array.isArray(entry.sections)) {
					for (const section of entry.sections) {
						if (!isRecord(section)) continue;
						sections.push({
							title: typeof section.title === "string" ? section.title : "",
							text: typeof section.text === "string" ? section.text : "",
							matchCount: numberOr(section.match_count, 0),
						});
					}
				}
				papers.push({
					paperId: typeof entry.paper_id === "string" ? entry.paper_id : "",
					available: entry.available === true,
					reason: typeof entry.reason === "string" ? entry.reason : null,
					sections,
				});
			}
			return { papers, effectiveLimits: numberMap(payload.effective_limits), clamped: stringList(payload.clamped) };
		},

		async getBudget(callOptions) {
			const url = `${baseUrl}/budget`;
			const payload = await requestJson(url, { fetch: fetchImpl, timeoutMs, retries, signal: callOptions?.signal });
			if (!isRecord(payload)) throw parseError(url, "the response is not an object");
			return {
				limits: isRecord(payload.limits) ? payload.limits : {},
				quotas: isRecord(payload.quotas) ? payload.quotas : {},
				spent: numberMap(payload.spent),
				// Reported rather than assumed: the service says whether this is an
				// episode's spend or the process's, and today it is the process's.
				scope: typeof payload.scope === "string" ? payload.scope : "unknown",
			};
		},
	};
}
