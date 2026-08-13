import { EventEmitter } from "node:events";
import * as undici from "undici";

/** Header/body idle timeout used when settings name none. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

// Node's 250ms default can abandon a valid connection attempt on a high-latency
// route, which a proxied one often is.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * Publish a settings-provided proxy into the environment the dispatcher reads.
 *
 * `EnvHttpProxyAgent` looks at HTTP_PROXY/HTTPS_PROXY/NO_PROXY and nothing else,
 * so a proxy named in settings has to become an environment variable before the
 * dispatcher is built. A variable the user already exported wins: it is the more
 * specific statement of intent for this run.
 */
export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream fetch
// body, which is exactly what aborting a streaming turn does. The body stream
// still rejects through reader.read(), so the error is not lost; this listener
// only keeps EventEmitter's unhandled "error" special case from killing the
// process. It has to be attached per Client, which is what the factories below
// are for - a listener on the outer agent would never see it.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(new undici.Pool(origin, { ...dispatcherOptions, factory: createUndiciClient }));
}

/**
 * Install undici's global dispatcher.
 *
 * Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY outright - the variables
 * are inherited like any other, nothing reads them - so every provider request
 * and OAuth flow takes the direct route, and gets judged by exit IP, until this
 * runs. Call it once at process start, before any provider SDK can issue a
 * request, and again once settings are loaded and may name their own proxy or
 * timeout. A timeout of 0 disables the idle timeout.
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: timeoutMs,
			headersTimeout: timeoutMs,
			connect: { autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch on the same undici the dispatcher belongs to: the bundled fetch
	// can otherwise read a compressed response through the npm dispatcher without
	// decompressing it, and response.json() then fails. A fetch someone replaced
	// after module load is a deliberate override and is left alone.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
