/**
 * JSONL framing: one JSON value per line, in both directions.
 *
 * The reader is byte-oriented rather than line-oriented because a pipe splits
 * wherever it likes: a frame can arrive in three chunks, and two frames can
 * arrive in one. Only a complete line is a frame.
 */

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export interface JsonlLineSink {
	/** A complete line, without its terminator. Never empty. */
	onLine(line: string): void;
	onEnd?: () => void;
}

/**
 * Feed a readable stream into a line sink. Returns the detach.
 *
 * A trailing fragment with no newline is dropped at end of stream rather than
 * delivered: an unterminated line is a frame the writer never finished, and
 * guessing at it is how a protocol starts acting on half a command.
 */
export function attachJsonlLineReader(stream: NodeJS.ReadableStream, sink: JsonlLineSink): () => void {
	let buffer = "";

	const onData = (chunk: Buffer | string): void => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim().length > 0) sink.onLine(line);
			newline = buffer.indexOf("\n");
		}
	};

	const onEnd = (): void => {
		sink.onEnd?.();
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
