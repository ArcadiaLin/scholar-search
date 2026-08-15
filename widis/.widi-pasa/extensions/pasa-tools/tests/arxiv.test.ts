import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeArxivId, parseAtomEntries } from "../core/arxiv.ts";
import { normalizeTitle } from "../core/text.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("normalizeArxivId", () => {
	it("strips the prefix, the version, and surrounding space", () => {
		assert.equal(normalizeArxivId("  arXiv:2501.10120v3 "), "2501.10120");
		assert.equal(normalizeArxivId("ARXIV:2501.10120"), "2501.10120");
		assert.equal(normalizeArxivId("2501.10120"), "2501.10120");
	});

	it("does not mistake a trailing digit group for a version", () => {
		assert.equal(normalizeArxivId("2501.10120v10"), "2501.10120");
		assert.equal(normalizeArxivId("hep-th/9901001"), "hep-th/9901001");
	});
});

describe("parseAtomEntries", () => {
	it("parses every entry of a recorded id_list feed", () => {
		const papers = parseAtomEntries(read("arxiv-id-list.xml"));
		assert.equal(papers.length, 2);
		const byId = new Map(papers.map((paper) => [paper.arxivId, paper]));

		const pasa = byId.get("2501.10120");
		assert.ok(pasa, "2501.10120 must be present");
		assert.equal(pasa.title, "PaSa: An LLM Agent for Comprehensive Academic Paper Search");
		assert.equal(pasa.published, "2025-01-17");
		assert.ok(pasa.abstract.length > 100);
		assert.ok(pasa.authors.length > 0);
		assert.equal(pasa.absUrl, "https://arxiv.org/abs/2501.10120");
		assert.match(pasa.pdfUrl, /arxiv\.org/);
		assert.ok(pasa.primaryCategory.length > 0);
	});

	it("normalizes multi-line titles and abstracts to one line", () => {
		for (const paper of parseAtomEntries(read("arxiv-id-list.xml"))) {
			assert.doesNotMatch(paper.title, /\s{2,}|\n/);
			assert.doesNotMatch(paper.abstract, /\s{2,}|\n/);
		}
	});

	// arXiv answers an unknown id with 200 and an empty feed rather than 404,
	// so "not found" only ever shows up as a missing entry.
	it("returns nothing for an empty feed", () => {
		assert.deepEqual(parseAtomEntries(read("arxiv-empty-feed.xml")), []);
	});

	it("returns nothing for a body that is not a feed", () => {
		assert.deepEqual(parseAtomEntries("<html><body>503 Service Unavailable</body></html>"), []);
		assert.deepEqual(parseAtomEntries(""), []);
	});

	it("skips an entry with no id instead of emitting a blank paper", () => {
		const xml =
			"<feed><entry><title>Orphan</title></entry><entry><id>http://arxiv.org/abs/2101.00001v1</id></entry></feed>";
		const papers = parseAtomEntries(xml);
		assert.equal(papers.length, 1);
		assert.equal(papers[0].arxivId, "2101.00001");
	});

	it("leaves optional fields empty rather than undefined", () => {
		const papers = parseAtomEntries("<feed><entry><id>http://arxiv.org/abs/2101.00001v1</id></entry></feed>");
		assert.deepEqual(papers[0], {
			arxivId: "2101.00001",
			title: "",
			authors: [],
			abstract: "",
			published: "",
			primaryCategory: "",
			absUrl: "https://arxiv.org/abs/2101.00001",
			pdfUrl: "",
		});
	});
});

describe("title resolution", () => {
	it("finds an exact title match in a recorded title search", () => {
		const wanted = "Multivariate Time-series Anomaly Detection via Graph Attention Network";
		const papers = parseAtomEntries(read("arxiv-title-search.xml"));
		assert.ok(papers.length > 0);
		const exact = papers.filter((paper) => normalizeTitle(paper.title) === normalizeTitle(wanted));
		assert.equal(exact.length, 1);
		assert.equal(exact[0].arxivId, "2009.02040");
	});

	// A near miss must not normalize to the same key: subtitle, different year,
	// or a different model size are exactly how a citation resolves to the wrong
	// paper, and only the exact comparison catches them.
	it("separates a near-miss title from the real one", () => {
		const wanted = normalizeTitle("Multivariate Time-series Anomaly Detection via Graph Attention Network");
		for (const near of [
			"Multivariate Time-series Anomaly Detection via Graph Attention Networks",
			"Multivariate Time-series Anomaly Detection via Graph Attention Network: A Survey",
			"Univariate Time-series Anomaly Detection via Graph Attention Network",
		]) {
			assert.notEqual(normalizeTitle(near), wanted, `${near} must not match`);
		}
	});
});
