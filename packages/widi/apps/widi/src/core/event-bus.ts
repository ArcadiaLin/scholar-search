import { formatError } from "../utils/errors.ts";
import type { OrchestratorClient } from "./client.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type { AgentId, OrchestratorEvent, OrchestratorEventListener } from "./types.ts";

export interface EventPublishOptions {
	readonly sendToListeners?: boolean;
	readonly sendToClients?: boolean;
}

/**
 * Broadcast owner for orchestrator clients and listeners.
 *
 * It deliberately knows nothing about extension observers; those are runner
 * lifecycle concerns and are composed around this bus by the orchestrator.
 */
export class OrchestratorEventBus {
	private readonly _listeners = new Set<OrchestratorEventListener>();
	private readonly _clients = new Map<string, OrchestratorClient<OrchestratorEvent>>();
	private readonly _diagnose: (diagnostic: OrchestratorDiagnostic, options?: EventPublishOptions) => Promise<void>;

	constructor(options: {
		readonly diagnose: (diagnostic: OrchestratorDiagnostic, options?: EventPublishOptions) => Promise<void>;
	}) {
		this._diagnose = options.diagnose;
	}

	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void {
		this._clients.set(client.id, client);
		return () => {
			if (this._clients.get(client.id) === client) {
				this._clients.delete(client.id);
			}
		};
	}

	findHumanRequestHandler(): OrchestratorClient<OrchestratorEvent>["requestHuman"] | undefined {
		return Array.from(this._clients.values()).find((client) => client.requestHuman)?.requestHuman;
	}

	subscribe(listener: OrchestratorEventListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	subscribeAgent(agentId: AgentId, listener: OrchestratorEventListener): () => void {
		return this.subscribe((event) => {
			if ("agentId" in event && event.agentId === agentId) {
				return listener(event);
			}
		});
	}

	async publish(event: OrchestratorEvent, options: EventPublishOptions = {}): Promise<void> {
		const listenerFailures: OrchestratorDiagnostic[] = [];
		if (options.sendToListeners !== false) {
			for (const listener of this._listeners) {
				try {
					await listener(event);
				} catch (error) {
					listenerFailures.push({
						severity: "warning",
						code: "orchestrator.listener_failed",
						message: `Listener failed for event ${event.type}: ${formatError(error)}`,
						agentId: eventAgentId(event),
					});
				}
			}
		}
		if (options.sendToClients !== false) {
			for (const client of this._clients.values()) {
				if (!client.receive) continue;
				try {
					await client.receive(event);
				} catch (error) {
					await this._diagnose(
						{
							severity: "warning",
							code: "orchestrator.client_failed",
							message: `Client failed for event ${event.type}: ${formatError(error)}`,
							agentId: eventAgentId(event),
						},
						{ sendToListeners: options.sendToListeners, sendToClients: false },
					);
				}
			}
		}
		for (const diagnostic of listenerFailures) {
			await this._diagnose(diagnostic, { sendToListeners: false, sendToClients: options.sendToClients });
		}
	}
}

function eventAgentId(event: OrchestratorEvent): AgentId | undefined {
	if ("agentId" in event) return event.agentId;
	return event.type === "diagnostic" ? event.diagnostic.agentId : undefined;
}
