/**
 * The protocol side of RPC mode: one orchestrator client that speaks JSONL.
 *
 * It is a client in the exact sense `core/client.ts` means, which is why this
 * mode needs no new core seam - the TUI registers the same way. `receive`
 * awaits the outbound drain, and because every hop from the harness up
 * (`agent-harness.ts` emitAny, `_handleHarnessEvent`, `event-bus.ts` publish)
 * awaits its callee, a consumer that reads slowly throttles the model loop
 * rather than growing a queue in memory.
 *
 * The cost of that, which the TUI does not pay: one bus, one client and one
 * write tail are shared by every agent, so a slow consumer slows all of them
 * and not just the one it is reading about. Accepted for v1 - "everything slows
 * down" is a safe failure and unbounded buffering is not.
 *
 * Commands are dispatched as they arrive rather than queued behind each other:
 * a `wait_idle` on one agent must not stall a `send` to another.
 */

import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type { OrchestratorClient } from "../core/client.ts";
import { OrchestratorError } from "../core/diagnostics.ts";
import type { HumanRequestEnvelope, HumanResponse } from "../core/human-request.ts";
import { MessageError, type MessageSink, messageBindingFor } from "../core/message.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import type { OrchestratorEvent, RuntimeModel } from "../core/types.ts";
import { formatError } from "../utils/errors.ts";
import type { RpcHumanChannel } from "./human-channel.ts";
import type { RpcCommand, RpcCommandName, RpcCommandResults, RpcOutbound, RpcSuccessFrame } from "./types.ts";
import { toWireEvent } from "./wire-event.ts";

export interface RpcServerOptions {
	readonly orchestrator: AgentOrchestrator;
	readonly modelRegistry: ModelRegistry;
	readonly human: RpcHumanChannel;
	readonly send: (frame: RpcOutbound) => void;
	/** Awaited after each event frame. Omitted means no backpressure coupling. */
	readonly drain?: () => Promise<void>;
	readonly onShutdown?: (reason?: string) => void;
}

export class RpcServer implements OrchestratorClient<OrchestratorEvent> {
	readonly id = "rpc";

	/**
	 * A bound value, not a method: `findHumanRequestHandler` pulls this off the
	 * client and calls it detached (`core/event-bus.ts`), so a prototype method
	 * would run with no `this`. The channel's own `request` is already bound.
	 */
	readonly requestHuman: (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;

	private readonly _orchestrator: AgentOrchestrator;
	private readonly _models: ModelRegistry;
	private readonly _send: (frame: RpcOutbound) => void;
	private readonly _drain: (() => Promise<void>) | undefined;
	private readonly _onShutdown: ((reason?: string) => void) | undefined;
	private readonly _sink: MessageSink;

	constructor(options: RpcServerOptions) {
		this._orchestrator = options.orchestrator;
		this._models = options.modelRegistry;
		this.requestHuman = options.human.request;
		this._send = options.send;
		this._drain = options.drain;
		this._onShutdown = options.onShutdown;
		// Fixed at construction, like every other sink holder: the policy belongs
		// to the binding and a request may not override it. An RPC peer speaks in
		// the human's place, so it gets the human binding.
		this._sink = options.orchestrator.messageSinkFor(messageBindingFor({ kind: "human" }));
	}

	async receive(event: OrchestratorEvent): Promise<void> {
		this._send({ type: "event", event: toWireEvent(event) });
		await this._drain?.();
	}

	/**
	 * Run one command and answer it. A rejection becomes an error response, so a
	 * refused command never reaches the process as an unhandled rejection.
	 */
	handleCommand(command: RpcCommand): void {
		void this._dispatch(command).catch((error: unknown) => {
			this.fail(command.id, command.cmd, formatError(error), errorCode(error));
		});
	}

	fail(id: string | undefined, cmd: string, error: string, code?: string): void {
		this._send(
			code === undefined
				? { type: "response", id, cmd, ok: false, error }
				: { type: "response", id, cmd, ok: false, error, code },
		);
	}

	private async _dispatch(command: RpcCommand): Promise<void> {
		const data = await this._run(command);
		// The switch in `_run` pairs each `cmd` with its own result, which the
		// distributed response type states but no inference can carry across the
		// call. The cast is that pairing, asserted once here.
		this._send({ type: "response", id: command.id, cmd: command.cmd, ok: true, data } as RpcSuccessFrame);
	}

	private async _run(command: RpcCommand): Promise<RpcCommandResults[RpcCommandName]> {
		const orchestrator = this._orchestrator;
		switch (command.cmd) {
			case "spawn": {
				const agentId = await orchestrator.spawnAgent({
					origin: command.origin,
					parent: command.parent,
					cwd: command.cwd,
					model: command.model === undefined ? undefined : this._requireModel(command.model),
					thinkingLevel: command.thinkingLevel,
				});
				return { agentId };
			}
			case "send":
				return await this._sink.send({
					targetAgentId: command.agentId,
					body: command.body,
					mode: command.mode,
					images: command.images,
				});
			case "prompt":
				return await this._sink.prompt({
					targetAgentId: command.agentId,
					body: command.body,
					mode: "next_turn",
					images: command.images,
				});
			case "abort":
				return await orchestrator.abortAgent(command.agentId, "human");
			case "dispose": {
				const agentIds = await orchestrator.disposeAgent(command.agentId, {
					intent: "removed",
					scope: command.scope,
					reason: command.reason,
				});
				return { agentIds };
			}
			case "compact":
				return await orchestrator.compactAgent(command.agentId, command.customInstructions);
			case "wait_idle":
				await orchestrator.waitForAgentIdle(command.agentId);
				return {};
			case "list_agents":
				return { agents: orchestrator.listAgents().agents };
			case "inspect":
				return orchestrator.inspectAgent(command.agentId);
			case "set_model":
				return await orchestrator.setAgentModelByReference(command.agentId, command.model);
			case "set_thinking_level":
				await orchestrator.setAgentThinkingLevel(command.agentId, command.level);
				return {};
			case "cancel_human_request":
				return { cancelled: await orchestrator.cancelHumanRequest(command.requestId, command.reason) };
			case "shutdown":
				this._onShutdown?.(command.reason);
				return {};
			default:
				// The union is exhaustive above; this is a frame off the wire, so the
				// name is whatever the client typed. Answering `ok` with no data
				// would let a typo read as success.
				throw new Error(`Unknown command: ${(command as { cmd: string }).cmd}`);
		}
	}

	/**
	 * A `provider/id` reference resolved against the registry, for the one path
	 * that needs the model object up front. Everything else routes through
	 * `setAgentModelByReference`, which resolves it in core.
	 */
	private _requireModel(reference: string): RuntimeModel {
		const separator = reference.indexOf("/");
		if (separator <= 0 || separator === reference.length - 1) {
			throw new Error(`Model reference must be 'provider/id': ${reference}`);
		}
		const model = this._models.find(reference.slice(0, separator), reference.slice(separator + 1));
		if (!model) throw new Error(`Unknown model reference: ${reference}`);
		return model;
	}
}

function errorCode(error: unknown): string | undefined {
	if (error instanceof OrchestratorError) return error.code;
	if (error instanceof MessageError) return error.code;
	return undefined;
}
