/** Convert an unknown thrown value into stable human-readable text. */
export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
