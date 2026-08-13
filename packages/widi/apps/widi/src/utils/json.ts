import { formatError } from "./errors.ts";
import { utf8ByteLength } from "./text.ts";

/** JSON-shaped data accepted at typed boundaries before runtime normalization. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Validate and bound an opaque JSON value, returning the normalized detached
 * value produced by the same round-trip used for persistence and transport.
 *
 * The parameter is typed for callers, but validation remains defensive because
 * values can cross untyped extension and storage boundaries at runtime.
 */
export function normalizeJsonValue(value: JsonValue, label: string, maxBytes: number): JsonValue {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new TypeError(`${label} must be JSON serializable: ${formatError(error)}`);
	}
	if (serialized === undefined) {
		throw new TypeError(`${label} must be JSON serializable.`);
	}
	if (utf8ByteLength(serialized) > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
	return JSON.parse(serialized) as JsonValue;
}

/**
 * Make a normalized value's runtime behavior match the readonly type it is
 * handed out under. Recursive, so one holder cannot change what a later holder
 * sees through a nested array or object.
 */
export function freezeJsonValue(value: JsonValue): JsonValue {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeJsonValue(child);
	return Object.freeze(value);
}
