/**
 * serper.dev Google search, ported from pasa's `google_search_arxiv_id`
 * (references/repos/pasa/utils.py). Queries are pinned to site:arxiv.org and
 * always carry pasa's `before:` time bound; results are reduced to arXiv IDs.
 *
 * The API key comes from SERPER_API_KEY in the process environment, falling
 * back to the workspace `.env` file (WIDI itself does not load dotenv).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpText } from "./http.ts";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const ARXIV_LINK_PATTERN = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d+)(?:v\d+)?/;

export interface SerperArxivHit {
	arxivId: string;
	title: string;
	link: string;
	snippet: string;
}

// Only the .env-derived key is cached: an exported env var is re-read every
// call so a changed process environment always wins.
let cachedEnvFileKey: string | undefined;

export async function resolveSerperApiKey(workspaceCwd: string): Promise<string> {
	const fromProcess = process.env.SERPER_API_KEY?.trim();
	if (fromProcess) {
		return fromProcess;
	}
	if (cachedEnvFileKey) {
		return cachedEnvFileKey;
	}
	try {
		const envFile = await readFile(join(workspaceCwd, ".env"), "utf8");
		for (const line of envFile.split("\n")) {
			const match = /^\s*SERPER_API_KEY\s*=\s*"?([^"\n]+?)"?\s*$/.exec(line);
			if (match?.[1]) {
				cachedEnvFileKey = match[1];
				return match[1];
			}
		}
	} catch {
		// No readable .env: fall through to the explicit error below.
	}
	throw new Error(
		"SERPER_API_KEY is not configured: export it in the environment or add it to the workspace .env file.",
	);
}

/**
 * The date bound is part of the evaluation contract, not a hint: a query that
 * silently loses it recalls papers published after the query date, which
 * inflates every downstream metric without failing anywhere. So an
 * unparseable bound throws rather than degrading to an unbounded search.
 */
export function normalizeEndDate(endDate: string): string {
	const compact = endDate.trim();
	if (/^\d{8}$/.test(compact)) {
		return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(compact)) {
		return compact;
	}
	throw new Error(`end_date must be YYYYMMDD or YYYY-MM-DD, got ${JSON.stringify(endDate)}.`);
}

export function buildArxivSearchQuery(query: string, endDate: string): string {
	return `${query.trim()} before:${normalizeEndDate(endDate)} site:arxiv.org`;
}

interface SerperOrganicItem {
	title?: string;
	link?: string;
	snippet?: string;
}

/**
 * Reduce a serper response body to arXiv hits, first occurrence wins.
 *
 * Separate from the request so the parser can be tested against a recorded
 * response: serper returns whatever Google gave it, so absent fields, non-arXiv
 * links and the same paper under several URLs are all normal.
 */
export function parseSerperArxivHits(responseBody: string): SerperArxivHit[] {
	const parsed = JSON.parse(responseBody) as { organic?: SerperOrganicItem[] };
	const seen = new Set<string>();
	const hits: SerperArxivHit[] = [];
	for (const item of parsed.organic ?? []) {
		const link = item.link ?? "";
		const match = ARXIV_LINK_PATTERN.exec(link);
		if (!match || seen.has(match[1])) {
			continue;
		}
		seen.add(match[1]);
		hits.push({ arxivId: match[1], title: (item.title ?? "").trim(), link, snippet: (item.snippet ?? "").trim() });
	}
	return hits;
}

export async function searchArxivViaSerper(args: {
	query: string;
	num: number;
	endDate: string;
	workspaceCwd: string;
	signal?: AbortSignal;
}): Promise<SerperArxivHit[]> {
	const apiKey = await resolveSerperApiKey(args.workspaceCwd);
	const body = JSON.stringify({ q: buildArxivSearchQuery(args.query, args.endDate), num: args.num, page: 1 });
	return parseSerperArxivHits(
		await httpText(SERPER_SEARCH_URL, {
			method: "POST",
			headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
			body,
			signal: args.signal,
		}),
	);
}
