import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeXmlEntities, normalizeTitle, normalizeWhitespace, stripHtmlTags } from "../core/text.ts";

describe("decodeXmlEntities", () => {
	it("decodes numeric, hex, and named entities", () => {
		assert.equal(decodeXmlEntities("caf&#233; &#x2014; d&#233;j&#224; vu"), "café — déjà vu");
		assert.equal(decodeXmlEntities("&quot;a&quot; &lt;b&gt; &apos;c&apos;"), "\"a\" <b> 'c'");
	});

	it("decodes &amp; last so an escaped entity does not become markup", () => {
		// "&amp;lt;" is a literal "&lt;", not a "<". Decoding &amp; first would
		// turn it into "&lt;" and then into "<", inventing a tag.
		assert.equal(decodeXmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
	});

	it("leaves unknown entities alone", () => {
		assert.equal(decodeXmlEntities("a &nbsp; b &unknown;"), "a &nbsp; b &unknown;");
	});
});

describe("normalizeWhitespace", () => {
	it("collapses newlines and runs of spaces", () => {
		assert.equal(normalizeWhitespace("  a \n\n  b\tc  "), "a b c");
	});
});

describe("stripHtmlTags", () => {
	it("replaces tags with a space so adjacent words do not fuse", () => {
		assert.equal(stripHtmlTags("<p>Deep</p><p>Learning</p>"), "Deep Learning");
	});

	it("decodes entities after stripping", () => {
		assert.equal(stripHtmlTags("<span>Bengio &amp; LeCun</span>"), "Bengio & LeCun");
	});
});

describe("normalizeTitle", () => {
	it("ignores case, punctuation, and spacing", () => {
		assert.equal(normalizeTitle("Attention Is All You Need!"), normalizeTitle("attention   is-all,you   need"));
	});

	it("keeps digits, unlike pasa's keep_letters", () => {
		// pasa's keep_letters drops digits, so "GPT-3" and "GPT-4" collapse into
		// the same key and one paper resolves to the other. This is a deliberate
		// deviation from references/repos/pasa/utils.py:294.
		assert.notEqual(normalizeTitle("GPT-3 is few-shot"), normalizeTitle("GPT-4 is few-shot"));
		assert.equal(normalizeTitle("GPT-3 is few-shot"), "gpt3isfewshot");
	});
});
