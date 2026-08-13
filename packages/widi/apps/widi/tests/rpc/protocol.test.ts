import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseInbound } from "../../src/rpc/frames.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/rpc/jsonl.ts";
import { ProtocolStdout, type RawWrite } from "../../src/rpc/stdout-guard.ts";

function collect(stream: PassThrough): { lines: string[]; ended: boolean[] } {
	const lines: string[] = [];
	const ended: boolean[] = [];
	attachJsonlLineReader(stream, { onLine: (line) => lines.push(line), onEnd: () => ended.push(true) });
	return { lines, ended };
}

describe("jsonl framing", () => {
	it("reassembles a frame split across chunks", () => {
		const stream = new PassThrough();
		const sink = collect(stream);
		stream.write('{"cmd":"li');
		stream.write('st_agents"}\n');
		expect(sink.lines).toEqual(['{"cmd":"list_agents"}']);
	});

	it("delivers several frames arriving in one chunk", () => {
		const stream = new PassThrough();
		const sink = collect(stream);
		stream.write('{"a":1}\n{"b":2}\n');
		expect(sink.lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("tolerates CRLF and skips blank lines", () => {
		const stream = new PassThrough();
		const sink = collect(stream);
		stream.write('{"a":1}\r\n\n   \n{"b":2}\n');
		expect(sink.lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("drops an unterminated trailing fragment at end of stream", () => {
		const stream = new PassThrough();
		const sink = collect(stream);
		stream.write('{"a":1}\n{"unfinis');
		stream.end();
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(sink.lines).toEqual(['{"a":1}']);
				expect(sink.ended).toEqual([true]);
				resolve();
			}, 5);
		});
	});

	it("serializes one JSON value per line", () => {
		expect(serializeJsonLine({ type: "ready" })).toBe('{"type":"ready"}\n');
	});
});

describe("parseInbound", () => {
	it("classifies a command", () => {
		const parsed = parseInbound('{"id":"1","cmd":"list_agents"}');
		expect(parsed.kind).toBe("command");
		if (parsed.kind !== "command") return;
		expect(parsed.command.cmd).toBe("list_agents");
	});

	it("classifies a human response and a withdrawal", () => {
		const answered = parseInbound(
			'{"type":"human_response","requestId":"r1","response":{"kind":"confirm","confirmed":true}}',
		);
		expect(answered.kind).toBe("human_response");
		const withdrawn = parseInbound('{"type":"human_response","requestId":"r1","cancelled":true}');
		expect(withdrawn.kind).toBe("human_response");
	});

	it("rejects malformed frames with a reason", () => {
		expect(parseInbound("not json").kind).toBe("invalid");
		expect(parseInbound("[1,2]").kind).toBe("invalid");
		expect(parseInbound('{"cmd":7}').kind).toBe("invalid");
		expect(parseInbound('{"cmd":"spawn","id":7}').kind).toBe("invalid");
		expect(parseInbound('{"type":"human_response"}').kind).toBe("invalid");
		expect(parseInbound('{"type":"human_response","requestId":"r1"}').kind).toBe("invalid");
	});
});

describe("ProtocolStdout", () => {
	function immediateWriter(sink: string[]): RawWrite {
		return (text, callback) => {
			sink.push(text);
			setTimeout(() => callback(), 0);
		};
	}

	it("writes frames in order even though each write is async", async () => {
		const written: string[] = [];
		const stdout = new ProtocolStdout({ write: immediateWriter(written) });
		stdout.write("one\n");
		stdout.write("two\n");
		stdout.write("three\n");
		await stdout.drain();
		expect(written).toEqual(["one\n", "two\n", "three\n"]);
	});

	it("drain waits for frames appended while an earlier one was in flight", async () => {
		const written: string[] = [];
		const stdout = new ProtocolStdout({ write: immediateWriter(written) });
		stdout.write("one\n");
		const drained = stdout.drain();
		stdout.write("two\n");
		await drained;
		expect(written).toEqual(["one\n", "two\n"]);
	});

	it("retries a full pipe instead of dropping the frame", async () => {
		const written: string[] = [];
		let attempts = 0;
		const stdout = new ProtocolStdout({
			write: (text, callback) => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("full") as Error & { code?: string };
					error.code = "EAGAIN";
					setTimeout(() => callback(error), 0);
					return;
				}
				written.push(text);
				setTimeout(() => callback(), 0);
			},
		});
		stdout.write("frame\n");
		await stdout.drain();
		expect(attempts).toBe(3);
		expect(written).toEqual(["frame\n"]);
	});

	it("latches on a broken pipe and stops accepting frames", async () => {
		const written: string[] = [];
		const failures: Error[] = [];
		const stdout = new ProtocolStdout({
			write: (text, callback) => {
				const error = new Error("gone") as Error & { code?: string };
				error.code = "EPIPE";
				setTimeout(() => callback(error), 0);
				written.push(text);
			},
			onFailure: (error) => failures.push(error),
		});
		stdout.write("frame\n");
		await stdout.drain();
		expect(failures.map((error) => error.message)).toEqual(["gone"]);
		expect(stdout.failure?.message).toBe("gone");

		stdout.write("after\n");
		await stdout.drain();
		// The consumer has already seen a truncated frame; there is nothing to
		// resynchronise to, so later frames are not attempted.
		expect(written).toEqual(["frame\n"]);
	});
});
