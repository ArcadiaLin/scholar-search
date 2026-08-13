import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { CoreDiagnostic } from "../../core/diagnostics.ts";

const ESC = "\u001b[";
const SGR_RESET = `${ESC}0m`;

type Paint = (text: string) => string;

function ansi(open: number, close = 39): Paint {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function decoration(open: number, close: number): Paint {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function foregroundRgb(hex: string): Paint {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return (text) => `${ESC}38;2;${red};${green};${blue}m${text}${ESC}39m`;
}

function backgroundRgb(hex: string): Paint {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return (text) => `${ESC}48;2;${red};${green};${blue}m${text}${ESC}49m`;
}

/**
 * Semantic hues of a color scheme, as hex values. Components never pick raw
 * terminal colors; the Theme turns these into paint functions.
 */
export interface ThemePalette {
	/** Emphasis: brand, titles, selection, active frames. */
	accent: string;
	/** Success / positive outcome. */
	ok: string;
	/** Warning. */
	warn: string;
	/** Error / failure. */
	error: string;
	/** Activity in progress, informational. */
	info: string;
	/** Slash commands: the recognized token in the editor, the row's name. Falls back to `accent`. */
	command?: string;
	/** De-emphasized text. */
	muted: string;
	/** Barely-there text (scroll info, placeholders). */
	faint: string;
	/** Frames, divider lines, box borders. */
	rule: string;
	/** Row background that lifts a line off the terminal's black. */
	surface: string;
	/** Row background of a tool still working. Falls back to `surface`. */
	toolPending?: string;
	/** Row background of a tool that finished cleanly. Falls back to `surface`. */
	toolSuccess?: string;
	/** Row background of a failed tool. Falls back to `surface`. */
	toolError?: string;
	/** Row background of a message nobody typed. Falls back to `surface`. */
	messageSurface?: string;
	/** Row background of a completed slash command. Falls back to `surface`. */
	commandSurface?: string;
}

/**
 * Default color scheme derived from the IDIW logo (chat_notes/idiw.png): a
 * diagonal blue gradient running from pale cyan #9dcfd3 through #7ab9cd and
 * #4899c3 down to deep blue #0a559e, on white. Accent/info and the
 * de-emphasis grays come straight from that gradient; the outcome hues
 * (ok/warn/error) keep their semantic green/yellow/red since the logo offers
 * none.
 */
export const defaultPalette: ThemePalette = {
	accent: "#4899c3",
	ok: "#83c092",
	warn: "#dbbc7f",
	error: "#e67e80",
	info: "#7ab9cd",
	muted: "#8fa9c0",
	faint: "#5b7186",
	rule: "#2f4d6b",
	surface: "#1e2833",
	toolPending: "#1b2a2e",
	toolSuccess: "#1c2a24",
	toolError: "#2c2023",
	messageSurface: "#1a222c",
	commandSurface: "#1c2a3d",
};

/**
 * Unified color scheme for the TUI. Owns the palette and decides, in one
 * place, which hue paints each visual role: panel frames (`border`), the
 * editor's attention frame (`borderActive`), panel/menu titles (`title`),
 * selection markers and active chips (`selection`), and status hues
 * (`ok`/`warn`/`error`/`info`). Also derives the pi-tui sub-themes
 * (`editorTheme`/`selectListTheme`/`markdownTheme`) so those components pick
 * up the same scheme.
 */
export class Theme {
	readonly palette: ThemePalette;

	// Text decorations (not palette-driven).
	readonly reset: Paint;
	readonly bold: Paint;
	readonly dim: Paint;
	readonly italic: Paint;
	readonly underline: Paint;
	readonly inverse: Paint;
	readonly strikethrough: Paint;

	// Raw ANSI colors for the rare spot that needs one.
	readonly red: Paint;
	readonly green: Paint;
	readonly yellow: Paint;
	readonly blue: Paint;
	readonly magenta: Paint;
	readonly cyan: Paint;
	readonly white: Paint;
	readonly gray: Paint;

	// Status hues from the palette.
	readonly accent: Paint;
	readonly ok: Paint;
	readonly warn: Paint;
	readonly error: Paint;
	readonly info: Paint;
	/** Slash commands, in the editor and in the transcript row they produce. */
	readonly command: Paint;
	readonly muted: Paint;
	readonly faint: Paint;

	// Visual roles.
	readonly border: Paint;
	readonly borderActive: Paint;
	readonly title: Paint;
	readonly selection: Paint;
	/** Background of user message rows in the transcript. */
	readonly surface: Paint;
	/**
	 * Transcript row backgrounds. A theme file written before these existed
	 * falls back to `surface`, so it keeps working and simply looks flatter.
	 */
	readonly toolPending: Paint;
	readonly toolSuccess: Paint;
	readonly toolError: Paint;
	readonly messageSurface: Paint;
	readonly commandSurface: Paint;

	readonly selectListTheme: SelectListTheme;
	readonly editorTheme: EditorTheme;
	readonly markdownTheme: MarkdownTheme;

	constructor(palette: ThemePalette = defaultPalette) {
		this.palette = palette;

		this.reset = (text) => `${SGR_RESET}${text}${SGR_RESET}`;
		this.bold = decoration(1, 22);
		this.dim = decoration(2, 22);
		this.italic = decoration(3, 23);
		this.underline = decoration(4, 24);
		this.inverse = decoration(7, 27);
		this.strikethrough = decoration(9, 29);

		this.red = ansi(31);
		this.green = ansi(32);
		this.yellow = ansi(33);
		this.blue = ansi(34);
		this.magenta = ansi(35);
		this.cyan = ansi(36);
		this.white = ansi(37);
		this.gray = ansi(90);

		this.accent = foregroundRgb(palette.accent);
		this.ok = foregroundRgb(palette.ok);
		this.warn = foregroundRgb(palette.warn);
		this.error = foregroundRgb(palette.error);
		this.info = foregroundRgb(palette.info);
		this.command = foregroundRgb(palette.command ?? palette.accent);
		this.muted = foregroundRgb(palette.muted);
		this.faint = foregroundRgb(palette.faint);

		this.border = foregroundRgb(palette.rule);
		this.borderActive = this.accent;
		this.title = this.accent;
		this.selection = this.accent;
		this.surface = backgroundRgb(palette.surface);
		this.toolPending = backgroundRgb(palette.toolPending ?? palette.surface);
		this.toolSuccess = backgroundRgb(palette.toolSuccess ?? palette.surface);
		this.toolError = backgroundRgb(palette.toolError ?? palette.surface);
		this.messageSurface = backgroundRgb(palette.messageSurface ?? palette.surface);
		this.commandSurface = backgroundRgb(palette.commandSurface ?? palette.surface);

		this.selectListTheme = {
			selectedPrefix: this.selection,
			selectedText: this.bold,
			description: this.muted,
			scrollInfo: this.faint,
			noMatch: this.faint,
		};
		this.editorTheme = { borderColor: this.border, selectList: this.selectListTheme };
		this.markdownTheme = {
			heading: (text) => this.bold(this.title(text)),
			link: this.info,
			linkUrl: this.dim,
			code: this.info,
			codeBlock: this.ok,
			codeBlockBorder: this.border,
			quote: this.italic,
			quoteBorder: this.dim,
			hr: this.dim,
			listBullet: this.accent,
			bold: this.bold,
			italic: this.italic,
			strikethrough: this.strikethrough,
			underline: this.underline,
		};
	}

	severityPaint(severity: "warning" | "error"): Paint {
		return severity === "error" ? this.error : this.warn;
	}
}

// ============================================================================
// Theme registry and the live holder
// ============================================================================

const DEFAULT_THEME_NAME = "default";
const PALETTE_KEYS = ["accent", "ok", "warn", "error", "info", "muted", "faint", "rule", "surface"] as const;
/** Validated when present, absent is fine: see ThemePalette for the fallbacks. */
const OPTIONAL_PALETTE_KEYS = [
	"command",
	"toolPending",
	"toolSuccess",
	"toolError",
	"messageSurface",
	"commandSurface",
] as const;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface RegisteredTheme {
	readonly name: string;
	readonly palette: ThemePalette;
	readonly sourcePath?: string;
}

export interface ThemeInfo {
	readonly name: string;
	readonly sourcePath?: string;
}

const registry = new Map<string, RegisteredTheme>();
let activeThemeName = DEFAULT_THEME_NAME;
let activeCore: Theme = new Theme(defaultPalette);
/** Bumped on every switch; render caches key on it so stale paints expire. */
let generation = 0;

/** The current theme generation; changes with every setTheme/resetThemes. */
export function themeGeneration(): number {
	return generation;
}

/**
 * Live stand-in for a snapshot object so consumers that captured it before a
 * theme switch (the editor keeps its `EditorTheme`, for one) still read the
 * active core's values.
 */
function delegating<T extends object>(pick: () => T): T {
	return new Proxy({} as T, { get: (_target, property) => Reflect.get(pick(), property) });
}

const liveSelectListTheme = delegating(() => activeCore.selectListTheme);
const liveEditorTheme = delegating(() => activeCore.editorTheme);
const liveMarkdownTheme = delegating(() => activeCore.markdownTheme);

/**
 * The active color scheme. Components always paint through this holder: every
 * property access is forwarded to the current core, so a reference captured
 * before a `setTheme` switch picks up the new paints. Note this only covers
 * access through `theme`; a paint *result* captured at module scope (a styled
 * constant) still freezes the old colors, so paint at render time instead.
 */
export const theme: Theme = new Proxy({} as Theme, {
	get: (_target, property) => {
		if (property === "selectListTheme") return liveSelectListTheme;
		if (property === "editorTheme") return liveEditorTheme;
		if (property === "markdownTheme") return liveMarkdownTheme;
		return Reflect.get(activeCore, property);
	},
});

/** Switch the holder to a registered palette; false when the name is unknown. */
export function setTheme(name: string): boolean {
	const entry = registry.get(name);
	if (!entry) return false;
	activeThemeName = name;
	activeCore = new Theme(entry.palette);
	generation++;
	return true;
}

/** Name of the theme the holder currently paints with. */
export function getThemeName(): string {
	return activeThemeName;
}

/** Every registered theme, the default first. */
export function getAllThemes(): ThemeInfo[] {
	return [...registry.values()].map(({ name, sourcePath }) => ({ name, sourcePath }));
}

/** Restore the default palette as the only and active theme. Test support. */
export function resetThemes(): void {
	registry.clear();
	registry.set(DEFAULT_THEME_NAME, { name: DEFAULT_THEME_NAME, palette: defaultPalette });
	activeThemeName = DEFAULT_THEME_NAME;
	activeCore = new Theme(defaultPalette);
	generation++;
}
resetThemes();

/** List what's wrong with a candidate palette; empty means it is usable. */
function paletteErrors(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return ["expected a JSON object of semantic colors"];
	}
	const candidate = value as Record<string, unknown>;
	const errors: string[] = [];
	for (const key of PALETTE_KEYS) {
		const color = candidate[key];
		if (typeof color !== "string" || !HEX_COLOR.test(color)) {
			errors.push(`"${key}" must be a #rrggbb hex string`);
		}
	}
	for (const key of OPTIONAL_PALETTE_KEYS) {
		const color = candidate[key];
		if (color !== undefined && (typeof color !== "string" || !HEX_COLOR.test(color))) {
			errors.push(`"${key}" must be a #rrggbb hex string when present`);
		}
	}
	return errors;
}

/**
 * Register every `<agentDir>/themes/*.json` file as a named palette (the file
 * basename becomes the theme name; the content is a flat ThemePalette object).
 * A missing directory is the normal case, not an error. Unreadable files and
 * palettes with missing or malformed colors are reported as diagnostics and
 * skipped, leaving the registry usable.
 */
export function loadThemes(agentDir: string): CoreDiagnostic[] {
	const themesDir = join(agentDir, "themes");
	if (!existsSync(themesDir)) return [];
	let files: string[];
	try {
		files = readdirSync(themesDir);
	} catch (error) {
		return [
			{
				severity: "error",
				code: "theme.read_failed",
				message: `Could not list ${themesDir}: ${error instanceof Error ? error.message : String(error)}`,
			},
		];
	}
	const diagnostics: CoreDiagnostic[] = [];
	for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
		const path = join(themesDir, file);
		const name = file.slice(0, -".json".length);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			diagnostics.push({
				severity: "error",
				code: "theme.read_failed",
				message: `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		const errors = paletteErrors(raw);
		if (errors.length > 0) {
			diagnostics.push({
				severity: "warning",
				code: "theme.invalid",
				message: `${path}: invalid theme "${name}" (${errors.join("; ")}); the file is ignored.`,
			});
			continue;
		}
		registry.set(name, { name, palette: raw as ThemePalette, sourcePath: path });
	}
	return diagnostics;
}
