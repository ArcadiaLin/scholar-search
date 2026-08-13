import { execFile } from "node:child_process";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import { activeAgent, type TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { latestExtensionStatus, tonePaint } from "./utils/extension-status.ts";

export class FooterView implements Component {
	private readonly state: TuiApplicationState;
	/** Where the process started: what to show before any agent exists. */
	private readonly startupCwd: string;
	private readonly onRefresh: () => void;
	/**
	 * One cache per directory. Agents may run in different workspaces, and a
	 * single cache would report the branch of whichever one was asked for last.
	 */
	private readonly git = new Map<string, GitBranchCache>();

	constructor(state: TuiApplicationState, cwd: string, onRefresh?: () => void) {
		this.state = state;
		this.startupCwd = cwd;
		this.onRefresh = onRefresh ?? (() => {});
	}

	/** The workspace of whatever is on screen: an open agent, or the staged session. */
	private currentCwd(): string {
		const agent = activeAgent(this.state);
		return agent?.display.cwd ?? this.state.pendingAgent?.display.cwd ?? this.startupCwd;
	}

	private branchOf(cwd: string): string | undefined {
		let cache = this.git.get(cwd);
		if (!cache) {
			cache = new GitBranchCache(cwd, this.onRefresh);
			this.git.set(cwd, cache);
		}
		return cache.current();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const pending = this.state.pendingAgent;
		const model = agent?.display.model ?? agent?.snapshot?.model ?? pending?.display.model;
		const thinkingLevel = agent?.display.thinkingLevel ?? (!agent ? pending?.display.thinkingLevel : undefined);
		const cwd = this.currentCwd();
		const branch = this.branchOf(cwd);
		const queueParts: string[] = [];
		if (agent?.queue.steer.length) {
			queueParts.push(`${agent.queue.steer.length} steer`);
		}
		const followUpCount = (agent?.queue.followUp.length ?? 0) + (agent?.pendingFollowUps.length ?? 0);
		if (followUpCount > 0) {
			queueParts.push(`${followUpCount} follow-up`);
		}
		if (agent?.unreadCount) queueParts.push(`${agent.unreadCount} unread`);

		// A footer-region status joins the always-kept parts as a single compact
		// segment: the latest one only, icon plus one line of text.
		const extensionStatus = latestExtensionStatus(agent, "footer");
		if (extensionStatus) {
			queueParts.push(
				tonePaint(extensionStatus.status.tone)(
					`${extensionStatus.status.icon ?? "✻"} ${singleLine(extensionStatus.status.text, 80)}`,
				),
			);
		}

		queueParts.push(...this.state.segments.texts("footer"));

		const context = contextReadout(this.state);
		const right = context ? theme.dim(context) : "";
		// Model identity sits directly under the editor, ahead of where the run
		// happens. What survives a narrow terminal is ordered by how much it
		// changes: the model id and cwd stay, their qualifiers go.
		const optionalParts = [
			model ? singleLine(model.provider, 40) : undefined,
			thinkingLevel ? `thinking ${singleLine(thinkingLevel, 40)}` : undefined,
			branch ? `⎇ ${branch}` : undefined,
		];
		const buildLeft = (dropped: number) =>
			theme.dim(
				[
					dropped < 1 ? optionalParts[0] : undefined,
					model ? singleLine(model.id, 60) : undefined,
					dropped < 2 ? optionalParts[1] : undefined,
					shortCwd(cwd),
					dropped < 3 ? optionalParts[2] : undefined,
					...queueParts,
				]
					.filter((part): part is string => part !== undefined)
					.join(" · "),
			);

		const rightWidth = visibleWidth(right);
		let left = buildLeft(0);
		for (let dropped = 1; dropped <= optionalParts.length && visibleWidth(left) + rightWidth + 2 > width; dropped++) {
			left = buildLeft(dropped);
		}
		return [alignSides(left, right, width)];
	}
}

/** `context: N% (12.3k/200k)` from the latest assistant-turn usage. */
function contextReadout(state: TuiApplicationState): string | undefined {
	const agent = activeAgent(state);
	if (!agent) return undefined;
	const tokens = agent.display.contextTokens;
	const contextWindow = agent.display.model?.contextWindow ?? agent.snapshot?.model.contextWindow;
	if (tokens === undefined || !contextWindow || contextWindow <= 0) {
		return undefined;
	}
	const percent = Math.round((tokens / contextWindow) * 100);
	return `context: ${percent}% (${formatTokenCount(tokens)}/${formatTokenCount(contextWindow)})`;
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function alignSides(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (rightWidth === 0) return truncateToWidth(left, width, "…");
	if (leftWidth + rightWidth + 2 <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	return truncateToWidth(`${left}  ${right}`, width, "…");
}

/** Abbreviate a cwd to `~/p/widi` style: home prefix plus one-letter parents. */
function shortCwd(cwd: string): string {
	const home = process.env.HOME;
	const relative = home && cwd.startsWith(home) ? `~${cwd.slice(home.length) || "/"}` : cwd;
	const segments = relative.split("/").filter((segment) => segment !== "");
	if (segments.length <= 2) return relative || "/";
	const abbreviated = segments.map((segment, index) => {
		if (index === segments.length - 1 || segment === "~") return segment;
		return segment.startsWith(".") ? segment.slice(0, 2) : segment.slice(0, 1);
	});
	return `${relative.startsWith("/") ? "/" : ""}${abbreviated.join("/")}`;
}

const GIT_REFRESH_MS = 5_000;

/**
 * Throttled, non-blocking git branch lookup. `current()` returns the cached
 * value and kicks off a refresh at most every GIT_REFRESH_MS; when a refresh
 * resolves to a different branch, onChange fires so the host can re-render.
 */
class GitBranchCache {
	private readonly cwd: string;
	private readonly onChange: () => void;
	private branch?: string;
	private lastRefreshAt = 0;
	private inFlight = false;

	constructor(cwd: string, onChange: () => void) {
		this.cwd = cwd;
		this.onChange = onChange;
	}

	current(): string | undefined {
		const now = Date.now();
		if (!this.inFlight && now - this.lastRefreshAt >= GIT_REFRESH_MS) {
			this.inFlight = true;
			this.lastRefreshAt = now;
			void this.refresh();
		}
		return this.branch;
	}

	private async refresh(): Promise<void> {
		try {
			const branch = await queryGitBranch(this.cwd);
			if (branch !== this.branch) {
				this.branch = branch;
				this.onChange();
			}
		} finally {
			this.inFlight = false;
		}
	}
}

function queryGitBranch(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, "branch", "--show-current"], (error, stdout) => {
			if (!error && stdout.trim()) {
				resolve(stdout.trim());
				return;
			}
			// Detached HEAD or an unborn branch: fall back to the short commit.
			execFile("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], (revError, revStdout) => {
				resolve(revError ? undefined : revStdout.trim() || undefined);
			});
		});
	});
}
