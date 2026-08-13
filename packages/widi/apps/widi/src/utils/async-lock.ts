/**
 * Process-local FIFO lock for serializing asynchronous read-modify-write
 * operations. It does not coordinate across processes.
 */
export class AsyncLock {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		let release: (() => void) | undefined;
		const previous = this.tail;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}
}
