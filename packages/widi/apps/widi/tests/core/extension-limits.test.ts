/**
 * What core enforces about a published message and a keyed status.
 *
 * The whole contract is: a kind a renderer can dispatch on, a size a branch can
 * carry, and a copy the publishing extension can no longer reach. Core does not
 * know what any kind means, so nothing here asserts a shape - the shapes and
 * their degrade behavior are the client's, and live in tests/tui.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionMessage, ExtensionStatus } from "../../src/core/extension/api.ts";
import {
	MAX_EXTENSION_MESSAGE_BYTES,
	validateExtensionMessage,
	validateExtensionStatus,
} from "../../src/core/extension/api.ts";
import { EXTENSION_MESSAGE_CUSTOM_TYPE } from "../../src/core/session-manager.ts";
import { createOrchestrator, MemoryExecutionEnv, requireLiveAgent } from "../helpers/orchestrator.ts";

describe("validateExtensionMessage", () => {
	it("carries any shape through beside its kind", () => {
		const messages: ExtensionMessage[] = [
			{ kind: "text", content: "plain" },
			{ kind: "table", columns: [{ label: "Path" }], rows: [["src/a.ts"]] },
			// A kind core has never heard of, which is the point: the vocabulary
			// belongs to whoever renders it.
			{ kind: "acme:coverage", percent: 91.2, files: [{ path: "src/a.ts", covered: true }] },
		];

		for (const message of messages) {
			expect(validateExtensionMessage(message)).toEqual(message);
		}
	});

	it("requires a kind a renderer can dispatch on", () => {
		const invalid = [
			{ content: "no kind" },
			{ kind: "", content: "x" },
			{ kind: "has space", content: "x" },
			{ kind: 7, content: "x" },
			{ kind: "x".repeat(129), content: "x" },
		];

		for (const message of invalid) {
			expect(() => validateExtensionMessage(message as unknown as ExtensionMessage)).toThrow();
		}
	});

	it("returns a copy detached and frozen all the way down", () => {
		const table = { kind: "table" as const, columns: [{ label: "Path" }], rows: [["src/a.ts"]] };

		const validated = validateExtensionMessage(table);
		table.rows[0][0] = "mutated";
		table.rows.push(["appended"]);
		table.columns[0].label = "mutated";

		expect(validated).toEqual({ kind: "table", columns: [{ label: "Path" }], rows: [["src/a.ts"]] });
		expect(Object.isFrozen(validated)).toBe(true);
		expect(Object.isFrozen((validated.rows as string[][])[0])).toBe(true);
	});

	it("bounds the serialized message as a whole", () => {
		expect(() => validateExtensionMessage({ kind: "text", content: "x".repeat(MAX_EXTENSION_MESSAGE_BYTES) })).toThrow(
			RangeError,
		);
	});

	it("refuses a value that cannot be written", () => {
		const cyclic: Record<string, unknown> = { kind: "text" };
		cyclic.self = cyclic;
		expect(() => validateExtensionMessage(cyclic as unknown as ExtensionMessage)).toThrow(TypeError);
	});

	it("keeps the persisted message and event immutable for consumers", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		let nestedMutationSucceeded = false;
		let envelopeMutationSucceeded = false;
		let eventWasFrozen = false;
		let downstreamMessage: ExtensionMessage | undefined;
		orchestrator.subscribe((event) => {
			if (event.type !== "extension_message_published" || event.message.kind !== "table") {
				return;
			}
			eventWasFrozen = Object.isFrozen(event);
			try {
				const firstRow = (event.message.rows as unknown as string[][])[0] as string[];
				firstRow[0] = "forged";
				nestedMutationSucceeded = true;
			} catch {
				// Runtime immutability is the behavior under test.
			}
			try {
				(event as unknown as { message: ExtensionMessage }).message = { kind: "text", content: "forged" };
				envelopeMutationSucceeded = true;
			} catch {
				// Runtime immutability is the behavior under test.
			}
		});
		orchestrator.subscribe((event) => {
			if (event.type === "extension_message_published") {
				downstreamMessage = event.message;
			}
		});
		const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");

		await runner
			.createContext("sample")
			.actions.publishMessage({ kind: "table", columns: [{ label: "Path" }], rows: [["original"]] });

		const tree = await orchestrator.getAgentSessionTree(agentId);
		const entry = tree.entries.find(
			(candidate) => candidate.type === "custom" && candidate.customType === EXTENSION_MESSAGE_CUSTOM_TYPE,
		);
		expect(eventWasFrozen).toBe(true);
		expect(nestedMutationSucceeded).toBe(false);
		expect(envelopeMutationSucceeded).toBe(false);
		expect(Object.isFrozen(downstreamMessage)).toBe(true);
		expect(entry?.type === "custom" && Object.isFrozen(entry.data)).toBe(true);
		expect(downstreamMessage).toMatchObject({ kind: "table", rows: [["original"]] });
		expect(JSON.stringify(tree)).toContain(EXTENSION_MESSAGE_CUSTOM_TYPE);
		expect(JSON.stringify(tree)).toContain("original");
		expect(JSON.stringify(tree)).not.toContain("forged");
	});
});

describe("validateExtensionStatus", () => {
	it("carries any shape through, frozen", () => {
		const status: ExtensionStatus = {
			text: "Indexing",
			progress: { completed: 3, total: 10 },
			region: "footer",
			icon: "👍🏽",
			tone: "info",
		};

		const validated = validateExtensionStatus(status);

		expect(validated).toEqual(status);
		expect(Object.isFrozen(validated)).toBe(true);
	});

	it("bounds what a status may carry", () => {
		expect(() => validateExtensionStatus({ text: "x".repeat(9_000) })).toThrow(RangeError);
	});
});
