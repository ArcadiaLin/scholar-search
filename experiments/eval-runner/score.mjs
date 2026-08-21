/**
 * Score a run against AutoScholarQuery gold, reading the answer pool and nothing
 * else.
 *
 * "The answer pool and nothing else" is the design, not an implementation detail.
 * The alternative - a regular expression over the agent's closing prose - is an
 * instrument that degrades silently: the agent writes "MetaBox+ I could not find"
 * and the regex scores it a hit (`docs/develop/plan.md` §3.5, second reason). It
 * is also what makes the pool a *hard* requirement rather than a suggestion in a
 * profile: an episode that never wrote to the pool scores zero and stays in the
 * denominator, because a prompt that says "you must" has already been shown not to
 * be enough (`backlog.md` B-4, and §3.4).
 *
 * Usage:
 *   node experiments/eval-runner/score.mjs --run runs/eval/<name>/run.json
 *   node experiments/eval-runner/score.mjs --run ... --k 20 --queries queries.json
 *
 * Reported per query and as a macro average: Recall@k, Precision@k, F1. Not Recall
 * alone - the official weighting is F1 70% / efficiency 20% / structure 10%
 * (`AGENTS.md` §5.3) - plus latency and the failure taxonomy, so a good F1 bought
 * with timeouts is visible as such.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeArxivId } from "./autoscholarquery.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Bumped when the shape of `score.json` changes. */
export const SCORER_VERSION = "1";

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		switch (flag) {
			case "--run":
				args.run = value;
				index += 1;
				break;
			case "--queries":
				args.queries = value;
				index += 1;
				break;
			case "--trace-dir":
				args.traceDir = value;
				index += 1;
				break;
			case "--k":
				args.k = Number(value);
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
	if (!args.run) throw new Error("--run <run.json> is required");
	return args;
}

/**
 * The arXiv ids one pool entry denotes.
 *
 * Several fields can carry it because the pool records whichever identifier the
 * agent cited plus whatever the service resolved, and only one of them may be an
 * arXiv id. A DOI-only entry simply contributes nothing to an arXiv-id benchmark,
 * which is a fact about the gold, not a bug in the pool.
 */
export function arxivIdsOf(entry) {
	const candidates = [entry?.arxivId, entry?.canonicalId, entry?.paperId, entry?.doi];
	const ids = new Set();
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const isArxivShaped =
			/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(candidate.trim()) ||
			/arxiv\.org\/(abs|pdf)\//i.test(candidate) ||
			/10\.48550\/arxiv\./i.test(candidate);
		if (!isArxivShaped) continue;
		const normalized = normalizeArxivId(candidate);
		if (normalized !== null) ids.add(normalized);
	}
	return [...ids];
}

/**
 * Read one episode's answer pool.
 *
 * Three outcomes, kept distinct: the file is there with papers in it, the file is
 * there and empty, or the file was never written. All three score zero recall when
 * empty, but only the third means the tool was never called, and telling them apart
 * is how you find out whether the agent is failing to search or failing to commit.
 */
export function readPool(traceDir, agentId) {
	if (typeof agentId !== "string" || agentId === "") return { status: "unknown-agent", papers: [] };
	const path = join(traceDir, `${agentId}.answer.json`);
	if (!existsSync(path)) return { status: "never-written", papers: [], path };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { status: "unreadable", papers: [], path, error: error.message };
	}
	const papers = Array.isArray(parsed.papers) ? parsed.papers : [];
	return {
		status: papers.length === 0 ? "empty" : "ok",
		papers,
		removed: Array.isArray(parsed.removed) ? parsed.removed : [],
		note: typeof parsed.note === "string" ? parsed.note : "",
		path,
	};
}

function fScore(precision, recall) {
	return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Score one query. `k` truncates the pool in the order the agent committed to it. */
export function scoreOne(result, pool, k) {
	const gold = new Set((result.gold?.arxivIds ?? []).map(normalizeArxivId).filter((id) => id !== null));
	// Insertion order is the agent's own ranking: the pool is a list it built, and
	// truncating anywhere else would be scoring an order nobody produced.
	const predictedEntries = pool.papers.slice(0, k);
	const predicted = new Set();
	for (const entry of predictedEntries) for (const id of arxivIdsOf(entry)) predicted.add(id);

	const hits = [...gold].filter((id) => predicted.has(id));
	const recall = gold.size === 0 ? null : hits.length / gold.size;
	const precision = predicted.size === 0 ? 0 : hits.length / predicted.size;

	return {
		id: result.id,
		agentId: result.agentId ?? null,
		terminationStatus: result.terminationStatus ?? null,
		elapsedMs: result.elapsedMs ?? null,
		poolStatus: pool.status,
		committed: pool.papers.length,
		withdrawn: pool.removed?.length ?? 0,
		// Papers the agent committed to that carry no arXiv id at all - they cannot
		// be credited against this gold, and silently dropping them would overstate
		// precision.
		unscorablePredictions: predictedEntries.length - predictedEntries.filter((e) => arxivIdsOf(e).length > 0).length,
		goldSize: gold.size,
		predictedSize: predicted.size,
		hits,
		missed: [...gold].filter((id) => !predicted.has(id)),
		recall,
		precision,
		f1: recall === null ? null : fScore(precision, recall),
	};
}

function mean(values) {
	const usable = values.filter((value) => typeof value === "number");
	return usable.length === 0 ? null : usable.reduce((total, value) => total + value, 0) / usable.length;
}

export function score(record, traceDir, k) {
	const perQuery = record.results.map((result) => scoreOne(result, readPool(traceDir, result.agentId), k));
	const byPoolStatus = {};
	const byTermination = {};
	for (const entry of perQuery) {
		byPoolStatus[entry.poolStatus] = (byPoolStatus[entry.poolStatus] ?? 0) + 1;
		const status = entry.terminationStatus ?? "unknown";
		byTermination[status] = (byTermination[status] ?? 0) + 1;
	}
	const scored = perQuery.filter((entry) => entry.recall !== null);
	return {
		scorerVersion: SCORER_VERSION,
		k,
		traceDir,
		counts: {
			queries: perQuery.length,
			// Queries with no gold cannot be scored; they are reported, never folded in.
			withGold: scored.length,
			withoutGold: perQuery.length - scored.length,
			byPoolStatus,
			byTermination,
		},
		macro: {
			// Macro over every query that has gold, including the ones that produced
			// nothing: a failed episode contributes a zero, it does not disappear.
			recallAtK: mean(scored.map((entry) => entry.recall)),
			precisionAtK: mean(scored.map((entry) => entry.precision)),
			f1: mean(scored.map((entry) => entry.f1)),
			medianElapsedMs: median(perQuery.map((entry) => entry.elapsedMs)),
		},
		perQuery,
	};
}

function median(values) {
	const usable = values.filter((value) => typeof value === "number").sort((left, right) => left - right);
	if (usable.length === 0) return null;
	const middle = Math.floor(usable.length / 2);
	return usable.length % 2 === 0 ? (usable[middle - 1] + usable[middle]) / 2 : usable[middle];
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const runPath = resolve(repoRoot, args.run);
	const record = JSON.parse(readFileSync(runPath, "utf8"));

	// Gold normally rides along in the run record; a queries file can supply it for
	// a run recorded before that was carried through.
	if (args.queries) {
		const queries = JSON.parse(readFileSync(resolve(repoRoot, args.queries), "utf8"));
		const byId = new Map(queries.map((item) => [item.id, item]));
		for (const result of record.results) result.gold = result.gold ?? byId.get(result.id)?.gold ?? null;
	}

	const traceDir = resolve(repoRoot, args.traceDir ?? record.traceDir ?? join(dirname(runPath), "trajectories"));
	const k = args.k ?? 20;
	const report = score(record, traceDir, k);

	const outPath = resolve(repoRoot, args.out ?? join(dirname(runPath), "score.json"));
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log(`scorer v${SCORER_VERSION} | k=${k} | pools from ${traceDir}`);
	console.log(
		`queries ${report.counts.queries} (${report.counts.withGold} with gold, ${report.counts.withoutGold} without)`,
	);
	console.log(`pool status: ${JSON.stringify(report.counts.byPoolStatus)}`);
	console.log(`termination: ${JSON.stringify(report.counts.byTermination)}`);
	for (const entry of report.perQuery) {
		const rate = entry.recall === null ? "no gold" : `${entry.hits.length}/${entry.goldSize}`;
		console.log(
			`  ${entry.id}: recall ${rate} | precision ${entry.precision.toFixed(3)} | ` +
				`pool ${entry.poolStatus} (${entry.committed} committed, ${entry.withdrawn} withdrawn) | ${entry.elapsedMs}ms`,
		);
		if (entry.missed.length > 0) console.log(`      missed: ${entry.missed.join(", ")}`);
	}
	const show = (value) => (value === null ? "n/a" : value.toFixed(4));
	console.log(
		`macro: Recall@${k} ${show(report.macro.recallAtK)} | Precision@${k} ${show(report.macro.precisionAtK)} | ` +
			`F1 ${show(report.macro.f1)} | median ${report.macro.medianElapsedMs}ms`,
	);
	console.log(`written: ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
