/**
 * arXiv API access, ported from pasa's `search_paper_by_arxiv_id` and
 * `search_arxiv_id_by_title` (references/repos/pasa/utils.py).
 *
 * pasa resolved papers through a local zip database with the arXiv API as
 * fallback; the database is not part of this repository, so the arXiv API is
 * the only source here. Title resolution uses the API's `ti:` search instead
 * of pasa's arxiv.org HTML scraping, which depended on page markup.
 */

import { httpText } from "./http.ts";
import { decodeXmlEntities, normalizeTitle, normalizeWhitespace } from "./text.ts";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";

export interface ArxivPaper {
	arxivId: string;
	title: string;
	authors: string[];
	abstract: string;
	published: string;
	primaryCategory: string;
	absUrl: string;
	pdfUrl: string;
}

export interface ArxivTitleCandidate extends ArxivPaper {
	exactTitleMatch: boolean;
}

export function normalizeArxivId(raw: string): string {
	return raw
		.trim()
		.replace(/^arXiv:/i, "")
		.replace(/v\d+$/, "");
}

function extractTag(xml: string, tag: string): string | undefined {
	return new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
}

export function parseAtomEntries(xml: string): ArxivPaper[] {
	const papers: ArxivPaper[] = [];
	for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const entry = match[1];
		const idTag = extractTag(entry, "id");
		if (!idTag) {
			continue;
		}
		const arxivId = normalizeArxivId(idTag.slice(idTag.lastIndexOf("/") + 1));
		const categoryMatch =
			/<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry) ?? /<category[^>]*term="([^"]+)"/.exec(entry);
		const pdfMatch =
			/<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(entry) ?? /<link[^>]*href="([^"]+)"[^>]*title="pdf"/.exec(entry);
		papers.push({
			arxivId,
			title: normalizeWhitespace(decodeXmlEntities(extractTag(entry, "title") ?? "")),
			authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((author) =>
				decodeXmlEntities(author[1].trim()),
			),
			abstract: normalizeWhitespace(decodeXmlEntities(extractTag(entry, "summary") ?? "")),
			published: extractTag(entry, "published")?.slice(0, 10) ?? "",
			primaryCategory: categoryMatch?.[1] ?? "",
			absUrl: `https://arxiv.org/abs/${arxivId}`,
			pdfUrl: pdfMatch?.[1] ?? "",
		});
	}
	return papers;
}

export async function fetchPapersByArxivId(
	arxivIds: string[],
	signal?: AbortSignal,
): Promise<{ papers: ArxivPaper[]; missingIds: string[] }> {
	const requested = [...new Set(arxivIds.map(normalizeArxivId).filter((id) => id.length > 0))];
	if (requested.length === 0) {
		return { papers: [], missingIds: [] };
	}
	const url = `${ARXIV_API_URL}?id_list=${requested.map(encodeURIComponent).join(",")}&max_results=${requested.length}`;
	const papers = parseAtomEntries(await httpText(url, { signal }));
	const found = new Set(papers.map((paper) => paper.arxivId));
	return { papers, missingIds: requested.filter((id) => !found.has(id)) };
}

export async function resolveArxivByTitle(
	title: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<ArxivTitleCandidate[]> {
	// Quotes would break the Lucene query string; the API treats the rest fine.
	const cleaned = normalizeWhitespace(title.replace(/"/g, " "));
	if (!cleaned) {
		return [];
	}
	let papers: ArxivPaper[] = [];
	for (const field of ["ti", "all"]) {
		const query = encodeURIComponent(`${field}:"${cleaned}"`);
		const url = `${ARXIV_API_URL}?search_query=${query}&start=0&max_results=${maxResults}&sortBy=relevance`;
		papers = parseAtomEntries(await httpText(url, { signal }));
		if (papers.length > 0) {
			break;
		}
	}
	const wanted = normalizeTitle(title);
	return papers.map((paper) => ({ ...paper, exactTitleMatch: normalizeTitle(paper.title) === wanted }));
}
