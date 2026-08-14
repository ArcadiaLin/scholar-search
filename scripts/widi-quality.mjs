#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widiRoot = join(repositoryRoot, "packages", "widi");
const mode = process.argv[2];

if (mode !== "check" && mode !== "format") {
	process.stderr.write("Usage: node scripts/widi-quality.mjs <check|format>\n");
	process.exit(2);
}

const executableSuffix = process.platform === "win32" ? ".cmd" : "";
const biome = join(widiRoot, "node_modules", ".bin", `biome${executableSuffix}`);
const sourcePaths = ["apps/widi/src", "apps/widi/tests", "apps/widi/docs", "packages/agent/src", "packages/agent/test"];

run(biome, ["check", ...(mode === "format" ? ["--write"] : []), "--error-on-warnings", ...sourcePaths]);

if (mode === "check") {
	const tsgo = join(widiRoot, "node_modules", ".bin", `tsgo${executableSuffix}`);
	run(tsgo, ["--noEmit", "-p", "tsconfig.json"]);
}

function run(executable, args) {
	const result = spawnSync(executable, args, { cwd: widiRoot, env: process.env, stdio: "inherit" });
	if (result.error) {
		process.stderr.write(`Failed to run ${executable}: ${result.error.message}\n`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}
