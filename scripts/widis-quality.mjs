#!/usr/bin/env node

/**
 * Lint, format, and type-check every WIDI namespace under `widis/`.
 *
 * Namespaces are discovered rather than listed: adding `widis/.widi-<name>/`
 * must be enough to put it under CI, which a hand-maintained path list in
 * package.json never managed - the pasa-tools extension sat outside every
 * check until this script existed.
 *
 * Two directories are deliberately never handed to biome: `runs/` is session
 * state, and `auth.json` holds credentials.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widiRoot = join(repositoryRoot, "packages", "widi");
const widisRoot = join(repositoryRoot, "widis");
const mode = process.argv[2];

if (mode !== "check" && mode !== "format") {
	process.stderr.write("Usage: node scripts/widis-quality.mjs <check|format>\n");
	process.exit(2);
}

const executableSuffix = process.platform === "win32" ? ".cmd" : "";
const biome = join(widiRoot, "node_modules", ".bin", `biome${executableSuffix}`);
const tsgo = join(widiRoot, "node_modules", ".bin", `tsgo${executableSuffix}`);

const namespaces = existsSync(widisRoot)
	? readdirSync(widisRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(".widi-"))
			.map((entry) => join(widisRoot, entry.name))
			.sort()
	: [];

if (namespaces.length === 0) {
	process.stderr.write(`No WIDI namespace found under ${relative(repositoryRoot, widisRoot)}/\n`);
	process.exit(1);
}

// Recorded API responses are bytes, not source. Formatting one would rewrite
// the very thing a parser test asserts against, and biome lints the <script>
// blocks inside a recorded HTML page as if they were ours.
const FIXTURE_DIR = "fixtures";
const BIOME_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".json", ".jsonc"];

function collectBiomeFiles(path, into) {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === FIXTURE_DIR) continue;
		const child = join(path, entry.name);
		if (entry.isDirectory()) collectBiomeFiles(child, into);
		else if (BIOME_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
			into.push(relative(repositoryRoot, child));
		}
	}
}

const biomeTargets = [];
const extensionProjects = [];
for (const namespace of namespaces) {
	const settings = join(namespace, "settings.json");
	if (existsSync(settings)) biomeTargets.push(relative(repositoryRoot, settings));
	for (const candidate of ["agent", "themes", "extensions"]) {
		const path = join(namespace, candidate);
		if (existsSync(path)) collectBiomeFiles(path, biomeTargets);
	}
	const extensionsDir = join(namespace, "extensions");
	if (!existsSync(extensionsDir)) continue;
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const project = join(extensionsDir, entry.name, "tsconfig.json");
		if (existsSync(project)) extensionProjects.push(project);
	}
}

run(biome, [
	"check",
	...(mode === "format" ? ["--write"] : []),
	"--error-on-warnings",
	"--config-path",
	relative(repositoryRoot, join(widiRoot, "biome.json")),
	...biomeTargets,
]);

// An extension is loaded by jiti at runtime, so the app's own build never sees
// it; its tsconfig is the only thing that type-checks it.
if (mode === "check") {
	for (const project of extensionProjects) {
		process.stdout.write(`tsgo ${relative(repositoryRoot, project)}\n`);
		run(tsgo, ["--noEmit", "-p", project]);
	}
}

function run(executable, args) {
	const result = spawnSync(executable, args, {
		cwd: repositoryRoot,
		env: process.env,
		stdio: "inherit",
		// npm's Windows shims are `.cmd` batch files, and since Node 20 `spawnSync`
		// refuses to execute one without a shell (EINVAL). Without this the whole
		// check step is unrunnable on Windows.
		shell: process.platform === "win32",
	});
	if (result.error) {
		process.stderr.write(`Failed to run ${executable}: ${result.error.message}\n`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}
