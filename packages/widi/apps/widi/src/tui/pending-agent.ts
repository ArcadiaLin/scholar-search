import type { SpawnAgentOptions } from "../core/agent-orchestrator.ts";
import type { RuntimeModel } from "../core/types.ts";
import type { PendingAgentStart, PendingAgentViewState, TuiApplicationState } from "./state.ts";

export interface PendingAgentDisplay {
	/** The profile's own id, which is also the prefix of the id it will be given. */
	readonly profileId: string;
	readonly profileLabel: string;
	/** The workspace the session will open in; `/workspace` rewrites it. */
	readonly cwd: string;
	/** Undefined while the runtime has no authenticated model to offer. */
	readonly model: RuntimeModel | undefined;
	readonly thinkingLevel?: string;
}

export interface PendingAgentRuntime {
	// The orchestrator's own parameter, not a narrowed restatement of it: a
	// method parameter is bivariant, so a narrower one here would keep type
	// checking a call the orchestrator cannot answer.
	spawnAgent(options: SpawnAgentOptions): Promise<string>;
}

export class PendingAgentController {
	private readonly state: TuiApplicationState;
	private readonly runtime: PendingAgentRuntime;
	private inFlight?: { readonly start: PendingAgentStart; readonly promise: Promise<string> };

	constructor(state: TuiApplicationState, runtime: PendingAgentRuntime, display: PendingAgentDisplay) {
		this.state = state;
		this.runtime = runtime;
		this.beginDefault(display);
	}

	beginDefault(display: PendingAgentDisplay): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent({ kind: "default", cwd: display.cwd }, display);
	}

	beginNewSession(
		source: { readonly profileId: string; readonly model: RuntimeModel | undefined },
		display: PendingAgentDisplay,
	): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent(
			{ kind: "new-session", profileId: source.profileId, model: source.model, cwd: display.cwd },
			display,
		);
	}

	cancel(): void {
		this.state.pendingAgent = undefined;
	}

	setModel(model: RuntimeModel): void {
		const pending = this.state.pendingAgent;
		if (!pending) throw new Error("No pending agent is available.");
		const start = pending.start.kind === "new-session" ? { ...pending.start, model } : pending.start;
		this.state.pendingAgent = { ...pending, start, display: { ...pending.display, model } };
	}

	/**
	 * Move the staged session to another directory. Only reachable while nothing
	 * has been spawned, which is the whole reason the intent exists as a value.
	 */
	setWorkspace(cwd: string): void {
		const pending = this.state.pendingAgent;
		if (!pending) throw new Error("No pending agent is available.");
		this.state.pendingAgent = { ...pending, start: { ...pending.start, cwd }, display: { ...pending.display, cwd } };
	}

	async materialize(): Promise<string> {
		const pending = this.state.pendingAgent;
		if (!pending) throw new Error("No pending agent is available.");
		if (this.inFlight?.start === pending.start) {
			return await this.inFlight.promise;
		}

		const promise = this.start(pending.start);
		this.inFlight = { start: pending.start, promise };
		try {
			const agentId = await promise;
			if (this.state.pendingAgent?.start === pending.start) {
				this.state.pendingAgent = undefined;
			}
			return agentId;
		} finally {
			if (this.inFlight?.promise === promise) this.inFlight = undefined;
		}
	}

	private async start(start: PendingAgentStart): Promise<string> {
		if (start.kind === "default") return await this.runtime.spawnAgent({ origin: { kind: "new" }, cwd: start.cwd });
		return await this.runtime.spawnAgent({
			origin: { kind: "new", profileId: start.profileId },
			model: start.model,
			cwd: start.cwd,
		});
	}
}

function createPendingAgent(start: PendingAgentStart, display: PendingAgentDisplay): PendingAgentViewState {
	return { start, timeline: [], draft: "", display: { ...display }, nextLiveItemId: 1 };
}
