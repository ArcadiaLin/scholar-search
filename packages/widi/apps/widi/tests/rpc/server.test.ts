import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { HumanResponse } from "../../src/core/human-request.ts";
import { RpcHumanChannel } from "../../src/rpc/human-channel.ts";
import { RpcServer } from "../../src/rpc/server.ts";
import type { RpcCommand, RpcEventFrame, RpcOutbound, RpcResponseFrame } from "../../src/rpc/types.ts";
import { createModelRegistry, createOrchestrator, MemoryExecutionEnv } from "../helpers/orchestrator.ts";

interface Fixture {
	readonly orchestrator: AgentOrchestrator;
	readonly server: RpcServer;
	readonly frames: RpcOutbound[];
	readonly human: RpcHumanChannel;
	readonly drainGate: { open: () => void; pending: () => boolean };
}

async function createFixture(options: { readonly blockDrain?: boolean } = {}): Promise<Fixture> {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	const modelRegistry = await createModelRegistry(env);
	const frames: RpcOutbound[] = [];
	const send = (frame: RpcOutbound): void => {
		frames.push(frame);
	};
	const human = new RpcHumanChannel({ send });

	let release: (() => void) | undefined;
	const drainGate = {
		open: () => {
			release?.();
			release = undefined;
		},
		pending: () => release !== undefined,
	};
	const drain = options.blockDrain
		? () =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		: undefined;

	const server = new RpcServer({ orchestrator, modelRegistry, human, send, drain });
	orchestrator.registerClient(server);
	return { orchestrator, server, frames, human, drainGate };
}

/** Run one command and wait for its answering frame. */
async function call(fixture: Fixture, command: RpcCommand): Promise<RpcResponseFrame> {
	fixture.server.handleCommand(command);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const answer = fixture.frames.find(
			(frame): frame is RpcResponseFrame => frame.type === "response" && frame.id === command.id,
		);
		if (answer) return answer;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`No response for ${command.cmd}`);
}

function eventFrames(fixture: Fixture): RpcEventFrame[] {
	return fixture.frames.filter((frame): frame is RpcEventFrame => frame.type === "event");
}

describe("RpcServer command dispatch", () => {
	it("spawns, lists and inspects an agent by explicit id", async () => {
		const fixture = await createFixture();
		const spawned = await call(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		// Narrowing on `cmd` narrows `data`: no assertion needed to read it.
		const agentId = spawned.data.agentId;
		expect(agentId).toBeTruthy();

		const listed = await call(fixture, { id: "2", cmd: "list_agents" });
		if (!listed.ok || listed.cmd !== "list_agents") throw new Error("list_agents failed");
		expect(listed.data.agents.map((agent) => agent.agentId)).toContain(agentId);

		const inspected = await call(fixture, { id: "3", cmd: "inspect", agentId });
		if (!inspected.ok || inspected.cmd !== "inspect") throw new Error("inspect failed");
		expect(inspected.data.agentId).toBe(agentId);

		await fixture.orchestrator.disposeAll("test");
	});

	it("answers a dispose with the agents it removed", async () => {
		const fixture = await createFixture();
		const spawned = await call(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		const agentId = spawned.data.agentId;

		const disposed = await call(fixture, { id: "2", cmd: "dispose", agentId, reason: "test" });
		if (!disposed.ok || disposed.cmd !== "dispose") throw new Error("dispose failed");
		expect(disposed.data.agentIds).toEqual([agentId]);
	});

	it("refuses a model reference it cannot resolve", async () => {
		const fixture = await createFixture();
		const bad = await call(fixture, {
			id: "1",
			cmd: "spawn",
			origin: { kind: "new" },
			model: "test-provider/no-such-model",
		});
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.error).toContain("Unknown model reference");

		const malformed = await call(fixture, { id: "2", cmd: "spawn", origin: { kind: "new" }, model: "no-slash" });
		if (malformed.ok) throw new Error("expected a refusal");
		expect(malformed.error).toContain("provider/id");
	});

	it("carries the core diagnostic code on a refusal that had one", async () => {
		const fixture = await createFixture();
		const answer = await call(fixture, { id: "1", cmd: "inspect", agentId: "no-such-agent" });
		expect(answer.ok).toBe(false);
		if (answer.ok) return;
		expect(answer.code).toBeTruthy();
	});

	it("refuses an unknown command instead of reporting an empty success", async () => {
		const fixture = await createFixture();
		const answer = await call(fixture, { id: "1", cmd: "bogus" } as unknown as RpcCommand);
		expect(answer.ok).toBe(false);
		if (answer.ok) return;
		expect(answer.error).toContain("Unknown command: bogus");
	});
});

describe("RpcServer human requests", () => {
	it("emits a request frame and resolves from the client's answer", async () => {
		const fixture = await createFixture();
		const asked = fixture.orchestrator.requestHuman({ source: { kind: "system" }, kind: "confirm", title: "Proceed?" });

		let frame = fixture.frames.find((f) => f.type === "human_request");
		for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			frame = fixture.frames.find((f) => f.type === "human_request");
		}
		if (!frame || frame.type !== "human_request") throw new Error("no human_request frame");

		const response: HumanResponse = { kind: "confirm", confirmed: true };
		expect(fixture.human.settle({ type: "human_response", requestId: frame.request.id, response })).toBe(true);
		await expect(asked).resolves.toEqual(response);
	});

	it("rejects the caller when the client withdraws", async () => {
		const fixture = await createFixture();
		const asked = fixture.orchestrator.requestHuman({ source: { kind: "system" }, kind: "input", title: "Name?" });
		let frame = fixture.frames.find((f) => f.type === "human_request");
		for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			frame = fixture.frames.find((f) => f.type === "human_request");
		}
		if (!frame || frame.type !== "human_request") throw new Error("no human_request frame");

		fixture.human.settle({ type: "human_response", requestId: frame.request.id, cancelled: true });
		await expect(asked).rejects.toThrow();
	});

	it("reports an answer to a request it is not holding", async () => {
		const fixture = await createFixture();
		expect(
			fixture.human.settle({
				type: "human_response",
				requestId: "never-asked",
				response: { kind: "confirm", confirmed: true },
			}),
		).toBe(false);
	});
});

describe("RpcServer backpressure", () => {
	it("does not finish receiving an event until the outbound drain resolves", async () => {
		const fixture = await createFixture({ blockDrain: true });
		let settled = false;
		const received = fixture.server
			.receive({ type: "agent_idle", agentId: "a", reason: "settled", idleAt: "now" })
			.then(() => {
				settled = true;
			});

		await new Promise((resolve) => setTimeout(resolve, 10));
		// The frame is already handed over; what is still outstanding is the drain,
		// and that is what keeps the publisher - and so the model loop - waiting.
		expect(eventFrames(fixture)).toHaveLength(1);
		expect(settled).toBe(false);

		fixture.drainGate.open();
		await received;
		expect(settled).toBe(true);
	});
});

describe("wire events survive the wire", () => {
	it("round-trips every event a real agent lifecycle produces", async () => {
		const fixture = await createFixture();
		const agentId = await fixture.orchestrator.spawnAgent({ origin: { kind: "new" } });
		await fixture.orchestrator.spawnAgent({ origin: { kind: "new" }, parent: agentId });
		await fixture.orchestrator.disposeAll("test");

		const frames = eventFrames(fixture);
		expect(frames.length).toBeGreaterThan(0);

		// The invariant the RPC protocol rests on: a projected event is exactly
		// what JSON can carry. A new event type that breaks it fails here rather
		// than in a client's parser.
		for (const frame of frames) {
			expect(JSON.parse(JSON.stringify(frame.event))).toEqual(frame.event);
		}
	});
});
