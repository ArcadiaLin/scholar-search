/**
 * Agent message domain.
 *
 * Everything an agent reads as user input is a message: human text, an
 * agent-to-agent message, or a system notice.
 * This module owns what a message is, how extensions may transform or reject
 * it, how its model-facing text is rendered, and in what order concurrent
 * messages reach one target's harness.
 *
 * It deliberately owns no runtime state beyond per-target delivery order. The
 * agent registry, harness references, extension runners, and session
 * persistence stay in the orchestrator and are injected as ports, so the
 * dependency edge runs one way: orchestrator -> message.
 */

import { AgentHarnessError, type AgentHarnessPhase } from "@arcadialin/agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentAbortOrigin, AgentId, AgentIdleReason, PromptOutcome } from "./types.ts";
import { maintenanceKindOf } from "./types.ts";

/**
 * Where a message came from. **Rendering and provenance only** - nothing here
 * decides behavior, so a holder may declare whatever it likes, including a kind
 * core has never heard of.
 *
 * The reason it can be open: the model-facing text comes from the holder's own
 * `render` (see {@link MessageRequest}), so binding `kind` would not stop a
 * holder from producing text identical to any other source's. What does decide
 * behavior is {@link MessageDeliveryPolicy}, which is bound when the sink is
 * handed out and cannot be overridden.
 */
export interface MessageSource {
	/** Core knows `human` and `agent`; anything else is rendered generically. */
	readonly kind: string;
	/** One human-readable line; what a UI shows when it does not know the kind. */
	readonly label?: string;
	/** The source's own payload. Stored verbatim, never interpreted. Must be JSON-serializable. */
	readonly details?: unknown;
}

/**
 * Caller intent, not a harness method. The harness method is chosen at delivery
 * time from the target's live phase: `next_turn` never preempts the reasoning
 * of a turn already in flight, `interrupt` does, and `precede` never wakes the
 * target at all.
 *
 * `precede` is not called `prompt`: `harness.prompt()` means "start a turn now",
 * and one word for two meanings would not survive this file. It describes what
 * a recap does - land on the branch and wait to be read with whatever input
 * comes next.
 */
export type MessageDeliveryMode = "next_turn" | "interrupt" | "precede";

/**
 * What a message does at delivery, as opposed to what it says about itself.
 * Bound when a sink is handed out, never taken from a request: a holder that
 * could set these would be choosing how hard its text lands, not just how it
 * is labelled.
 */
export interface MessageDeliveryPolicy {
	/** Counts as the human interrupting; drives the human-interrupt coordination. */
	readonly humanInterrupt: boolean;
	/** Whether an extension block ends the message or degrades to a diagnostic. */
	readonly blockPolicy: MessageBlockPolicy;
	/** Keep retrying past a delivery failure instead of failing the caller. */
	readonly retryOnFailure: boolean;
	/** Adjacent messages sharing a key merge into one user message. */
	readonly mergeKey?: string;
}

/** What a sink fixes on behalf of its holder. */
export interface MessageSinkBinding {
	/** The default source; a request may override it. */
	readonly source: MessageSource;
	readonly policy: MessageDeliveryPolicy;
	/**
	 * How this sink turns a body into the text the model reads, when the request
	 * does not bring its own. It belongs to the sink rather than to the declared
	 * source: a request that renames its source is choosing a label, and if it
	 * also wants different text it says so with `render`.
	 */
	readonly render?: (body: string) => string;
	/**
	 * This sink's messages land as plain `role:"user"` entries - no type, no
	 * record of a source. True for the shell alone: existing sessions read back
	 * unchanged, and carrying no type at all is what says the user typed it. A
	 * request that overrides the source is no longer the shell speaking and gets
	 * a typed entry like everyone else.
	 */
	readonly plainEntry?: boolean;
}

/** What a holder asks for. Identity is a label here, not a capability. */
export interface MessageRequest {
	readonly targetAgentId: AgentId;
	/** Semantic body, before any source attribution is rendered onto it. */
	readonly body: string;
	/** Overrides the sink's source. Rendering and provenance only. */
	readonly source?: MessageSource;
	/**
	 * Produces the text the model reads. Runs once, at enqueue: the queue
	 * re-attempts delivery across phase changes, and a second run would give one
	 * message two versions. Defaults to {@link renderMessageContent}.
	 */
	readonly render?: (body: string) => string;
	readonly images?: readonly ImageContent[];
	readonly mode: MessageDeliveryMode;
	/** Recorded on the entry, never acted on. See {@link MessageEntryDetails.editedByHuman}. */
	readonly editedByHuman?: true;
}

/** A request resolved against the sink it arrived through. */
export interface MessageDraft extends MessageRequest {
	/** The request's source if it named one, the sink's otherwise. */
	readonly source: MessageSource;
	readonly binding: MessageSinkBinding;
}

/** Everything a holder can do with a bound sink. */
export interface MessageSender {
	send(request: MessageRequest): Promise<MessageSendOutcome>;
}

/**
 * A sender that may also start a turn and wait for its assistant message. Only
 * the trusted shell gets one: `prompt` refuses a busy target rather than
 * queueing, which is the wrong answer for every other holder.
 */
export interface MessageSink extends MessageSender {
	prompt(request: MessageRequest): Promise<PromptOutcome>;
}

/**
 * Delivery-relevant state of a target: the live harness phase, or `undefined`
 * when the target has no routable harness at all.
 *
 * There is no second phase vocabulary parallel to `AgentHarnessPhase`. An agent
 * that is still being created, or already gone, is refused before anything of
 * its reaches this queue; the only way a queued target loses its harness
 * afterwards is disposal, which cancels its queue on the same tick. `undefined`
 * covers the window between those two facts.
 */
export type MessageDeliveryPhase = AgentHarnessPhase | undefined;

/**
 * `append` is the one method that does not wake the target: it writes the
 * message onto the branch at the current leaf, where the next turn reads it
 * along with everything else. It is durable, which is why a recap uses it rather
 * than the harness's in-memory next-turn queue.
 */
export type MessageDeliveryMethod = "prompt" | "follow_up" | "steer" | "append";

export type MessageDeliveryDecision =
	| { readonly kind: "deliver"; readonly method: MessageDeliveryMethod }
	| { readonly kind: "defer" }
	| { readonly kind: "reject"; readonly reason: string };

/**
 * Result of running the extension input pipeline over a message. Structurally
 * the extension runner's own run type minus its diagnostics, so the
 * orchestrator can pass its run straight through without translation.
 */
export type MessageInterceptRun =
	| { readonly kind: "pass" }
	| {
			readonly kind: "transform";
			readonly text: string;
			readonly images?: readonly ImageContent[];
			readonly transformedBy: readonly string[];
	  }
	| { readonly kind: "block"; readonly reason?: string; readonly blockedBy: string };

export interface MessageInterceptEvent {
	readonly type: "input";
	readonly source: MessageSource;
	readonly targetAgentId: AgentId;
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

export type MessageTransformOutcome =
	| { readonly kind: "pass"; readonly text: string; readonly images?: readonly ImageContent[] }
	| {
			readonly kind: "transform";
			readonly text: string;
			readonly images?: readonly ImageContent[];
			readonly transformedBy: readonly string[];
	  }
	| { readonly kind: "block"; readonly reason?: string; readonly blockedBy: string };

/**
 * What a `block` from the input pipeline means for this message.
 *
 * `enforce` ends the message: the human sees a blocked input, an agent sees its
 * tool call fail. `ignore` is for the senders with nobody left to tell. There a
 * block degrades to a diagnostic and the original body is delivered.
 */
export type MessageBlockPolicy = "enforce" | "ignore";

/**
 * The producers core ships with. Anyone else declares its own source and gets
 * the generic treatment; these are the ones whose identity, delivery policy and
 * default rendering core decides.
 */
export type BuiltInMessageProducer =
	| { readonly kind: "human" }
	| {
			readonly kind: "agent";
			readonly senderAgentId: AgentId;
			/**
			 * Set when the runtime is speaking *about* that agent rather than
			 * relaying something it said. See {@link AgentNotice}.
			 */
			readonly notice?: AgentNotice;
	  }
	| { readonly kind: "extension"; readonly extensionId: string };

/**
 * The runtime observing that an agent stopped, as opposed to that agent
 * choosing to speak. The body still carries the agent's own last words; that
 * there will be no more of them is the runtime's to state.
 */
export interface AgentNotice {
	/** `idle`: stopped and not continuing on its own. `gone`: disposed. */
	readonly status: "idle" | "gone";
	/** Only meaningful for `idle`: whether it settled or was cut short. */
	readonly reason?: AgentIdleReason;
	/** Only with `aborted`, and only when the abort was asked for. */
	readonly abortedBy?: AgentAbortOrigin;
}

/** What an agent notice records in `MessageSource.details`. */
export interface AgentNoticeSourceDetails {
	readonly senderAgentId: AgentId;
	readonly notice: AgentNotice;
}

/**
 * Shared by every notice regardless of sender, so a fan-out that finishes
 * together costs the watcher one turn. Safe across senders because merging here
 * concatenates rather than summarizes, and each notice keeps its own tag.
 */
export const AGENT_NOTICE_MERGE_KEY = "agent_notice";

/**
 * Bodies are not escaped, so the tag is a convention, not an isolation boundary.
 */
export function renderAgentNoticeText(senderAgentId: AgentId, notice: AgentNotice, body: string): string {
	const reason = notice.reason === undefined ? "" : ` reason="${notice.reason}"`;
	const abortedBy = notice.abortedBy === undefined ? "" : ` aborted-by="${notice.abortedBy}"`;
	return `<agent-notification from="${senderAgentId}" status="${notice.status}"${reason}${abortedBy}>\n${body}\n</agent-notification>`;
}

/**
 * Everything core decides about a built-in producer, in one place: who it says
 * it is, what its messages do on arrival, and how its text reaches the model.
 *
 * The three are together on purpose. They are the answer to one question - "what
 * is it for this producer to speak?" - and splitting them across a source table,
 * a policy table and a renderer switch is how they drift: a new producer added
 * to two of the three reads as a bug in the third.
 *
 * Attribution is rendered only where the reader needs to know the text is not
 * its own and the body does not already say so.
 */
export function messageBindingFor(producer: BuiltInMessageProducer): MessageSinkBinding {
	switch (producer.kind) {
		case "human":
			// The shell speaking for the person at the keyboard: the only binding
			// that counts as a human interrupt, and the only one whose text reaches
			// the model unmarked, because it is the model's baseline user message.
			return {
				source: { kind: "human" },
				policy: { humanInterrupt: true, blockPolicy: "enforce", retryOnFailure: false },
				render: (body) => body,
				plainEntry: true,
			};
		case "agent": {
			const senderAgentId = producer.senderAgentId;
			const notice = producer.notice;
			if (notice === undefined) {
				return {
					source: { kind: "agent", label: senderAgentId },
					policy: { humanInterrupt: false, blockPolicy: "enforce", retryOnFailure: false },
					render: (body) => `[Message from ${senderAgentId}]\n\n${body}`,
				};
			}
			// `ignore` because an extension able to block this would leave the
			// watcher waiting forever on an agent that will never speak again - the
			// failure the notice exists to remove. `retryOnFailure` because the stop
			// happened once and there is nobody left to tell that telling failed.
			return {
				source: {
					kind: "agent",
					label: senderAgentId,
					details: { senderAgentId, notice } satisfies AgentNoticeSourceDetails,
				},
				policy: {
					humanInterrupt: false,
					blockPolicy: "ignore",
					retryOnFailure: true,
					mergeKey: AGENT_NOTICE_MERGE_KEY,
				},
				render: (body) => renderAgentNoticeText(senderAgentId, notice, body),
			};
		}
		case "extension": {
			const extensionId = producer.extensionId;
			return {
				source: { kind: `extension:${extensionId}`, label: extensionId },
				policy: { humanInterrupt: false, blockPolicy: "enforce", retryOnFailure: false },
				render: (body) => `[Input from extension ${extensionId}]\n\n${body}`,
			};
		}
	}
}

/**
 * Result of accepting a message. A block is a normal outcome, not a failure:
 * the caller decides how to say so - a surface shows a notice, a tool call
 * fails. Sources whose block policy is `ignore` never produce it.
 */
export type MessageSendOutcome =
	| { readonly kind: "accepted" }
	| { readonly kind: "blocked"; readonly inputId: string; readonly reason?: string; readonly blockedBy: string };

export type MessageErrorCode = "message_invalid" | "target_unavailable" | "delivery_rejected";

export class MessageError extends Error {
	readonly code: MessageErrorCode;

	constructor(code: MessageErrorCode, message: string) {
		super(message);
		this.name = "MessageError";
		this.code = code;
	}
}

export function assertMessageBody(body: string): void {
	if (typeof body !== "string" || body.trim().length === 0) {
		throw new MessageError("message_invalid", "Message body must be a non-empty string.");
	}
}

/**
 * The text the model reads, chosen once and applied after interception - so the
 * extension pipeline sees the semantic body and never a rendered one.
 *
 * Three sources of the answer, most specific first: what this request asked for,
 * what its sink renders by default, and finally the body unchanged. The last is
 * for a sink built by hand rather than by {@link messageBindingFor}, where
 * marking the text would be core inventing an attribution nobody asked for.
 */
export function renderMessageContent(draft: MessageDraft, body: string): string {
	return (draft.render ?? draft.binding.render ?? ((text: string) => text))(body);
}

export interface MessageTransformPorts {
	/**
	 * Run the target's extension input pipeline. Returns `pass` when the target
	 * has no live extension runtime.
	 */
	readonly intercept: (event: MessageInterceptEvent) => Promise<MessageInterceptRun>;
}

/**
 * Apply the extension input pipeline to a draft and resolve the block policy
 * for its source. An ignored block keeps the original body: the pipeline
 * reports no text for a run it ended, and earlier handlers' rewrites are not
 * partially applied.
 */
export async function transformMessage(
	draft: MessageDraft,
	ports: MessageTransformPorts,
): Promise<MessageTransformOutcome> {
	const run = await ports.intercept({
		type: "input",
		source: draft.source,
		targetAgentId: draft.targetAgentId,
		text: draft.body,
		images: draft.images,
	});
	if (run.kind === "transform") {
		return { kind: "transform", text: run.text, images: run.images ?? draft.images, transformedBy: run.transformedBy };
	}
	if (run.kind === "block" && draft.binding.policy.blockPolicy === "enforce") {
		return { kind: "block", reason: run.reason, blockedBy: run.blockedBy };
	}
	return { kind: "pass", text: draft.body, images: draft.images };
}

/**
 * Choose how a message reaches the target, given its live phase.
 *
 * `requiresIdle` marks a delivery whose caller awaits the resulting assistant
 * message: it can only be a fresh prompt, so a busy target is a rejection
 * rather than a queued follow-up.
 */
export function decideMessageDelivery(input: {
	readonly phase: MessageDeliveryPhase;
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	readonly targetAgentId: AgentId;
}): MessageDeliveryDecision {
	const { phase, targetAgentId } = input;
	if (phase === undefined) {
		return { kind: "reject", reason: `Agent ${targetAgentId} can no longer receive messages.` };
	}
	// An append drives no agent loop and joins no queue, so no phase can refuse
	// it: the harness buffers the write behind whatever is running and lands it
	// at that operation's save point. It is the one method with no phase gate.
	if (input.mode === "precede") return { kind: "deliver", method: "append" };
	if (input.requiresIdle && phase !== "idle") {
		return { kind: "reject", reason: `Agent ${targetAgentId} cannot accept a prompt while ${phase}.` };
	}
	// Maintenance work does not run an agent loop, so a steer or follow-up would
	// be accepted into a queue nothing drains. It waits for the next phase change
	// instead. A retry is inside a turn, and the loop that resumes will read both
	// queues, so it is delivered exactly like one.
	if (maintenanceKindOf(phase)) return { kind: "defer" };
	if (phase === "idle") return { kind: "deliver", method: "prompt" };
	return { kind: "deliver", method: input.mode === "interrupt" ? "steer" : "follow_up" };
}

/** Outcome of one accepted delivery. */
export interface MessageDeliveryReceipt {
	readonly method: MessageDeliveryMethod;
	/**
	 * The run this delivery started, present only when it began a fresh prompt.
	 * Acceptance never waits for it: `sendMessage` resolves as soon as the
	 * harness owns the text.
	 */
	readonly completed?: Promise<AssistantMessage>;
}

/**
 * What a delivery records about itself, beyond the text the model reads.
 *
 * Absent only for input the shell submits as the human: that lands as a plain
 * `role:"user"` entry, and having no type at all is what says "this is what the
 * user typed". Everything else carries one, so a UI reading the branch back
 * knows who wrote it without inferring anything from the text.
 */
export interface MessageEntryPayload {
	readonly customType: string;
	readonly details: MessageEntryDetails;
}

export interface MessageEntryDetails {
	readonly source: MessageSource;
	/** The body before rendering: what a UI shows, as opposed to what the model read. */
	readonly body: string;
	readonly transformedBy?: readonly string[];
	/**
	 * A human rewrote this body before it was sent. The source still names
	 * whoever produced it, which on its own would file the human's words under
	 * them; a reader has no way to tell from the text.
	 */
	readonly editedByHuman?: true;
}

export interface MessageDeliveryRequest {
	readonly agentId: AgentId;
	readonly method: MessageDeliveryMethod;
	readonly text: string;
	readonly images: readonly ImageContent[] | undefined;
	/** Absent for plain shell input; present for every other source. */
	readonly entry: MessageEntryPayload | undefined;
	/** The batch contains input submitted directly by the human surface. */
	readonly humanInterrupt: boolean;
	/** True when the enqueuing caller awaits `receipt.completed` itself. */
	readonly awaited: boolean;
}

export interface MessageDeliveryPorts {
	/** Re-read immediately before every delivery attempt, never cached. */
	readonly resolvePhase: (agentId: AgentId) => MessageDeliveryPhase;
	readonly deliver: (request: MessageDeliveryRequest) => Promise<MessageDeliveryReceipt>;
}

export interface MessageEnqueueInput {
	readonly targetAgentId: AgentId;
	/** Rendered, post-interception text. */
	readonly text: string;
	/** Absent for plain shell input; present for every other source. */
	readonly entry?: MessageEntryPayload;
	readonly images?: readonly ImageContent[];
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	/** True only for input submitted directly by the human surface. */
	readonly humanInterrupt: boolean;
	/**
	 * Messages sharing a key are merged into one user message when they are
	 * adjacent in the queue. Undefined never merges.
	 */
	readonly mergeKey?: string;
	readonly awaited: boolean;
	/**
	 * Keep the message queued when delivery fails for a reason retrying might
	 * fix, instead of rejecting acceptance. Set for messages whose sender has
	 * already moved on and would otherwise never learn the text was lost - an
	 * agent notice its watcher is waiting for is the motivating case. A caller
	 * awaiting its own run sets it false so the error reaches it.
	 */
	readonly retryOnFailure: boolean;
	/** Notified each time such a failure defers the message. */
	readonly onDeferredFailure?: (error: unknown) => void;
}

interface QueuedMessage {
	readonly text: string;
	readonly entry: MessageEntryPayload | undefined;
	readonly images: readonly ImageContent[] | undefined;
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	readonly humanInterrupt: boolean;
	readonly mergeKey: string | undefined;
	readonly awaited: boolean;
	readonly retryOnFailure: boolean;
	readonly onDeferredFailure: ((error: unknown) => void) | undefined;
	readonly resolve: (receipt: MessageDeliveryReceipt) => void;
	readonly reject: (error: unknown) => void;
	settled: boolean;
}

/**
 * Per-target FIFO delivery with acceptance-order serialization.
 *
 * Without it, two concurrent sends can both observe an idle target and both
 * call `prompt()`. The queue holds the run right, re-resolves the target phase
 * immediately before each attempt, and releases as soon as the harness accepts
 * the text - never waiting for the model run itself.
 *
 * Ordering is per target only. Nothing here is persisted: a runtime restart
 * drops undelivered messages by design.
 */
export class MessageDeliveryQueue {
	private readonly _ports: MessageDeliveryPorts;
	private readonly _queues = new Map<AgentId, QueuedMessage[]>();
	// The batch currently awaiting its harness call. It is no longer in the
	// queue array, so cancellation has to reach it here or its senders would
	// wait on a promise nothing can settle.
	private readonly _inFlight = new Map<AgentId, QueuedMessage[]>();
	private readonly _draining = new Set<AgentId>();
	private readonly _rerun = new Set<AgentId>();
	private readonly _scheduled = new Set<AgentId>();

	constructor(ports: MessageDeliveryPorts) {
		this._ports = ports;
	}

	/** Accept a message and resolve once the target harness owns its text. */
	enqueue(input: MessageEnqueueInput): Promise<MessageDeliveryReceipt> {
		return new Promise<MessageDeliveryReceipt>((resolve, reject) => {
			const queue = this._queues.get(input.targetAgentId) ?? [];
			queue.push({
				text: input.text,
				entry: input.entry,
				images: input.images,
				mode: input.mode,
				requiresIdle: input.requiresIdle,
				humanInterrupt: input.humanInterrupt,
				mergeKey: input.mergeKey,
				awaited: input.awaited,
				retryOnFailure: input.retryOnFailure,
				onDeferredFailure: input.onDeferredFailure,
				resolve,
				reject,
				settled: false,
			});
			this._queues.set(input.targetAgentId, queue);
			this.wake(input.targetAgentId);
		});
	}

	/**
	 * Re-examine a target's queue after a phase change. Safe to call for an
	 * unchanged phase, and the only way a deferred message resumes.
	 */
	wake(agentId: AgentId): void {
		const queue = this._queues.get(agentId);
		if (!queue || queue.length === 0) return;
		if (this._draining.has(agentId)) {
			this._rerun.add(agentId);
			return;
		}
		if (this._scheduled.has(agentId)) return;
		this._scheduled.add(agentId);
		queueMicrotask(() => {
			this._scheduled.delete(agentId);
			void this._drain(agentId);
		});
	}

	/** Whether any message is still waiting for or being handed to this target. */
	hasPending(agentId: AgentId): boolean {
		return (this._queues.get(agentId)?.length ?? 0) > 0 || (this._inFlight.get(agentId)?.length ?? 0) > 0;
	}

	/**
	 * Fail everything outstanding for a target, for example on dispose. This
	 * includes the batch already handed to the harness: its call may never
	 * settle, and its senders must not be left waiting forever.
	 */
	cancel(agentId: AgentId, reason: string): void {
		const outstanding = [...(this._queues.get(agentId) ?? []), ...(this._inFlight.get(agentId) ?? [])];
		this._queues.delete(agentId);
		this._inFlight.delete(agentId);
		for (const message of outstanding) {
			this._fail(message, new MessageError("target_unavailable", reason));
		}
	}

	private async _drain(agentId: AgentId): Promise<void> {
		if (this._draining.has(agentId)) return;
		this._draining.add(agentId);
		try {
			for (;;) {
				const queue = this._queues.get(agentId);
				if (!queue || queue.length === 0) break;
				const head = queue[0];
				if (head.settled) {
					queue.shift();
					continue;
				}

				const decision = decideMessageDelivery({
					phase: this._ports.resolvePhase(agentId),
					mode: head.mode,
					requiresIdle: head.requiresIdle,
					targetAgentId: agentId,
				});
				if (decision.kind === "defer") break;
				if (decision.kind === "reject") {
					queue.shift();
					this._fail(head, new MessageError("delivery_rejected", decision.reason));
					continue;
				}

				const batch = this._takeMergeableBatch(queue);
				const text = batch.map((message) => message.text).join("\n\n");
				// The batch has left the queue array. Publish it so a cancel during
				// the harness call can still settle its senders.
				this._inFlight.set(agentId, batch);
				let failure: { readonly error: unknown } | undefined;
				try {
					const receipt = await this._ports.deliver({
						agentId,
						method: decision.method,
						text,
						entry: mergeEntryPayloads(batch),
						images: head.images,
						humanInterrupt: batch.some((message) => message.humanInterrupt),
						awaited: batch.some((message) => message.awaited),
					});
					for (const message of batch) this._resolve(message, receipt);
				} catch (error) {
					failure = { error };
				} finally {
					if (this._inFlight.get(agentId) === batch) {
						this._inFlight.delete(agentId);
					}
				}
				if (!failure) continue;

				// `busy` and `invalid_state` are expected races against a run that
				// started or ended between resolving the phase and the call, and are
				// retried silently. Anything else is unexpected, but a message whose
				// sender has moved on is still better retried than dropped: keep it
				// queued, report once, and wait for the next phase change. Never
				// retry inline - that could spin against a broken harness.
				const retryable = isRetryableDeliveryError(failure.error);
				// `retryOnFailure` outranks that judgement, because such a message
				// has nobody left to report to. It does not outrank a
				// terminal one: waiting for a phase change on a harness that has
				// been shut down would leave the sender queued behind an agent that
				// can never take it, until an unrelated cancel notices.
				const terminal = isTerminalDeliveryError(failure.error);
				const retried: QueuedMessage[] = [];
				for (const message of batch) {
					// A cancel during the harness call already settled this one.
					if (message.settled) continue;
					if (retryable || (message.retryOnFailure && !terminal)) {
						retried.push(message);
					} else {
						this._fail(message, failure.error);
					}
				}
				if (retried.length === 0) continue;
				if (!retryable) {
					for (const message of retried) {
						message.onDeferredFailure?.(failure.error);
					}
				}
				// Requeue onto the target's live queue. A cancel during the call
				// detached the array this batch came from, and pushing back onto it
				// would strand these senders on a queue nothing drains.
				if (this._queues.get(agentId) === queue) {
					queue.unshift(...retried);
				} else {
					for (const message of retried) {
						this._fail(
							message,
							new MessageError(
								"target_unavailable",
								`Agent ${agentId} stopped receiving messages before the delivery could be retried.`,
							),
						);
					}
				}
				break;
			}
		} finally {
			this._draining.delete(agentId);
			const queue = this._queues.get(agentId);
			if (!queue || queue.length === 0) this._queues.delete(agentId);
			if (this._rerun.delete(agentId) && this.hasPending(agentId)) {
				this.wake(agentId);
			}
		}
	}

	/**
	 * Take the head plus every immediately following message that merges with
	 * it. Images never merge: a merged batch is one user message and a rewritten
	 * image set could not be attributed back to its own body.
	 *
	 * The whole batch is delivered by the head's mode, so a differing mode ends
	 * it: merging across modes would silently re-decide how hard the tail lands.
	 */
	private _takeMergeableBatch(queue: QueuedMessage[]): QueuedMessage[] {
		const head = queue.shift();
		if (!head) return [];
		const batch = [head];
		if (head.mergeKey === undefined || head.images !== undefined) return batch;
		while (queue.length > 0) {
			const next = queue[0];
			if (
				next.settled ||
				next.mergeKey !== head.mergeKey ||
				next.mode !== head.mode ||
				next.images !== undefined ||
				next.requiresIdle
			) {
				break;
			}
			queue.shift();
			batch.push(next);
		}
		return batch;
	}

	private _resolve(message: QueuedMessage, receipt: MessageDeliveryReceipt): void {
		if (message.settled) return;
		message.settled = true;
		message.resolve(receipt);
	}

	private _fail(message: QueuedMessage, error: unknown): void {
		if (message.settled) return;
		message.settled = true;
		message.reject(error);
	}
}

/**
 * One entry for a merged batch. The batch becomes a single user message, so it
 * gets a single record: one source, and the bodies joined the way the texts
 * were, so `details.body` still describes the whole message.
 */
function mergeEntryPayloads(batch: readonly QueuedMessage[]): MessageEntryPayload | undefined {
	const head = batch[0];
	if (!head?.entry) return undefined;
	if (batch.length === 1) return head.entry;
	const transformedBy = batch.flatMap((message) => message.entry?.details.transformedBy ?? []);
	// One human-edited body in the batch makes the merged body human-edited:
	// the merged entry cannot say which part they wrote, and claiming none of
	// it is theirs is the answer that misleads.
	const editedByHuman = batch.some((message) => message.entry?.details.editedByHuman);
	return {
		customType: head.entry.customType,
		details: {
			source: mergeEntrySources(batch),
			body: batch.map((message) => message.entry?.details.body ?? message.text).join("\n\n"),
			...(transformedBy.length === 0 ? undefined : { transformedBy }),
			...(editedByHuman ? { editedByHuman: true as const } : undefined),
		},
	};
}

/**
 * Naming the head would file the whole batch under whoever was first: notices
 * differ in which agent stopped. The kind is unanimous (a `mergeKey` is
 * kind-scoped) so it stays; anything the batch disagrees on is dropped rather
 * than guessed. Nothing is lost - the merged
 * text is self-attributing, each message keeping its own header or tag.
 */
function mergeEntrySources(batch: readonly QueuedMessage[]): MessageSource {
	const sources = batch.map((message) => message.entry?.details.source).filter((source) => source !== undefined);
	const head = sources[0];
	if (head === undefined) return { kind: "merged" };
	if (sources.every((source) => source.label === head.label && source.details === head.details)) return head;
	const label = sources.every((source) => source.label === head.label) ? head.label : undefined;
	return { kind: head.kind, ...(label === undefined ? undefined : { label }) };
}

export function isRetryableDeliveryError(error: unknown): boolean {
	return error instanceof AgentHarnessError && (error.code === "busy" || error.code === "invalid_state");
}

/**
 * The target can never accept anything again. `busy` and `invalid_state`
 * describe a phase the caller can wait out; this one describes a harness that
 * has been shut down, so no amount of waiting or requeueing changes the answer.
 */
export function isTerminalDeliveryError(error: unknown): boolean {
	return error instanceof AgentHarnessError && error.code === "shutdown";
}
