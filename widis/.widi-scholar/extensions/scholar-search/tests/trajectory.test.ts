/**
 * The public search trace, $\bar{\tau}_t$.
 *
 * The load-bearing test in this file is the one asserting that a thinking block
 * cannot reach the trace. Everything else about the collector is a convenience;
 * that property is the mechanism keeping $C^R_t \neq C^M_t$, and if it breaks
 * the Reviewer becomes a second self-reflection in the same context
 * (`docs/design.md` §5.1).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLECTED_EVENTS, createTraceCollector } from "../core/trajectory.ts";

function collector(options: { maxCalls?: number; maxArgChars?: number } = {}) {
	return createTraceCollector({ agentId: "search-test", profileId: "search", ...options });
}

function searchResult(overrides: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: "3 result(s)" }],
		details: {
			searchState: {
				issuedQueries: [
					{ provider: "openalex", query: "main" },
					{ provider: "arxiv", query: "sub" },
				],
				selectedSources: ["openalex", "arxiv"],
				filters: { end_date: "2024-06-30", subqueries: ["sub"] },
				recalled: 120,
				returned: 20,
				failures: [],
				...overrides,
			},
		},
	};
}

describe("the trace excludes private reasoning", () => {
	// The stream this collector sits on is mostly thinking deltas. They must be
	// unreachable, not merely unused.
	it("ignores every event carrying assistant reasoning", () => {
		const trace = collector();
		const secret = "the user is probably after the torsional diffusion line of work";

		const rejected = [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: secret } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: secret } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: secret } },
			{ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: secret }] } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: secret }] } },
			{
				type: "turn_end",
				message: { role: "assistant", content: [{ type: "thinking", thinking: secret }] },
				toolResults: [],
			},
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: secret }] }] },
			{ type: "agent_start" },
			{ type: "turn_start" },
		];

		for (const event of rejected) {
			assert.equal(trace.record(event), false, `${event.type} must not contribute to the trace`);
		}

		const snapshot = trace.snapshot();
		assert.deepEqual(snapshot.calls, []);
		assert.ok(!JSON.stringify(snapshot).includes(secret), "no rejected event's content may appear in the trace");
	});

	it("collects only the two tool-execution events, by allow-list", () => {
		assert.deepEqual([...COLLECTED_EVENTS], ["tool_execution_start", "tool_execution_end"]);
	});

	it("keeps reasoning out even when it rides along on a collected event", () => {
		// A future upstream change could attach more to a tool event. Only the
		// fields this module names are copied, so extra ones cannot leak.
		const trace = collector();
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "search_metadata",
			args: { query: "diffusion conformers" },
			reasoning: "I should hide my real intent here",
			message: { content: [{ type: "thinking", thinking: "and here" }] },
		});

		const snapshot = JSON.stringify(trace.snapshot());
		assert.ok(snapshot.includes("diffusion conformers"), "the issued query is public and must be kept");
		assert.ok(!snapshot.includes("hide my real intent"));
		assert.ok(!snapshot.includes("and here"));
	});
});

describe("what the trace does record", () => {
	it("records the issued query and filter parameters", () => {
		const trace = collector();
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "search_metadata",
			args: { query: "diffusion conformers", end_date: "2024-06-30", top_k: 30 },
		});

		const call = trace.snapshot().calls[0];
		assert.equal(call?.toolName, "search_metadata");
		assert.equal(call?.args.query, "diffusion conformers");
		assert.equal(call?.args.end_date, "2024-06-30");
		assert.equal(call?.args.top_k, 30);
	});

	it("collects the subqueries of the whole episode, deduplicated", () => {
		const trace = collector();
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "search_metadata",
			args: { subqueries: ["a", "b"] },
		});
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c2",
			toolName: "search_metadata",
			args: { subqueries: ["b", "c"] },
		});

		assert.deepEqual(trace.snapshot().subqueries, ["a", "b", "c"]);
	});

	it("carries the service's candidate counts and the sources it queried", () => {
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: searchResult(),
			isError: false,
		});

		const snapshot = trace.snapshot();
		assert.deepEqual(snapshot.candidateCounts, { recalled: 120, returned: 20 });
		assert.deepEqual(snapshot.calls[0]?.searchState?.selectedSources, ["openalex", "arxiv"]);
		assert.deepEqual(snapshot.calls[0]?.searchState?.filters.subqueries, ["sub"]);
	});

	it("keeps the query as actually issued alongside the query the agent wrote", () => {
		// A Reviewer that reads only the agent's wording cannot see a provider
		// rewrite, and the rewrite that mattered turned every query into an OR bag
		// (`docs/develop/backlog.md` F-1, and B-2 for what that cost the review).
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: searchResult({
				issuedQueries: [
					{ provider: "arxiv", query: "active learning superpixel", nativeQuery: "all:active AND all:superpixel" },
					{ provider: "openalex", query: "active learning superpixel" },
				],
			}),
			isError: false,
		});

		const issued = trace.snapshot().calls[0]?.searchState?.issuedQueries;
		assert.equal(issued?.[0]?.nativeQuery, "all:active AND all:superpixel");
		assert.equal(issued?.[1]?.nativeQuery, null, "a provider that does not rewrite reports null, not its own guess");
	});

	it("keeps the service's classified failures even when the call succeeded", () => {
		// "20 results" and "20 results, and arXiv timed out" are different facts
		// about coverage, and coverage gaps are the Reviewer's main subject.
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: searchResult({ failures: [{ source: "arxiv", errorType: "timeout", message: "arXiv timed out" }] }),
			isError: false,
		});

		const snapshot = trace.snapshot();
		assert.equal(snapshot.failures.length, 1);
		assert.equal(snapshot.failures[0]?.errorType, "timeout");
		assert.equal(snapshot.budget.failedCalls, 0, "a service-side failure is not a failed tool call");
	});

	it("records a failed tool call with its actionable diagnostic", () => {
		const trace = collector();
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "provider_query",
			args: { provider: "openalex" },
		});
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "provider_query",
			result: { content: [{ type: "text", text: "bogus_field is not a valid field. Valid fields are ..." }] },
			isError: true,
		});

		const snapshot = trace.snapshot();
		assert.equal(snapshot.calls[0]?.failed, true);
		assert.match(snapshot.calls[0]?.errorMessage ?? "", /not a valid field/);
		assert.equal(snapshot.budget.failedCalls, 1);
	});

	it("accounts for the budget in calls per tool", () => {
		const trace = collector();
		for (const [i, name] of ["list_providers", "search_metadata", "search_metadata", "get_paper"].entries()) {
			trace.record({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: name, args: {} });
		}

		const budget = trace.snapshot().budget;
		assert.equal(budget.totalCalls, 4);
		assert.deepEqual(budget.callsByTool, { list_providers: 1, search_metadata: 2, get_paper: 1 });
		assert.equal(budget.droppedCalls, 0);
	});
});

describe("collector robustness", () => {
	it("does not assume start arrives before end", () => {
		// Observer events have no ordering guarantee (SKILL.md §6). A collector
		// that only created records on `start` would silently lose the whole call.
		const trace = collector();
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: searchResult(),
			isError: false,
		});
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "search_metadata",
			args: { query: "late" },
		});

		const snapshot = trace.snapshot();
		assert.equal(snapshot.calls.length, 1, "the two halves must merge into one call, not two");
		assert.equal(snapshot.calls[0]?.args.query, "late");
		assert.equal(snapshot.calls[0]?.searchState?.recalled, 120);
	});

	it("counts one call once however many events it produces", () => {
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: searchResult(),
			isError: false,
		});

		assert.equal(trace.snapshot().budget.totalCalls, 1);
	});

	it("is bounded, and says how much it dropped", () => {
		// A trace that grows with the episode would become the thing it summarises.
		const trace = collector({ maxCalls: 2 });
		for (const i of [1, 2, 3, 4]) {
			trace.record({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "search_metadata", args: {} });
		}

		const budget = trace.snapshot().budget;
		assert.equal(budget.totalCalls, 2);
		assert.equal(budget.droppedCalls, 2, "silent truncation would read as a complete trace");
	});

	it("bounds a single oversized argument", () => {
		const trace = collector({ maxArgChars: 20 });
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "provider_query",
			args: { raw: "x".repeat(5_000) },
		});

		const value = trace.snapshot().calls[0]?.args.raw;
		assert.equal(typeof value, "string");
		assert.ok((value as string).length < 30);
	});

	it("ignores a malformed event instead of throwing", () => {
		// The collector sits on an observer. Throwing there would break the turn
		// it is only supposed to watch.
		const trace = collector();
		for (const bad of [
			null,
			undefined,
			42,
			"tool_execution_start",
			[],
			{},
			{ type: 7 },
			{ type: "tool_execution_start" },
		]) {
			assert.equal(trace.record(bad), false);
		}
		assert.deepEqual(trace.snapshot().calls, []);
	});

	it("keeps calls in the order they arrived", () => {
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "b", toolName: "list_providers", args: {} });
		trace.record({ type: "tool_execution_start", toolCallId: "a", toolName: "search_metadata", args: {} });

		assert.deepEqual(
			trace.snapshot().calls.map((call) => call.toolName),
			["list_providers", "search_metadata"],
		);
	});
});

describe("the trace carries citable evidence", () => {
	// EvidenceState in design.md §5.1: what the search *found*, as against what it
	// *did*. Without it a Reviewer has no id it can cite, and the gate's
	// "evidence must exist" rule would reject everything.
	function resultWithPapers(papers: unknown[], extra: Record<string, unknown> = {}) {
		return { content: [{ type: "text", text: "ok" }], details: { papers, ...extra } };
	}

	it("collects paper identity and attributes it to the call that found it", () => {
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: { query: "q" } });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: resultWithPapers([{ paperId: "10.1/a", title: "A Paper", sources: ["openalex"] }]),
			isError: false,
		});

		const evidence = trace.snapshot().evidence;
		assert.equal(evidence.length, 1);
		assert.equal(evidence[0]?.paperId, "10.1/a");
		assert.equal(evidence[0]?.title, "A Paper");
		assert.equal(evidence[0]?.foundBy, "c1", "attribution is what makes a coverage claim checkable");
	});

	it("keeps the first call that surfaced a paper, not the last", () => {
		const trace = collector();
		for (const id of ["c1", "c2"]) {
			trace.record({ type: "tool_execution_start", toolCallId: id, toolName: "search_metadata", args: {} });
			trace.record({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "search_metadata",
				result: resultWithPapers([{ paperId: "10.1/a", title: "A Paper", sources: [] }]),
				isError: false,
			});
		}

		const evidence = trace.snapshot().evidence;
		assert.equal(evidence.length, 1, "the same paper found twice is one piece of evidence");
		assert.equal(evidence[0]?.foundBy, "c1");
	});

	it("collects the single paper from get_paper too", () => {
		const trace = collector();
		trace.record({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "get_paper",
			args: { paper_id: "10.1/a" },
		});
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "get_paper",
			result: { content: [], details: { paper: { paperId: "10.1/a", title: "A Paper", sources: [] } } },
			isError: false,
		});

		assert.equal(trace.snapshot().evidence[0]?.paperId, "10.1/a");
	});

	it("bounds the evidence list", () => {
		const trace = createTraceCollector({ agentId: "a", profileId: "search", maxEvidence: 3 });
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: {} });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: resultWithPapers(
				Array.from({ length: 50 }, (_, i) => ({ paperId: `10.1/${i}`, title: "t", sources: [] })),
			),
			isError: false,
		});

		assert.equal(trace.snapshot().evidence.length, 3);
	});

	it("does not turn an abstract into evidence", () => {
		// Identity and title only. A trace carrying abstracts would grow with the
		// corpus, which is the thing the summary view exists to prevent.
		const trace = collector();
		trace.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "search_metadata", args: {} });
		trace.record({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "search_metadata",
			result: resultWithPapers([
				{ paperId: "10.1/a", title: "A Paper", sources: [], abstract: "a very long abstract indeed" },
			]),
			isError: false,
		});

		assert.ok(!JSON.stringify(trace.snapshot().evidence).includes("very long abstract"));
	});
});
