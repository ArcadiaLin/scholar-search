/**
 * The service client's contract, exercised against a local HTTP server and a
 * recorded payload rather than a live Search Service.
 *
 * Two reasons for the local server: the behaviour that matters most under
 * failure - a 429 that recovers, a connection that never answers, a caller that
 * aborts - is exactly what cannot be provoked reliably against the real
 * service; and a test suite that needs `uv run uvicorn` in another terminal is
 * a test suite that stops being run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createServiceClient,
	DEFAULT_SERVICE_BASE_URL,
	resolveServiceBaseUrl,
	SERVICE_URL_ENV_VAR,
	ServiceRequestError,
} from "../core/service-client.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const providersFixture = readFileSync(join(fixturesDir, "providers.json"), "utf8");

type Reply = { status: number; body?: string; contentType?: string; hang?: boolean };
type Handler = (attempt: number) => Reply;

/**
 * Each test gets its own path prefix on the shared server, and requests are
 * counted per prefix.
 *
 * A shared counter reset between tests looked simpler and was wrong: the
 * abort test's request can reach the server after the client has already
 * rejected, so it landed on the *next* test's counter and turned "did not
 * retry" into an off-by-one failure. Scoping by path makes a late request
 * unable to touch anyone else's accounting.
 */
interface Scope {
	/** The path segment this scope owns, so a test can assert the URL that was built. */
	readonly name: string;
	readonly baseUrl: string;
	attempts(): number;
	paths(): readonly string[];
}

const handlers = new Map<string, Handler>();
const attemptsByScope = new Map<string, number>();
const pathsByScope = new Map<string, string[]>();

const server: Server = createServer((request, response) => {
	const url = request.url ?? "";
	const scope = url.split("/")[1] ?? "";
	attemptsByScope.set(scope, (attemptsByScope.get(scope) ?? 0) + 1);
	pathsByScope.get(scope)?.push(url);
	const reply = handlers.get(scope)?.(attemptsByScope.get(scope) ?? 1) ?? { status: 500 };
	if (reply.hang) return; // never answers; the client's timeout must fire
	response.writeHead(reply.status, { "Content-Type": reply.contentType ?? "application/json" });
	response.end(reply.body ?? "");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

let scopeCounter = 0;

function arrange(next: Handler): Scope {
	scopeCounter += 1;
	const scope = `s${scopeCounter}`;
	handlers.set(scope, next);
	attemptsByScope.set(scope, 0);
	pathsByScope.set(scope, []);
	return {
		name: scope,
		baseUrl: `${base}/${scope}`,
		attempts: () => attemptsByScope.get(scope) ?? 0,
		paths: () => pathsByScope.get(scope) ?? [],
	};
}

/** The fixture payload, served unchanged. The common arrangement. */
function arrangeFixture(): Scope {
	return arrange(() => ({ status: 200, body: providersFixture }));
}

function clientFor(scope: Scope, overrides: { timeoutMs?: number; retries?: number; baseUrl?: string } = {}) {
	return createServiceClient({
		baseUrl: overrides.baseUrl ?? scope.baseUrl,
		timeoutMs: overrides.timeoutMs ?? 2_000,
		retries: overrides.retries ?? 0,
	});
}

describe("resolveServiceBaseUrl", () => {
	it("falls back to the local default when the variable is absent", () => {
		assert.equal(resolveServiceBaseUrl({}), DEFAULT_SERVICE_BASE_URL);
	});

	it("treats an empty or blank value as unset rather than as an empty host", () => {
		assert.equal(resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "" }), DEFAULT_SERVICE_BASE_URL);
		assert.equal(resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "   " }), DEFAULT_SERVICE_BASE_URL);
	});

	it("uses the configured address and normalises trailing slashes", () => {
		assert.equal(resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "http://svc:9000" }), "http://svc:9000");
		assert.equal(resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "http://svc:9000///" }), "http://svc:9000");
		assert.equal(resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "  http://svc:9000/  " }), "http://svc:9000");
	});

	it("does not hardcode the address anywhere but the documented default", () => {
		// The env var must be able to point the client somewhere else entirely;
		// this is the check that catches a baked-in URL creeping back in.
		assert.notEqual(
			resolveServiceBaseUrl({ [SERVICE_URL_ENV_VAR]: "http://elsewhere:1234" }),
			DEFAULT_SERVICE_BASE_URL,
		);
	});
});

describe("listProviders", () => {
	it("parses the recorded service payload", async () => {
		const scope = arrangeFixture();
		const providers = await clientFor(scope).listProviders();

		assert.deepEqual(
			providers.map((provider) => provider.name),
			["openalex", "arxiv", "serper"],
		);
		assert.deepEqual(scope.paths(), [`/${scope.name}/providers`]);
	});

	it("reports enabled and disabled providers distinctly", async () => {
		const scope = arrangeFixture();
		const providers = await clientFor(scope).listProviders();
		const byName = new Map(providers.map((provider) => [provider.name, provider]));

		assert.equal(byName.get("openalex")?.enabled, true);
		assert.equal(byName.get("arxiv")?.enabled, true);
		// A configured-but-disabled provider must survive parsing: dropping it would
		// hide from the agent that the source exists but cannot serve a query.
		assert.equal(byName.get("serper")?.enabled, false);
	});

	it("derives the enabled capability list from the flag map", async () => {
		const scope = arrangeFixture();
		const providers = await clientFor(scope).listProviders();
		const openalex = providers.find((provider) => provider.name === "openalex");
		assert.ok(openalex);

		assert.ok(openalex.enabledCapabilities.includes("graph_citations"));
		assert.ok(openalex.enabledCapabilities.includes("search_native_query"));
		// False flags are absent from the derived list but still present in the map,
		// so a caller can tell "not supported" from "never heard of".
		assert.ok(!openalex.enabledCapabilities.includes("text_fulltext"));
		assert.equal(openalex.capabilities.text_fulltext, false);
	});

	it("translates the nested cost model and reliability profile", async () => {
		const scope = arrangeFixture();
		const providers = await clientFor(scope).listProviders();
		const openalex = providers.find((provider) => provider.name === "openalex");
		assert.ok(openalex);

		assert.equal(openalex.costModel.works_search?.usdPerCall, 0.001);
		assert.equal(openalex.costModel.works_search?.dailyQuota, 1000);
		assert.equal(openalex.costModel.single_work?.dailyQuota, null);
		assert.equal(openalex.reliability.retryPolicy, "exponential");
		assert.ok(openalex.reliability.errorTaxonomy.includes("rate_limit"));
	});

	it("keeps the provider field map so callers can see the unified vocabulary", async () => {
		const scope = arrangeFixture();
		const providers = await clientFor(scope).listProviders();
		const arxiv = providers.find((provider) => provider.name === "arxiv");
		assert.ok(arxiv);

		assert.equal(arxiv.fieldMap.summary, "abstract");
		assert.ok(Object.values(arxiv.fieldMap).includes("authors"));
	});

	it("accepts a base URL with a trailing slash without doubling it", async () => {
		const scope = arrangeFixture();
		await clientFor(scope, { baseUrl: `${scope.baseUrl}/` }).listProviders();
		assert.deepEqual(scope.paths(), [`/${scope.name}/providers`]);
	});
});

describe("listProviders failure handling", () => {
	it("retries a rate limit and succeeds within the bound", async () => {
		const scope = arrange((attempt) => (attempt < 3 ? { status: 429 } : { status: 200, body: providersFixture }));
		const providers = await clientFor(scope, { retries: 2 }).listProviders();
		assert.equal(providers.length, 3);
		assert.equal(scope.attempts(), 3);
	});

	it("gives up after the bounded number of retries and stays observable", async () => {
		const scope = arrange(() => ({ status: 503, body: "upstream down" }));
		await assert.rejects(clientFor(scope, { retries: 2 }).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "http");
			assert.equal(error.status, 503);
			assert.match(error.bodySnippet ?? "", /upstream down/);
			return true;
		});
		assert.equal(scope.attempts(), 3, "retries are bounded, not unlimited");
	});

	it("does not retry a status that will never succeed", async () => {
		const scope = arrange(() => ({ status: 404, body: "no such route" }));
		await assert.rejects(clientFor(scope, { retries: 3 }).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 404);
			return true;
		});
		assert.equal(scope.attempts(), 1);
	});

	it("times out a service that never answers", async () => {
		const scope = arrange(() => ({ status: 200, hang: true }));
		await assert.rejects(clientFor(scope, { timeoutMs: 150, retries: 0 }).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "timeout");
			return true;
		});
	});

	it("reports an unreachable service as a network failure, not an empty list", async () => {
		// Nothing listens on this port, so the connection is refused outright.
		const dead = createServiceClient({ baseUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 1_000 });
		await assert.rejects(dead.listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "network");
			assert.match(error.message, /Search Service/);
			return true;
		});
	});

	it("stops immediately when the caller aborts", async () => {
		const scope = arrange(() => ({ status: 503 }));
		const controller = new AbortController();
		const pending = clientFor(scope, { retries: 5 }).listProviders({ signal: controller.signal });
		controller.abort();
		await assert.rejects(pending);
		assert.ok(scope.attempts() <= 1, `aborting must not keep retrying, saw ${scope.attempts()} attempts`);
	});

	it("rejects a 200 that is not JSON without retrying it", async () => {
		const scope = arrange(() => ({ status: 200, body: "<html>proxy error</html>", contentType: "text/html" }));
		await assert.rejects(clientFor(scope, { retries: 2 }).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "parse");
			return true;
		});
		assert.equal(scope.attempts(), 1, "malformed JSON will not become valid on a retry");
	});

	it("rejects a payload that is not an array", async () => {
		const scope = arrange(() => ({ status: 200, body: JSON.stringify({ providers: [] }) }));
		await assert.rejects(clientFor(scope).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "parse");
			assert.match(error.message, /expected a JSON array/);
			return true;
		});
	});

	it("rejects a provider record missing a required field rather than skipping it", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify([{ name: "openalex", enabled: true, capabilities: {} }, { name: "broken" }]),
		}));
		await assert.rejects(clientFor(scope).listProviders(), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "parse");
			assert.match(error.message, /"broken"/);
			return true;
		});
	});

	it("tolerates a record whose optional sections are absent", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify([{ name: "minimal", enabled: true, capabilities: { search_keyword: true } }]),
		}));
		const providers = await clientFor(scope).listProviders();
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0]?.enabledCapabilities, ["search_keyword"]);
		assert.deepEqual(providers[0]?.costModel, {});
		assert.deepEqual(providers[0]?.fieldMap, {});
		assert.deepEqual(providers[0]?.quotaRemaining, {});
		assert.equal(providers[0]?.reliability.retryPolicy, null);
	});
});
