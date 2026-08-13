import { describe, expect, it } from "vitest";
import { type ClipboardEnvironment, copyToClipboard } from "../../src/utils/clipboard.ts";

interface Recorder {
	readonly environment: ClipboardEnvironment;
	readonly sync: string[];
	readonly streamed: string[];
	readonly terminal: string[];
}

function recorder(options: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	failing?: readonly string[];
	streamedExit?: number;
}): Recorder {
	const failing = new Set(options.failing ?? []);
	const sync: string[] = [];
	const streamed: string[] = [];
	const terminal: string[] = [];
	return {
		sync,
		streamed,
		terminal,
		environment: {
			platform: options.platform ?? "linux",
			env: options.env ?? {},
			runSync: (command) => {
				sync.push(command);
				if (failing.has(command)) throw new Error(`${command} failed`);
			},
			runStreamed: async (command) => {
				streamed.push(command);
				return failing.has(command) ? 1 : (options.streamedExit ?? 0);
			},
			writeTerminal: (data) => {
				terminal.push(data);
			},
		},
	};
}

const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

describe("copyToClipboard", () => {
	it("uses pbcopy on darwin and stays off the terminal", async () => {
		const { environment, sync, terminal } = recorder({ platform: "darwin" });

		await copyToClipboard("hello", environment);

		expect(sync).toEqual(["pbcopy"]);
		expect(terminal).toEqual([]);
	});

	it("uses clip on windows", async () => {
		const { environment, sync } = recorder({ platform: "win32" });

		await copyToClipboard("hello", environment);

		expect(sync).toEqual(["clip"]);
	});

	it("prefers wl-copy on a wayland session", async () => {
		const { environment, sync, streamed, terminal } = recorder({ env: { WAYLAND_DISPLAY: "wayland-0" } });

		await copyToClipboard("hello", environment);

		expect(streamed).toEqual(["wl-copy"]);
		expect(sync).toEqual([]);
		expect(terminal).toEqual([]);
	});

	it("falls back from a failing wl-copy to xclip", async () => {
		const { environment, sync, streamed } = recorder({
			env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
			failing: ["wl-copy"],
		});

		await copyToClipboard("hello", environment);

		expect(streamed).toEqual(["wl-copy"]);
		expect(sync).toEqual(["xclip -selection clipboard"]);
	});

	it("falls back from a failing xclip to xsel", async () => {
		const { environment, sync } = recorder({ env: { DISPLAY: ":0" }, failing: ["xclip -selection clipboard"] });

		await copyToClipboard("hello", environment);

		expect(sync).toEqual(["xclip -selection clipboard", "xsel --clipboard --input"]);
	});

	it("tries termux first when it is a termux session", async () => {
		const { environment, sync } = recorder({ env: { TERMUX_VERSION: "0.118" } });

		await copyToClipboard("hello", environment);

		expect(sync).toEqual(["termux-clipboard-set"]);
	});

	it("falls back to OSC 52 when no tool is available", async () => {
		const { environment, sync, terminal } = recorder({ env: {} });

		await copyToClipboard("hello", environment);

		expect(sync).toEqual([]);
		expect(terminal).toEqual([osc52("hello")]);
	});

	it("also emits OSC 52 in a remote session, where the local clipboard is the server's", async () => {
		const { environment, sync, terminal } = recorder({
			platform: "darwin",
			env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
		});

		await copyToClipboard("hello", environment);

		expect(sync).toEqual(["pbcopy"]);
		expect(terminal).toEqual([osc52("hello")]);
	});

	it("refuses an OSC 52 payload past the length terminals cope with", async () => {
		const { environment, terminal } = recorder({ env: {} });

		await expect(copyToClipboard("x".repeat(100_000), environment)).rejects.toThrow(/too large for OSC 52/);
		expect(terminal).toEqual([]);
	});

	it("does not fail a remote copy that a tool already made, however large", async () => {
		const { environment, sync, terminal } = recorder({ platform: "darwin", env: { MOSH_CONNECTION: "1" } });

		await copyToClipboard("x".repeat(100_000), environment);

		expect(sync).toEqual(["pbcopy"]);
		expect(terminal).toEqual([]);
	});
});
