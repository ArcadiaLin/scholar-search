/**
 * The RPC protocol: three blocks and no fourth.
 *
 * 1. Commands, a mechanical projection of the orchestrator's public methods
 *    (`apps/widi/docs/orchestrator.md` section 6). Every command that concerns
 *    one agent names it: there is no "current agent" here, because there is
 *    none in core either - `activeAgentId` is TUI state, and agents run
 *    concurrently.
 * 2. The event stream, already carrying `agentId` on every frame.
 * 3. Human requests, a two-way channel with correlation ids.
 *
 * The command set stays a projection on purpose. Inventing a verb per method
 * is how pi ended up with two hand-written unions to keep aligned; here a new
 * orchestrator method is a new case and nothing else.
 *
 * Scope note: an RPC client is not an agent. It stands where the TUI stands,
 * beside the orchestrator, so it addresses the whole runtime rather than one
 * agent's tree. Commands map to `AgentOrchestrator`, never to the
 * identity-bound `AgentToOrchestratorHost`.
 */

import type { AbortResult, CompactResult, ThinkingLevel } from "@arcadialin/agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentProfileOverride } from "../core/agent-profile.ts";
import type { AgentSnapshot } from "../core/agent-types.ts";
import type { CoreDiagnostic } from "../core/diagnostics.ts";
import type { AgentDisposeScope } from "../core/host.ts";
import type { HumanRequestEnvelope, HumanResponse } from "../core/human-request.ts";
import type { MessageDeliveryMode, MessageSendOutcome } from "../core/message.ts";
import type { AgentId, PromptOutcome, RuntimeModel } from "../core/types.ts";
import type { WireOrchestratorEvent } from "./wire-event.ts";

export const RPC_PROTOCOL_VERSION = 1;

/**
 * Where a spawned agent's context comes from.
 *
 * Narrower than the orchestrator's own origin in one place: a resume reference
 * is only ever an address string. The in-process form also accepts a resolved
 * `PersistedSessionInfo`, which is an object this side of the wire has no way
 * to have obtained honestly.
 */
export type RpcSpawnOrigin =
	| { readonly kind: "new"; readonly profileId?: string; readonly profileOverride?: AgentProfileOverride }
	| { readonly kind: "resume"; readonly reference: string }
	| { readonly kind: "fork"; readonly sourceAgentId: AgentId; readonly entryId?: string };

interface RpcCommandBase {
	/** Echoed on the response. Absent means the caller is not correlating. */
	readonly id?: string;
}

export type RpcCommand =
	| (RpcCommandBase & {
			readonly cmd: "spawn";
			readonly origin: RpcSpawnOrigin;
			readonly parent?: AgentId;
			readonly cwd?: string;
			/** Model reference (`provider/id`); refused when unregistered. */
			readonly model?: string;
			readonly thinkingLevel?: ThinkingLevel;
	  })
	| (RpcCommandBase & {
			readonly cmd: "send";
			readonly agentId: AgentId;
			readonly body: string;
			readonly mode: MessageDeliveryMode;
			readonly images?: readonly ImageContent[];
	  })
	| (RpcCommandBase & {
			readonly cmd: "prompt";
			readonly agentId: AgentId;
			readonly body: string;
			readonly images?: readonly ImageContent[];
	  })
	| (RpcCommandBase & { readonly cmd: "abort"; readonly agentId: AgentId })
	| (RpcCommandBase & {
			readonly cmd: "dispose";
			readonly agentId: AgentId;
			readonly scope?: AgentDisposeScope;
			readonly reason?: string;
	  })
	| (RpcCommandBase & { readonly cmd: "compact"; readonly agentId: AgentId; readonly customInstructions?: string })
	| (RpcCommandBase & { readonly cmd: "wait_idle"; readonly agentId: AgentId })
	| (RpcCommandBase & { readonly cmd: "list_agents" })
	| (RpcCommandBase & { readonly cmd: "inspect"; readonly agentId: AgentId })
	| (RpcCommandBase & {
			readonly cmd: "set_model";
			readonly agentId: AgentId;
			/** Model reference (`provider/id`). */
			readonly model: string;
	  })
	| (RpcCommandBase & { readonly cmd: "set_thinking_level"; readonly agentId: AgentId; readonly level: ThinkingLevel })
	| (RpcCommandBase & { readonly cmd: "cancel_human_request"; readonly requestId: string; readonly reason?: string })
	| (RpcCommandBase & { readonly cmd: "shutdown"; readonly reason?: string });

export type RpcCommandName = RpcCommand["cmd"];

/** Result payload per command, so a client can discriminate on `cmd`. */
export interface RpcCommandResults {
	spawn: { readonly agentId: AgentId };
	send: MessageSendOutcome;
	prompt: PromptOutcome;
	abort: AbortResult;
	dispose: { readonly agentIds: readonly AgentId[] };
	compact: CompactResult;
	wait_idle: Record<string, never>;
	list_agents: { readonly agents: readonly AgentSnapshot[] };
	inspect: AgentSnapshot;
	set_model: RuntimeModel;
	set_thinking_level: Record<string, never>;
	cancel_human_request: { readonly cancelled: boolean };
	shutdown: Record<string, never>;
}

/** The client answering a `human_request`, or withdrawing from it. */
export type RpcHumanResponseFrame = { readonly type: "human_response"; readonly requestId: string } & (
	| { readonly response: HumanResponse }
	| { readonly cancelled: true }
);

export type RpcInbound = RpcCommand | RpcHumanResponseFrame;

/**
 * First frame on the stream. `rootAgentId` is simply the first agent created,
 * with no standing the others lack - there is deliberately no command that only
 * it accepts.
 */
export interface RpcReadyFrame {
	readonly type: "ready";
	readonly protocolVersion: number;
	readonly rootAgentId?: AgentId;
	readonly cwd: string;
	readonly agentDir: string;
	readonly diagnostics: readonly CoreDiagnostic[];
}

/**
 * One command's answer. Distributed over the command names so that narrowing on
 * `ok` and then `cmd` narrows `data` too - a client should not have to assert
 * what the payload of a response it just matched is.
 */
export type RpcSuccessFrame = {
	[TCmd in RpcCommandName]: {
		readonly type: "response";
		readonly id?: string;
		readonly cmd: TCmd;
		readonly ok: true;
		readonly data: RpcCommandResults[TCmd];
	};
}[RpcCommandName];

export interface RpcErrorFrame {
	readonly type: "response";
	readonly id?: string;
	/** Whatever the client asked for, which need not be a known command. */
	readonly cmd: string;
	readonly ok: false;
	readonly error: string;
	/** Present when the failure carried a core diagnostic code. */
	readonly code?: string;
}

export type RpcResponseFrame = RpcSuccessFrame | RpcErrorFrame;

export interface RpcEventFrame {
	readonly type: "event";
	readonly event: WireOrchestratorEvent;
}

export interface RpcHumanRequestFrame {
	readonly type: "human_request";
	readonly request: HumanRequestEnvelope;
}

export type RpcOutbound = RpcReadyFrame | RpcResponseFrame | RpcEventFrame | RpcHumanRequestFrame;
