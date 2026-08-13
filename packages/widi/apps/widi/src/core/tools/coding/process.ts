import { type ChildProcess, spawn } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited stdio
 * handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its
 * stdout/stderr pipe open. We must not resolve and destroy the streams on a
 * fixed deadline measured from `exit`, or output still being written past that
 * deadline is silently lost. Instead, after `exit` we wait for the pipes to
 * fall idle: the grace timer is re-armed on every chunk, so an actively writing
 * descendant keeps us reading, while a quiet inherited handle still releases us
 * after the grace elapses.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/**
 * Kill a process and all its children (cross-platform).
 *
 * On Unix the negative pid targets the whole process group, which requires the
 * child to have been spawned with `detached: true`.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails.
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead.
			}
		}
	}
}

/**
 * Detached child processes are tracked so they can be killed when the WIDI
 * process exits, otherwise a killed parent can orphan a process group. Graceful
 * shutdown aborts the tool calls that own them (which kills their trees and
 * untracks the pids); this set plus the `exit` hook below is a last-resort net
 * for normal event-loop exit and
 * `process.exit()`. Signal termination and fatal native failures can bypass
 * Node's `exit` event, so every process host must also call
 * {@link killTrackedDetachedChildren} from its own synchronous shutdown path.
 */
const trackedDetachedChildPids = new Set<number>();

let exitHookInstalled = false;

/**
 * Install a one-time synchronous `exit` handler that kills every still-tracked
 * detached child. Lazily armed on the first tracked pid so a process that never
 * spawns a detached child pays nothing. This is best-effort only: Node does not
 * emit `exit` for every signal or fatal termination.
 */
function ensureExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", killTrackedDetachedChildren);
}

export function trackDetachedChildPid(pid: number): void {
	ensureExitHook();
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}
