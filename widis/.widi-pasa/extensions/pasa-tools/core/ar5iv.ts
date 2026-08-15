/**
 * ar5iv full-text citation extraction, ported from pasa's
 * `search_section_by_arxiv_id` (references/repos/pasa/utils.py).
 *
 * pasa parsed the ar5iv HTML with BeautifulSoup and returned section ->
 * cited titles; its own warning notes those titles can be wrong and suggests
 * re-extracting them from the reference string. This port returns the raw
 * reference strings instead and leaves title extraction to the model, which
 * is exactly pasa's recommended workaround.
 */

import { normalizeArxivId } from "./arxiv.ts";
import { HttpStatusError, httpText } from "./http.ts";
import { stripHtmlTags } from "./text.ts";

const AR5IV_HTML_URL = "https://ar5iv.labs.arxiv.org/html";

export interface Ar5ivSection {
	title: string;
	references: string[];
}

export interface Ar5ivCitationMap {
	arxivId: string;
	sections: Ar5ivSection[];
	bibliographySize: number;
}

function parseBibliography(html: string): Map<string, string> {
	const bibliography = new Map<string, string>();
	for (const match of html.matchAll(/<li[^>]*id="(bib\.[^"]+)"[^>]*>([\s\S]*?)<\/li>/g)) {
		bibliography.set(match[1], stripHtmlTags(match[2]));
	}
	return bibliography;
}

/**
 * Map each section of an ar5iv page to the reference strings it cites.
 * Returns null for HTML that is not a real conversion.
 *
 * Kept separate from the fetch so the parser - the part that breaks silently
 * when ar5iv changes its markup - can be tested against recorded pages.
 */
export function parseAr5ivCitationMap(html: string, arxivId: string): Ar5ivCitationMap | null {
	// Real conversions always carry ar5iv's ltx markup; a page without it is an
	// error or redirect stub, mirroring pasa's validity check.
	if (!html.includes("ltx_")) {
		return null;
	}
	const bibliography = parseBibliography(html);
	const headings = [...html.matchAll(/<h[2-4][^>]*class="[^"]*ltx_title[^"]*"[^>]*>([\s\S]*?)<\/h[2-4]>/g)];
	const sections: Ar5ivSection[] = [];
	for (let index = 0; index < headings.length; index++) {
		const start = headings[index].index + headings[index][0].length;
		const end = index + 1 < headings.length ? headings[index + 1].index : html.length;
		const chunk = html.slice(start, end);
		const seen = new Set<string>();
		const references: string[] = [];
		for (const cite of chunk.matchAll(/<a[^>]*href="#(bib\.[^"]+)"[^>]*>/g)) {
			if (seen.has(cite[1])) {
				continue;
			}
			seen.add(cite[1]);
			const reference = bibliography.get(cite[1]);
			if (reference) {
				references.push(reference);
			}
		}
		if (references.length > 0) {
			sections.push({ title: stripHtmlTags(headings[index][1]), references });
		}
	}
	return { arxivId, sections, bibliographySize: bibliography.size };
}

/**
 * Fetch the ar5iv rendering of a paper and map each section to the reference
 * strings it cites. Returns null when the paper has no usable ar5iv HTML
 * (not converted yet, or ar5iv served an error page); network failures throw.
 */
export async function fetchAr5ivCitationMap(arxivId: string, signal?: AbortSignal): Promise<Ar5ivCitationMap | null> {
	const normalizedId = normalizeArxivId(arxivId);
	let html: string;
	try {
		html = await httpText(`${AR5IV_HTML_URL}/${normalizedId}`, { signal, timeoutMs: 45_000 });
	} catch (error) {
		if (error instanceof HttpStatusError && error.status === 404) {
			return null;
		}
		throw error;
	}
	return parseAr5ivCitationMap(html, normalizedId);
}
