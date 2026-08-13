/**
 * The protocol's exclusive hold on stdout.
 *
 * Two jobs, and they are separate on purpose. `takeOverStdout` moves every
 * ordinary write out of the way: a `console.log` from an extension, a
 * dependency or a debug leftover would otherwise land inside a JSONL frame and
 * corrupt the stream past parsing. `ProtocolStdout` then owns the real
 * descriptor, serialises frames onto it, and reports when the consumer is
 * behind - which is what lets backpressure reach the model loop instead of
 * queueing frames in memory without bound.
 *
 * Neither is module-level state: a channel is constructed with the writer it
 * owns, so a test drives a fake one instead of the process descriptor.
 */

/** A node stream write in callback form, which is how backpressure surfaces. */
export type RawWrite = (text: string, callback: (error?: Error | null) => void) => void;

/** Write errors worth retrying: the pipe is full, not broken. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EAGAIN", "ENOBUFS", "EWOULDBLOCK"]);

function transientCode(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export interface StdoutTakeover {
	/** The descriptor as it was before the takeover; the protocol's channel. */
	readonly rawWrite: RawWrite;
	readonly restore: () => void;
}

/**
 * Redirect `process.stdout.write` to stderr and hand back the real descriptor.
 *
 * Everything that is not a protocol frame ends up on stderr, where a host can
 * still read it. Returns undefined when a takeover is already in place, so a
 * second caller cannot capture a descriptor that is itself a redirect.
 */
export function takeOverStdout(): StdoutTakeover | undefined {
	const stdout = process.stdout;
	if (isRedirected(stdout.write)) return undefined;

	const rawStdoutWrite = stdout.write.bind(stdout);
	const rawStderrWrite = process.stderr.write.bind(process.stderr);
	const original = stdout.write;

	const redirect = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		return rawStderrWrite(typeof chunk === "string" ? chunk : Buffer.from(chunk), done);
	}) as typeof stdout.write;
	markRedirected(redirect);
	stdout.write = redirect;

	return {
		rawWrite: (text, callback) => {
			rawStdoutWrite(text, callback);
		},
		restore: () => {
			if (stdout.write === redirect) stdout.write = original;
		},
	};
}

const REDIRECT_MARK = "__widiRpcStdoutRedirect";

function markRedirected(write: unknown): void {
	(write as Record<string, boolean>)[REDIRECT_MARK] = true;
}

function isRedirected(write: unknown): boolean {
	return (write as Record<string, boolean> | undefined)?.[REDIRECT_MARK] === true;
}

/**
 * Frames on one descriptor, in order, with a drain a producer can await.
 *
 * Writes are chained rather than issued concurrently: two frames interleaved
 * mid-line are two unparseable lines. A caller that awaits {@link drain} after
 * handing over a frame runs no faster than the consumer reads it.
 */
export class ProtocolStdout {
	private readonly _write: RawWrite;
	private readonly _onFailure: ((error: Error) => void) | undefined;
	private _tail: Promise<void> = Promise.resolve();
	private _failure: Error | undefined;

	constructor(options: { readonly write: RawWrite; readonly onFailure?: (error: Error) => void }) {
		this._write = options.write;
		this._onFailure = options.onFailure;
	}

	/**
	 * The write that ended the channel, if one did. A broken protocol stream is
	 * not recoverable - the consumer has already seen a truncated frame - so the
	 * channel latches instead of dropping single frames silently.
	 */
	get failure(): Error | undefined {
		return this._failure;
	}

	write(text: string): void {
		if (text.length === 0 || this._failure) return;
		this._tail = this._tail.then(() => this._writeChunk(text));
	}

	/**
	 * Resolves once nothing further is queued. Loops because a producer may have
	 * appended to the tail while the previous one was in flight, and a drain that
	 * returned then would report a queue that is still full as empty.
	 */
	async drain(): Promise<void> {
		while (true) {
			const tail = this._tail;
			await tail;
			if (tail === this._tail) return;
		}
	}

	private async _writeChunk(text: string): Promise<void> {
		while (!this._failure) {
			try {
				await new Promise<void>((resolve, reject) => {
					this._write(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				});
				return;
			} catch (error) {
				if (!transientCode(error)) {
					this._failure = error instanceof Error ? error : new Error(String(error));
					this._onFailure?.(this._failure);
					return;
				}
				// Full pipe. Yield so the consumer gets a turn to read.
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	}
}
