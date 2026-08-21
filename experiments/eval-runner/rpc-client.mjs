/**
 * Versioned JSONL RPC client for driving widi-scholar headlessly.
 *
 * This is the only supported automation boundary (`AGENTS.md` §3.3): a benchmark
 * runner drives the namespace through its RPC entry point and **must not** scrape
 * TUI text, parse terminal control sequences, or read session files. Those are
 * all readable, which is exactly why the rule is written down - a runner that
 * reads a session file is coupled to a storage layout that is core's business and
 * free to change.
 *
 * Everything this client reports therefore comes from RPC frames: the `ready`
 * frame, command responses, and the event stream. The one exception is repository
 * revision, which is a fact about the checkout rather than about the run, and is
 * read with `git`.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Bumped when this client's own recorded shape changes, so a stored run can be
 * read back by the code that understands it. Separate from the RPC protocol
 * version, which belongs to WIDI.
 */
export const RUNNER_VERSION = "1";

export class RpcClientError extends Error {
	constructor(message, details) {
		super(message);
		this.name = "RpcClientError";
		this.details = details;
	}
}

/**
 * A running widi RPC subprocess.
 *
 * Started through the namespace's own npm script rather than by reaching into
 * `packages/widi` directly: the script is the documented entry point, and going
 * around it would let a runner drift from how the namespace is actually launched.
 */
export class WidiRpcSession {
	#child;
	#pending = new Map();
	#events = [];
	#stderr = "";
	#readyPromise;
	#closed = false;

	constructor({ repoRoot, namespace = "scholar", script = "widi:rpc", env = process.env }) {
		this.repoRoot = repoRoot;
		this.namespace = namespace;
		this.script = script;

		this.#child = spawn("npm", ["run", "--silent", script], {
			cwd: repoRoot,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		this.#child.stderr.on("data", (chunk) => {
			this.#stderr += String(chunk);
		});

		let resolveReady;
		let rejectReady;
		this.#readyPromise = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});

		createInterface({ input: this.#child.stdout }).on("line", (line) => {
			if (line.trim() === "") return;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				// stdout must carry nothing but JSONL. A non-JSON line is a protocol
				// violation worth failing on, not worth guessing around.
				rejectReady(new RpcClientError("non-JSON line on the RPC stdout stream", { line: line.slice(0, 400) }));
				return;
			}
			if (frame.type === "ready") {
				this.ready = frame;
				resolveReady(frame);
				return;
			}
			if (frame.type === "event") {
				this.#events.push(frame.event);
				return;
			}
			if (frame.type === "response" && frame.id !== undefined) {
				const settle = this.#pending.get(frame.id);
				if (settle) {
					this.#pending.delete(frame.id);
					settle(frame);
				}
			}
		});

		this.#child.on("exit", (code) => {
			this.#closed = true;
			const error = new RpcClientError(`widi rpc exited with code ${code}`, { stderr: this.#stderr.slice(0, 2_000) });
			for (const settle of this.#pending.values()) settle({ ok: false, error: error.message, code: "exited" });
			this.#pending.clear();
			rejectReady(error);
		});
	}

	get stderr() {
		return this.#stderr;
	}

	get events() {
		return this.#events;
	}

	waitReady() {
		return this.#readyPromise;
	}

	/** Send one command and resolve with its response frame. */
	async send(command) {
		if (this.#closed) throw new RpcClientError("the RPC session has already exited");
		const id = `c${this.#pending.size}-${command.cmd}-${this.#events.length}`;
		const settled = new Promise((resolve) => this.#pending.set(id, resolve));
		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return settled;
	}

	/** Send a command and throw unless it succeeded. */
	async require(command) {
		const response = await this.send(command);
		if (!response.ok) {
			throw new RpcClientError(`${command.cmd} failed: ${response.error}`, { code: response.code, command });
		}
		return response.data;
	}

	async shutdown() {
		if (this.#closed) return;
		try {
			await this.send({ cmd: "shutdown" });
		} catch {
			// Already gone; the exit handler has cleaned up.
		}
		await new Promise((resolve) => this.#child.on("exit", resolve));
	}
}

/**
 * The provenance every run must carry (`AGENTS.md` §5.3).
 *
 * Assembled from the RPC surface, not from session files. `budget` comes from the
 * `get_budget` tool because the effective bounds live in the Search Service's
 * configuration, which the runtime does not otherwise expose.
 */
export async function collectProvenance(session, agentId, { widiRevision, extensionVersion, budget } = {}) {
	const snapshot = await session.require({ cmd: "inspect", agentId });
	return {
		runnerVersion: RUNNER_VERSION,
		namespace: session.namespace,
		rpcProtocolVersion: session.ready?.protocolVersion ?? null,
		widiRevision: widiRevision ?? null,
		profile: {
			id: snapshot.profile?.reference?.id ?? null,
			label: snapshot.profile?.reference?.label ?? null,
			source: snapshot.profile?.source?.kind ?? null,
		},
		model: {
			provider: snapshot.model?.provider ?? null,
			id: snapshot.model?.id ?? null,
			baseUrl: snapshot.model?.baseUrl ?? null,
		},
		thinkingLevel: snapshot.thinkingLevel ?? null,
		extensions: {
			ids: snapshot.extensions?.extensionIds ?? [],
			// The runtime tracks whether a loaded extension has gone stale relative to
			// its files. A run made against a stale extension is not reproducible.
			stale: snapshot.extensions?.stale ?? null,
			scholarSearchVersion: extensionVersion ?? null,
		},
		tools: snapshot.tools?.activeToolNames ?? [],
		budget: budget ?? null,
		startupDiagnostics: (session.ready?.diagnostics ?? []).map((entry) => ({
			severity: entry.severity,
			code: entry.code,
		})),
	};
}
