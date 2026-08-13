import { describe, expect, it } from "vitest";
import { type JsonValue, normalizeJsonValue } from "../../src/utils/json.ts";

describe("JSON utilities", () => {
	it("returns a detached value with JSON normalization applied", () => {
		const input: Record<string, unknown> = { kept: [1, 2], dropped: undefined, notFinite: Number.NaN };

		const normalized = normalizeJsonValue(input as JsonValue, "Test payload", 1_024);
		(input.kept as number[]).push(3);

		expect(normalized).toEqual({ kept: [1, 2], notFinite: null });
	});

	it("rejects values that JSON cannot represent", () => {
		expect(() => normalizeJsonValue(undefined as unknown as JsonValue, "Test payload", 1_024)).toThrow(TypeError);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => normalizeJsonValue(cyclic as unknown as JsonValue, "Test payload", 1_024)).toThrow(
			/Test payload must be JSON serializable/,
		);
	});

	it("applies byte limits to serialized UTF-8, not character count", () => {
		expect(normalizeJsonValue("你", "Test payload", 5)).toBe("你");
		expect(() => normalizeJsonValue("你", "Test payload", 4)).toThrow(/Test payload exceeds 4 UTF-8 bytes/);
	});
});
