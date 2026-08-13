/**
 * Content addressing for immutable persistence objects.
 *
 * A state root is the hash of what it contains, which is what makes the rest of
 * the model cheap: two refs naming the same state share one object, a fork
 * copies an object at most once, and writing an object twice is a no-op instead
 * of a conflict. It also fixes the write order - an object can be committed
 * before the ref that names it, because its identity does not depend on where
 * the ref landed.
 *
 * Hashing therefore has to be stable across processes and across key insertion
 * order, so JSON.stringify is not enough on its own.
 */

import { createHash } from "node:crypto";

export const CONTENT_HASH_ALGORITHM = "sha256";

/**
 * Deterministic JSON: object keys sorted, arrays left alone, unrepresentable
 * values rejected rather than silently dropped.
 *
 * `JSON.stringify` drops `undefined` properties and turns them into holes in
 * arrays, so two objects that differ would hash the same. An immutable identity
 * is not the place to be forgiving about that.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Persisted objects cannot hold ${String(value)}.`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		const body = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",");
		return `{${body}}`;
	}
	throw new Error(`Persisted objects cannot hold a value of type ${typeof value}.`);
}

/** The state root of an object body, as it appears in a ref. */
export function contentHash(value: unknown): string {
	return `${CONTENT_HASH_ALGORITHM}:${createHash(CONTENT_HASH_ALGORITHM)
		.update(canonicalJson(value), "utf-8")
		.digest("hex")}`;
}

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether a string can be a state root at all.
 *
 * Cheap syntactic check only. A well-formed hash naming an object nobody wrote
 * is a dangling ref, which is a recovery-time diagnostic rather than a parse
 * error.
 */
export function isContentHash(value: string): boolean {
	return CONTENT_HASH_PATTERN.test(value);
}
