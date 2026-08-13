import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWidiKeybindings, loadUserKeybindings, matchRequestOptionIndex } from "../../src/tui/keybindings.ts";

describe("loadUserKeybindings", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "widi-keybindings-"));
	});

	afterEach(async () => {
		setKeybindings(createWidiKeybindings());
		await rm(agentDir, { recursive: true, force: true });
	});

	it("returns no bindings and no diagnostics when the file is missing", () => {
		const load = loadUserKeybindings(agentDir);
		expect(load.bindings).toEqual({});
		expect(load.diagnostics).toEqual([]);
	});

	it("overrides default keys with the user's binding", async () => {
		await writeFile(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "app.interrupt": "ctrl+x", "app.request.next": ["n", "tab"] }),
		);

		const load = loadUserKeybindings(agentDir);
		expect(load.diagnostics).toEqual([]);
		const keybindings = createWidiKeybindings(load.bindings);

		// ctrl+x (0x18) now interrupts; escape no longer does.
		expect(keybindings.matches("\x18", "app.interrupt")).toBe(true);
		expect(keybindings.matches("\x1b", "app.interrupt")).toBe(false);
		// Untouched actions keep their defaults (left arrow for the previous request tab).
		expect(keybindings.matches("\x1b[D", "app.request.previous")).toBe(true);
		expect(keybindings.getKeys("app.request.next")).toEqual(["n", "tab"]);
	});

	it("can override built-in tui actions too", async () => {
		await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "tui.select.up": "k" }));

		const load = loadUserKeybindings(agentDir);
		expect(load.diagnostics).toEqual([]);
		const keybindings = createWidiKeybindings(load.bindings);
		expect(keybindings.matches("k", "tui.select.up")).toBe(true);
	});

	it("collects invalid entries as diagnostics and skips them", async () => {
		await writeFile(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "app.nope": "x", "app.exit": "not-a-key", "app.steer": 42, "app.interrupt": "ctrl+q" }),
		);

		const load = loadUserKeybindings(agentDir);
		expect(load.bindings).toEqual({ "app.interrupt": "ctrl+q" });
		expect(load.diagnostics).toHaveLength(3);
		expect(load.diagnostics.map((d) => d.code)).toEqual([
			"keybindings.invalid_entry",
			"keybindings.invalid_entry",
			"keybindings.invalid_entry",
		]);
		expect(load.diagnostics.every((d) => d.severity === "warning")).toBe(true);

		// Invalid entries fall back to defaults; the valid override applies.
		const keybindings = createWidiKeybindings(load.bindings);
		expect(keybindings.matches("\x04", "app.exit")).toBe(true);
		expect(keybindings.matches("\x11", "app.interrupt")).toBe(true);
	});

	it("applies a renamed action under its new name and says so", async () => {
		await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": "ctrl+w" }));

		const load = loadUserKeybindings(agentDir);

		expect(load.bindings).toEqual({ "app.expand": "ctrl+w" });
		expect(load.diagnostics).toHaveLength(1);
		expect(load.diagnostics[0]).toMatchObject({ severity: "warning", code: "keybindings.renamed_action" });
		expect(createWidiKeybindings(load.bindings).matches("\x17", "app.expand")).toBe(true);
	});

	it("reports an unparseable file and keeps defaults", async () => {
		await writeFile(join(agentDir, "keybindings.json"), "{ not json");

		const load = loadUserKeybindings(agentDir);
		expect(load.bindings).toEqual({});
		expect(load.diagnostics).toHaveLength(1);
		expect(load.diagnostics[0]).toMatchObject({ severity: "error", code: "keybindings.read_failed" });
	});

	it("reports a non-object file and keeps defaults", async () => {
		await writeFile(join(agentDir, "keybindings.json"), JSON.stringify(["app.interrupt"]));

		const load = loadUserKeybindings(agentDir);
		expect(load.bindings).toEqual({});
		expect(load.diagnostics).toHaveLength(1);
		expect(load.diagnostics[0]).toMatchObject({ severity: "error", code: "keybindings.read_failed" });
	});

	it("remapped request option keys drive matchRequestOptionIndex", async () => {
		await writeFile(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "app.request.option1": "a", "app.request.option2": "s" }),
		);

		const load = loadUserKeybindings(agentDir);
		setKeybindings(createWidiKeybindings(load.bindings));

		expect(matchRequestOptionIndex("a")).toBe(0);
		expect(matchRequestOptionIndex("s")).toBe(1);
		// The old number keys are unbound from the option actions.
		expect(matchRequestOptionIndex("1")).toBeUndefined();
		expect(matchRequestOptionIndex("2")).toBeUndefined();
		// Options the user did not touch still answer their number keys.
		expect(matchRequestOptionIndex("3")).toBe(2);
	});
});
