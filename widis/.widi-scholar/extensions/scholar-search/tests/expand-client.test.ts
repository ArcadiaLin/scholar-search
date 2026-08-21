/**
 * The client half of the remaining five tools: expansion, facet probing,
 * rank-only, full text, and budget.
 *
 * The properties worth pinning here are the ones a caller can be misled by:
 * that a clamped walk arrives labelled as clamped, that rank-only reports zero
 * provider calls, that full text never widens the paper set, and that the
 * budget's scope travels with the numbers.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createServiceClient, ServiceRequestError } from "../core/service-client.ts";

interface Capture {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}

type Reply = { status: number; body?: string };

interface Scope {
	readonly name: string;
	readonly baseUrl: string;
	calls(): readonly Capture[];
}

const handlers = new Map<string, () => Reply>();
const callsByScope = new Map<string, Capture[]>();
let counter = 0;

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
		callsByScope.get(scope)?.push({ method: request.method ?? "", path: url, body });
		const reply = handlers.get(scope)?.() ?? { status: 500 };
		response.writeHead(reply.status, { "Content-Type": "application/json" });
		response.end(reply.body ?? "");
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

function arrange(next: () => Reply): Scope {
	counter += 1;
	const scope = `e${counter}`;
	handlers.set(scope, next);
	callsByScope.set(scope, []);
	return { name: scope, baseUrl: `${base}/${scope}`, calls: () => callsByScope.get(scope) ?? [] };
}

function clientFor(scope: Scope) {
	return createServiceClient({ baseUrl: scope.baseUrl, timeoutMs: 2_000, retries: 0 });
}

function paper(id: string, title = "A Paper") {
	return { paper_id: id, title, sources: ["openalex"] };
}

describe("expandCitations", () => {
	it("posts the seeds and translates the options to wire names", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], edges: [], direction: "forward", effective_limits: {}, clamped: [] }),
		}));
		await clientFor(scope).expandCitations({ seedIds: ["W1", "W2"], direction: "forward", depth: 1, fanout: 5 });

		const call = scope.calls()[0];
		assert.equal(call?.method, "POST");
		assert.equal(call?.path, `/${scope.name}/expand/citations`);
		assert.deepEqual(call?.body, { seed_ids: ["W1", "W2"], direction: "forward", depth: 1, fanout: 5 });
	});

	it("omits options the caller did not set", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], edges: [], direction: "backward", effective_limits: {}, clamped: [] }),
		}));
		await clientFor(scope).expandCitations({ seedIds: ["W1"] });

		assert.deepEqual(Object.keys(scope.calls()[0]?.body as object), ["seed_ids"]);
	});

	it("surfaces the papers, the edges and the walk's accounting", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				papers: [paper("W2"), paper("W3")],
				edges: [{ source_id: "W1", target_id: "W2", edge_type: "references" }],
				direction: "backward",
				effective_limits: { depth: 2, fanout: 25 },
				clamped: [],
				provider_calls: 2,
				failures: [],
			}),
		}));
		const result = await clientFor(scope).expandCitations({ seedIds: ["W1"] });

		assert.equal(result.papers.length, 2);
		assert.deepEqual(result.edges[0], { sourceId: "W1", targetId: "W2", edgeType: "references" });
		assert.equal(result.effectiveLimits.depth, 2);
		assert.equal(result.providerCalls, 2);
	});

	it("carries the clamp list through, because a clamped walk is not an exhausted graph", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				papers: [],
				edges: [],
				direction: "backward",
				effective_limits: { depth: 2 },
				clamped: ["depth", "max_total_candidates"],
			}),
		}));
		const result = await clientFor(scope).expandCitations({ seedIds: ["W1"], depth: 99 });

		assert.deepEqual([...result.clamped], ["depth", "max_total_candidates"]);
	});

	it("keeps the walk's classified failures", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				papers: [],
				edges: [],
				direction: "backward",
				effective_limits: {},
				clamped: [],
				failures: [{ stage: "expand", source: "openalex", error_type: "rate_limit", message: "seed 'W1': limited" }],
			}),
		}));
		const result = await clientFor(scope).expandCitations({ seedIds: ["W1"] });

		assert.equal(result.failures[0]?.errorType, "rate_limit");
		assert.match(result.failures[0]?.message ?? "", /W1/);
	});

	it("reports a missing graph capability as a capability limit", async () => {
		const scope = arrange(() => ({
			status: 501,
			body: JSON.stringify({ detail: "No enabled provider advertises the graph_citations capability." }),
		}));
		await assert.rejects(
			clientFor(scope).expandCitations({ seedIds: ["W1"], direction: "forward" }),
			(error: unknown) => {
				assert.ok(error instanceof ServiceRequestError);
				assert.equal(error.status, 501);
				assert.match(error.detail ?? "", /graph_citations/);
				return true;
			},
		);
	});
});

describe("facetProbe", () => {
	it("posts the query and grouping fields", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ query: "q", source: "openalex", groups: {} }),
		}));
		await clientFor(scope).facetProbe({ query: "q", groupBy: ["publication_year"] });

		assert.deepEqual(scope.calls()[0]?.body, { query: "q", group_by: ["publication_year"] });
	});

	it("returns the provider's buckets unchanged", async () => {
		const buckets = [
			{ key: "2021", count: 12 },
			{ key: "2022", count: 30 },
		];
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ query: "q", source: "openalex", groups: { publication_year: buckets } }),
		}));
		const result = await clientFor(scope).facetProbe({ query: "q", groupBy: ["publication_year"] });

		assert.equal(result.source, "openalex");
		assert.deepEqual(result.groups.publication_year, buckets);
	});
});

describe("rankCandidates", () => {
	it("posts the candidates and reports that no provider was called", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [paper("W1")], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		const result = await clientFor(scope).rankCandidates({ query: "q", candidates: [paper("W1")], topK: 5 });

		assert.deepEqual(scope.calls()[0]?.body, { query: "q", candidates: [paper("W1")], top_k: 5 });
		// Rank-only. If this were ever non-zero, ranking and searching would stop
		// being distinguishable in the trajectory.
		assert.equal(result.providerCalls, 0);
	});

	it("reports records it could not parse rather than dropping them silently", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [paper("W1")], scored: 1, skipped: 4, provider_calls: 0 }),
		}));
		const result = await clientFor(scope).rankCandidates({ query: "q", candidates: [paper("W1")] });

		assert.equal(result.skipped, 4);
	});
});

describe("searchFulltext", () => {
	it("posts only the papers it was given", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], effective_limits: {}, clamped: [] }),
		}));
		await clientFor(scope).searchFulltext({ paperIds: ["2206.01729"], query: "torsion" });

		// The query must travel as a section filter, never as a second recall path.
		assert.deepEqual(scope.calls()[0]?.body, { paper_ids: ["2206.01729"], query: "torsion" });
	});

	it("omits an empty section filter rather than sending one", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], effective_limits: {}, clamped: [] }),
		}));
		await clientFor(scope).searchFulltext({ paperIds: ["2206.01729"], sections: [] });

		assert.deepEqual(Object.keys(scope.calls()[0]?.body as object), ["paper_ids"]);
	});

	it("distinguishes an unavailable paper from an empty one", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				papers: [
					{
						paper_id: "2206.01729",
						available: true,
						reason: null,
						sections: [{ title: "Method", text: "t", match_count: 2 }],
					},
					{
						paper_id: "9999.99999",
						available: false,
						reason: "no ar5iv rendering exists for this paper",
						sections: [],
					},
				],
				effective_limits: { max_papers: 5 },
				clamped: [],
			}),
		}));
		const result = await clientFor(scope).searchFulltext({ paperIds: ["2206.01729", "9999.99999"] });

		assert.equal(result.papers[0]?.available, true);
		assert.equal(result.papers[0]?.sections[0]?.matchCount, 2);
		assert.equal(result.papers[1]?.available, false);
		assert.match(result.papers[1]?.reason ?? "", /no ar5iv rendering/);
	});
});

describe("getBudget", () => {
	it("gets the budget and keeps the scope label with the numbers", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({
				limits: { expand: { max_depth: 2 } },
				quotas: { openalex: { enabled: true } },
				spent: { facet: 3, fulltext: 1 },
				scope: "process",
			}),
		}));
		const result = await clientFor(scope).getBudget();

		assert.equal(scope.calls()[0]?.method, "GET");
		assert.equal(scope.calls()[0]?.path, `/${scope.name}/budget`);
		assert.deepEqual(result.spent, { facet: 3, fulltext: 1 });
		// Without the scope the numbers are unreadable: process-wide spend read as
		// an episode's would look like one enormously expensive search.
		assert.equal(result.scope, "process");
	});

	it("says the scope is unknown rather than assuming an episode", async () => {
		const scope = arrange(() => ({ status: 200, body: JSON.stringify({ limits: {}, quotas: {}, spent: {} }) }));
		const result = await clientFor(scope).getBudget();

		assert.equal(result.scope, "unknown");
	});
});

describe("rankCandidates candidate translation", () => {
	// The bug this guards: the agent holds `PaperSummary` records, because that is
	// what every other tool handed it, while /rank validates the service's
	// snake_case `Paper`. Posting them unchanged made the service skip all of
	// them, so ranking returned nothing and said so only in a `skipped` count.
	function summary() {
		return {
			paperId: "10.1/x",
			title: "A Paper",
			authors: ["Ada Lovelace", "Alan Turing"],
			authorCount: 2,
			venue: "NeurIPS",
			year: 2020,
			published: "2020-01-01",
			doi: "10.1/x",
			arxivId: "2206.01729",
			openalexId: "W1",
			citationCount: 12,
			abstract: "text",
			url: "https://example.org/x",
			sources: ["openalex"],
			score: 0.5,
			rank: 1,
			tier: "partially_relevant",
		};
	}

	function postedCandidates(scope: Scope): Record<string, unknown>[] {
		const body = scope.calls()[0]?.body as { candidates: Record<string, unknown>[] };
		return body.candidates;
	}

	it("renames the summary's keys to the wire shape", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({ query: "q", candidates: [summary()] });

		const posted = postedCandidates(scope)[0];
		assert.equal(posted?.paper_id, "10.1/x");
		assert.equal(posted?.arxiv_id, "2206.01729");
		assert.equal(posted?.openalex_id, "W1");
		assert.equal(posted?.citation_count, 12);
		assert.equal(posted?.paperId, undefined, "the camelCase key must not survive alongside the wire key");
	});

	it("turns author names back into author objects", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({ query: "q", candidates: [summary()] });

		assert.deepEqual(postedCandidates(scope)[0]?.authors, [{ name: "Ada Lovelace" }, { name: "Alan Turing" }]);
	});

	it("turns the single url back into the urls map", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({ query: "q", candidates: [summary()] });

		assert.deepEqual(postedCandidates(scope)[0]?.urls, { paper: "https://example.org/x" });
	});

	it("drops the derived fields the service does not model", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({ query: "q", candidates: [summary()] });

		const posted = postedCandidates(scope)[0];
		for (const dropped of ["authorCount", "author_count", "rank", "tier", "url"]) {
			assert.equal(posted?.[dropped], undefined, `${dropped} must not be posted`);
		}
	});

	it("passes a record that already speaks the wire shape through untouched", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		const wire = { paper_id: "W9", title: "Already wire-shaped", sources: ["openalex"] };
		await clientFor(scope).rankCandidates({ query: "q", candidates: [wire] });

		assert.deepEqual(postedCandidates(scope)[0], wire);
	});
});

describe("rankCandidates accepts what the tool text taught the agent", () => {
	// Observed live: the agent rebuilds candidates from the rendered tool output,
	// where the identifier is labelled `id:`. This is the exact shape it sent.
	const asTheAgentBuildsIt = {
		id: "1609.04846",
		title: "A Tutorial about Random Neural Networks in Supervised Learning",
		authors: ["Sebastián Basterrech", "Gerardo Rubino"],
		year: 2016,
		venue: "Neural Network World",
		abstract: "Random Neural Networks are a class of Neural Networks...",
		sources: ["arxiv"],
	};

	it("maps `id` to the wire identifier", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({ query: "q", candidates: [asTheAgentBuildsIt] });

		const posted = (scope.calls()[0]?.body as { candidates: Record<string, unknown>[] }).candidates[0];
		assert.equal(posted?.paper_id, "1609.04846");
		assert.equal(posted?.id, undefined);
		assert.deepEqual(posted?.authors, [{ name: "Sebastián Basterrech" }, { name: "Gerardo Rubino" }]);
	});

	it("falls back to a DOI or arXiv id when no identifier field was named", async () => {
		const scope = arrange(() => ({
			status: 200,
			body: JSON.stringify({ papers: [], scored: 1, skipped: 0, provider_calls: 0 }),
		}));
		await clientFor(scope).rankCandidates({
			query: "q",
			candidates: [
				{ title: "Only a DOI", doi: "10.1/only" },
				{ title: "Only an arXiv id", arxivId: "2206.01729" },
			],
		});

		const posted = (scope.calls()[0]?.body as { candidates: Record<string, unknown>[] }).candidates;
		assert.equal(posted[0]?.paper_id, "10.1/only");
		assert.equal(posted[1]?.paper_id, "2206.01729");
	});
});
