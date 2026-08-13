#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widiRoot = join(repositoryRoot, "packages", "widi");
const agentDir = join(repositoryRoot, ".widi-scholar");
const sourceArgs = process.argv.slice(2);
const dev = sourceArgs.includes("--dev");
const forwardedArgs = sourceArgs.filter((argument) => argument !== "--dev");

appendDefaultOption(forwardedArgs, "--cwd", repositoryRoot);
appendDefaultOption(forwardedArgs, "--agent-dir", agentDir);
appendDefaultOption(forwardedArgs, "--profile", "main");

let command;
let commandArgs;
let cwd;

if (dev) {
	const tsxPath = join(
		widiRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "tsx.cmd" : "tsx",
	);
	if (!existsSync(tsxPath)) {
		process.stderr.write(
			"WIDI dependencies are not installed. Run `npm run bootstrap` first.\n",
		);
		process.exit(1);
	}
	command = tsxPath;
	commandArgs = [
		"--tsconfig",
		join(widiRoot, "apps", "widi", "tsconfig.json"),
		join(widiRoot, "apps", "widi", "src", "cli.ts"),
		...forwardedArgs,
	];
	cwd = repositoryRoot;
} else {
	const cliPath = join(widiRoot, "apps", "widi", "dist", "cli.js");
	if (!existsSync(cliPath)) {
		process.stderr.write(
			"WIDI is not built. Run `npm run bootstrap` and `npm run build`, or use `npm run widi:dev`.\n",
		);
		process.exit(1);
	}
	command = process.execPath;
	commandArgs = [cliPath, ...forwardedArgs];
	cwd = repositoryRoot;
}

const child = spawn(command, commandArgs, {
	cwd,
	env: process.env,
	stdio: "inherit",
});

child.on("error", (error) => {
	process.stderr.write(`Failed to start WIDI: ${error.message}\n`);
	process.exitCode = 1;
});

child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});

function appendDefaultOption(args, option, value) {
	if (!args.includes(option)) args.push(option, value);
}
