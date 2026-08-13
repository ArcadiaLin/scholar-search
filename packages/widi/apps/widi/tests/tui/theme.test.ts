import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistentMessageItem } from "../../src/tui/state.ts";
import {
	defaultPalette,
	getAllThemes,
	getThemeName,
	loadThemes,
	resetThemes,
	setTheme,
	type ThemePalette,
	theme,
} from "../../src/tui/theme/theme.ts";
import { renderTimelineItem, type TimelineRenderContext } from "../../src/tui/views/utils/timeline-item.ts";

const HOT_PALETTE: ThemePalette = {
	accent: "#ff0000",
	ok: "#00ff00",
	warn: "#ffff00",
	error: "#ff00ff",
	info: "#00ffff",
	muted: "#888888",
	faint: "#444444",
	rule: "#00ff00",
	surface: "#101010",
};

const renderContext: TimelineRenderContext = {
	liveThinkingIds: new Set(),
	livePreparingAssistantIds: new Set(),
	toolOutputExpanded: false,
};

async function writeTheme(agentDir: string, file: string, content: unknown): Promise<void> {
	await mkdir(join(agentDir, "themes"), { recursive: true });
	await writeFile(join(agentDir, "themes", file), typeof content === "string" ? content : JSON.stringify(content));
}

describe("theme registry and holder", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "widi-themes-"));
	});

	afterEach(async () => {
		resetThemes();
		await rm(agentDir, { recursive: true, force: true });
	});

	it("lists the default palette as the first and only theme before any load", () => {
		expect(getThemeName()).toBe("default");
		expect(getAllThemes()).toEqual([{ name: "default", sourcePath: undefined }]);
		expect(setTheme("no-such-theme")).toBe(false);
		expect(getThemeName()).toBe("default");
	});

	it("hands old references the new paints after a theme switch", async () => {
		// `theme` is captured at module scope above, the way every component
		// imports it; switching the core must still reach it.
		const before = theme.accent("x");
		expect(before).toContain("38;2;72;153;195"); // default #4899c3

		await writeTheme(agentDir, "hot.json", HOT_PALETTE);
		expect(loadThemes(agentDir)).toEqual([]);
		expect(setTheme("hot")).toBe(true);

		expect(getThemeName()).toBe("hot");
		expect(theme.palette.accent).toBe("#ff0000");
		expect(theme.accent("x")).toContain("38;2;255;0;0");
		expect(theme.accent("x")).not.toBe(before);
		// Methods delegate too, and consult the current core.
		expect(theme.severityPaint("error")("x")).toBe(theme.error("x"));
		expect(theme.severityPaint("error")("x")).toContain("38;2;255;0;255");
	});

	it("keeps sub-theme objects captured before a switch live", async () => {
		const editorTheme = theme.editorTheme;
		expect(editorTheme.borderColor("x")).toContain("38;2;47;77;107"); // default rule #2f4d6b

		await writeTheme(agentDir, "hot.json", HOT_PALETTE);
		loadThemes(agentDir);
		setTheme("hot");

		// borderColor tracks the new palette's rule hue through the same object.
		expect(editorTheme.borderColor("x")).toContain("38;2;0;255;0");
		expect(theme.selectListTheme.noMatch("x")).toBe(theme.faint("x"));
		expect(theme.markdownTheme.link("x")).toContain("38;2;0;255;255");
	});

	it("renders the extension table separator from the live holder", async () => {
		const item: PersistentMessageItem = {
			type: "extension-message",
			id: "ext-1",
			entryId: "ext-1",
			extensionId: "reports",
			message: { kind: "table", columns: [{ label: "Path" }, { label: "Lines" }], rows: [["src/a.ts", "12"]] },
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
		};

		await writeTheme(agentDir, "hot.json", HOT_PALETTE);
		loadThemes(agentDir);
		setTheme("hot");

		const lines = renderTimelineItem(item, 80, renderContext);
		const separator = ` ${theme.dim("│")} `;
		expect(lines.some((line) => line.includes(separator))).toBe(true);
	});

	it("skips unreadable and invalid theme files with diagnostics", async () => {
		await writeTheme(agentDir, "broken.json", "{ not json");
		await writeTheme(agentDir, "missing-colors.json", { accent: "#ff0000" });
		await writeTheme(agentDir, "bad-color.json", { ...HOT_PALETTE, ok: "red" });
		await writeTheme(agentDir, "good.json", HOT_PALETTE);

		const diagnostics = loadThemes(agentDir);

		expect(diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual([
			"warning:theme.invalid",
			"error:theme.read_failed",
			"warning:theme.invalid",
		]);
		expect(getAllThemes().map((entry) => entry.name)).toEqual(["default", "good"]);
		expect(getAllThemes()[1]?.sourcePath).toBe(join(agentDir, "themes", "good.json"));
		expect(setTheme("missing-colors")).toBe(false);
		expect(setTheme("good")).toBe(true);
		expect(theme.palette).toEqual(HOT_PALETTE);
	});

	it("ignores extra keys and non-json files in the themes directory", async () => {
		await writeTheme(agentDir, "extras.json", { ...HOT_PALETTE, comment: "mine", name: "ignored" });
		await mkdir(join(agentDir, "themes"), { recursive: true });
		await writeFile(join(agentDir, "themes", "notes.txt"), "not a theme");

		expect(loadThemes(agentDir)).toEqual([]);
		// The name comes from the file, not a field inside it.
		expect(getAllThemes().map((entry) => entry.name)).toEqual(["default", "extras"]);
	});

	it("returns no diagnostics when the themes directory is absent", () => {
		expect(loadThemes(agentDir)).toEqual([]);
	});

	it("falls back to the accent hue when a palette names no command color", () => {
		expect(defaultPalette.command).toBeUndefined();
		expect(theme.command("x")).toBe(theme.accent("x"));
	});

	it("restores the default palette on reset", async () => {
		await writeTheme(agentDir, "hot.json", HOT_PALETTE);
		loadThemes(agentDir);
		setTheme("hot");

		resetThemes();

		expect(getThemeName()).toBe("default");
		expect(getAllThemes().map((entry) => entry.name)).toEqual(["default"]);
		expect(theme.palette).toEqual(defaultPalette);
	});
});

// The palette WIDI ships in `.widi/themes` is a data file no compiler checks;
// a typo in one hex string is a warning at startup and a missing theme.
describe("the shipped prism theme", () => {
	afterEach(() => {
		resetThemes();
	});

	it("loads without diagnostics and paints every role", () => {
		const repoAgentDir = fileURLToPath(new URL("../../../../.widi", import.meta.url));

		expect(loadThemes(repoAgentDir)).toEqual([]);
		expect(setTheme("prism")).toBe(true);
		expect(theme.accent("x")).toContain("38;2;171;158;239");
		expect(theme.surface("x")).toContain("48;2;42;41;59");
		expect(theme.command("x")).toContain("38;2;255;216;110");
	});
});
