import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type { AgentActivitySnapshot, CandidateItem, RuntimeModel } from "../core/types.ts";
import type { CommandEngine } from "./commands/engine.ts";
import { LINE_COMMAND_TRIGGER } from "./commands/parse.ts";
import type { CommandView } from "./commands/types.ts";

interface CommandCompletionItem {
	readonly view: CommandView;
	readonly search: string;
	readonly label: string;
	readonly description?: string;
}

/** Node readdir fallback bounds for @ completion when fd is unavailable. */
const AT_FALLBACK_MAX_SCAN = 2_000;
const AT_FALLBACK_MAX_SUGGESTIONS = 50;

export class WidiCommandAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = [LINE_COMMAND_TRIGGER, "@"];
	private readonly engine: CommandEngine;
	private readonly agentId?: string;
	private readonly orchestrator: AgentOrchestrator;
	private readonly getActivity: () => AgentActivitySnapshot | undefined;
	private readonly getPendingModel?: () => RuntimeModel | undefined;
	private readonly cwd?: string;
	private readonly fdPath?: string;
	private readonly fileProvider?: CombinedAutocompleteProvider;

	constructor(options: {
		readonly engine: CommandEngine;
		readonly agentId?: string;
		readonly orchestrator: AgentOrchestrator;
		readonly getActivity: () => AgentActivitySnapshot | undefined;
		readonly getPendingModel?: () => RuntimeModel | undefined;
		readonly cwd?: string;
		/** fd binary override; undefined probes the PATH, null forces the fallback. */
		readonly fdPath?: string | null;
	}) {
		this.engine = options.engine;
		this.agentId = options.agentId;
		this.orchestrator = options.orchestrator;
		this.getActivity = options.getActivity;
		this.getPendingModel = options.getPendingModel;
		if (options.cwd) {
			this.cwd = options.cwd;
			this.fdPath = options.fdPath === undefined ? detectFdPath() : (options.fdPath ?? undefined);
			this.fileProvider = new CombinedAutocompleteProvider([], options.cwd, this.fdPath ?? null);
		}
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (options.signal.aborted) return null;
		const line = lines[cursorLine] ?? "";
		const beforeCursor = line.slice(0, cursorCol);

		if (beforeCursor.startsWith(LINE_COMMAND_TRIGGER)) {
			return await this.commandSuggestions(beforeCursor, options.signal);
		}

		// Without fd the combined provider's "@" branch is empty; scan the tree
		// ourselves. Path completion still delegates (it needs no fd).
		const atPrefix = extractAtPrefix(beforeCursor);
		if (atPrefix !== undefined && this.cwd && !this.fdPath) {
			return this.atFallbackSuggestions(atPrefix, options.signal);
		}
		return (await this.fileProvider?.getSuggestions(lines, cursorLine, cursorCol, options)) ?? null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const before = currentLine.slice(0, cursorCol - prefix.length);
		const after = currentLine.slice(cursorCol);
		const nextLines = [...lines];
		if (prefix.startsWith(LINE_COMMAND_TRIGGER)) {
			if (prefix.includes(" ")) {
				// Terminal argument phase: the item value is the full "/name value"
				// text. pi-tui submits right after applying a "/" completion, so
				// no trailing space is added here.
				nextLines[cursorLine] = `${before}${item.value}${after}`;
				return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
			}
			// Command-name phase: land the cursor in argument position. pi-tui
			// submits right after applying a "/" completion, and the trailing
			// space is trimmed there.
			nextLines[cursorLine] = `${before}${item.value} ${after}`;
			return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
		}
		if (this.fileProvider) {
			// Argument values, "@" mentions and paths. The combined provider's
			// apply logic (quoting, no space after directories) is independent of
			// where the candidates came from.
			return this.fileProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		nextLines[cursorLine] = `${before}${item.value}${after}`;
		return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.fileProvider?.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}

	private async commandSuggestions(beforeCursor: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
		// Argument phase: `/name arg…`. The command's own completer lists
		// candidates; filtering happens here because completers ignore the prefix.
		// Only the first argument completes: anything past it is free-form input
		// (template arguments, skill instructions) the command cannot predict.
		const argumentMatch = /^\/(\S+)\s+(\S*)$/.exec(beforeCursor);
		if (argumentMatch) {
			const command = this.engine.get(argumentMatch[1] ?? "");
			if (!command?.complete) return null;
			const argumentPrefix = argumentMatch[2] ?? "";
			let candidates: readonly CandidateItem[];
			try {
				candidates = await command.complete(this.commandContext(), argumentPrefix);
			} catch {
				return null;
			}
			if (signal.aborted) return null;
			const filtered = filterArgumentCandidates(candidates, argumentPrefix);
			// A sole exact match is already typed out; keeping the menu open
			// would make Enter confirm a no-op instead of submitting.
			if (filtered.length === 1 && filtered[0]?.value.toLowerCase() === argumentPrefix.toLowerCase()) {
				return null;
			}
			if (filtered.length === 0) return null;
			if (command.argumentCompletes) {
				// Terminal candidates: the item value is the whole command line
				// and the prefix covers `/name arg…`, so pi-tui's fall-through
				// submits the completed command the moment Enter accepts it.
				return {
					items: filtered.map((candidate) => ({
						value: `${LINE_COMMAND_TRIGGER}${command.name} ${candidate.value}`,
						label: candidate.label ?? candidate.value,
						description: candidate.description,
					})),
					prefix: beforeCursor,
				};
			}
			return {
				items: filtered.map((candidate) => ({
					value: candidate.value,
					label: candidate.label ?? candidate.value,
					description: candidate.description,
				})),
				// Not "/" prefixed: Enter inserts the value without submitting.
				prefix: argumentPrefix,
			};
		}
		const body = beforeCursor.slice(LINE_COMMAND_TRIGGER.length);
		const items = this.engine.list(this.getActivity()).map(toCommandCompletionItem);
		const filtered = fuzzyFilter(items, body, (item) => item.search).map((item) => ({
			value: `${LINE_COMMAND_TRIGGER}${item.view.name}`,
			label: item.label,
			description: item.description,
		}));
		return filtered.length > 0 ? { items: filtered, prefix: beforeCursor } : null;
	}

	private atFallbackSuggestions(atPrefix: string, signal: AbortSignal): AutocompleteSuggestions | null {
		if (!this.cwd) return null;
		const query = atPrefix.slice(1).replace(/^"/u, "");
		const ranked = rankAtCandidates(collectAtCandidates(this.cwd, signal), query).slice(0, AT_FALLBACK_MAX_SUGGESTIONS);
		if (signal.aborted || ranked.length === 0) return null;
		return { items: ranked.map(toAtItem), prefix: atPrefix };
	}

	private commandContext() {
		return {
			agentId: this.agentId,
			orchestrator: this.orchestrator,
			pendingModel: this.getPendingModel?.(),
			...(this.cwd === undefined ? undefined : { workspaceCwd: this.cwd }),
		};
	}
}

/** Case-insensitive prefix filter with a fuzzy fallback on zero hits. */
function filterArgumentCandidates(
	candidates: readonly CandidateItem[],
	argumentPrefix: string,
): readonly CandidateItem[] {
	const lower = argumentPrefix.toLowerCase();
	const prefixHits = candidates.filter(
		(candidate) =>
			candidate.value.toLowerCase().startsWith(lower) ||
			(candidate.label ?? candidate.value).toLowerCase().startsWith(lower),
	);
	if (prefixHits.length > 0) return prefixHits;
	return fuzzyFilter([...candidates], argumentPrefix, (candidate) => candidate.label ?? candidate.value);
}

function toCommandCompletionItem(view: CommandView): CommandCompletionItem {
	const availability =
		view.available === false ? `unavailable: ${view.unavailableReason ?? "not available"}` : undefined;
	return {
		view,
		search: view.name,
		label: `${LINE_COMMAND_TRIGGER}${view.name}`,
		description: [view.argumentHint, view.description, availability].filter(Boolean).join(" — "),
	};
}

/** The whitespace-delimited token at the cursor when it starts with "@". */
function extractAtPrefix(beforeCursor: string): string | undefined {
	const boundary = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\t"));
	const token = beforeCursor.slice(boundary + 1);
	return token.startsWith("@") ? token : undefined;
}

/** Synchronously probe for an fd binary; undefined when none is installed. */
function detectFdPath(): string | undefined {
	for (const name of ["fd", "fd-find", "fdfind"]) {
		try {
			execFileSync("which", [name], { stdio: "ignore" });
			return name;
		} catch {
			// Try the next binary name.
		}
	}
	return undefined;
}

interface AtCandidate {
	readonly path: string;
	readonly isDirectory: boolean;
}

/** Depth-first readdir scan for @ completion when fd is unavailable. */
function collectAtCandidates(cwd: string, signal: AbortSignal): AtCandidate[] {
	const candidates: AtCandidate[] = [];
	const stack = [""];
	let scanned = 0;
	while (stack.length > 0 && scanned < AT_FALLBACK_MAX_SCAN) {
		if (signal.aborted) break;
		const relativeDir = stack.pop() ?? "";
		const absoluteDir = relativeDir ? join(cwd, relativeDir) : cwd;
		let entries: Dirent[];
		try {
			entries = readdirSync(absoluteDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (signal.aborted || scanned >= AT_FALLBACK_MAX_SCAN) break;
			if (entry.name === ".git") continue;
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			let isDirectory = entry.isDirectory();
			if (!isDirectory && entry.isSymbolicLink()) {
				try {
					isDirectory = statSync(join(absoluteDir, entry.name)).isDirectory();
				} catch {
					// Broken symlink or permission error: keep it as a file candidate.
				}
			}
			scanned += 1;
			candidates.push({ path: relativePath, isDirectory });
			// Symlinked directories are listed but never descended into.
			if (isDirectory && !entry.isSymbolicLink()) stack.push(relativePath);
		}
	}
	return candidates;
}

function rankAtCandidates(candidates: readonly AtCandidate[], query: string): AtCandidate[] {
	const lowerQuery = query.toLowerCase();
	const scored: Array<{ candidate: AtCandidate; score: number }> = [];
	for (const candidate of candidates) {
		const score = scoreAtCandidate(candidate, lowerQuery);
		if (score > 0) scored.push({ candidate, score });
	}
	scored.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		if (a.candidate.isDirectory !== b.candidate.isDirectory) {
			return a.candidate.isDirectory ? -1 : 1;
		}
		return a.candidate.path.localeCompare(b.candidate.path);
	});
	return scored.map((entry) => entry.candidate);
}

function scoreAtCandidate(candidate: AtCandidate, lowerQuery: string): number {
	if (lowerQuery.length === 0) {
		const depthPenalty = candidate.path.split("/").length - 1;
		return (candidate.isDirectory ? 120 : 100) - depthPenalty;
	}
	const lowerBase = basename(candidate.path).toLowerCase();
	let score = 0;
	if (lowerBase === lowerQuery) score = 100;
	else if (lowerBase.startsWith(lowerQuery)) score = 80;
	else if (lowerBase.includes(lowerQuery)) score = 50;
	else if (candidate.path.toLowerCase().includes(lowerQuery)) score = 30;
	if (candidate.isDirectory && score > 0) score += 10;
	return score;
}

function toAtItem(candidate: AtCandidate): AutocompleteItem {
	const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path;
	const value = valuePath.includes(" ") ? `@"${valuePath}"` : `@${valuePath}`;
	return {
		value,
		label: `${basename(candidate.path)}${candidate.isDirectory ? "/" : ""}`,
		description: candidate.path,
	};
}
