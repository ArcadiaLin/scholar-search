#!/usr/bin/env node

/**
 * Run the tests of every WIDI namespace extension under `widis/`.
 *
 * Node's own test runner, loaded through the tsx already installed for the WIDI
 * runtime. An extension lives outside every npm workspace, so a test framework
 * of its own would mean a second lockfile at the repository root - which
 * `AGENTS.md` §4 rules out. `node:test` and `node:assert` are builtins, so the
 * only thing borrowed from packages/widi is TypeScript transpilation.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widisRoot = join(repositoryRoot, "widis");
const tsxLoader = join(repositoryRoot, "packages", "widi", "node_modules", "tsx", "dist", "loader.mjs");

if (!existsSync(tsxLoader)) {
	process.stderr.write("WIDI dependencies are not installed. Run `npm run bootstrap` first.\n");
	process.exit(1);
}

const testFiles = [];
for (const namespace of existsSync(widisRoot) ? readdirSync(widisRoot) : []) {
	if (!namespace.startsWith(".widi-")) continue;
	const extensionsDir = join(widisRoot, namespace, "extensions");
	if (!existsSync(extensionsDir)) continue;
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const testsDir = join(extensionsDir, entry.name, "tests");
		if (!existsSync(testsDir)) continue;
		for (const file of readdirSync(testsDir)) {
			if (file.endsWith(".test.ts")) testFiles.push(join(testsDir, file));
		}
	}
}

if (testFiles.length === 0) {
	process.stdout.write("No WIDI namespace extension tests found.\n");
	process.exit(0);
}

process.stdout.write(`Running ${testFiles.length} extension test files\n`);
const result = spawnSync(
	process.execPath,
	["--import", tsxLoader, "--test", ...testFiles.map((file) => relative(repositoryRoot, file))],
	{ cwd: repositoryRoot, env: process.env, stdio: "inherit" },
);
if (result.error) {
	process.stderr.write(`Failed to run node --test: ${result.error.message}\n`);
	process.exit(1);
}
process.exit(result.status ?? 1);
