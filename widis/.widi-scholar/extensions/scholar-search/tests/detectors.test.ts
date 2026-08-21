/**
 * The seven detectors, and above all that they recognise the three behaviours
 * that were actually measured.
 *
 * `docs/develop/plan.md` §4.2's first acceptance criterion names a specific
 * input: the `search-k9u1` trajectory, on which **R1, R3 and R6 must fire**.
 * Those three are not hypotheses about how an agent might fail - they are the
 * three failures that episode exhibited, and a detector that cannot see them in
 * that trajectory is not written correctly.
 *
 * The trajectory itself is not in this repository (`runs/` is gitignored), so the
 * fixture below is reconstructed from the counts `docs/reviewer-design.md` §2.1
 * and §2.2 record verbatim: 64 calls, `get_paper` 33, `search_metadata` 28,
 * `expand_citations` 2, `list_providers` 1, `facet_probe` / `rank_candidates` /
 * `search_fulltext` zero, and thirty issued queries with not one quoted phrase.
 * That is a reconstruction, and it is worth being explicit about: it is faithful
 * to the published numbers, not a replay of the original file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type DetectorTraceView,
	detectConditions,
	FALLBACK_THRESHOLDS,
	jaccard,
	renderConditions,
} from "../core/review.ts";

function calls(counts: Record<string, number>, failed: Record<string, number> = {}): DetectorTraceView["calls"] {
	const list: { toolCallId: string; toolName: string; failed: boolean }[] = [];
	let index = 0;
	for (const [toolName, count] of Object.entries(counts)) {
		const failures = failed[toolName] ?? 0;
		for (let i = 0; i < count; i += 1) {
			index += 1;
			list.push({ toolCallId: `call-${index}`, toolName, failed: i < failures });
		}
	}
	return list;
}

function trace(overrides: Partial<DetectorTraceView> = {}): DetectorTraceView {
	const byTool = { search_metadata: 1, get_paper: 1 };
	return {
		subqueries: ['"active learning"', "superpixel segmentation"],
		calls: calls(byTool),
		evidence: [{ paperId: "10.1/a", sources: ["arxiv", "openalex"] }],
		budget: { totalCalls: 2, callsByTool: byTool },
		failures: [],
		...overrides,
	};
}

/**
 * `search-k9u1`, reconstructed from `reviewer-design.md` §2.1/§2.2.
 *
 * The queries are stand-ins with the one property that matters here: thirty
 * keyword-shaped queries and not a single quoted phrase, which is what §2.2's
 * third row records - the agent had stated in that very episode that it would
 * try phrase queries, and then issued none.
 */
const K9U1: DetectorTraceView = (() => {
	const byTool = { get_paper: 33, search_metadata: 28, expand_citations: 2, list_providers: 1 };
	return {
		subqueries: Array.from({ length: 30 }, (_, index) => `superpixel semantic segmentation variant ${index}`),
		calls: calls(byTool, { expand_citations: 2 }),
		evidence: Array.from({ length: 24 }, (_, index) => ({ paperId: `10.1/k${index}`, sources: ["arxiv"] })),
		budget: { totalCalls: 64, callsByTool: byTool },
		failures: [{ source: "openalex", errorType: "http" }],
	};
})();

describe("the k9u1 trajectory", () => {
	const fired = new Set(detectConditions(K9U1).map((condition) => condition.id));

	it("fires R1: 28 searches and facet_probe never called", () => {
		assert.ok(fired.has("R1"));
	});

	it("fires R3: thirty queries and not one quoted phrase", () => {
		assert.ok(fired.has("R3"));
	});

	it("fires R6: 33 get_paper against 28 searches, and no rank_candidates", () => {
		assert.ok(fired.has("R6"));
	});

	it("reports numbers rather than adjectives", () => {
		// The Reviewer is meant to quote the observation, not paraphrase a verdict.
		const observations = detectConditions(K9U1).map((condition) => condition.observation);
		assert.ok(observations.some((text) => text.includes("28")), "the search count must be in the text");
		assert.ok(observations.some((text) => text.includes("33")), "the fetch count must be in the text");
	});

	it("gives every condition a citable id from the trace", () => {
		for (const condition of detectConditions(K9U1)) {
			if (condition.id === "R7") continue; // budget cites no single call
			assert.ok(condition.evidenceIds.length > 0, `${condition.id} cited nothing`);
		}
	});
});

describe("R1 - never probed the distribution", () => {
	it("holds its fire below the search threshold", () => {
		const byTool = { search_metadata: 2 };
		const fired = detectConditions(trace({ budget: { totalCalls: 2, callsByTool: byTool }, calls: calls(byTool) }));
		assert.ok(!fired.some((condition) => condition.id === "R1"));
	});

	it("does not fire once facet_probe has been called", () => {
		const byTool = { search_metadata: 5, facet_probe: 1 };
		const fired = detectConditions(trace({ budget: { totalCalls: 6, callsByTool: byTool }, calls: calls(byTool) }));
		assert.ok(!fired.some((condition) => condition.id === "R1"));
	});
});

describe("R2 - the queries are one question asked repeatedly", () => {
	it("fires when every pair overlaps at or above the ceiling", () => {
		const fired = detectConditions(
			trace({ subqueries: ["superpixel semantic segmentation", "semantic segmentation superpixel methods"] }),
		);
		assert.ok(fired.some((condition) => condition.id === "R2"));
	});

	it("does not fire when one pair asks something different", () => {
		const fired = detectConditions(
			trace({ subqueries: ["superpixel semantic segmentation", "annotation budget labelling strategy"] }),
		);
		assert.ok(!fired.some((condition) => condition.id === "R2"));
	});

	it("needs at least two queries to say anything", () => {
		const fired = detectConditions(trace({ subqueries: ["superpixel segmentation"] }));
		assert.ok(!fired.some((condition) => condition.id === "R2"));
	});

	it("takes its ceiling from the thresholds rather than from a constant", () => {
		// The 0.5 has no basis; it is a running value pending an HP search
		// (`reviewer-design.md` §8). A detector that hard-coded it would put that
		// value out of the search's reach.
		const queries = ["superpixel semantic segmentation", "annotation budget labelling strategy"];
		const strict = detectConditions(trace({ subqueries: queries }), {
			...FALLBACK_THRESHOLDS,
			subqueryJaccardCeiling: 0,
		});
		assert.ok(strict.some((condition) => condition.id === "R2"));
	});
});

describe("R3 - no phrase query", () => {
	it("does not fire when one query is quoted", () => {
		const fired = detectConditions(trace({ subqueries: ['"active learning" superpixel', "region methods"] }));
		assert.ok(!fired.some((condition) => condition.id === "R3"));
	});

	it("says nothing about a search that issued no subqueries at all", () => {
		const fired = detectConditions(trace({ subqueries: [] }));
		assert.ok(!fired.some((condition) => condition.id === "R3"));
	});
});

describe("R4 - citation expansion", () => {
	it("fires when there is plenty to expand from and no expansion happened", () => {
		const fired = detectConditions(
			trace({ evidence: Array.from({ length: 12 }, (_, i) => ({ paperId: `p${i}`, sources: ["arxiv", "openalex"] })) }),
		);
		assert.ok(fired.some((condition) => condition.id === "R4"));
	});

	it("fires differently when every expansion call failed", () => {
		// This is F-10's shape: two failed calls and the agent abandoned the route,
		// concluding the literature had no edges rather than that its ids were wrong.
		const byTool = { search_metadata: 3, expand_citations: 2 };
		const fired = detectConditions(
			trace({
				budget: { totalCalls: 5, callsByTool: byTool },
				calls: calls(byTool, { expand_citations: 2 }),
				evidence: [{ paperId: "p0", sources: ["arxiv", "openalex"] }],
			}),
		);
		const r4 = fired.find((condition) => condition.id === "R4");
		assert.ok(r4);
		assert.match(r4.observation, /failed/);
	});

	it("does not fire when expansion ran and worked", () => {
		const byTool = { search_metadata: 3, expand_citations: 2 };
		const fired = detectConditions(
			trace({
				budget: { totalCalls: 5, callsByTool: byTool },
				calls: calls(byTool),
				evidence: [{ paperId: "p0", sources: ["arxiv", "openalex"] }],
			}),
		);
		assert.ok(!fired.some((condition) => condition.id === "R4"));
	});
});

describe("R5 - source imbalance", () => {
	it("fires when every paper came from one source", () => {
		const fired = detectConditions(trace({ evidence: [{ paperId: "p0", sources: ["arxiv"] }] }));
		const r5 = fired.find((condition) => condition.id === "R5");
		assert.ok(r5);
		assert.match(r5.observation, /arxiv/);
	});

	it("fires when one source keeps failing", () => {
		const fired = detectConditions(
			trace({
				failures: Array.from({ length: 3 }, () => ({ source: "openalex", errorType: "rate_limit" })),
			}),
		);
		const r5 = fired.find((condition) => condition.id === "R5");
		assert.ok(r5);
		// "operational" is the distinction that decides the advice: a rate limit is
		// not a fact about the literature.
		assert.match(r5.observation, /operational/);
	});

	it("says nothing before any paper has been found", () => {
		const fired = detectConditions(trace({ evidence: [] }));
		assert.ok(!fired.some((condition) => condition.id === "R5"));
	});
});

describe("R6 - fetching without ever re-reading", () => {
	it("does not fire once rank_candidates has been called", () => {
		const byTool = { search_metadata: 2, get_paper: 8, rank_candidates: 1 };
		const fired = detectConditions(trace({ budget: { totalCalls: 11, callsByTool: byTool }, calls: calls(byTool) }));
		assert.ok(!fired.some((condition) => condition.id === "R6"));
	});

	it("does not fire when fetching stays below the ratio", () => {
		const byTool = { search_metadata: 8, get_paper: 4 };
		const fired = detectConditions(trace({ budget: { totalCalls: 12, callsByTool: byTool }, calls: calls(byTool) }));
		assert.ok(!fired.some((condition) => condition.id === "R6"));
	});
});

describe("R7 - the soft budget", () => {
	it("fires at the configured ceiling and suggests stopping", () => {
		const fired = detectConditions(trace({ budget: { totalCalls: 40, callsByTool: { search_metadata: 40 } } }));
		const r7 = fired.find((condition) => condition.id === "R7");
		assert.equal(r7?.action, "stop");
	});
});

describe("every detector maps onto the fixed action space", () => {
	it("invents no action", () => {
		// A detector that could name a new action would put the advice outside the
		// space an effect can be attributed to.
		const allowed = new Set([
			"refine_query",
			"add_source",
			"expand_citation",
			"rerank",
			"increase_diversity",
			"check_constraint",
			"organize_answer",
			"stop",
		]);
		for (const condition of detectConditions(K9U1)) assert.ok(allowed.has(condition.action), condition.action);
	});
});

describe("jaccard", () => {
	it("is 1 for the same content words in a different order", () => {
		assert.equal(jaccard("active learning segmentation", "segmentation learning active"), 1);
	});

	it("is 0 for disjoint queries and for an empty one", () => {
		assert.equal(jaccard("superpixel", "annotation"), 0);
		assert.equal(jaccard("", "superpixel"), 0);
	});
});

describe("rendering the conditions", () => {
	it("presents them as measurements, not as instructions", () => {
		const rendered = renderConditions(detectConditions(K9U1));
		assert.match(rendered, /DETECTED CONDITIONS/);
		assert.match(rendered, /R1 -> suggests check_constraint/);
		assert.match(rendered, /measurements, not instructions/);
	});

	it("says so when nothing fired", () => {
		// An empty section reads as "no information"; saying nothing fired is
		// information, and it is what a `stop` verdict rests on.
		assert.match(renderConditions([]), /\(none/);
	});
});
