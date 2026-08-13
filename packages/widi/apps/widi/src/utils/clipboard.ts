import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Base64 grows the payload by a third and terminals buffer the whole escape
 * before acting on it; past this, emitting it desynchronizes rendering.
 */
const MAX_OSC52_ENCODED_LENGTH = 100_000;
const TOOL_TIMEOUT_MS = 5_000;

/**
 * Everything the copy path touches outside itself, so tests can drive the
 * platform branches without a clipboard, a display server, or a terminal.
 */
export interface ClipboardEnvironment {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	/** Run a tool that reads stdin; throw on any failure. */
	runSync(command: string, input: string): void;
	/** Run a tool that reads stdin, resolving its exit code (non-zero on spawn failure). */
	runStreamed(command: string, input: string): Promise<number>;
	/** Write an escape sequence to the terminal. */
	writeTerminal(data: string): void;
}

export const nodeClipboardEnvironment: ClipboardEnvironment = {
	platform: platform(),
	env: process.env,
	runSync: (command, input) => {
		execSync(command, { input, timeout: TOOL_TIMEOUT_MS, stdio: ["pipe", "ignore", "ignore"] });
	},
	// wl-copy under execSync hangs on its own fork; it has to be spawned and
	// waited on. A missing binary surfaces as an async "error" event, not a
	// throw, which is why this resolves a code instead of rejecting.
	runStreamed: (command, input) =>
		new Promise<number>((resolve) => {
			const child = spawn(command, [], { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => resolve(1));
			child.on("close", (code) => resolve(code ?? 1));
			child.stdin.on("error", () => {
				// EPIPE when the tool exits before reading it all.
			});
			child.stdin.write(input);
			child.stdin.end();
		}),
	writeTerminal: (data) => {
		process.stdout.write(data);
	},
};

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function copyViaX11(environment: ClipboardEnvironment, text: string): boolean {
	try {
		environment.runSync("xclip -selection clipboard", text);
		return true;
	} catch {
		try {
			environment.runSync("xsel --clipboard --input", text);
			return true;
		} catch {
			return false;
		}
	}
}

async function copyViaLinuxTool(environment: ClipboardEnvironment, text: string): Promise<boolean> {
	const env = environment.env;
	if (env.TERMUX_VERSION) {
		try {
			environment.runSync("termux-clipboard-set", text);
			return true;
		} catch {
			// Fall through to the display-server tools.
		}
	}
	if (isWaylandSession(env) && env.WAYLAND_DISPLAY) {
		if ((await environment.runStreamed("wl-copy", text)) === 0) return true;
	}
	return env.DISPLAY ? copyViaX11(environment, text) : false;
}

async function copyViaPlatformTool(environment: ClipboardEnvironment, text: string): Promise<boolean> {
	try {
		switch (environment.platform) {
			case "darwin":
				environment.runSync("pbcopy", text);
				return true;
			case "win32":
				environment.runSync("clip", text);
				return true;
			case "linux":
				return await copyViaLinuxTool(environment, text);
			default:
				return false;
		}
	} catch {
		return false;
	}
}

function emitOsc52(environment: ClipboardEnvironment, text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
	environment.writeTerminal(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * Put text on the system clipboard, after pi's copy path minus its native
 * addon (widi adds no native dependency, and only ever writes).
 *
 * Order matters. The platform tool goes first: emitting OSC 52 alongside it
 * has both the terminal and the tool writing the same clipboard, and a large
 * escape payload desynchronizes rendering. OSC 52 is the fallback when no tool
 * worked — and, in a remote session, an addition rather than a fallback, since
 * a tool on the far side populates the server's clipboard, not the user's.
 *
 * Throws when nothing worked, so the caller can say so instead of pretending.
 */
export async function copyToClipboard(
	text: string,
	environment: ClipboardEnvironment = nodeClipboardEnvironment,
): Promise<void> {
	const copied = await copyViaPlatformTool(environment, text);
	const remote = isRemoteSession(environment.env);
	if (copied && !remote) return;
	if (emitOsc52(environment, text) || copied) return;
	throw new Error("Could not reach a clipboard: no platform tool worked and the text is too large for OSC 52.");
}
