/**
 * The human-request half of the protocol, owned separately from the server.
 *
 * It has to be separate: `createWidiRuntime` can ask a human before the
 * orchestrator exists - the "ask" project-trust policy runs through the broker
 * during startup (`core/runtime-service.ts`) - and a channel that only came up
 * with the server would have nobody to ask. This needs no orchestrator, only
 * the outbound writer, so it is built first and handed to both.
 *
 * That mirrors what the TUI does with `StartupHumanPrompt`, minus the placeholder:
 * here the boot-phase asker and the running-phase asker are one object.
 */

import type { HumanRequestEnvelope, HumanResponse } from "../core/human-request.ts";
import type { RpcHumanRequestFrame, RpcHumanResponseFrame } from "./types.ts";

interface PendingRequest {
	readonly resolve: (response: HumanResponse) => void;
	readonly reject: (error: Error) => void;
	readonly detachAbort: () => void;
}

export class RpcHumanChannel {
	private readonly _send: (frame: RpcHumanRequestFrame) => void;
	private readonly _pending = new Map<string, PendingRequest>();

	constructor(options: { readonly send: (frame: RpcHumanRequestFrame) => void }) {
		this._send = options.send;
	}

	/** The `HumanRequestHandler` shape, bound so it can be passed as a value. */
	readonly request = (request: HumanRequestEnvelope, signal?: AbortSignal): Promise<HumanResponse> => {
		return new Promise<HumanResponse>((resolve, reject) => {
			const onAbort = () => {
				this._pending.delete(request.id);
				reject(new Error(`Human request ${request.id} was aborted.`));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this._pending.set(request.id, {
				resolve,
				reject,
				detachAbort: () => signal?.removeEventListener("abort", onAbort),
			});
			this._send({ type: "human_request", request });
		});
	};

	/**
	 * Settle a parked request from an inbound frame. Returns false when the id is
	 * unknown, which the caller answers as a protocol error rather than ignoring:
	 * a client that answers a request twice has lost track of its own state.
	 */
	settle(frame: RpcHumanResponseFrame): boolean {
		const pending = this._pending.get(frame.requestId);
		if (!pending) return false;
		this._pending.delete(frame.requestId);
		pending.detachAbort();
		if ("cancelled" in frame) {
			pending.reject(new Error(`Human request ${frame.requestId} was cancelled by the client.`));
			return true;
		}
		pending.resolve(frame.response);
		return true;
	}

	/** Abandon everything parked; used when the input stream ends. */
	closeAll(reason: string): void {
		for (const [requestId, pending] of [...this._pending]) {
			this._pending.delete(requestId);
			pending.detachAbort();
			pending.reject(new Error(reason));
		}
	}
}
