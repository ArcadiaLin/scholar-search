#!/usr/bin/env node

/**
 * One command that gets you to a working Scholar Search Agent.
 *
 * `run-widi.mjs` starts the WIDI runtime and nothing else, so a TUI opened that
 * way has the nine retrieval tools registered but every one of them fails: the
 * tools are a thin client over the Python Search Service, and that service is a
 * separate process. Starting it by hand in another terminal is a step that is
 * easy to forget and whose failure mode - "the tool says the service is
 * unreachable" - looks like a bug in the extension.
 *
 * So this script owns both halves: bring the service up, wait until it actually
 * answers, then hand the terminal to the TUI. When the TUI exits, the service it
 * started goes with it.
 *
 * Two behaviours worth knowing:
 *
 * - **An already-running service is reused, not duplicated.** Probing `/health`
 *   first means a service you started yourself (with a debugger attached, or on
 *   a different config) keeps serving, and this script does not leave a second
 *   one bound to the same port on exit.
 * - **The service's own output never reaches the terminal.** uvicorn logs a line
 *   per request; interleaved into a full-screen TUI they corrupt the display.
 *   They go to a log file instead, whose path is printed before the TUI starts.
 *   This script's own progress lines go to stderr for the same reason plus one
 *   more: `--mode rpc` makes stdout a JSONL stream whose reader treats any
 *   non-JSON line as a protocol violation.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serviceRoot = join(repositoryRoot, "src", "search-service");

const args = process.argv.slice(2);
const host = process.env.SEARCH_SERVICE_HOST || "127.0.0.1";
const port = process.env.SEARCH_SERVICE_PORT || "8000";
const baseUrl = process.env.SCHOLAR_SEARCH_SERVICE_URL || `http://${host}:${port}`;

/** Whether something already answers `/health` at `baseUrl`. */
async function serviceIsUp() {
	try {
		const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
		return response.ok;
	} catch {
		return false;
	}
}

function startService() {
	const logDirectory = join(repositoryRoot, "runs", "logs");
	mkdirSync(logDirectory, { recursive: true });
	const logPath = join(logDirectory, "search-service.log");
	const log = createWriteStream(logPath, { flags: "a" });

	const child = spawn("uv", ["run", "uvicorn", "search_service.main:app", "--host", host, "--port", port], {
		cwd: serviceRoot,
		// PYTHONPATH is how the service package is found without installing it,
		// matching the command in the docs.
		env: { ...process.env, PYTHONPATH: "src" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	child.on("error", (error) => {
		process.stderr.write(
			`Failed to start the Search Service: ${error.message}\n` +
				"`uv` must be on PATH. Run `npm run bootstrap` first.\n",
		);
	});
	return { child, logPath };
}

/** Poll `/health` until it answers or we give up. */
async function waitForService(timeoutMs, isAlive) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive()) return false;
		if (await serviceIsUp()) return true;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return false;
}

if (!existsSync(serviceRoot)) {
	process.stderr.write(`Search Service directory is missing: ${serviceRoot}\n`);
	process.exit(2);
}

let service;
let ownsService = false;

if (await serviceIsUp()) {
	process.stderr.write(`Search Service already running at ${baseUrl} - reusing it.\n`);
} else {
	const started = startService();
	service = started.child;
	ownsService = true;
	let exited = false;
	service.on("exit", () => {
		exited = true;
	});

	process.stderr.write(`Starting Search Service at ${baseUrl} (log: ${started.logPath})\n`);
	const ready = await waitForService(60_000, () => !exited);
	if (!ready) {
		process.stderr.write(
			`Search Service did not answer ${baseUrl}/health in time. See ${started.logPath}.\n` +
				"The most common cause is dependencies not installed: run `npm run bootstrap`.\n",
		);
		if (!exited) service.kill();
		process.exit(1);
	}
	process.stderr.write("Search Service is up.\n");
}

function stopService() {
	if (!ownsService || service === undefined || service.exitCode !== null) return;
	// The TUI got its own SIGINT from the terminal; this covers the other exits.
	service.kill("SIGTERM");
}

// `--profile search` unless the caller asked for another one: this entry point
// exists to open the retrieval agent, not the general-purpose `main` agent.
const widiArgs = ["--namespace", "scholar", ...args];
if (!args.includes("--profile") && !args.some((argument) => argument.startsWith("--profile="))) {
	widiArgs.push("--profile", "search");
}

const tui = spawn(process.execPath, [join(repositoryRoot, "scripts", "run-widi.mjs"), ...widiArgs], {
	cwd: repositoryRoot,
	env: { ...process.env, SCHOLAR_SEARCH_SERVICE_URL: baseUrl },
	stdio: "inherit",
});

tui.on("error", (error) => {
	process.stderr.write(`Failed to start WIDI: ${error.message}\n`);
	stopService();
	process.exitCode = 1;
});

tui.on("exit", (code, signal) => {
	stopService();
	process.exitCode = signal ? 1 : (code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	// The TUI receives the same signal from the terminal and exits on its own;
	// this handler only makes sure the service does not outlive it.
	process.on(signal, () => {
		stopService();
	});
}
