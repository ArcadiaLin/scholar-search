import type { HumanRequestEnvelope, HumanResponse } from "./human-request.ts";

export interface OrchestratorClient<TEvent = unknown> {
	id: string;
	receive?: (event: TEvent) => void | Promise<void>;
	requestHuman?: (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;
}
