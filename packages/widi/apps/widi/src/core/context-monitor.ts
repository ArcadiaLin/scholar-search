import { calculateContextTokens, getLastAssistantUsage } from "@arcadialin/agent-core";
import { formatError } from "../utils/errors.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import { modelReference } from "./model-registry.js";
import type { SessionManager } from "./session-manager.ts";
import type { AgentContextUsage, AgentId, OrchestratorEvent, RuntimeModel } from "./types.ts";

interface ContextSubject {
	readonly generation: number;
	readonly model: RuntimeModel;
}

interface ContextProjection {
	readonly generation: number;
	readonly usage?: AgentContextUsage;
}

/** Session-derived context gauge, isolated from agent lifecycle state. */
export class AgentContextMonitor {
	private readonly _sessionManager: SessionManager;
	private readonly _resolve: (agentId: AgentId) => ContextSubject | undefined;
	private readonly _publish: (event: OrchestratorEvent) => Promise<void>;
	private readonly _diagnose: (diagnostic: OrchestratorDiagnostic) => Promise<void>;
	private readonly _projections = new Map<AgentId, ContextProjection>();

	constructor(options: {
		readonly sessionManager: SessionManager;
		readonly resolve: (agentId: AgentId) => ContextSubject | undefined;
		readonly publish: (event: OrchestratorEvent) => Promise<void>;
		readonly diagnose: (diagnostic: OrchestratorDiagnostic) => Promise<void>;
	}) {
		this._sessionManager = options.sessionManager;
		this._resolve = options.resolve;
		this._publish = options.publish;
		this._diagnose = options.diagnose;
	}

	attach(agentId: AgentId, generation: number): void {
		this._projections.set(agentId, { generation });
	}

	detach(agentId: AgentId, generation: number): void {
		if (this._projections.get(agentId)?.generation === generation) {
			this._projections.delete(agentId);
		}
	}

	get(agentId: AgentId): AgentContextUsage | undefined {
		const subject = this._resolve(agentId);
		const projection = this._projections.get(agentId);
		const usage = subject && projection?.generation === subject.generation ? projection.usage : undefined;
		return usage ? { ...usage } : undefined;
	}

	async invalidate(agentId: AgentId): Promise<void> {
		const subject = this._resolve(agentId);
		if (!subject) return;
		await this._set(agentId, subject.generation, undefined);
	}

	async refresh(agentId: AgentId): Promise<number | undefined> {
		const subject = this._resolve(agentId);
		if (!subject) return undefined;
		try {
			const snapshot = await this._sessionManager.getAgentSessionSnapshot(agentId);
			const lastUsage = getLastAssistantUsage([...snapshot.pathToRoot]);
			if (!lastUsage) {
				await this._set(agentId, subject.generation, undefined);
				return undefined;
			}
			const current = this._resolve(agentId);
			if (!current || current.generation !== subject.generation) {
				return undefined;
			}
			const tokens = calculateContextTokens(lastUsage);
			const contextWindow = current.model.contextWindow;
			const usage: AgentContextUsage = {
				tokens,
				contextWindow,
				percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0,
				model: modelReference(current.model),
			};
			await this._set(agentId, current.generation, usage);
			return tokens;
		} catch (error) {
			await this._set(agentId, subject.generation, undefined);
			await this._diagnose({
				severity: "warning",
				code: "orchestrator.context_usage_failed",
				message: `Failed to measure context usage for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
			return undefined;
		}
	}

	private async _set(agentId: AgentId, generation: number, usage: AgentContextUsage | undefined): Promise<void> {
		const subject = this._resolve(agentId);
		if (!subject || subject.generation !== generation) return;
		const previous = this._projections.get(agentId);
		if (
			previous?.generation === generation &&
			previous.usage?.tokens === usage?.tokens &&
			previous.usage?.contextWindow === usage?.contextWindow &&
			previous.usage?.model === usage?.model
		) {
			return;
		}
		this._projections.set(agentId, { generation, ...(usage === undefined ? undefined : { usage: { ...usage } }) });
		await this._publish({
			type: "agent_context_usage_changed",
			agentId,
			usage: usage ? { ...usage } : undefined,
			changedAt: now(),
		});
	}
}

function now(): string {
	return new Date().toISOString();
}
