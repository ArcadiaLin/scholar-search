/**
 * RPC mode entry: core's second front end, beside the TUI rather than under it.
 *
 * Startup order is load-bearing.
 *
 * The stdout takeover and the human channel come up first, because
 * `createWidiRuntime` can ask a human before an orchestrator exists - the "ask"
 * project-trust policy runs through the broker during startup.
 *
 * The root agent is then created *before* the client registers, and everything
 * else waits, so `ready` is unconditionally the first frame on the stream.
 * `ready` states the initial facts and every frame after it describes a change
 * to them; a client that saw `agent_spawned` for the root before knowing the
 * protocol version would have to buffer events to interpret them.
 *
 * Only the core halves of extensions load here. That is not a degradation: the
 * dual-entry contract keeps every UI capability on the `tui` export, so a core
 * half has nothing to lose by there being no terminal - see
 * `notes/develop/rpc-mode.md`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_DIR } from "../core/constants.ts";
import { createWidiRuntime } from "../core/runtime-service.ts";
import { formatError } from "../utils/errors.ts";
import { parseInbound } from "./frames.ts";
import { RpcHumanChannel } from "./human-channel.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { RpcServer } from "./server.ts";
import { ProtocolStdout, takeOverStdout } from "./stdout-guard.ts";
import { RPC_PROTOCOL_VERSION, type RpcOutbound } from "./types.ts";

export interface WidiRpcOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	/** Start with no agent at all; the client spawns whatever it needs. */
	readonly noRoot?: boolean;
}

export async function runWidiRpc(options: WidiRpcOptions): Promise<void> {
	const takeover = takeOverStdout();
	if (!takeover) {
		throw new Error("RPC mode needs sole ownership of stdout, and something already took it.");
	}
	const { rawWrite, restore: restoreStdout } = takeover;

	const stdout = new ProtocolStdout({
		write: rawWrite,
		onFailure: (error) => {
			// The consumer has already seen a truncated frame; there is no state to
			// resynchronise to. Say so on stderr, which is still ours, and stop.
			process.stderr.write(`widi rpc: stdout failed: ${error.message}\n`);
			process.exitCode = 1;
			void shutdown("stdout failed");
		},
	});
	const send = (frame: RpcOutbound): void => {
		stdout.write(serializeJsonLine(frame));
	};
	const human = new RpcHumanChannel({ send });

	let server: RpcServer | undefined;
	/**
	 * Work held until `ready` has gone out, so that frame is unconditionally the
	 * first one a client reads.
	 *
	 * Input arriving before then is held rather than refused: a client piped into
	 * stdin has already written its commands by the time anyone could have read
	 * `ready`, and losing them would make the obvious usage wrong. Even the answer
	 * to a malformed frame waits, because "ready is first, always" is a rule a
	 * client can code against and "first, unless you sent bad JSON" is not.
	 *
	 * Human requests are the exception in the other direction: they go out
	 * immediately, and their answers are taken immediately, because startup itself
	 * may be the one asking.
	 */
	const heldUntilReady: (() => void)[] = [];
	const afterReady = (work: () => void): void => {
		if (server) work();
		else heldUntilReady.push(work);
	};

	const route = (line: string): void => {
		const parsed = parseInbound(line);
		if (parsed.kind === "invalid") {
			afterReady(() => send({ type: "response", cmd: "parse", ok: false, error: parsed.message }));
			return;
		}
		if (parsed.kind === "human_response") {
			if (!human.settle(parsed.frame)) {
				afterReady(() =>
					send({
						type: "response",
						cmd: "human_response",
						ok: false,
						error: `Unknown human request: ${parsed.frame.requestId}`,
					}),
				);
			}
			return;
		}
		afterReady(() => server?.handleCommand(parsed.command));
	};

	const detachReader = attachJsonlLineReader(process.stdin, {
		onLine: route,
		onEnd: () => {
			void shutdown("input stream ended");
		},
	});

	let shuttingDown = false;
	let unregisterClient: (() => void) | undefined;
	let disposeRuntime: ((reason: string) => Promise<void>) | undefined;
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	async function shutdown(reason: string): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		detachReader();
		human.closeAll(`Shutting down: ${reason}`);
		unregisterClient?.();
		try {
			await disposeRuntime?.(reason);
		} catch (error) {
			process.stderr.write(`widi rpc: shutdown failed: ${formatError(error)}\n`);
		}
		// Frames already handed over still belong to the consumer.
		await stdout.drain();
		restoreStdout();
		resolveClosed?.();
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void shutdown(signal);
		});
	}

	try {
		const runtime = await createWidiRuntime({
			cwd: options.cwd,
			agentDir: options.agentDir ?? join(homedir(), DEFAULT_AGENT_DIR),
			defaultProfileId: options.profileId,
			requestHuman: human.request,
		});
		disposeRuntime = async (reason) => {
			await runtime.orchestrator.disposeAll(reason);
		};

		const rootAgentId = options.noRoot ? undefined : await runtime.orchestrator.spawnAgent({ origin: { kind: "new" } });

		server = new RpcServer({
			orchestrator: runtime.orchestrator,
			modelRegistry: runtime.services.modelRegistry,
			human,
			send,
			drain: () => stdout.drain(),
			onShutdown: (reason) => {
				void shutdown(reason ?? "client requested shutdown");
			},
		});

		send({
			type: "ready",
			protocolVersion: RPC_PROTOCOL_VERSION,
			rootAgentId,
			cwd: runtime.services.cwd,
			agentDir: runtime.services.agentDir,
			diagnostics: runtime.diagnostics,
		});

		unregisterClient = runtime.orchestrator.registerClient(server);

		// After `ready` and after the client is registered, so a held command's
		// events reach the stream in the same order a fresh one's would.
		for (const work of heldUntilReady.splice(0)) work();
	} catch (error) {
		await shutdown("startup failed");
		throw error;
	}

	await closed;
}

export { RpcServer } from "./server.ts";
export * from "./types.ts";
export type { WireAssistantMessageEvent, WireHarnessEvent, WireOrchestratorEvent } from "./wire-event.ts";
export { toWireEvent } from "./wire-event.ts";
