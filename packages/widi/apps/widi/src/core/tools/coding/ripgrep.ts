import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "./process.ts";

export interface RgRunOptions {
	signal?: AbortSignal;
	/** Called for each stdout line. Call `stop` to terminate rg early. */
	onLine: (line: string, stop: () => void) => void;
}

export interface RgRunResult {
	exitCode: number | null;
	stderr: string;
	/** True when the consumer stopped rg early via `stop()`. */
	stoppedEarly: boolean;
}

/**
 * Streaming ripgrep invocation seam shared by the grep and find tools.
 * Override this to delegate search execution to a sandbox, SSH host, or remote
 * environment.
 */
export type RgRunner = (args: readonly string[], options: RgRunOptions) => Promise<RgRunResult>;

/**
 * Resolve the ripgrep executable from an explicit settings path or PATH.
 * WIDI never downloads executables; a missing rg is a hard error.
 */
export function resolveRgExecutable(explicitPath?: string): string {
	if (explicitPath) {
		if (existsSync(explicitPath)) {
			return explicitPath;
		}
		throw new Error(`Custom ripgrep path not found: ${explicitPath}`);
	}
	const rgOnPath = findRgOnPath();
	if (rgOnPath) {
		return rgOnPath;
	}
	throw new Error("ripgrep (rg) was not found on PATH. Install ripgrep or set rgPath in settings.");
}

let cachedRgOnPath: string | null | undefined;

function findRgOnPath(): string | null {
	if (cachedRgOnPath !== undefined) {
		return cachedRgOnPath;
	}
	const executableNames = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const executableName of executableNames) {
			const candidate = join(directory, executableName);
			if (existsSync(candidate)) {
				cachedRgOnPath = candidate;
				return candidate;
			}
		}
	}
	cachedRgOnPath = null;
	return null;
}

/**
 * Default local backend: spawn rg, stream stdout lines to the consumer, and
 * kill the process on abort or early stop.
 */
export function createLocalRgRunner(rgPath?: string): RgRunner {
	return (args, { signal, onLine }) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			let executable: string;
			try {
				executable = resolveRgExecutable(rgPath);
			} catch (error) {
				reject(error);
				return;
			}

			const child = spawn(executable, [...args], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);

			const lineReader = createInterface({ input: child.stdout });
			let stderr = "";
			let stoppedEarly = false;
			let settled = false;

			const stop = () => {
				if (stoppedEarly || settled) return;
				stoppedEarly = true;
				if (child.pid) killProcessTree(child.pid);
			};
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			const settle = (complete: () => void) => {
				if (settled) return;
				settled = true;
				lineReader.close();
				signal?.removeEventListener("abort", onAbort);
				if (child.pid) untrackDetachedChildPid(child.pid);
				complete();
			};

			signal?.addEventListener("abort", onAbort, { once: true });
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			lineReader.on("line", (line) => {
				if (settled || stoppedEarly) return;
				onLine(line, stop);
			});
			child.on("error", (error) => {
				settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
			});
			child.on("close", (code) => {
				settle(() => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					resolve({ exitCode: code, stderr, stoppedEarly });
				});
			});
		});
}
