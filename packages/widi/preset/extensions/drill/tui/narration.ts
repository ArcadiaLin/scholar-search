import type { WidiTuiExtensionApi } from "../../../../apps/widi/src/tui/extension-host/index.ts";

/**
 * The interface talking as itself.
 *
 * Narration and performance have to be told apart on sight, or a new user cannot
 * learn which half of WIDI is answering them - and that is the first thing the
 * tour exists to teach. Narration goes through `chat.insert`, which renders it as
 * an extension row: attributed to drill, ephemeral, gone when the drill is, and
 * costing no turn. The model's own words arrive the ordinary way.
 *
 * It arrives a line at a time for the same reason the model's text does. A block
 * that appears all at once is a wall to be skipped; the same block revealed at
 * reading speed is something a person actually reads, and reading it is the
 * entire purpose.
 */

/** Roughly a line of prose per beat of reading. A blank line is a breath, not a wait. */
const LINE_MS = 420;
const BLANK_LINE_MS = 120;

export class Narrator {
	private readonly api: WidiTuiExtensionApi;
	private rows = 0;

	constructor(api: WidiTuiExtensionApi) {
		this.api = api;
	}

	/** One block of narration, as its own row, revealed line by line. */
	async say(lines: readonly string[]): Promise<void> {
		if (lines.length === 0) return;
		this.rows++;
		const id = `beat-${this.rows}`;
		const shown: string[] = [];
		for (const line of lines) {
			shown.push(line);
			this.api.capability("chat")?.insert(id, shown.join("\n"));
			await delay(line.trim() === "" ? BLANK_LINE_MS : LINE_MS);
		}
	}

	/** What to look at while the next thing happens. Printed, never asserted. */
	async watch(text: string): Promise<void> {
		await this.say([`Watch: ${text}`]);
	}

	/** Where the drill is, on the working line, replaced in place each beat. */
	progress(text: string): void {
		this.api.capability("workingLine")?.set("progress", text);
	}

	/** The keys that drive the drill, named in the footer as they resolve today. */
	keys(text: string): void {
		this.api.capability("footer")?.set("keys", text);
	}

	notice(text: string, ttlMs = 6_000): void {
		this.api.capability("notices")?.post("drill", text, { ttlMs });
	}

	/** Leave nothing of the drill behind on a screen that outlives it. */
	clear(): void {
		this.api.capability("workingLine")?.remove("progress");
		this.api.capability("footer")?.remove("keys");
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
