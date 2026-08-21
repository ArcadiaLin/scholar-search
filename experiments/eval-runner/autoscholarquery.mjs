/**
 * AutoScholarQuery -> a queries file the eval runner can drive.
 *
 * Two things this does that are not just reformatting:
 *
 * - **It carries the gold answers through.** `answer_arxiv_id` is the whole reason
 *   the dataset is usable as a benchmark, and it was sitting unread while the
 *   runner had "complete recording ability but no metric at all"
 *   (`docs/develop/backlog.md`, closing note).
 * - **It maps `source_meta.published_time` onto `endDate`.** Each question is
 *   derived from the related-work section of a paper published on that date, so a
 *   paper published after it cannot be a correct answer. Leaving the boundary out
 *   lets later papers occupy the top-k and depresses recall for a reason that has
 *   nothing to do with retrieval quality (`backlog.md` F-5). Filling it in by hand
 *   was the previous procedure, which is to say it was usually not done.
 *
 * Usage:
 *   node experiments/eval-runner/autoscholarquery.mjs --split train --limit 20 \
 *     --out runs/eval/train-20/queries.json
 *   node experiments/eval-runner/autoscholarquery.mjs --split train \
 *     --ids AutoScholarQuery_train_1 --out runs/eval/one/queries.json
 *
 * The dataset lives under `references/datasets/`, which is not in Git: it is a
 * gated HuggingFace repo (`CarlanLark/pasa-dataset`), so it has to be fetched with
 * credentials before this script has anything to read. `references/sources.yaml`
 * records the provenance.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DATASET_DIR = join("references", "datasets", "pasa", "AutoScholarQuery");

function parseArgs(argv) {
	const args = { split: "train", datasetDir: DEFAULT_DATASET_DIR };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		switch (flag) {
			case "--split":
				args.split = value;
				index += 1;
				break;
			case "--limit":
				args.limit = Number(value);
				index += 1;
				break;
			case "--ids":
				// Comma-separated qids, for reproducing one case rather than a split.
				args.ids = value.split(",").map((id) => id.trim());
				index += 1;
				break;
			case "--dataset-dir":
				args.datasetDir = value;
				index += 1;
				break;
			case "--input":
				args.input = value;
				index += 1;
				break;
			case "--out":
				args.out = value;
				index += 1;
				break;
			default:
				if (flag.startsWith("--")) throw new Error(`unknown flag: ${flag}`);
		}
	}
	if (!args.out) throw new Error("--out is required");
	return args;
}

/** `20230917` -> `2023-09-17`. Already-hyphenated input passes through. */
export function toIsoDate(published) {
	if (typeof published !== "string") return null;
	const digits = published.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(digits)) return digits;
	if (/^\d{8}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
	if (/^\d{4}$/.test(digits)) return digits;
	return null;
}

/** Versionless, lower-case: the form both sides of the comparison must agree on. */
export function normalizeArxivId(value) {
	if (typeof value !== "string") return null;
	const trimmed = value
		.trim()
		.replace(/^arxiv:/i, "")
		.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
		.replace(/\.pdf$/i, "")
		.replace(/^10\.48550\/arxiv\./i, "")
		.replace(/v\d+$/i, "");
	return trimmed === "" ? null : trimmed.toLowerCase();
}

/**
 * One dataset record -> one query item.
 *
 * Exported so the shape is testable without the dataset present, which matters
 * here: the dataset is gated and cannot be committed as a fixture.
 */
export function toQueryItem(record) {
	const question = typeof record.question === "string" ? record.question.trim() : "";
	if (question === "") return null;
	const gold = Array.isArray(record.answer_arxiv_id)
		? record.answer_arxiv_id.map(normalizeArxivId).filter((id) => id !== null)
		: [];
	return {
		id: typeof record.qid === "string" && record.qid !== "" ? record.qid : null,
		query: question,
		endDate: toIsoDate(record.source_meta?.published_time),
		gold: {
			arxivIds: gold,
			// The dataset's own titles, kept for reading a scored run by eye. Not used
			// for matching: a title match is a judgement, an id match is a fact.
			titles: Array.isArray(record.answer) ? record.answer : [],
		},
	};
}

export function convert(lines, options = {}) {
	const wanted = options.ids ? new Set(options.ids) : null;
	const items = [];
	let skipped = 0;
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			skipped += 1;
			continue;
		}
		const item = toQueryItem(record);
		if (item === null) {
			skipped += 1;
			continue;
		}
		// A record with no qid still gets a stable id, derived from its position, so
		// every query can be correlated across runs.
		if (item.id === null) item.id = `${options.split ?? "split"}_${index}`;
		if (wanted !== null && !wanted.has(item.id)) continue;
		items.push(item);
		if (options.limit !== undefined && items.length >= options.limit) break;
	}
	return { items, skipped };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const inputPath = resolve(repoRoot, args.input ?? join(args.datasetDir, `${args.split}.jsonl`));

	let raw;
	try {
		raw = readFileSync(inputPath, "utf8");
	} catch (error) {
		// Naming the reason matters: the file is absent by design, not by accident.
		throw new Error(
			`cannot read ${inputPath}: ${error.message}\n` +
				"AutoScholarQuery is not in this repository (references/datasets/ is ignored, and the upstream " +
				"HuggingFace dataset CarlanLark/pasa-dataset is gated). Fetch it with credentials first; " +
				"references/sources.yaml records the provenance.",
		);
	}

	const { items, skipped } = convert(raw.split(/\r?\n/), {
		ids: args.ids,
		limit: args.limit,
		split: args.split,
	});
	if (items.length === 0) throw new Error(`no usable records in ${inputPath}`);

	const outPath = resolve(repoRoot, args.out);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");

	const withBoundary = items.filter((item) => item.endDate !== null).length;
	const goldCount = items.reduce((total, item) => total + item.gold.arxivIds.length, 0);
	console.log(`${items.length} query/queries from ${inputPath}${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
	console.log(`date boundary present on ${withBoundary}/${items.length}; ${goldCount} gold arXiv id(s) in total`);
	console.log(`written: ${outPath}`);
}

// Importable for tests; runs only when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
