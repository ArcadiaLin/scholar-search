import type { Result } from "@arcadialin/agent-core";

/** Return a successful result value or throw its original error. */
export function unwrapResult<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}
