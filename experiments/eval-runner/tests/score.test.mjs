/**
 * Scoring a run from its answer pools.
 *
 * The properties worth pinning down are the ones that make a number honest rather
 * than flattering: a failed episode counts as a zero instead of vanishing, an
 * empty pool is distinguishable from a pool that was never written, and papers the
 * agent committed to that cannot be credited are reported rather than dropped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { arxivIdsOf, readPool, score, scoreOne } from "../score.mjs";

const GOLD = ["1810.09726", "2002.06583", "2010.01884", "1911.11789"];

function entry(overrides = {}) {
	return { canonicalId: "arxiv:1810.09726", paperId: "1810.09726", arxivId: "1810.09726", ...overrides };
}

function pool(papers, overrides = {}) {
	return { status: papers.length === 0 ? "empty" : "ok", papers, removed: [], ...overrides };
}

function result(overrides = {}) {
	return { id: "q1", agentId: "search-1", terminationStatus: "completed", elapsedMs: 1_000, gold: { arxivIds: GOLD }, ...overrides };
}

describe("reading an arXiv id off a pool entry", () => {
	it("accepts the several fields that may carry it", () => {
		assert.deepEqual(arxivIdsOf({ arxivId: "1810.09726v3" }), ["1810.09726"]);
		assert.deepEqual(arxivIdsOf({ canonicalId: "arxiv:1810.09726" }), ["1810.09726"]);
		assert.deepEqual(arxivIdsOf({ doi: "10.48550/arXiv.1810.09726" }), ["1810.09726"]);
		assert.deepEqual(arxivIdsOf({ paperId: "https://arxiv.org/abs/1810.09726" }), ["1810.09726"]);
	});

	it("finds nothing in an entry that is not an arXiv paper", () => {
		// Not an error: a DOI-only paper simply cannot be credited against an
		// arXiv-id gold, and that is a fact about the gold.
		assert.deepEqual(arxivIdsOf({ canonicalId: "doi:10.1007/abc", paperId: "10.1007/abc" }), []);
	});
});

describe("scoring one query", () => {
	it("counts hits, misses and precision", () => {
		const scored = scoreOne(result(), pool([entry(), entry({ arxivId: "9999.99999", canonicalId: "arxiv:9999.99999" })]), 20);

		assert.deepEqual(scored.hits, ["1810.09726"]);
		assert.equal(scored.goldSize, 4);
		assert.equal(scored.recall, 0.25);
		assert.equal(scored.precision, 0.5);
		assert.equal(scored.missed.length, 3);
	});

	it("scores a perfect pool as 1", () => {
		const papers = GOLD.map((id) => entry({ arxivId: id, canonicalId: `arxiv:${id}`, paperId: id }));
		const scored = scoreOne(result(), pool(papers), 20);
		assert.equal(scored.recall, 1);
		assert.equal(scored.precision, 1);
		assert.equal(scored.f1, 1);
	});

	it("truncates at k in the order the agent committed", () => {
		// The pool is a list the agent built; truncating in any other order would
		// score a ranking nobody produced.
		const papers = [
			entry({ arxivId: "9999.99999", canonicalId: "arxiv:9999.99999", paperId: "9999.99999" }),
			entry({ arxivId: "1810.09726", canonicalId: "arxiv:1810.09726", paperId: "1810.09726" }),
		];
		assert.equal(scoreOne(result(), pool(papers), 1).hits.length, 0);
		assert.equal(scoreOne(result(), pool(papers), 2).hits.length, 1);
	});

	it("scores an empty pool as zero rather than as absent", () => {
		const scored = scoreOne(result(), pool([]), 20);
		assert.equal(scored.recall, 0);
		assert.equal(scored.precision, 0);
		assert.equal(scored.f1, 0);
		assert.equal(scored.poolStatus, "empty");
	});

	it("reports committed papers that cannot be credited", () => {
		// Dropping them would overstate precision: the agent did commit to them.
		const scored = scoreOne(result(), pool([entry(), { canonicalId: "doi:10.1007/abc", paperId: "10.1007/abc" }]), 20);
		assert.equal(scored.unscorablePredictions, 1);
		assert.equal(scored.predictedSize, 1);
	});

	it("leaves recall undefined when there is no gold", () => {
		const scored = scoreOne(result({ gold: { arxivIds: [] } }), pool([entry()]), 20);
		assert.equal(scored.recall, null);
		assert.equal(scored.f1, null);
	});

	it("does not double-count one paper committed under two identifiers", () => {
		const papers = [entry(), entry({ paperId: "https://arxiv.org/abs/1810.09726" })];
		assert.equal(scoreOne(result(), pool(papers), 20).predictedSize, 1);
	});
});

describe("reading a pool off disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-"));

	it("tells a pool that was never written from one that is empty", () => {
		// Same zero, different diagnosis: one agent never called the tool, the other
		// called it and committed to nothing.
		assert.equal(readPool(dir, "missing-agent").status, "never-written");
		writeFileSync(join(dir, "empty-agent.answer.json"), JSON.stringify({ papers: [], removed: [] }));
		assert.equal(readPool(dir, "empty-agent").status, "empty");
	});

	it("reports an unreadable pool instead of scoring it as empty", () => {
		writeFileSync(join(dir, "broken-agent.answer.json"), "{not json");
		assert.equal(readPool(dir, "broken-agent").status, "unreadable");
	});

	it("reads papers, withdrawals and the note", () => {
		writeFileSync(
			join(dir, "good-agent.answer.json"),
			JSON.stringify({ papers: [entry()], removed: [{ canonicalId: "arxiv:1", reason: "off topic" }], note: "n" }),
		);
		const read = readPool(dir, "good-agent");
		assert.equal(read.status, "ok");
		assert.equal(read.papers.length, 1);
		assert.equal(read.removed.length, 1);
		assert.equal(read.note, "n");
	});
});

describe("scoring a run", () => {
	const dir = mkdtempSync(join(tmpdir(), "run-"));

	it("keeps a failed episode in the denominator", () => {
		// §5.3: failed requests are never silently excluded. A timeout that dropped
		// out of the average would make the average a statement about the successes.
		writeFileSync(
			join(dir, "a.answer.json"),
			JSON.stringify({ papers: GOLD.map((id) => entry({ arxivId: id, canonicalId: `arxiv:${id}`, paperId: id })) }),
		);
		const record = {
			results: [
				result({ id: "ok", agentId: "a" }),
				result({ id: "timeout", agentId: "b", terminationStatus: "timeout", ok: false }),
			],
		};

		const report = score(record, dir, 20);
		assert.equal(report.counts.queries, 2);
		assert.equal(report.counts.withGold, 2);
		assert.equal(report.macro.recallAtK, 0.5, "one perfect and one empty averages to 0.5, not to 1");
		assert.deepEqual(report.counts.byPoolStatus, { ok: 1, "never-written": 1 });
		assert.deepEqual(report.counts.byTermination, { completed: 1, timeout: 1 });
	});

	it("reports queries with no gold separately from scored ones", () => {
		const record = { results: [result({ id: "no-gold", agentId: "z", gold: { arxivIds: [] } })] };
		const report = score(record, dir, 20);
		assert.equal(report.counts.withGold, 0);
		assert.equal(report.counts.withoutGold, 1);
		assert.equal(report.macro.recallAtK, null);
	});
});
