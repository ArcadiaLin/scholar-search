#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widiRoot = join(repositoryRoot, "packages", "widi");
const sourceArgs = process.argv.slice(2);
const namespace = namespaceValue(sourceArgs);
const forwardedArgs = sourceArgs.filter((argument, index) => {
	if (argument === "--namespace") return false;
	if (index > 0 && sourceArgs[index - 1] === "--namespace") return false;
	return !argument.startsWith("--namespace=");
});
const agentDir = join(repositoryRoot, "widis", `.widi-${namespace}`);
if (!existsSync(agentDir)) {
	process.stderr.write(`Unknown WIDI namespace or missing agent directory: ${namespace}\n`);
	process.exit(2);
}

const dev = forwardedArgs.includes("--dev");
const cleanArgs = forwardedArgs.filter((argument) => argument !== "--dev");

appendDefaultOption(cleanArgs, "--cwd", repositoryRoot);
appendDefaultOption(cleanArgs, "--agent-dir", agentDir);
appendDefaultOption(cleanArgs, "--profile", "main");
if (optionValue(cleanArgs, "--mode") === "rpc") {
	appendDefaultOption(cleanArgs, "--human-timeout", "30000");
}

let command;
let commandArgs;
let cwd;

if (dev) {
	// Run tsx's own JS entry under the current Node instead of the `.bin` shim: on
	// Windows that shim is a `.cmd`, and Node >= 20 refuses to spawn one without
	// `shell: true` (EINVAL). Going straight to the entry keeps a single code path
	// across platforms and avoids shell quoting for paths.
	const tsxPath = join(widiRoot, "node_modules", "tsx", "dist", "cli.mjs");
	if (!existsSync(tsxPath)) {
		process.stderr.write("WIDI dependencies are not installed. Run `npm run bootstrap` first.\n");
		process.exit(1);
	}
	command = process.execPath;
	commandArgs = [
		tsxPath,
		"--tsconfig",
		join(widiRoot, "apps", "widi", "tsconfig.json"),
		join(widiRoot, "apps", "widi", "src", "cli.ts"),
		...cleanArgs,
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
	commandArgs = [cliPath, ...cleanArgs];
	cwd = repositoryRoot;
}
const child = spawn(command, commandArgs, { cwd, env: process.env, stdio: "inherit" });

child.on("error", (error) => {
	process.stderr.write(`Failed to start WIDI: ${error.message}\n`);
	process.exitCode = 1;
});

child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});

function namespaceValue(args) {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--namespace") {
			const value = args[index + 1];
			if (!value) {
				process.stderr.write("--namespace requires a value\n");
				process.exit(2);
			}
			return validateNamespace(value);
		}
		if (argument.startsWith("--namespace=")) {
			return validateNamespace(argument.slice("--namespace=".length));
		}
	}
	return "scholar";
}

function validateNamespace(value) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
		process.stderr.write(`Invalid WIDI namespace: ${value}\n`);
		process.exit(2);
	}
	return value;
}

function appendDefaultOption(args, option, value) {
	if (!args.includes(option)) args.push(option, value);
}

function optionValue(args, option) {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}
