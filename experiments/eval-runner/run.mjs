/**
 * Headless evaluation entry point for widi-scholar.
 *
 * Drives a set of queries through `npm run --silent widi:rpc` and writes one
 * machine-readable record per query plus a run-level provenance record.
 *
 * What it deliberately does not do (`AGENTS.md` §3.3): scrape TUI text, parse
 * terminal control sequences, or read session files. Every number here comes off
 * the RPC stream, so this runner keeps working across any change to how sessions
 * are stored.
 *
 * Usage:
 *   node experiments/eval-runner/run.mjs --queries queries.json --out runs/eval/<name>
 *   node experiments/eval-runner/run.mjs --query "..." --model vllm/qwen3.6-35b-a3b
 *
 * A queries file is a JSON array of `{ id, query, endDate? }`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectProvenance, RUNNER_VERSION, WidiRpcSession } from "./rpc-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
	const args = {
		namespace: "scholar",
		profile: "search",
		script: "widi:rpc",
		deadlineMs: 600_000,
		out: join("runs", "eval"),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		switch (flag) {
			case "--queries":
				args.queriesPath = value;
				index += 1;
				break;
			case "--query":
				args.query = value;
				index += 1;
				break;
			case "--end-date":
				args.endDate = value;
				index += 1;
				break;
			case "--model":
				args.model = value;
				index += 1;
				break;
			case "--profile":
				args.profile = value;
				index += 1;
				break;
			case "--namespace":
				args.namespace = value;
				index += 1;
				break;
			case "--script":
				args.script = value;
				index += 1;
				break;
			case "--out":
				args.out = value;
				index += 1;
				break;
			case "--deadline-ms":
				args.deadlineMs = Number(value);
				index += 1;
				break;
			default:
				if (flag.startsWith("--")) throw new Error(`unknown flag: ${flag}`);
		}
	}
	return args;
}

/** The checkout's revision. A fact about the tree, not about the run - hence git, not RPC. */
function revisionOf(path) {
	try {
		return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function isDirty(path) {
	try {
		return execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
	} catch {
		return null;
	}
}

/**
 * The per-query result.
 *
 * `terminationStatus` is separate from `ok` on purpose: a query that timed out and
 * a query the provider refused are both "no answer", and a benchmark that folded
 * them together could not report a failure taxonomy. A failed query stays in the
 * record - it must reach the denominator rather than vanish from it (§5.3).
 */
async function runOneQuery(session, agentId, item, deadlineMs) {
	const body = item.endDate ? `${item.query}\n\nDate boundary: nothing published after ${item.endDate}.` : item.query;

	const startedAt = Date.now();
	const response = await session.send({ cmd: "prompt", agentId, body, deadlineMs });
	const elapsedMs = Date.now() - startedAt;

	if (!response.ok) {
		return {
			id: item.id,
			query: item.query,
			endDate: item.endDate ?? null,
			ok: false,
			terminationStatus: response.code ?? "error",
			error: response.error,
			elapsedMs,
			answer: null,
			usage: null,
		};
	}

	const data = response.data;
	const content = data?.message?.content ?? [];
	// Only the text parts: a benchmark comparing answers must not have its output
	// silently include the model's reasoning on providers that expose it.
	const answer = content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	return {
		id: item.id,
		query: item.query,
		endDate: item.endDate ?? null,
		ok: true,
		terminationStatus: data?.kind ?? "completed",
		stopReason: data?.stopReason ?? null,
		elapsedMs,
		answer,
		usage: data?.message?.usage ?? null,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const queries = args.queriesPath
		? JSON.parse(readFileSync(args.queriesPath, "utf8"))
		: args.query
			? [{ id: "q1", query: args.query, endDate: args.endDate }]
			: null;
	if (!queries || queries.length === 0) {
		throw new Error("nothing to run: pass --queries <file> or --query <text>");
	}

	const session = new WidiRpcSession({ repoRoot, namespace: args.namespace, script: args.script });
	const started = new Date().toISOString();

	try {
		await session.waitReady();
		const agentId = await session
			.require({
				cmd: "spawn",
				origin: { kind: "new", profileId: args.profile },
				...(args.model ? { model: args.model } : {}),
			})
			.then((data) => data.agentId);

		// The effective budget comes from the tool, because the bounds live in the
		// Search Service's configuration and the runtime cannot see them.
		let budget = null;
		const budgetCall = await session.send({
			cmd: "prompt",
			agentId,
			body: "Call get_budget and say nothing else.",
			deadlineMs: 120_000,
		});
		if (budgetCall.ok) {
			const events = session.events.filter((event) => event.type === "agent_harness_event");
			for (const event of events.reverse()) {
				const inner = event.event;
				if (inner?.type === "tool_execution_end" && inner.toolName === "get_budget") {
					budget = inner.result?.details ?? null;
					break;
				}
			}
		}

		const provenance = await collectProvenance(session, agentId, {
			widiRevision: revisionOf(join(repoRoot, "packages", "widi")),
			extensionVersion: budget?.extensionVersion ?? null,
			budget: budget ? { limits: budget.limits, quotas: budget.quotas, scope: budget.scope } : null,
		});
		provenance.repoRevision = revisionOf(repoRoot);
		provenance.repoDirty = isDirty(repoRoot);
		provenance.startedAt = started;

		const results = [];
		for (const item of queries) {
			// Every query gets a fresh agent: a shared context would let query N see
			// query N-1's results, which makes the per-query numbers meaningless.
			const perQueryAgent = await session
				.require({
					cmd: "spawn",
					origin: { kind: "new", profileId: args.profile },
					...(args.model ? { model: args.model } : {}),
				})
				.then((data) => data.agentId);
			results.push(await runOneQuery(session, perQueryAgent, item, args.deadlineMs));
			await session.send({ cmd: "dispose", agentId: perQueryAgent, reason: "eval query finished" });
		}

		const summary = await session.send({ cmd: "run_summary" });
		const outDir = resolve(repoRoot, args.out);
		mkdirSync(outDir, { recursive: true });

		const record = {
			runnerVersion: RUNNER_VERSION,
			provenance,
			results,
			runSummary: summary.ok ? summary.data : { error: summary.error },
			finishedAt: new Date().toISOString(),
			counts: {
				total: results.length,
				ok: results.filter((entry) => entry.ok).length,
				failed: results.filter((entry) => !entry.ok).length,
			},
		};
		writeFileSync(join(outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

		console.log(`runner v${RUNNER_VERSION} | rpc protocol v${provenance.rpcProtocolVersion}`);
		console.log(`profile ${provenance.profile.id} | model ${provenance.model.provider}/${provenance.model.id}`);
		console.log(
			`widi ${String(provenance.widiRevision).slice(0, 12)} | repo ${String(provenance.repoRevision).slice(0, 12)}${provenance.repoDirty ? " (dirty)" : ""}`,
		);
		console.log(
			`extensions ${provenance.extensions.ids.join(", ")} | scholar-search v${provenance.extensions.scholarSearchVersion}`,
		);
		console.log(`queries ${record.counts.total}: ${record.counts.ok} ok, ${record.counts.failed} failed`);
		for (const entry of results) {
			console.log(
				`  ${entry.id}: ${entry.terminationStatus} in ${entry.elapsedMs}ms, ${entry.answer?.length ?? 0} chars`,
			);
		}
		console.log(`written: ${join(outDir, "run.json")}`);
	} finally {
		await session.shutdown();
	}
}

await main();
