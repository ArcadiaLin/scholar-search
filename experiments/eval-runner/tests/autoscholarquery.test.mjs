/**
 * The AutoScholarQuery conversion, tested without the dataset.
 *
 * The dataset is gated upstream and not in this repository, so the records here
 * are written by hand from the shape `docs/develop/backlog.md` §0 quotes verbatim.
 * That is the one case where a hand-written fixture is right rather than a
 * shortcut (contrast `docs/develop/decisions.md` D-05): there is no file to record
 * from, and the alternative is no test at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, normalizeArxivId, toIsoDate, toQueryItem } from "../autoscholarquery.mjs";

/** The record `backlog.md` §0 quotes: train line 2, the session that started all this. */
const TRAIN_1 = {
	qid: "AutoScholarQuery_train_1",
	question:
		"Could you provide me some works employs image patches and superpixels in region-based methods for semantic segmentation?",
	answer: ["CEREALS", "Reinforced active learning", "MetaBox+", "ViewAL"],
	answer_arxiv_id: ["1810.09726", "2002.06583", "2010.01884", "1911.11789"],
	source_meta: { published_time: "20230917" },
};

describe("the date boundary", () => {
	it("maps published_time onto an ISO end date", () => {
		// Each question comes from the related-work section of a paper published on
		// that date, so a later paper cannot be a correct answer. Filling this in by
		// hand was the previous procedure (`backlog.md` F-5).
		assert.equal(toIsoDate("20230917"), "2023-09-17");
	});

	it("passes through a date that is already ISO, and a bare year", () => {
		assert.equal(toIsoDate("2023-09-17"), "2023-09-17");
		assert.equal(toIsoDate("2023"), "2023");
	});

	it("returns null rather than inventing a boundary", () => {
		for (const value of [undefined, null, "", "not a date", "202309"]) assert.equal(toIsoDate(value), null);
	});
});

describe("arXiv id normalization", () => {
	it("agrees on one form for every spelling the two sides use", () => {
		// The gold is bare ids; the answer pool may hold a version, a URL, or the
		// registered arXiv DOI. Matching requires one form.
		for (const spelling of [
			"1810.09726",
			"arXiv:1810.09726",
			"1810.09726v2",
			"https://arxiv.org/abs/1810.09726",
			"https://arxiv.org/pdf/1810.09726.pdf",
			"10.48550/arXiv.1810.09726",
		]) {
			assert.equal(normalizeArxivId(spelling), "1810.09726", spelling);
		}
	});

	it("returns null for something that is not an id", () => {
		assert.equal(normalizeArxivId(""), null);
		assert.equal(normalizeArxivId(undefined), null);
	});
});

describe("converting a record", () => {
	it("carries the question, the boundary and every gold id", () => {
		const item = toQueryItem(TRAIN_1);
		assert.equal(item.id, "AutoScholarQuery_train_1");
		assert.match(item.query, /superpixels in region-based methods/);
		assert.equal(item.endDate, "2023-09-17");
		assert.deepEqual(item.gold.arxivIds, ["1810.09726", "2002.06583", "2010.01884", "1911.11789"]);
		assert.equal(item.gold.titles.length, 4);
	});

	it("drops a record with no question", () => {
		assert.equal(toQueryItem({ qid: "x", question: "   " }), null);
	});

	it("keeps a record whose gold is missing, and reports it as empty", () => {
		// Not dropped: a query with no gold still runs, and the scorer reports it as
		// unscorable rather than quietly excluding it from the denominator.
		const item = toQueryItem({ qid: "x", question: "a question" });
		assert.deepEqual(item.gold.arxivIds, []);
	});
});

describe("converting a split", () => {
	const lines = [JSON.stringify(TRAIN_1), "", JSON.stringify({ ...TRAIN_1, qid: "second" }), "{not json"];

	it("skips blank and malformed lines and counts them", () => {
		const { items, skipped } = convert(lines);
		assert.equal(items.length, 2);
		assert.equal(skipped, 1);
	});

	it("selects by qid", () => {
		const { items } = convert(lines, { ids: ["second"] });
		assert.deepEqual(
			items.map((item) => item.id),
			["second"],
		);
	});

	it("honours a limit", () => {
		assert.equal(convert(lines, { limit: 1 }).items.length, 1);
	});

	it("gives a record with no qid a stable positional id", () => {
		const { items } = convert([JSON.stringify({ question: "q" })], { split: "dev" });
		assert.equal(items[0].id, "dev_0");
	});
});
