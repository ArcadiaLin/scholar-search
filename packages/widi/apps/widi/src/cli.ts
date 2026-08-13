#!/usr/bin/env node
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { runWidiRpc } from "./rpc/index.ts";
import { runWidiTui } from "./tui/application.ts";

/** The front end core is driven through. `tui` is the default. */
type EntryMode = "tui" | "rpc";

interface EntryOptions {
	mode: EntryMode;
	cwd: string;
	agentDir?: string;
	profileId?: string;
	noRoot?: boolean;
}

function parseArgs(argv: string[]): EntryOptions {
	const options: EntryOptions = { mode: "tui", cwd: process.cwd() };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		switch (argument) {
			case "--mode":
				options.mode = requireMode(requireValue(argv, ++index, argument));
				break;
			case "--cwd":
				options.cwd = requireValue(argv, ++index, argument);
				break;
			case "--agent-dir":
				options.agentDir = requireValue(argv, ++index, argument);
				break;
			case "--profile":
				options.profileId = requireValue(argv, ++index, argument);
				break;
			case "--no-root":
				options.noRoot = true;
				break;
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return options;
}

function requireMode(value: string): EntryMode {
	if (value === "tui" || value === "rpc") return value;
	throw new Error(`Unknown mode: ${value}. Expected 'tui' or 'rpc'.`);
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined) throw new Error(`Missing value for ${flag}`);
	return value;
}

// From the environment alone, before anything can issue a request. The runtime
// configures it a second time once settings are loaded and may name their own
// proxy or idle timeout.
configureHttpDispatcher();

const options = parseArgs(process.argv.slice(2));

// Errors go to stderr in both modes, which stays true in RPC: the protocol owns
// stdout and everything else is pushed to stderr by the takeover.
(options.mode === "rpc" ? runWidiRpc(options) : runWidiTui(options)).catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
