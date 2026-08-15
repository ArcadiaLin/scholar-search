/**
 * Minimal HTTP helper for the pasa retrieval tools: global fetch plus a hard
 * timeout, bounded retries with backoff, and a status error type the caller
 * can branch on. Exhausted retries rethrow so failures stay observable.
 */

export class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, url: string) {
		super(`HTTP ${status} from ${url}`);
		this.name = "HttpStatusError";
		this.status = status;
	}
}

export interface HttpTextOptions {
	readonly method?: "GET" | "POST";
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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

export async function httpText(url: string, options: HttpTextOptions = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? DEFAULT_RETRIES;
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		options.signal?.throwIfAborted();
		if (attempt > 0) {
			await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000), options.signal);
		}
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (options.signal) {
			signals.push(options.signal);
		}
		try {
			const response = await fetch(url, {
				method: options.method ?? "GET",
				headers: { "User-Agent": "widi-pasa-tools/0.1", ...options.headers },
				body: options.body,
				signal: AbortSignal.any(signals),
			});
			if (response.ok) {
				return await response.text();
			}
			if (!RETRYABLE_STATUSES.has(response.status)) {
				throw new HttpStatusError(response.status, url);
			}
			lastError = new HttpStatusError(response.status, url);
		} catch (error) {
			options.signal?.throwIfAborted();
			if (error instanceof HttpStatusError && !RETRYABLE_STATUSES.has(error.status)) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
