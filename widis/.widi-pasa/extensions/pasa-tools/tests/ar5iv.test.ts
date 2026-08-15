import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAr5ivCitationMap } from "../core/ar5iv.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const recorded = readFileSync(join(fixtures, "ar5iv-2307.00235.html"), "utf8");

describe("parseAr5ivCitationMap", () => {
	it("extracts sections and their cited references from a recorded page", () => {
		const map = parseAr5ivCitationMap(recorded, "2307.00235");
		assert.ok(map, "the recorded page is a real conversion");
		assert.equal(map.arxivId, "2307.00235");
		// The guard that actually matters: a markup change that breaks the
		// heading or cite selectors yields zero sections rather than an error.
		assert.ok(map.sections.length > 0, "markup change would silently empty this");
		assert.ok(map.bibliographySize > 0);
	});

	it("gives every returned section a title and at least one reference", () => {
		const map = parseAr5ivCitationMap(recorded, "2307.00235");
		assert.ok(map);
		for (const section of map.sections) {
			assert.ok(section.title.trim().length > 0);
			assert.ok(section.references.length > 0);
			assert.equal(section.references.length, new Set(section.references).size);
			for (const reference of section.references) {
				assert.ok(reference.trim().length > 0);
				assert.doesNotMatch(reference, /<[a-z]/i, "references must be text, not markup");
			}
		}
	});

	it("returns reference strings, not parsed titles", () => {
		// pasa's own warning (utils.py:250) is that its title extraction is
		// unreliable and an LLM should read the raw string instead. Keeping the
		// full bibliography entry is what makes that possible.
		const map = parseAr5ivCitationMap(recorded, "2307.00235");
		assert.ok(map);
		const all = map.sections.flatMap((section) => section.references);
		assert.ok(
			all.some((reference) => reference.length > 60),
			"entries carry authors and venue, not just a title",
		);
	});

	it("rejects a page that is not an ar5iv conversion", () => {
		assert.equal(parseAr5ivCitationMap("<html><body>Not found</body></html>", "9999.99999"), null);
		assert.equal(parseAr5ivCitationMap("", "9999.99999"), null);
	});

	it("reports an empty section list when a conversion cites nothing", () => {
		const html =
			'<html><body class="ltx_document"><h2 class="ltx_title">1 Introduction</h2><p>No citations.</p></body></html>';
		const map = parseAr5ivCitationMap(html, "2101.00001");
		assert.deepEqual(map, { arxivId: "2101.00001", sections: [], bibliographySize: 0 });
	});

	it("drops a citation whose bibliography entry is missing", () => {
		const html = [
			'<html><body class="ltx_document">',
			'<h2 class="ltx_title">1 Related Work</h2>',
			'<a href="#bib.bib1">[1]</a><a href="#bib.bib99">[99]</a>',
			'<ul class="ltx_biblist"><li id="bib.bib1"><span>Doe, J. A paper. Venue, 2020.</span></li></ul>',
			"</body></html>",
		].join("");
		const map = parseAr5ivCitationMap(html, "2101.00001");
		assert.ok(map);
		assert.equal(map.sections.length, 1);
		assert.deepEqual(map.sections[0].references, ["Doe, J. A paper. Venue, 2020."]);
	});

	it("counts a paper cited twice in one section once", () => {
		const html = [
			'<html><body class="ltx_document">',
			'<h2 class="ltx_title">1 Related Work</h2>',
			'<a href="#bib.bib1">[1]</a> and again <a href="#bib.bib1">[1]</a>',
			'<ul class="ltx_biblist"><li id="bib.bib1"><span>Doe, J. A paper. Venue, 2020.</span></li></ul>',
			"</body></html>",
		].join("");
		const map = parseAr5ivCitationMap(html, "2101.00001");
		assert.equal(map?.sections[0].references.length, 1);
	});

	// Documented deviation from pasa: get_2nd_section folds subsection text into
	// its parent, so a citation in "2.1" is attributed to "2". Here headings are
	// flat, and a parent section spans only up to its first subsection heading.
	it("attributes a citation to its own subsection, not the parent", () => {
		const html = [
			'<html><body class="ltx_document">',
			'<h2 class="ltx_title">2 Method</h2><p>Overview with no citation.</p>',
			'<h3 class="ltx_title">2.1 Background</h3><a href="#bib.bib1">[1]</a>',
			'<ul class="ltx_biblist"><li id="bib.bib1"><span>Doe, J. A paper. Venue, 2020.</span></li></ul>',
			"</body></html>",
		].join("");
		const map = parseAr5ivCitationMap(html, "2101.00001");
		assert.ok(map);
		assert.deepEqual(
			map.sections.map((section) => section.title),
			["2.1 Background"],
		);
	});
});
