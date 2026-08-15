/**
 * pasa-tools: WIDI Core-half extension porting the retrieval primitives of
 * pasa (references/repos/pasa) into model-callable tools:
 *
 *   pasa_search         serper Google search pinned to site:arxiv.org
 *   pasa_fetch_paper    arXiv API metadata by arXiv ID (batch)
 *   pasa_resolve_title  arXiv API title search, for citation entity resolution
 *   pasa_expand_refs    ar5iv full text -> section -> cited reference strings
 *
 * The retrieval logic lives in `core/` as pure functions with explicit
 * inputs/outputs; this file only adapts them to the WIDI tool contract.
 * Parameter schemas are hand-written JSON Schema: jiti cannot resolve a bare
 * "typebox" import from widis/, and WIDI treats the schema as plain JSON
 * Schema (typebox's TSchema is structurally empty in the pinned version).
 */

import {
	EXTENSION_API_VERSION,
	type ExtensionDefinition,
} from "../../../../packages/widi/apps/widi/src/core/extension/api.ts";
import { fetchAr5ivCitationMap } from "./core/ar5iv.ts";
import { type ArxivPaper, fetchPapersByArxivId, resolveArxivByTitle } from "./core/arxiv.ts";
import { searchArxivViaSerper } from "./core/serper.ts";

const MAX_SNIPPET_CHARS = 200;
const MAX_ABSTRACT_CHARS = 1_500;
const MAX_FETCH_OUTPUT_CHARS = 12_000;
const MAX_REFERENCE_CHARS = 300;
const MAX_EXPAND_SECTIONS = 20;
const MAX_EXPAND_REFERENCES_PER_SECTION = 15;
const MAX_EXPAND_OUTPUT_CHARS = 8_000;

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function readParams<T>(params: unknown): T {
	return params as T;
}

function formatPaper(paper: ArxivPaper, index: number): string {
	const authors = paper.authors.slice(0, 5).join(", ") + (paper.authors.length > 5 ? " et al." : "");
	return [
		`${index + 1}. ${paper.title}`,
		`   arXiv: ${paper.arxivId} | published: ${paper.published} | category: ${paper.primaryCategory}`,
		`   authors: ${authors}`,
		`   abs: ${paper.absUrl} | pdf: ${paper.pdfUrl || "n/a"}`,
		`   abstract: ${truncate(paper.abstract, MAX_ABSTRACT_CHARS)}`,
	].join("\n");
}

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => {
		api.registerTool({
			name: "pasa_search",
			label: "PASA Search",
			description:
				"Search Google via serper.dev for arXiv papers matching a query (restricted to site:arxiv.org). " +
				"This is the initial recall step of pasa-style literature search. Returns candidate arXiv IDs with " +
				"titles and snippets; use pasa_fetch_paper to get abstracts for the candidates. " +
				"end_date is mandatory: it is the research question's date boundary, and every search must respect it.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query; 'site:arxiv.org' is appended automatically." },
					num: { type: "integer", minimum: 1, maximum: 20, description: "Max results to request (default 10)." },
					end_date: {
						type: "string",
						description:
							"Upper date bound, as YYYYMMDD or YYYY-MM-DD. Required: results are restricted to papers " +
							"published before it. Use the date boundary given with the research question.",
					},
				},
				required: ["query", "end_date"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ query: string; num?: number; end_date: string }>(params);
				// The schema marks end_date required, but nothing validates tool
				// arguments at runtime, so an omitted bound would otherwise reach
				// normalizeEndDate as undefined and fail with an unreadable TypeError.
				if (typeof input.end_date !== "string" || input.end_date.trim() === "") {
					throw new Error("pasa_search requires end_date: pass the date boundary of the research question.");
				}
				const hits = await searchArxivViaSerper({
					query: input.query,
					num: input.num ?? 10,
					endDate: input.end_date,
					workspaceCwd: context.workspace.cwd,
					signal: context.signal ?? undefined,
				});
				if (hits.length === 0) {
					const text = `No arXiv results for query "${input.query}". Try rephrasing or broadening the query.`;
					return { content: [{ type: "text", text }], details: { hits: [] } };
				}
				const lines = hits.map(
					(hit, index) =>
						`${index + 1}. arXiv:${hit.arxivId} — ${hit.title}\n   ${truncate(hit.snippet, MAX_SNIPPET_CHARS)}`,
				);
				const text = `Found ${hits.length} arXiv candidates:\n${lines.join("\n")}`;
				return { content: [{ type: "text", text }], details: { hits } };
			},
		});

		api.registerTool({
			name: "pasa_fetch_paper",
			label: "PASA Fetch Paper",
			description:
				"Fetch metadata (title, authors, abstract, published date, links) for one or more arXiv papers " +
				"via the arXiv API. Use after pasa_search to inspect candidates, or with IDs from pasa_resolve_title.",
			parameters: {
				type: "object",
				properties: {
					arxiv_ids: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						maxItems: 10,
						description: "ArXiv IDs, e.g. ['2106.12345']; version suffixes (v2) are stripped.",
					},
				},
				required: ["arxiv_ids"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ arxiv_ids: string[] }>(params);
				const { papers, missingIds } = await fetchPapersByArxivId(input.arxiv_ids, context.signal ?? undefined);
				if (papers.length === 0) {
					const text = `No papers found for: ${input.arxiv_ids.join(", ")}. Check the arXiv IDs.`;
					return { content: [{ type: "text", text }], details: { papers: [], missingIds } };
				}
				let text = papers.map(formatPaper).join("\n\n");
				if (missingIds.length > 0) {
					text += `\n\nNot found: ${missingIds.join(", ")}`;
				}
				if (text.length > MAX_FETCH_OUTPUT_CHARS) {
					text = `${text.slice(0, MAX_FETCH_OUTPUT_CHARS)}\n[truncated]`;
				}
				return { content: [{ type: "text", text }], details: { papers, missingIds } };
			},
		});

		api.registerTool({
			name: "pasa_resolve_title",
			label: "PASA Resolve Title",
			description:
				"Resolve a paper title (e.g. one extracted from a citation by pasa_expand_refs) to arXiv candidates " +
				"via the arXiv API. Each candidate carries an exact_title_match flag; only trust exact matches " +
				"blindly, otherwise verify with pasa_fetch_paper.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "Paper title to resolve." },
					max_results: {
						type: "integer",
						minimum: 1,
						maximum: 10,
						description: "Max candidates to return (default 5).",
					},
				},
				required: ["title"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ title: string; max_results?: number }>(params);
				const candidates = await resolveArxivByTitle(input.title, input.max_results ?? 5, context.signal ?? undefined);
				if (candidates.length === 0) {
					const text = `No arXiv match for title "${input.title}". The paper may not be on arXiv.`;
					return { content: [{ type: "text", text }], details: { candidates: [] } };
				}
				const lines = candidates.map(
					(candidate, index) =>
						`${index + 1}. arXiv:${candidate.arxivId} — ${candidate.title}` +
						` [exact_title_match=${candidate.exactTitleMatch}] (${candidate.published})`,
				);
				const text = `Title candidates for "${input.title}":\n${lines.join("\n")}`;
				return { content: [{ type: "text", text }], details: { candidates } };
			},
		});

		api.registerTool({
			name: "pasa_expand_refs",
			label: "PASA Expand References",
			description:
				"Expand one hop of the citation graph: fetch a paper's full text from ar5iv and return, per section, " +
				"the reference strings it cites. This is pasa's Expand primitive. Pick relevant references, extract " +
				"their titles, then resolve them with pasa_resolve_title. Returns an 'unavailable' result when the " +
				"paper has no ar5iv HTML.",
			parameters: {
				type: "object",
				properties: {
					arxiv_id: { type: "string", description: "ArXiv ID of the paper to expand, e.g. '2106.12345'." },
				},
				required: ["arxiv_id"],
			},
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();
				const input = readParams<{ arxiv_id: string }>(params);
				const map = await fetchAr5ivCitationMap(input.arxiv_id, context.signal ?? undefined);
				if (!map) {
					const text =
						`Full text for arXiv:${input.arxiv_id} is not available on ar5iv ` +
						"(not converted or conversion failed); references cannot be expanded for this paper.";
					return { content: [{ type: "text", text }], details: { available: false } };
				}
				if (map.sections.length === 0) {
					const text =
						`ar5iv full text for arXiv:${map.arxivId} was fetched (bibliography: ${map.bibliographySize} entries) ` +
						"but no section-level citations could be extracted.";
					return { content: [{ type: "text", text }], details: { available: true, ...map } };
				}
				const blocks: string[] = [];
				for (const section of map.sections.slice(0, MAX_EXPAND_SECTIONS)) {
					const references = section.references
						.slice(0, MAX_EXPAND_REFERENCES_PER_SECTION)
						.map((reference) => `  - ${truncate(reference, MAX_REFERENCE_CHARS)}`);
					const omitted = section.references.length - references.length;
					blocks.push(`## ${section.title}\n${references.join("\n")}${omitted > 0 ? `\n  ... ${omitted} more` : ""}`);
				}
				let text =
					`Section citations for arXiv:${map.arxivId} (bibliography: ${map.bibliographySize} entries):\n\n` +
					blocks.join("\n\n");
				if (text.length > MAX_EXPAND_OUTPUT_CHARS) {
					text = `${text.slice(0, MAX_EXPAND_OUTPUT_CHARS)}\n[truncated]`;
				}
				return { content: [{ type: "text", text }], details: { available: true, ...map } };
			},
		});
	},
};

export default extension;
