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

	constructor(options: {
		kind: ServiceErrorKind;
		url: string;
		message: string;
		status?: number;
		bodySnippet?: string;
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ServiceRequestError";
		this.kind = options.kind;
		this.url = options.url;
		this.status = options.status;
		this.bodySnippet = options.bodySnippet;
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

export interface ServiceClient {
	/** The resolved base URL, so a caller can report which service it talked to. */
	readonly baseUrl: string;
	listProviders(options?: { signal?: AbortSignal }): Promise<readonly ProviderRecord[]>;
}

export interface ServiceClientOptions {
	readonly baseUrl: string;
	readonly fetch?: FetchLike;
	readonly timeoutMs?: number;
	readonly retries?: number;
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

/** GET a JSON document, with a hard timeout and bounded retries. */
async function getJson(
	url: string,
	options: { fetch: FetchLike; timeoutMs: number; retries: number; signal?: AbortSignal },
): Promise<unknown> {
	let lastError: ServiceRequestError | undefined;
	for (let attempt = 0; attempt <= options.retries; attempt += 1) {
		options.signal?.throwIfAborted();
		if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS), options.signal);

		const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
		if (options.signal) signals.push(options.signal);

		let response: Response;
		try {
			response = await options.fetch(url, {
				method: "GET",
				headers: { Accept: "application/json" },
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
			const bodySnippet = await readSnippet(response);
			const failure = new ServiceRequestError({
				kind: "http",
				url,
				status: response.status,
				bodySnippet,
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

async function readSnippet(response: Response): Promise<string | undefined> {
	try {
		const text = await response.text();
		return text === "" ? undefined : text.slice(0, MAX_BODY_SNIPPET_CHARS);
	} catch {
		// A body that cannot be read must not mask the status that mattered.
		return undefined;
	}
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

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
	const baseUrl = stripTrailingSlashes(options.baseUrl);
	const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? DEFAULT_RETRIES;

	return {
		baseUrl,
		async listProviders(callOptions) {
			const url = `${baseUrl}/providers`;
			const payload = await getJson(url, { fetch: fetchImpl, timeoutMs, retries, signal: callOptions?.signal });
			return parseProviders(url, payload);
		},
	};
}
