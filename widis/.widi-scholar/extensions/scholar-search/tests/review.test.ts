/**
 * The advice gate, and what the Reviewer is allowed to see.
 *
 * `docs/design.md` §5.2 lists what the gate must do; each item here is one of
 * those. The gate is the reason "the sidecar helped" can be told apart from "the
 * sidecar talked a lot": without the caps and the dedup, a Reviewer can fill
 * Main's context with restatements and every measurement of its contribution
 * becomes a measurement of its verbosity.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADVICE_ACTIONS, createAdviceGate, renderTraceForReviewer } from "../core/review.ts";

const trace = { evidenceIds: new Set(["10.1/a", "10.1/b", "call-1"]) };

function advice(overrides: Record<string, unknown> = {}) {
	return {
		action: "refine_query",
		target: "subquery 2",
		instructions: "Narrow it: it is pulling in the adjacent applications field.",
		evidence_ids: ["10.1/a"],
		confidence: 0.7,
		expected_effect: "the 2019-2021 gap should fill",
		novelty_key: "subquery-2-too-broad",
		...overrides,
	};
}

describe("the action space is closed", () => {
	it("admits an action from the fixed set", () => {
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice(), trace).admitted, true);
	});

	it("refuses an action outside the set and names the set", () => {
		// A fixed action space is what makes an effect attributable to a piece of
		// advice; an open one turns advice into freeform text.
		const gate = createAdviceGate();
		const result = gate.admit(advice({ action: "rewrite_everything" }), trace);

		assert.equal(result.admitted, false);
		assert.equal(result.refusal, "unknown_action");
		assert.match(result.reason ?? "", /refine_query/);
	});

	it("declares exactly the seven documented actions", () => {
		assert.deepEqual(
			[...ADVICE_ACTIONS],
			["refine_query", "add_source", "expand_citation", "rerank", "increase_diversity", "check_constraint", "stop"],
		);
	});
});

describe("evidence must exist in the trace", () => {
	it("refuses advice citing an id the search never produced", () => {
		// Either a hallucination or a reference to another run. Both are
		// unattributable, so neither may reach Main.
		const gate = createAdviceGate();
		const result = gate.admit(advice({ evidence_ids: ["10.1/never-seen"] }), trace);

		assert.equal(result.admitted, false);
		assert.equal(result.refusal, "unknown_evidence");
		assert.match(result.reason ?? "", /10\.1\/never-seen/);
	});

	it("accepts a tool-call id as evidence", () => {
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice({ evidence_ids: ["call-1"] }), trace).admitted, true);
	});

	it("allows advice with no evidence, but the field must still be honest", () => {
		// Some advice is about absence - a facet nobody searched - and has no id to
		// cite. That is legitimate; inventing an id to look rigorous is not.
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice({ evidence_ids: [] }), trace).admitted, true);
	});
});

describe("deduplication", () => {
	it("refuses a repeated novelty key", () => {
		const gate = createAdviceGate();
		gate.admit(advice(), trace);
		const result = gate.admit(advice({ target: "different target" }), trace);

		assert.equal(result.refusal, "duplicate_novelty_key");
	});

	it("refuses the same action on the same target under a new key", () => {
		// The novelty key is self-reported, so it cannot be the only defence:
		// renaming the key must not get the same suggestion through twice.
		const gate = createAdviceGate();
		gate.admit(advice(), trace);
		const result = gate.admit(advice({ novelty_key: "a-brand-new-key" }), trace);

		assert.equal(result.refusal, "duplicate_action_target");
	});

	it("admits the same action on a different target", () => {
		const gate = createAdviceGate();
		gate.admit(advice(), trace);
		const result = gate.admit(advice({ target: "subquery 3", novelty_key: "subquery-3-too-broad" }), trace);

		assert.equal(result.admitted, true);
	});
});

describe("no-action advice", () => {
	it("admits one stop", () => {
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice({ action: "stop", novelty_key: "looks-done" }), trace).admitted, true);
	});

	it("refuses a second stop", () => {
		// §5.2: repeated no-action advice must be dropped or merged. One `stop` is a
		// judgement; a second is noise in Main's context.
		const gate = createAdviceGate();
		gate.admit(advice({ action: "stop", target: "run", novelty_key: "looks-done" }), trace);
		const result = gate.admit(advice({ action: "stop", target: "other", novelty_key: "still-done" }), trace);

		assert.equal(result.refusal, "repeated_no_action");
	});
});

describe("budget", () => {
	it("caps advice per episode", () => {
		const gate = createAdviceGate({ maxPerEpisode: 2, maxPerAction: 99 });
		for (const index of [1, 2]) {
			assert.equal(gate.admit(advice({ target: `t${index}`, novelty_key: `k${index}` }), trace).admitted, true);
		}
		const result = gate.admit(advice({ target: "t3", novelty_key: "k3" }), trace);

		assert.equal(result.refusal, "episode_cap_reached");
		assert.equal(gate.admitted().length, 2);
	});

	it("caps repeats of one action", () => {
		const gate = createAdviceGate({ maxPerAction: 1 });
		gate.admit(advice({ target: "t1", novelty_key: "k1" }), trace);
		const result = gate.admit(advice({ target: "t2", novelty_key: "k2" }), trace);

		assert.equal(result.refusal, "action_cap_reached");
	});

	it("does not spend a novelty key on advice the cap refused", () => {
		// The over-cap suggestion may be legitimate next episode, so refusing it
		// must not also burn its key.
		const gate = createAdviceGate({ maxPerEpisode: 1, maxPerAction: 99 });
		gate.admit(advice({ target: "t1", novelty_key: "k1" }), trace);
		const overCap = gate.admit(advice({ target: "t2", novelty_key: "k2" }), trace);
		assert.equal(overCap.refusal, "episode_cap_reached");

		const fresh = createAdviceGate();
		assert.equal(fresh.admit(advice({ target: "t2", novelty_key: "k2" }), trace).admitted, true);
	});
});

describe("required fields", () => {
	it("refuses advice with no instructions", () => {
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice({ instructions: "  " }), trace).refusal, "missing_fields");
	});

	it("refuses advice with no novelty key", () => {
		const gate = createAdviceGate();
		assert.equal(gate.admit(advice({ novelty_key: "" }), trace).refusal, "missing_fields");
	});

	it("refuses a non-object", () => {
		const gate = createAdviceGate();
		for (const bad of [null, undefined, 42, "advice", []]) {
			assert.equal(gate.admit(bad, trace).admitted, false);
		}
	});
});

describe("the gate keeps a record", () => {
	it("records every refusal with its reason", () => {
		// A silently dropped suggestion is indistinguishable from one never made,
		// which would make the sidecar's contribution unmeasurable.
		const gate = createAdviceGate();
		gate.admit(advice({ action: "nonsense" }), trace);
		gate.admit(advice({ evidence_ids: ["nope"] }), trace);

		const refusals = gate.refusals();
		assert.equal(refusals.length, 2);
		assert.deepEqual(
			refusals.map((entry) => entry.refusal),
			["unknown_action", "unknown_evidence"],
		);
		assert.ok(refusals.every((entry) => entry.reason.length > 0));
	});
});

describe("what the Reviewer is shown", () => {
	const fullTrace = {
		subqueries: ["message passing", "QM9 benchmark"],
		calls: [
			{
				toolCallId: "call-1",
				toolName: "search_metadata",
				args: { query: "gnn", end_date: "2023-12-31" },
				failed: false,
				errorMessage: undefined,
			},
			{
				toolCallId: "call-2",
				toolName: "provider_query",
				args: { provider: "openalex" },
				failed: true,
				errorMessage: "bogus_field is not a valid field",
			},
		],
		evidence: [{ paperId: "10.1/a", title: "A Paper", foundBy: "call-1" }],
		budget: { totalCalls: 2, failedCalls: 1, callsByTool: { search_metadata: 1, provider_query: 1 } },
		candidateCounts: { recalled: 120, returned: 20 },
		failures: [{ source: "arxiv", errorType: "timeout", message: "arXiv timed out" }],
	};

	it("shows the queries, the counts, the failures and the citable ids", () => {
		const rendered = renderTraceForReviewer(fullTrace);

		assert.match(rendered, /message passing/);
		assert.match(rendered, /120 recalled, 20 returned/);
		assert.match(rendered, /arxiv \[timeout\]/);
		assert.match(rendered, /10\.1\/a :: A Paper/);
		assert.match(rendered, /call-2 provider_query FAILED/);
	});

	it("cannot show what the trace does not carry", () => {
		// The rendering is built from the trace object alone, so no wording in the
		// Reviewer's prompt can conjure the Main Agent's reasoning: it is not there
		// to be rendered.
		const rendered = renderTraceForReviewer({
			...fullTrace,
			// A caller trying to smuggle reasoning in through an extra field.
			...({ thinking: "the model privately believed X" } as unknown as Record<string, never>),
		});

		assert.ok(!rendered.includes("privately believed"));
	});

	it("bounds what it renders and says so", () => {
		const many = {
			...fullTrace,
			calls: Array.from({ length: 100 }, (_, index) => ({
				toolCallId: `c${index}`,
				toolName: "search_metadata",
				args: {},
				failed: false,
				errorMessage: undefined,
			})),
		};
		const rendered = renderTraceForReviewer(many, { maxCalls: 5 });

		assert.match(rendered, /95 more call\(s\) not shown/);
	});
});
