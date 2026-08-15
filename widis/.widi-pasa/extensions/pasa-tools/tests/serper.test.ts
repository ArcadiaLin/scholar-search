import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArxivSearchQuery, normalizeEndDate, parseSerperArxivHits } from "../core/serper.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const recorded = readFileSync(join(fixtures, "serper-search.json"), "utf8");

describe("normalizeEndDate", () => {
	it("accepts both pasa's compact form and ISO", () => {
		assert.equal(normalizeEndDate("20231024"), "2023-10-24");
		assert.equal(normalizeEndDate("2023-10-24"), "2023-10-24");
		assert.equal(normalizeEndDate("  20231024  "), "2023-10-24");
	});

	// pasa silently dropped the bound on a bad date (utils.py:43-47), which
	// turns a bounded query into an unbounded one and recalls papers published
	// after the query date. That failure is invisible in the results, so it has
	// to be loud here.
	for (const bad of ["", "2023", "10-24-2023", "20231024x", "last year"]) {
		it(`refuses ${JSON.stringify(bad)} instead of dropping the bound`, () => {
			assert.throws(() => normalizeEndDate(bad), /end_date must be/);
		});
	}
});

describe("buildArxivSearchQuery", () => {
	it("always pins the site and the date bound", () => {
		assert.equal(
			buildArxivSearchQuery("  graph anomaly detection ", "20231024"),
			"graph anomaly detection before:2023-10-24 site:arxiv.org",
		);
	});

	it("cannot produce an unbounded query", () => {
		assert.throws(() => buildArxivSearchQuery("q", "whenever"));
	});
});

describe("parseSerperArxivHits", () => {
	it("reduces a recorded response to unique arXiv hits", () => {
		const hits = parseSerperArxivHits(recorded);
		const ids = hits.map((hit) => hit.arxivId);
		assert.equal(ids.length, new Set(ids).size, "ids must be unique");
		assert.ok(ids.includes("2009.02040"));
		for (const hit of hits) {
			assert.match(hit.arxivId, /^\d{4}\.\d+$/);
			assert.ok(hit.title.length > 0);
		}
	});

	it("keeps the first occurrence when Google returns a paper twice", () => {
		const body = JSON.stringify({
			organic: [
				{ title: "First", link: "https://arxiv.org/abs/2009.02040", snippet: "a" },
				{ title: "Same paper, pdf url", link: "https://arxiv.org/pdf/2009.02040v2", snippet: "b" },
			],
		});
		const hits = parseSerperArxivHits(body);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].title, "First");
	});

	it("accepts abs, pdf and html urls and strips the version", () => {
		const body = JSON.stringify({
			organic: [
				{ link: "https://arxiv.org/abs/2101.00001" },
				{ link: "https://arxiv.org/pdf/2102.00002v3" },
				{ link: "https://arxiv.org/html/2103.00003v11" },
			],
		});
		assert.deepEqual(
			parseSerperArxivHits(body).map((hit) => hit.arxivId),
			["2101.00001", "2102.00002", "2103.00003"],
		);
	});

	it("drops results that are not arXiv papers", () => {
		const body = JSON.stringify({
			organic: [
				{ link: "https://openreview.net/forum?id=abc" },
				{ link: "https://arxiv.org/list/cs.LG/2301" },
				{ link: "https://blog.example.com/arxiv.org/abs/1234" },
			],
		});
		assert.deepEqual(parseSerperArxivHits(body), []);
	});

	it("tolerates a response with no organic block and items with no fields", () => {
		assert.deepEqual(parseSerperArxivHits(JSON.stringify({ credits: 1 })), []);
		assert.deepEqual(parseSerperArxivHits(JSON.stringify({ organic: [] })), []);
		const partial = parseSerperArxivHits(JSON.stringify({ organic: [{ link: "https://arxiv.org/abs/2104.00004" }] }));
		assert.deepEqual(partial, [
			{ arxivId: "2104.00004", title: "", link: "https://arxiv.org/abs/2104.00004", snippet: "" },
		]);
	});
});
