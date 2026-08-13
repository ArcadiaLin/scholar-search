import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	lookupCommandPresenter,
	presentCommandResult,
	registerCommandPresenter,
	unregisterCommandPresenter,
} from "../../src/tui/command-presenter.ts";
import { widiCommands } from "../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import type { ActionCommand } from "../../src/tui/commands/types.ts";
import type { CommandResultItem } from "../../src/tui/state.ts";
import { theme } from "../../src/tui/theme/theme.ts";
import { stubCommandHost } from "../helpers/command-host.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function commandItem(overrides: Partial<CommandResultItem>): CommandResultItem {
	return {
		type: "command-result",
		id: "command-item-1",
		commandId: "command-1",
		durability: "ephemeral",
		createdAt: "2026-01-01T00:00:00.000Z",
		name: "tree",
		argument: "",
		status: "completed",
		...overrides,
	};
}

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trimEnd());
}

describe("presentCommandResult frame", () => {
	it("renders a running command as a pending line", () => {
		const lines = plain(presentCommandResult(commandItem({ name: "model", status: "running" }), 80));
		expect(lines).toEqual(["/model …"]);
	});

	it("renders a failed command with its error message", () => {
		const lines = plain(
			presentCommandResult(
				commandItem({ name: "model", status: "failed", error: { message: "unknown provider" } }),
				80,
			),
		);
		expect(lines).toEqual(["/model unknown provider"]);
	});

	it("falls back to the formatResult display when no presenter is registered", () => {
		const lines = plain(presentCommandResult(commandItem({ name: "compact", display: "compacted 12000 tokens" }), 80));
		expect(lines).toEqual(["✓ /compact compacted 12000 tokens"]);
	});

	it("falls back to the raw result without a display or presenter", () => {
		const lines = plain(presentCommandResult(commandItem({ name: "agents", result: { count: 2 } }), 80));
		expect(lines[0]).toBe("✓ /agents");
		expect(lines.join("\n")).toContain("count");
	});

	// The command hue is what ties the token typed in the editor to the row it
	// produced; a completed row is the half of that pair the transcript owns.
	it("paints the name of a completed row in the command hue", () => {
		const hex = theme.palette.command ?? theme.palette.accent;
		const value = Number.parseInt(hex.slice(1), 16);
		const sgr = `38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;

		const completed = presentCommandResult(commandItem({ name: "compact", display: "done" }), 80);
		expect(completed[0]).toContain(sgr);

		// In flight and failed rows stay on the frame's dim name: the outcome
		// glyph is not there yet, or the error message owns the line.
		expect(presentCommandResult(commandItem({ name: "compact", status: "running" }), 80)[0]).not.toContain(sgr);
	});
});

describe("command presenter registry", () => {
	afterEach(() => {
		unregisterCommandPresenter("demo");
	});

	it("routes a completed result through a registered lines presenter", () => {
		registerCommandPresenter("demo", { kind: "lines", present: () => ["custom row"] });

		const lines = presentCommandResult(commandItem({ name: "demo", display: "fallback" }), 80);

		expect(lines).toEqual(["custom row"]);
	});

	it("reports a diagnostic when a registration replaces a live one", () => {
		registerCommandPresenter("demo", { kind: "lines", present: () => ["first"] });

		const diagnostic = registerCommandPresenter("demo", { kind: "lines", present: () => ["second"] });

		expect(diagnostic?.code).toBe("command_presenter.overridden");
		expect(presentCommandResult(commandItem({ name: "demo" }), 80)).toEqual(["second"]);
	});

	it("degrades a component presenter to the fallback outside the timeline layer", () => {
		registerCommandPresenter("demo", {
			kind: "component",
			factory: () => ({ render: () => ["component row"], invalidate: () => {} }),
		});

		const lines = plain(presentCommandResult(commandItem({ name: "demo", display: "fallback" }), 80));

		expect(lines).toEqual(["✓ /demo fallback"]);
	});
});

describe("CommandEngine presenter sync", () => {
	const presented: ActionCommand = {
		kind: "action",
		agentPolicy: "runtime",
		name: "presented",
		description: "A command with a presenter.",
		execute: async () => "done",
		presenter: { kind: "lines", present: () => ["presented row"] },
	};

	it("registers the command's presenter and drops it on unregister", () => {
		const engine = new CommandEngine([presented]);
		expect(lookupCommandPresenter("presented")).toBeDefined();

		expect(engine.unregister("presented")).toBe(true);
		expect(lookupCommandPresenter("presented")).toBeUndefined();
	});
});

describe("/tree presenter", () => {
	// The engine constructor syncs the built-in presenters into the registry.
	beforeAll(() => {
		new CommandEngine(widiCommands(stubCommandHost()));
	});

	it("summarizes a bare /tree snapshot on the headline", () => {
		const item = commandItem({ result: { entries: [{ id: "e1" }, { id: "e2" }], leafId: "e2" } });

		const lines = plain(presentCommandResult(item, 100));

		expect(lines).toEqual(["✓ /tree · 2 entries · leaf e2"]);
	});

	it("marks a cancelled navigation", () => {
		const lines = plain(presentCommandResult(commandItem({ result: { cancelled: true } }), 100));
		expect(lines).toEqual(["✓ /tree · navigation cancelled"]);
	});

	it("marks a plain navigation", () => {
		const lines = plain(presentCommandResult(commandItem({ result: { cancelled: false } }), 100));
		expect(lines).toEqual(["✓ /tree · navigated"]);
	});

	it("previews the branch summary under the headline", () => {
		const item = commandItem({
			result: {
				cancelled: false,
				summaryEntry: { type: "branch_summary", summary: "goal line\nsecond\nthird\nfourth\nfifth\nsixth" },
			},
		});

		const lines = plain(presentCommandResult(item, 100));

		expect(lines).toEqual(["✓ /tree · branch summarized", "goal line", "second", "third", "fourth", "… +2 lines"]);
	});

	it("expands the branch summary preview with the transcript toggle", () => {
		const item = commandItem({
			result: { cancelled: false, summaryEntry: { type: "branch_summary", summary: "one\ntwo\nthree\nfour\nfive" } },
		});

		const lines = plain(presentCommandResult(item, 100, { expanded: true }));

		expect(lines).toEqual(["✓ /tree · branch summarized", "one", "two", "three", "four", "five"]);
	});
});
