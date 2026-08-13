import { AgentHarnessError } from "@arcadialin/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_NOTICE_MERGE_KEY,
	type BuiltInMessageProducer,
	decideMessageDelivery,
	type MessageDeliveryPhase,
	type MessageDeliveryPorts,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDraft,
	MessageError,
	type MessageInterceptRun,
	messageBindingFor,
	renderMessageContent,
	transformMessage,
} from "../../src/core/message.ts";

function createDeferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const AGENT_BINDING = messageBindingFor({ kind: "agent", senderAgentId: "agent-source" });

function createDraft(overrides: Partial<MessageDraft> = {}): MessageDraft {
	return {
		source: AGENT_BINDING.source,
		binding: AGENT_BINDING,
		targetAgentId: "agent-target",
		body: "please review",
		mode: "next_turn",
		...overrides,
	};
}

interface QueueFixture {
	readonly queue: MessageDeliveryQueue;
	readonly phases: Map<string, MessageDeliveryPhase>;
	readonly delivered: Array<{ method: string; text: string }>;
	readonly deliver: ReturnType<typeof vi.fn>;
}

function createQueue(
	options: {
		/** Passing it explicitly as undefined models a target that is gone. */
		phase?: MessageDeliveryPhase;
		/** Mirror the harness: an accepted prompt puts the target into a turn. */
		promptStartsTurn?: boolean;
		onDeliver?: (method: string, text: string) => void | Promise<void>;
	} = {},
): QueueFixture {
	const phases = new Map<string, MessageDeliveryPhase>([["agent-target", "phase" in options ? options.phase : "idle"]]);
	const delivered: Array<{ method: string; text: string }> = [];
	const handler: MessageDeliveryPorts["deliver"] = async (request) => {
		await options.onDeliver?.(request.method, request.text);
		delivered.push({ method: request.method, text: request.text });
		if (request.method === "prompt" && options.promptStartsTurn !== false) {
			phases.set(request.agentId, "turn");
		}
		return { method: request.method };
	};
	const deliver = vi.fn(handler);
	const queue = new MessageDeliveryQueue({ resolvePhase: (agentId) => phases.get(agentId), deliver });
	return { queue, phases, delivered, deliver };
}

function enqueue(
	fixture: QueueFixture,
	input: {
		text: string;
		mode?: "next_turn" | "interrupt";
		mergeKey?: string;
		requiresIdle?: boolean;
		retryOnFailure?: boolean;
		onDeferredFailure?: (error: unknown) => void;
	},
): Promise<MessageDeliveryReceipt> {
	return fixture.queue.enqueue({
		targetAgentId: "agent-target",
		text: input.text,
		mode: input.mode ?? "next_turn",
		requiresIdle: input.requiresIdle ?? false,
		humanInterrupt: false,
		mergeKey: input.mergeKey,
		awaited: false,
		retryOnFailure: input.retryOnFailure ?? false,
		onDeferredFailure: input.onDeferredFailure,
	});
}

describe("message bindings", () => {
	const render = (producer: BuiltInMessageProducer) =>
		renderMessageContent(createDraft({ binding: messageBindingFor(producer) }), "hello");

	it("attributes cross-agent and extension messages, leaving self-describing text alone", () => {
		expect(render({ kind: "human" })).toBe("hello");
		expect(render({ kind: "agent", senderAgentId: "agent-7" })).toBe("[Message from agent-7]\n\nhello");
		expect(render({ kind: "extension", extensionId: "watchdog" })).toBe("[Input from extension watchdog]\n\nhello");
	});

	// The two halves of a binding are bound for opposite reasons: a request may
	// relabel itself freely, but the text it produces stays the sink's unless it
	// brings its own renderer.
	it("keeps the sink's renderer when a request overrides only the source", () => {
		const binding = messageBindingFor({ kind: "extension", extensionId: "watchdog" });
		const draft = createDraft({ binding, source: { kind: "human" } });
		expect(renderMessageContent(draft, "hello")).toBe("[Input from extension watchdog]\n\nhello");
		expect(renderMessageContent({ ...draft, render: (body) => `> ${body}` }, "hello")).toBe("> hello");
	});
});

describe("message interception", () => {
	async function run(
		draft: MessageDraft,
		intercepted: MessageInterceptRun,
	): Promise<ReturnType<typeof transformMessage>> {
		return await transformMessage(draft, { intercept: async () => intercepted });
	}

	it("passes the source and target to the interceptor", async () => {
		const intercept = vi.fn(async () => ({ kind: "pass" }) as MessageInterceptRun);
		await transformMessage(createDraft(), { intercept });
		expect(intercept).toHaveBeenCalledWith({
			type: "input",
			source: { kind: "agent", label: "agent-source" },
			targetAgentId: "agent-target",
			text: "please review",
			images: undefined,
		});
	});

	it("applies a rewrite and keeps the current images when none are returned", async () => {
		const images = [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }];
		const outcome = await run(createDraft({ images }), {
			kind: "transform",
			text: "rewritten",
			transformedBy: ["policy"],
		});
		expect(outcome).toEqual({ kind: "transform", text: "rewritten", images, transformedBy: ["policy"] });
	});

	it("enforces a block for every source that can be told about it", async () => {
		expect(messageBindingFor({ kind: "human" }).policy.blockPolicy).toBe("enforce");
		expect(messageBindingFor({ kind: "agent", senderAgentId: "agent-1" }).policy.blockPolicy).toBe("enforce");
		expect(messageBindingFor({ kind: "extension", extensionId: "watchdog" }).policy.blockPolicy).toBe("enforce");
		const outcome = await run(createDraft(), { kind: "block", reason: "denied", blockedBy: "guard" });
		expect(outcome).toEqual({ kind: "block", reason: "denied", blockedBy: "guard" });
	});
});

describe("delivery decisions", () => {
	const decide = (phase: MessageDeliveryPhase, mode: "next_turn" | "interrupt" = "next_turn", requiresIdle = false) =>
		decideMessageDelivery({ phase, mode, requiresIdle, targetAgentId: "agent-target" });

	it("prompts an idle target and queues onto a running turn", () => {
		expect(decide("idle")).toEqual({ kind: "deliver", method: "prompt" });
		expect(decide("turn")).toEqual({ kind: "deliver", method: "follow_up" });
		expect(decide("turn", "interrupt")).toEqual({ kind: "deliver", method: "steer" });
	});

	// Compaction and branch summary hold the harness without running an agent
	// loop: a steer accepted here would sit in a queue nothing drains. A retry is
	// inside a turn, so the loop that resumes reads both queues.
	it("defers while the target cannot consume input yet", () => {
		expect(decide("compaction")).toEqual({ kind: "defer" });
		expect(decide("compaction", "interrupt")).toEqual({ kind: "defer" });
		expect(decide("branch_summary")).toEqual({ kind: "defer" });
		expect(decide("retry")).toEqual({ kind: "deliver", method: "follow_up" });
	});

	it("rejects a gone target and a busy target the caller is waiting on", () => {
		expect(decide(undefined).kind).toBe("reject");
		expect(decide("turn", "next_turn", true).kind).toBe("reject");
		expect(decide("idle", "next_turn", true)).toEqual({ kind: "deliver", method: "prompt" });
	});
});

describe("MessageDeliveryQueue", () => {
	it("serializes concurrent sends so only one claims the idle target", async () => {
		const fixture = createQueue({ phase: "idle" });

		const first = enqueue(fixture, { text: "first" });
		const second = enqueue(fixture, { text: "second" });
		await Promise.all([first, second]);

		expect(fixture.delivered).toEqual([
			{ method: "prompt", text: "first" },
			{ method: "follow_up", text: "second" },
		]);
	});

	it("merges adjacent results sharing a key into one user message", async () => {
		const fixture = createQueue({ phase: "turn" });
		const mergeKey = AGENT_NOTICE_MERGE_KEY;

		await Promise.all([
			enqueue(fixture, { text: "notice-1 sent", mergeKey }),
			enqueue(fixture, { text: "notice-2 sent", mergeKey }),
			enqueue(fixture, { text: "a message" }),
		]);

		expect(fixture.delivered).toEqual([
			{ method: "follow_up", text: "notice-1 sent\n\nnotice-2 sent" },
			{ method: "follow_up", text: "a message" },
		]);
	});

	it("holds a message through maintenance and delivers it on the next wake", async () => {
		const fixture = createQueue({ phase: "compaction" });

		const accepted = enqueue(fixture, { text: "queued" });
		await Promise.resolve();
		await Promise.resolve();
		expect(fixture.deliver).not.toHaveBeenCalled();

		fixture.phases.set("agent-target", "idle");
		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([{ method: "prompt", text: "queued" }]);
	});

	it("retries a busy race at the next wake without spinning", async () => {
		let attempts = 0;
		const fixture = createQueue({
			phase: "idle",
			promptStartsTurn: false,
			onDeliver: () => {
				attempts += 1;
				if (attempts === 1) throw new AgentHarnessError("busy", "busy");
			},
		});

		const accepted = enqueue(fixture, { text: "queued" });
		await vi.waitFor(() => expect(attempts).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		// No inline retry: the queue waits to be told the phase moved.
		expect(attempts).toBe(1);
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([{ method: "prompt", text: "queued" }]);
	});

	it("rejects an unexpected failure the sender is still waiting on", async () => {
		const fixture = createQueue({
			phase: "idle",
			onDeliver: () => {
				throw new Error("session write failed");
			},
		});

		await expect(enqueue(fixture, { text: "queued" })).rejects.toThrow("session write failed");
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	// An agent notice has no sender left to tell, so losing it would leave the
	// watcher waiting forever for a report that never arrives.
	it("keeps an unexpected failure queued when its sender has moved on", async () => {
		let attempts = 0;
		const fixture = createQueue({
			phase: "idle",
			promptStartsTurn: false,
			onDeliver: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("session write failed");
			},
		});
		const deferred: unknown[] = [];

		const accepted = enqueue(fixture, {
			text: "notice-1 sent",
			retryOnFailure: true,
			onDeferredFailure: (error) => deferred.push(error),
		});
		await vi.waitFor(() => expect(deferred).toHaveLength(1));
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([{ method: "prompt", text: "notice-1 sent" }]);
	});

	// The batch has already left the queue array while the harness call is in
	// flight. If cancel could not reach it, its senders would wait on a promise
	// nothing is left to settle.
	it("settles a batch that was mid-delivery when the target was cancelled", async () => {
		const stuck = createDeferred<void>();
		const fixture = createQueue({ phase: "idle", onDeliver: async () => await stuck.promise });

		const accepted = enqueue(fixture, { text: "in flight" });
		await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalledTimes(1));
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.cancel("agent-target", "agent disposed");
		await expect(accepted).rejects.toThrow("agent disposed");
		expect(fixture.queue.hasPending("agent-target")).toBe(false);

		// The late failure of the abandoned call must not resurrect the batch.
		stuck.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	it("does not requeue a retryable failure onto a queue that was cancelled", async () => {
		const attempt = createDeferred<void>();
		const fixture = createQueue({
			phase: "idle",
			onDeliver: async () => {
				await attempt.promise;
				throw new AgentHarnessError("busy", "busy");
			},
		});

		const accepted = enqueue(fixture, { text: "in flight", retryOnFailure: true });
		await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalledTimes(1));
		fixture.queue.cancel("agent-target", "agent disposed");
		attempt.resolve();

		await expect(accepted).rejects.toThrow("agent disposed");
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	it("rejects a gone target and fails everything still queued on cancel", async () => {
		const gone = createQueue({ phase: undefined });
		await expect(enqueue(gone, { text: "lost" })).rejects.toBeInstanceOf(MessageError);

		const held = createQueue({ phase: "compaction" });
		const pending = enqueue(held, { text: "pending" });
		await Promise.resolve();
		held.queue.cancel("agent-target", "agent disposed");
		await expect(pending).rejects.toThrow("agent disposed");
		expect(held.queue.hasPending("agent-target")).toBe(false);
	});
});
