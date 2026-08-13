import { formatError } from "../utils/errors.ts";
import { type OrchestratorDiagnostic, OrchestratorError, toDiagnostic } from "./diagnostics.ts";
import { agentIdFromOperationSource, type OperationSource } from "./operation-source.ts";
import type { AgentId } from "./types.ts";

export type HumanRequestKind = "confirm" | "select" | "multi-select" | "questions" | "input" | "custom";

/**
 * One question inside a kind="questions" batch. Each question is a choice
 * (single or multi) rendered as its own tab in the panel; the whole batch is
 * answered together and returned as one ordered array.
 */
export interface HumanQuestion {
	/** single: one option; multi: any number of options. */
	multiSelect?: boolean;
	/** The question text shown as the tab body. */
	title: string;
	/** Short label for the tab strip; falls back to a "Q<n>" ordinal. */
	header?: string;
	message?: string;
	options: readonly (string | HumanRequestOption)[];
}

/** One question's answer, positionally matching the request's questions. */
export type HumanQuestionAnswer =
	| { kind: "select"; value: string | undefined }
	| { kind: "multi-select"; values: string[] | undefined };

/**
 * A selectable option. A bare string is shorthand for a label that doubles as
 * its value; the object form separates the machine value from the shown label
 * and carries an optional dim description column.
 */
export interface HumanRequestOption {
	label: string;
	value?: string;
	description?: string;
}

export interface NormalizedHumanRequestOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * Collapse the mixed option shape into a uniform {value,label,description}.
 * A string becomes a value that is its own label; an object without an
 * explicit value falls back to its label.
 */
export function normalizeHumanRequestOptions(
	options: readonly (string | HumanRequestOption)[] | undefined,
): NormalizedHumanRequestOption[] {
	if (!options) return [];
	return options.map((option) =>
		typeof option === "string"
			? { value: option, label: option }
			: { value: option.value ?? option.label, label: option.label, description: option.description },
	);
}

export interface HumanRequest {
	source: OperationSource;
	kind: HumanRequestKind;
	title: string;
	message?: string;
	options?: readonly (string | HumanRequestOption)[];
	// For kind="questions": the ordered batch of questions posed together.
	questions?: readonly HumanQuestion[];
	placeholder?: string;
	// Whether the client should offer free-form input alongside options.
	// Absent means the kind's inherent form (input: always, confirm/select:
	// never). Free input is returned as a literal value without interpretation.
	allowFreeInput?: boolean;
	payload?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
	// A provisional request is expected to be withdrawn by its caller's
	// signal as normal control flow (e.g. a manual-input prompt racing a
	// local OAuth callback server). The caller still gets the aborted
	// rejection, but no diagnostic is published for the withdrawal.
	provisional?: boolean;
}

export type HumanRequestDraft = Omit<HumanRequest, "source"> & {
	/**
	 * The call this request belongs to, when a tool is the one asking. The
	 * orchestrator turns it into the tool-scoped source; the agent id stays its
	 * own to fill in, so a tool can name itself and nothing beyond that.
	 *
	 * Without it the request is attributed to the agent as a whole, which is
	 * all a caller that is not a tool can honestly claim.
	 */
	tool?: { readonly toolCallId: string; readonly toolName: string };
};

export interface HumanRequestEnvelope extends Omit<HumanRequest, "signal"> {
	id: string;
	// The requesting agent, resolved by the broker before the handler runs;
	// carries the same value as the human_request_* events so multi-agent
	// consumers never depend on the pending event for identity.
	agentId?: AgentId;
	createdAt: string;
}

export type HumanResponse =
	| { kind: "confirm"; confirmed: boolean }
	| { kind: "select"; value: string | undefined }
	| { kind: "multi-select"; values: string[] | undefined }
	| { kind: "questions"; answers: readonly HumanQuestionAnswer[] }
	| { kind: "input"; value: string | undefined }
	| { kind: "custom"; value: unknown };

export interface ToolHumanHost {
	request(request: HumanRequestDraft): Promise<HumanResponse>;
}

export type HumanRequestEvent =
	| { readonly type: "human_request_pending"; agentId?: AgentId; request: HumanRequestEnvelope }
	| {
			readonly type: "human_request_resolved";
			agentId?: AgentId;
			requestId: string;
			response: HumanResponse;
			completedAt: string;
	  }
	| { readonly type: "human_request_timeout"; agentId?: AgentId; requestId: string; completedAt: string }
	| {
			readonly type: "human_request_cancelled";
			agentId?: AgentId;
			requestId: string;
			reason?: string;
			completedAt: string;
	  };

export type HumanRequestHandler = (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;

export interface HumanRequestBrokerHost {
	findHumanRequestHandler(): HumanRequestHandler | undefined;
	emit(event: HumanRequestEvent): Promise<void>;
	publishDiagnostic(diagnostic: OrchestratorDiagnostic): Promise<void>;
	recordAgentLifecycleFailure(agentId: AgentId, code: string, message: string, error: unknown): Promise<void>;
}

interface PendingHumanRequest {
	agentId?: AgentId;
	cancel(reason?: string): Promise<void>;
}

export class HumanRequestBroker {
	private readonly host: HumanRequestBrokerHost;
	private readonly pendingRequests: Map<string, PendingHumanRequest> = new Map();
	private nextRequestId = 1;

	constructor(host: HumanRequestBrokerHost) {
		this.host = host;
	}

	async request(request: HumanRequest, options: { agentId?: AgentId } = {}): Promise<HumanResponse> {
		const requestHuman = this.host.findHumanRequestHandler();
		const requestId = this.createRequestId();
		const agentId = options.agentId ?? agentIdFromOperationSource(request.source);
		// The caller's signal must not travel inside the envelope: handlers get
		// the broker-owned signal as a separate argument.
		const { signal: _callerSignal, ...requestFacts } = request;
		const envelope: HumanRequestEnvelope = { ...requestFacts, id: requestId, agentId, createdAt: now() };

		if (!requestHuman) {
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "orchestrator.human_request_unhandled",
				message: "No orchestrator client can handle human requests.",
				agentId,
			};
			await this.host.publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		const controller = new AbortController();
		const abortFromCaller = () => controller.abort();

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let cancelPending: (reason?: string) => Promise<void> = async () => {};
		try {
			if (request.signal?.aborted) {
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.human_request_aborted",
					message: "Human request was aborted.",
					agentId,
				});
			}
			const responsePromise = new Promise<HumanResponse>((resolve, reject) => {
				let settled = false;
				let abortHandler: (() => void) | undefined;
				let callerAbortRegistered = false;
				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					if (callerAbortRegistered) {
						request.signal?.removeEventListener("abort", abortFromCaller);
					}
					if (abortHandler) {
						controller.signal.removeEventListener("abort", abortHandler);
					}
				};
				const rejectWithDiagnostic = (diagnostic: OrchestratorDiagnostic, beforeReject?: () => void) => {
					if (settled) return;
					settled = true;
					cleanup();
					beforeReject?.();
					reject(new OrchestratorError(diagnostic));
				};
				abortHandler = () => {
					rejectWithDiagnostic({
						severity: "error",
						code: "orchestrator.human_request_aborted",
						message: "Human request was aborted.",
						agentId,
					});
				};
				controller.signal.addEventListener("abort", abortHandler, { once: true });
				if (request.signal?.aborted) {
					controller.abort();
				} else {
					request.signal?.addEventListener("abort", abortFromCaller, { once: true });
					callerAbortRegistered = request.signal !== undefined;
				}
				cancelPending = async (reason) => {
					if (settled) return;
					await this.host.emit({ type: "human_request_cancelled", agentId, requestId, reason, completedAt: now() });
					rejectWithDiagnostic(
						{
							severity: "error",
							code: "orchestrator.human_request_cancelled",
							message: reason ? `Human request was cancelled: ${reason}` : "Human request was cancelled.",
							agentId,
						},
						() => controller.abort(),
					);
				};
				if (request.timeoutMs !== undefined) {
					timeoutId = setTimeout(() => {
						void this.host.emit({ type: "human_request_timeout", agentId, requestId, completedAt: now() });
						rejectWithDiagnostic(
							{
								severity: "error",
								code: "orchestrator.human_request_timeout",
								message: "Human request timed out.",
								agentId,
							},
							() => controller.abort(),
						);
					}, request.timeoutMs);
				}
				requestHuman(envelope, controller.signal).then(
					(value) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(value);
					},
					(error) => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					},
				);
			});
			this.pendingRequests.set(requestId, { agentId, cancel: (reason) => cancelPending(reason) });
			await this.host.emit({ type: "human_request_pending", agentId, request: envelope });
			const response = await responsePromise;
			this.pendingRequests.delete(requestId);
			await this.host.emit({ type: "human_request_resolved", agentId, requestId, response, completedAt: now() });
			return response;
		} catch (error) {
			this.pendingRequests.delete(requestId);
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.human_request_failed",
				message: formatError(error),
				agentId,
			});
			const withdrawnProvisional =
				request.provisional === true && diagnostic.code === "orchestrator.human_request_aborted";
			if (!withdrawnProvisional) {
				await this.host.publishDiagnostic(diagnostic);
			}
			throw new OrchestratorError(diagnostic);
		}
	}

	async cancel(requestId: string, reason?: string): Promise<boolean> {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) return false;
		await pending.cancel(reason);
		return true;
	}

	async cancelForAgent(agentId: AgentId, reason: string): Promise<void> {
		for (const [requestId, pending] of [...this.pendingRequests]) {
			if (pending.agentId !== agentId) continue;
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this.host.recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to cancel human request ${requestId} for agent ${agentId}: ${formatError(error)}`,
					error,
				);
			}
			this.pendingRequests.delete(requestId);
		}
	}

	async cancelAll(reason: string): Promise<void> {
		for (const [requestId, pending] of [...this.pendingRequests]) {
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this.host.publishDiagnostic({
					severity: "warning",
					code: "orchestrator.dispose_all_failed",
					message: `Failed to cancel human request ${requestId}: ${formatError(error)}`,
				});
			}
			this.pendingRequests.delete(requestId);
		}
	}

	private createRequestId(): string {
		const id = `human-request-${this.nextRequestId}`;
		this.nextRequestId += 1;
		return id;
	}
}

function now(): string {
	return new Date().toISOString();
}
