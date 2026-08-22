/**
 * The retrieval half of the service client: `searchMetadata`, `getPaper` and
 * `providerQuery`.
 *
 * Same shape as `service-client.test.ts` - a local server and recorded payloads,
 * so a request's body and a response's projection can both be asserted without
 * a live Search Service. What matters here is what leaves the boundary: the
 * request body the service will actually receive, and the bounded summary the
 * tool layer is allowed to show the model.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createServiceClient, ServiceRequestError } from "../core/service-client.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const searchFixture = readFileSync(join(fixturesDir, "search-metadata.json"), "utf8");
const paperFixture = readFileSync(join(fixturesDir, "paper-lookup.json"), "utf8");

interface Capture {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly contentType: string | undefined;
}

type Reply = { status: number; body?: string; contentType?: string };

interface Scope {
	readonly name: string;
	readonly baseUrl: string;
	calls(): readonly Capture[];
}

const handlers = new Map<string, (attempt: number) => Reply>();
const callsByScope = new Map<string, Capture[]>();
let scopeCounter = 0;

const server: Server = createServer((request, response) => {
	const url = request.url ?? "";
	const scope = url.split("/")[1] ?? "";
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		let body: unknown;
		if (raw !== "") {
			try {
				body = JSON.parse(raw);
			} catch {
				body = raw;
			}
		}
		const calls = callsByScope.get(scope);
		calls?.push({ method: request.method ?? "", path: url, body, contentType: request.headers["content-type"] });
		const reply = handlers.get(scope)?.(calls?.length ?? 1) ?? { status: 500 };
		response.writeHead(reply.status, { "Content-Type": reply.contentType ?? "application/json" });
		response.end(reply.body ?? "");
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

function arrange(next: (attempt: number) => Reply): Scope {
	scopeCounter += 1;
	const scope = `q${scopeCounter}`;
	handlers.set(scope, next);
	callsByScope.set(scope, []);
	return { name: scope, baseUrl: `${base}/${scope}`, calls: () => callsByScope.get(scope) ?? [] };
}

function clientFor(scope: Scope, overrides: { retries?: number; maxAbstractChars?: number; maxAuthors?: number } = {}) {
	return createServiceClient({
		baseUrl: scope.baseUrl,
		timeoutMs: 2_000,
		retries: overrides.retries ?? 0,
		maxAbstractChars: overrides.maxAbstractChars,
		maxAuthorsPerPaper: overrides.maxAuthors,
	});
}

describe("searchMetadata request", () => {
	it("posts the query to /search/metadata as JSON", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		await clientFor(scope).searchMetadata({ query: "transformer attention" });

		const call = scope.calls()[0];
		assert.equal(call?.method, "POST");
		assert.equal(call?.path, `/${scope.name}/search/metadata`);
		assert.match(call?.contentType ?? "", /application\/json/);
		assert.deepEqual(call?.body, { query: "transformer attention" });
	});

	it("translates every set option to its wire name", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		await clientFor(scope).searchMetadata({
			query: "q",
			subqueries: ["a", "b"],
			topK: 5,
			endDate: "2024-01-01",
			sources: ["openalex"],
			timeoutMs: 9_000,
			providerParams: { openalex: { filter: "is_oa:true" } },
		});

		assert.deepEqual(scope.calls()[0]?.body, {
			query: "q",
			subqueries: ["a", "b"],
			top_k: 5,
			end_date: "2024-01-01",
			sources: ["openalex"],
			timeout_ms: 9_000,
			provider_params: { openalex: { filter: "is_oa:true" } },
		});
	});

	it("omits an option the caller did not set rather than sending null", async () => {
		// `end_date: null` and an absent `end_date` are the same request today, but
		// an absent bound is the honest encoding of "the caller said nothing" and
		// keeps the service free to treat an explicit null differently.
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		await clientFor(scope).searchMetadata({ query: "q", subqueries: [] });

		const body = scope.calls()[0]?.body as Record<string, unknown>;
		assert.deepEqual(Object.keys(body), ["query"]);
	});
});

describe("searchMetadata response", () => {
	it("projects a ranked paper onto the summary view", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope).searchMetadata({ query: "q" });

		assert.equal(result.papers.length, 1);
		const paper = result.papers[0];
		assert.ok(paper);
		assert.equal(paper.title, "Attention Is All You Need");
		assert.equal(paper.paperId, "10.48550/arXiv.1706.03762");
		assert.equal(paper.arxivId, "1706.03762");
		assert.equal(paper.openalexId, "W2963403868");
		assert.equal(paper.venue, "NeurIPS");
		assert.equal(paper.year, 2017);
		assert.equal(paper.rank, 1);
		assert.equal(paper.url, "https://arxiv.org/abs/1706.03762");
		assert.deepEqual(paper.sources, ["openalex"]);
	});

	it("keeps author names and reports how many there were", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope, { maxAuthors: 2 }).searchMetadata({ query: "q" });

		const paper = result.papers[0];
		assert.deepEqual(paper?.authors, ["Ashish Vaswani", "Noam Shazeer"]);
		// The count is the whole author list, so the tool layer can render "et al."
		// rather than implying the paper has two authors.
		assert.equal(paper?.authorCount, 6);
	});

	it("bounds the abstract at the length the caller asked for", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope, { maxAbstractChars: 20 }).searchMetadata({ query: "q" });

		const abstract = result.papers[0]?.abstract;
		assert.ok(abstract);
		assert.ok(abstract.length <= 23, `abstract was ${abstract.length} chars: ${abstract}`);
		assert.ok(abstract.endsWith("..."));
	});

	it("drops the fields that would make context grow with the corpus", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope).searchMetadata({ query: "q" });

		// `raw`, `field_provenance` and the reference lists are in the service
		// payload and must not reach a summary: docs/design.md §4.1.
		const paper = result.papers[0] as unknown as Record<string, unknown>;
		assert.ok(JSON.parse(searchFixture).papers[0].raw !== undefined, "the fixture must still contain raw");
		for (const dropped of ["raw", "field_provenance", "references", "citations", "counts_by_year", "external_ids"]) {
			assert.equal(paper[dropped], undefined, `${dropped} must not survive into the summary`);
		}
	});

	it("surfaces the service's process account, including the subquery fan-out", async () => {
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope).searchMetadata({ query: "q" });

		assert.deepEqual([...result.searchState.selectedSources].sort(), ["arxiv", "openalex"]);
		assert.equal(result.searchState.issuedQueries.length, 4);
		assert.equal(result.searchState.recalled, 2);
		assert.equal(result.searchState.returned, 1);
		assert.deepEqual(result.searchState.filters.subqueries, ["self-attention"]);
		assert.deepEqual(result.searchState.failures, []);
	});

	it("records the query as actually sent, not only as the caller wrote it", async () => {
		// A provider rewrite that the trajectory cannot see is a rewrite nobody can
		// debug: arXiv turned every multi-word query into an OR bag and the trace
		// showed the agent's own wording throughout (`docs/develop/backlog.md` F-1).
		const scope = arrange(() => ({ status: 200, body: searchFixture }));
		const result = await clientFor(scope).searchMetadata({ query: "q" });

		const arxiv = result.searchState.issuedQueries.find((issued) => issued.provider === "arxiv");
		assert.equal(arxiv?.query, "transformer attention");
		assert.equal(arxiv?.nativeQuery, "all:transformer AND all:attention");
	});

	it("reports a provider that sends the query unchanged as a null native query", async () => {
		const payload = JSON.parse(searchFixture) as Record<string, unknown>;
		const state = payload.search_state as Record<string, unknown>;
		state.issued_queries = [{ provider: "arxiv", mode: "aggregated", query: "q" }];
		const scope = arrange(() => ({ status: 200, body: JSON.stringify(payload) }));

		const result = await clientFor(scope).searchMetadata({ query: "q" });
		assert.equal(result.searchState.issuedQueries[0]?.nativeQuery, null);
	});

	it("carries the classified failures out of a total upstream failure", async () => {
		// 502 is exactly when the classification matters: a quota limit, an empty
		// result and a broken source need three different next moves, and they used
		// to arrive as one sentence (`docs/develop/backlog.md` F-2).
		const scope = arrange(() => ({
			status: 502,
			body: JSON.stringify({
				detail: "All providers failed.",
				failures: [{ stage: "recall", source: "openalex", error_type: "rate_limit", message: "quota gone" }],
				alternative_sources: ["arxiv"],
			}),
		}));

		await assert.rejects(clientFor(scope, { retries: 0 }).searchMetadata({ query: "q" }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.failures.length, 1);
			assert.equal(error.failures[0]?.errorType, "rate_limit");
			assert.deepEqual([...error.alternativeSources], ["arxiv"]);
			return true;
		});
	});

	it("reports no alternative sources when the service names none", async () => {
		const scope = arrange(() => ({ status: 502, body: JSON.stringify({ detail: "All providers failed." }) }));

		await assert.rejects(clientFor(scope, { retries: 0 }).searchMetadata({ query: "q" }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.deepEqual(error.failures, []);
			assert.deepEqual([...error.alternativeSources], []);
			return true;
		});
	});

	it("reports failures that happened even though the search succeeded", async () => {
		const payload = JSON.parse(searchFixture) as Record<string, unknown>;
		const state = payload.search_state as Record<string, unknown>;
		state.failures = [{ stage: "recall", source: "arxiv", error_type: "timeout", message: "arXiv timed out" }];
		const scope = arrange(() => ({ status: 200, body: JSON.stringify(payload) }));

		const result = await clientFor(scope).searchMetadata({ query: "q" });

		assert.equal(result.papers.length, 1, "a partial failure must not discard the results that did arrive");
		assert.equal(result.searchState.failures.length, 1);
		assert.equal(result.searchState.failures[0]?.errorType, "timeout");
	});

	it("accepts an empty result set as an answer rather than an error", async () => {
		const payload = JSON.parse(searchFixture) as Record<string, unknown>;
		payload.papers = [];
		const scope = arrange(() => ({ status: 200, body: JSON.stringify(payload) }));

		const result = await clientFor(scope).searchMetadata({ query: "q" });
		assert.deepEqual(result.papers, []);
	});

	it("rejects a response with no papers array", async () => {
		const scope = arrange(() => ({ status: 200, body: JSON.stringify({ search_state: {} }) }));
		await assert.rejects(clientFor(scope).searchMetadata({ query: "q" }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.kind, "parse");
			return true;
		});
	});

	it("carries the service's own explanation out of a rejected request", async () => {
		const scope = arrange(() => ({ status: 422, body: JSON.stringify({ detail: "top_k must be <= 200" }) }));
		await assert.rejects(clientFor(scope).searchMetadata({ query: "q", topK: 999 }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 422);
			// The tool layer turns this into advice, so it needs the field name the
			// service named, not a prefix of the serialised body.
			assert.equal(error.detail, "top_k must be <= 200");
			return true;
		});
	});
});

describe("the judge account on a search", () => {
	it("defaults to nothing judged rather than to judging having worked", async () => {
		// A service build that does not report judging has not done any; assuming
		// otherwise is how a capability gap sediments as "it looks finished" (D-09).
		const scope = arrange(() => ({ status: 200, body: JSON.stringify({ papers: [], search_state: {} }) }));
		const result = await clientFor(scope).searchMetadata({ query: "q" });

		assert.equal(result.searchState.judge.supported, false);
		assert.equal(result.searchState.judge.level, "off");
		assert.equal(result.searchState.judge.judged, 0);
		assert.equal(result.searchState.judge.rubricVersion, null);
	});

	it("carries what was judged, and under which instrument", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				papers: [],
				search_state: {
					judge: {
						level: "l3b",
						requested_level: "auto",
						supported: true,
						considered: 30,
						judged: 28,
						cache_hits: 4,
						rubric_version: "r3",
						criteria_version: "cq_1a2b",
						model_version: "vllm/qwen",
					},
				},
			}),
		}));
		const result = await clientFor(scope).searchMetadata({ query: "q", judgeLevel: "auto" });

		const judge = result.searchState.judge;
		assert.equal(judge.level, "l3b");
		assert.equal(judge.requestedLevel, "auto");
		assert.equal(judge.judged, 28);
		assert.equal(judge.considered, 30);
		assert.equal(judge.cacheHits, 4);
		// The three versions are what make the number a measurement rather than a score.
		assert.deepEqual([judge.rubricVersion, judge.criteriaVersion, judge.modelVersion], [
			"r3",
			"cq_1a2b",
			"vllm/qwen",
		]);
	});

	it("sends judge_level only when the caller set it", async () => {
		const withLevel = arrange(() => ({ status: 200, body: searchFixture }));
		await clientFor(withLevel).searchMetadata({ query: "q", judgeLevel: "l3b" });
		assert.equal((withLevel.calls()[0]?.body as Record<string, unknown>).judge_level, "l3b");

		const without = arrange(() => ({ status: 200, body: searchFixture }));
		await clientFor(without).searchMetadata({ query: "q" });
		// Absent, not `"off"`: not constraining a knob is a different request from
		// constraining it to its default.
		assert.equal("judge_level" in (without.calls()[0]?.body as Record<string, unknown>), false);
	});
});

describe("getPaper", () => {
	it("gets the encoded id from /paper and reports which source answered", async () => {
		const scope = arrange(() => ({ status: 200, body: paperFixture }));
		const result = await clientFor(scope).getPaper("1706.03762");

		assert.equal(scope.calls()[0]?.method, "GET");
		assert.equal(scope.calls()[0]?.path, `/${scope.name}/paper/1706.03762`);
		assert.equal(result.source, "arxiv");
		assert.deepEqual(result.triedSources, ["arxiv"]);
		assert.equal(result.paper.title, "Attention Is All You Need");
	});

	it("encodes an id containing slashes so it cannot address another route", async () => {
		const scope = arrange(() => ({ status: 200, body: paperFixture }));
		await clientFor(scope).getPaper("10.1145/3292500");

		assert.equal(scope.calls()[0]?.path, `/${scope.name}/paper/10.1145%2F3292500`);
	});

	it("keeps the failures of the sources tried before the answer", async () => {
		const payload = JSON.parse(paperFixture) as Record<string, unknown>;
		payload.source = "openalex";
		payload.tried_sources = ["arxiv", "openalex"];
		payload.failures = [{ stage: "lookup", source: "arxiv", error_type: "timeout", message: "arXiv timed out" }];
		const scope = arrange(() => ({ status: 200, body: JSON.stringify(payload) }));

		const result = await clientFor(scope).getPaper("1706.03762");

		assert.equal(result.source, "openalex");
		assert.deepEqual(result.triedSources, ["arxiv", "openalex"]);
		assert.equal(result.failures[0]?.source, "arxiv");
	});

	it("passes a 404 out with the reason and the sources that were tried", async () => {
		const scope = arrange(() => ({
			status: 404,
			body: JSON.stringify({
				detail: "No provider could resolve paper_id '9999.99999'.",
				tried_sources: ["arxiv", "openalex"],
				failures: [],
			}),
		}));
		await assert.rejects(clientFor(scope).getPaper("9999.99999"), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 404);
			assert.match(error.detail ?? "", /9999\.99999/);
			assert.deepEqual(error.bodyJson?.tried_sources, ["arxiv", "openalex"]);
			return true;
		});
	});

	it("distinguishes a missing capability from a missing paper", async () => {
		const scope = arrange(() => ({
			status: 501,
			body: JSON.stringify({ detail: "No enabled provider advertises the id_lookup capability." }),
		}));
		await assert.rejects(clientFor(scope).getPaper("1706.03762"), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 501);
			assert.match(error.detail ?? "", /id_lookup/);
			return true;
		});
	});
});

describe("providerQuery", () => {
	it("posts the native parameters and returns the response unrewritten", async () => {
		const providerPayload = { meta: { count: 1 }, results: [{ id: "https://openalex.org/W1", weird_field: [1, 2] }] };
		const scope = arrange(() => ({ status: 200, body: JSON.stringify(providerPayload) }));

		const result = await clientFor(scope).providerQuery({
			provider: "openalex",
			endpoint: "works",
			params: { filter: "from_publication_date:2020-01-01", per_page: 1 },
		});

		assert.equal(scope.calls()[0]?.method, "POST");
		assert.equal(scope.calls()[0]?.path, `/${scope.name}/provider/openalex/query`);
		assert.deepEqual(scope.calls()[0]?.body, {
			endpoint: "works",
			params: { filter: "from_publication_date:2020-01-01", per_page: 1 },
		});
		// Passthrough exists to observe what the agent can express, so the payload
		// must arrive unnormalised - including fields this client knows nothing of.
		assert.deepEqual(result.raw, providerPayload);
		assert.equal(result.provider, "openalex");
	});

	it("omits endpoint when the caller did not name one", async () => {
		const scope = arrange(() => ({ status: 200, body: "{}" }));
		await clientFor(scope).providerQuery({ provider: "arxiv", params: { search_query: "all:electron" } });

		assert.deepEqual(scope.calls()[0]?.body, { params: { search_query: "all:electron" } });
	});

	it("reports a provider that does not accept native queries as a capability limit", async () => {
		const scope = arrange(() => ({
			status: 501,
			body: JSON.stringify({ detail: "Provider 'serper' does not advertise search_native_query capability." }),
		}));
		await assert.rejects(clientFor(scope).providerQuery({ provider: "serper", params: {} }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 501);
			assert.match(error.detail ?? "", /search_native_query/);
			return true;
		});
	});

	it("reports an unknown provider as a 404 naming it", async () => {
		const scope = arrange(() => ({
			status: 404,
			body: JSON.stringify({ detail: "Provider 'scopus' is not configured or disabled." }),
		}));
		await assert.rejects(clientFor(scope).providerQuery({ provider: "scopus", params: {} }), (error: unknown) => {
			assert.ok(error instanceof ServiceRequestError);
			assert.equal(error.status, 404);
			assert.match(error.detail ?? "", /scopus/);
			return true;
		});
	});

	it("does not retry a rejected syntax", async () => {
		// A 400 means the query was wrong, and it will be wrong the second time
		// too. Retrying only spends quota.
		const scope = arrange(() => ({ status: 400, body: JSON.stringify({ detail: "unknown filter field 'topic'" }) }));
		await assert.rejects(clientFor(scope, { retries: 3 }).providerQuery({ provider: "openalex", params: {} }));
		assert.equal(scope.calls().length, 1);
	});
});
