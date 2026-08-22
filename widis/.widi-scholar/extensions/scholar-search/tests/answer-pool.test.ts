/**
 * The answer pool as a recorder.
 *
 * What these tests check is the property `docs/develop/plan.md` §3.7 asks for and
 * only that: the pool is a *reliable record* of what the agent committed to. They
 * deliberately do not check whether the agent uses it well - what it puts in, when,
 * or what it misses. That is the P axis's subject, and conflating the two would
 * make a green suite here look like evidence about search quality.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnswerPool, renderPoolSummary } from "../core/answer-pool.ts";

let tick = 0;
function pool(options: { maxPapers?: number } = {}) {
	tick = 0;
	return createAnswerPool({
		agentId: "search-test",
		now: () => `2026-08-21T00:00:${String(tick++).padStart(2, "0")}Z`,
		...options,
	});
}

function paper(canonicalId: string | null, paperId: string, title = "A Paper") {
	return { canonicalId, paperId, title, arxivId: null, doi: null, openalexId: null, authors: ["X"], year: 2020 };
}

describe("the pool records what the agent committed to", () => {
	it("keys an entry by the identity the service computed", () => {
		const store = pool();
		const result = store.add(paper("arxiv:1810.09726", "1810.09726"), "region-based AL", "call-1");

		assert.equal(result.outcome, "added");
		assert.equal(result.entry.canonicalId, "arxiv:1810.09726");
		// The identifier the agent cited is kept too, so its own reference resolves.
		assert.equal(result.entry.paperId, "1810.09726");
		assert.equal(store.size(), 1);
	});

	it("records the call that added each paper", () => {
		// Without this the pool cannot answer "which search found this", which is
		// exactly the provenance question the pool exists to make answerable
		// (`plan.md` §3.3).
		const store = pool();
		store.add(paper("arxiv:1", "1"), "why", "call-7");
		assert.equal(store.snapshot().papers[0]?.addedByToolCall, "call-7");
	});

	it("collapses two identifiers for one paper into one entry", () => {
		// The acceptance criterion `plan.md` §3.7.2 states: the same paper added
		// under two ids must appear once. The pool relies on the service having
		// resolved both to one canonical id - it does not re-derive identity.
		const store = pool();
		store.add(paper("arxiv:1810.09726", "1810.09726"), "found via arXiv", "call-1");
		const second = store.add(
			paper("arxiv:1810.09726", "https://doi.org/10.48550/arxiv.1810.09726"),
			"found again via OpenAlex",
			"call-2",
		);

		assert.equal(second.outcome, "updated");
		assert.equal(store.size(), 1);
		const entry = store.snapshot().papers[0];
		// The later judgement is the current one; the provenance stays with the call
		// that first committed to the paper.
		assert.equal(entry?.why, "found again via OpenAlex");
		assert.equal(entry?.addedByToolCall, "call-1");
	});

	it("falls back to the agent's own identifier when the service resolved none", () => {
		// A paper the service cannot resolve is still the agent's answer. Losing it
		// would be worse than keeping it under an unnormalised key.
		const store = pool();
		const result = store.add(paper(null, "some-preprint-handle"), "why", "call-1");
		assert.equal(result.entry.canonicalId, "some-preprint-handle");
	});

	it("refuses to grow without bound, and says what to do instead", () => {
		const store = pool({ maxPapers: 2 });
		store.add(paper("a", "a"), "why", "call-1");
		store.add(paper("b", "b"), "why", "call-1");

		assert.throws(() => store.add(paper("c", "c"), "why", "call-1"), /ceiling/);
		assert.equal(store.size(), 2);
		assert.equal(store.full(), true);
	});

	it("still accepts an update once full", () => {
		// The ceiling is on how many papers are committed, not on revising them.
		const store = pool({ maxPapers: 1 });
		store.add(paper("a", "a"), "first reading", "call-1");
		assert.equal(store.add(paper("a", "a"), "second reading", "call-2").outcome, "updated");
	});
});

describe("a withdrawal is evidence, not a deletion", () => {
	it("logs the reason, the call and the original addition", () => {
		// This pair is a negative example with a provenance, which is what
		// `docs/design.md` §6 requires of $NP^{judge}$ examples (`plan.md` §3.5).
		const store = pool();
		store.add(paper("arxiv:1", "1", "Off Topic"), "looked relevant", "call-1");
		const result = store.remove("arxiv:1", "not about active learning at all", "call-9");

		assert.equal(result.outcome, "removed");
		assert.equal(store.size(), 0);
		const removal = store.snapshot().removed[0];
		assert.equal(removal?.reason, "not about active learning at all");
		assert.equal(removal?.removedByToolCall, "call-9");
		assert.equal(removal?.addedByToolCall, "call-1");
		assert.equal(removal?.title, "Off Topic");
	});

	it("accepts whichever identifier the agent cited, not only the canonical one", () => {
		const store = pool();
		store.add(
			{ ...paper("arxiv:1810.09726", "1810.09726"), doi: "10.48550/arXiv.1810.09726" },
			"why",
			"call-1",
		);

		assert.equal(store.remove("10.48550/arXiv.1810.09726", "changed my mind", "call-2").outcome, "removed");
	});

	it("reports a withdrawal of something never committed as absent", () => {
		const store = pool();
		assert.equal(store.remove("arxiv:9", "reason", "call-1").outcome, "absent");
		assert.deepEqual(store.snapshot().removed, []);
	});

	it("lets a withdrawn paper be committed again, keeping the withdrawal on record", () => {
		const store = pool();
		store.add(paper("arxiv:1", "1"), "first", "call-1");
		store.remove("arxiv:1", "wrong", "call-2");
		store.add(paper("arxiv:1", "1"), "second thoughts", "call-3");

		const snapshot = store.snapshot();
		assert.equal(snapshot.papers.length, 1);
		assert.equal(snapshot.removed.length, 1, "the reversal is part of the record even after being reversed");
	});
});

describe("the pool's note and timestamps", () => {
	it("keeps the latest note and stamps every change", () => {
		const store = pool();
		store.add(paper("arxiv:1", "1"), "why", "call-1");
		store.setNote("covers superpixels; active learning still missing");
		store.setNote("covers both directions now");

		const snapshot = store.snapshot();
		assert.equal(snapshot.note, "covers both directions now");
		assert.equal(snapshot.papers[0]?.addedAt, "2026-08-21T00:00:00Z");
		assert.equal(snapshot.updatedAt, "2026-08-21T00:00:02Z");
	});

	it("has no timestamp before anything happens", () => {
		assert.equal(pool().snapshot().updatedAt, null);
	});
});

describe("reading the pool back", () => {
	it("returns counts, ids and titles rather than records", () => {
		// A read that returned whole entries would put the pool back into the context
		// on every call, which is the growth the summary views exist to prevent
		// (`plan.md` §3.6, first point).
		const store = pool();
		store.add({ ...paper("arxiv:1", "1", "CEREALS"), authors: ["A", "B"] }, "the opening work", "call-1");
		const rendered = renderPoolSummary(store.snapshot());

		assert.match(rendered, /1 paper\(s\) committed, 0 withdrawn/);
		assert.match(rendered, /arxiv:1 :: CEREALS/);
		assert.ok(!rendered.includes("the opening work"), "the summary is a citation view, not the entries");
	});

	it("says an empty pool means no scorable answer", () => {
		assert.match(renderPoolSummary(pool().snapshot()), /empty/);
	});

	it("bounds the list and says how much it left out", () => {
		const store = pool();
		for (let index = 0; index < 10; index += 1) store.add(paper(`arxiv:${index}`, `${index}`), "why", "call-1");
		assert.match(renderPoolSummary(store.snapshot(), { maxListed: 3 }), /7 more not listed/);
	});
});
