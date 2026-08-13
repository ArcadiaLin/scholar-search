import { type Static, Type } from "typebox";
import type { AgentProfileBrief, AgentTreeClosedEntry, AgentTreeEntry, AgentTreeRunningEntry } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { callerChildren, requireAgentHost } from "./shared.ts";

/** Newest resumable sessions kept in the listing; the rest are counted. */
const MAX_RESUMABLE_ENTRIES = 10;

const listAgentsSchema = Type.Object({
	include: Type.Optional(
		Type.Array(Type.Union([Type.Literal("profiles"), Type.Literal("live"), Type.Literal("resumable")]), {
			description: "Which sections to return. Defaults to all three.",
		}),
	),
});

export type ListAgentsInput = Static<typeof listAgentsSchema>;

export interface ListAgentsDetails {
	readonly callerAgentId: string;
	/** Each section is absent when it was not asked for. */
	readonly profiles?: readonly AgentProfileBrief[];
	/** The caller's own agents, each keeping the subtree below it. */
	readonly live?: readonly AgentTreeRunningEntry[];
	readonly resumable?: readonly AgentTreeClosedEntry[];
	/** Set when the session directories could not be read, leaving running agents only. */
	readonly closedUnavailable?: boolean;
}

/**
 * Everything a caller needs to decide who does the next piece of work: the
 * profiles it can spawn from, the agents it already has running, and the
 * sessions it can reopen. One tool because the three are read together - an
 * origin is chosen by comparing them.
 *
 * Tree-scoped. Any agent holding `send_message` can talk to any runtime-local
 * agent id it already knows, including one in another tree; this tool only
 * enumerates the caller's own. Cross-tree contact starts when a human, another
 * agent, or an incoming message shares an exact id.
 *
 * One level deep: the caller's own agents, not what those spawned in turn. The
 * runtime hands over the whole tree and this is where it is cut, so the depth is
 * a decision about what a model should read at once rather than about what can
 * be known. Deeper entries are counted, never dropped silently.
 */
export function createListAgentsToolDefinition(): ToolDefinition<typeof listAgentsSchema, ListAgentsDetails> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List what you can delegate to: the profiles you can spawn an agent from, the agents you spawned that are running now with what each is doing, and the sessions you can resume. It shows one level - your own agents, not theirs - and does not enumerate other trees. You may still send_message to an exact agent id shared with you, from any tree or level. Only a running agent can be watched or disposed; a session you resume becomes a running agent, and messaging the agent id a session was written under reopens it for you.",
		promptSnippet: "List the profiles, running agents, and resumable sessions",
		parameters: listAgentsSchema,
		execute: async (_toolCallId, { include }, context) => {
			const host = requireAgentHost(context);
			const sections = new Set(include ?? ["profiles", "live", "resumable"]);
			const wantsTree = sections.has("live") || sections.has("resumable");
			const profiles = sections.has("profiles") ? await host.listProfiles() : undefined;
			const listing = wantsTree ? await host.listAgents() : undefined;
			const children = listing ? callerChildren(listing.entries, host.agentId) : [];
			const live = sections.has("live") ? children.filter(isRunning) : undefined;
			const resumable = sections.has("resumable") ? children.filter(isClosed) : undefined;
			const closedUnavailable = resumable !== undefined && listing?.closedUnavailable === true;
			return {
				content: [{ type: "text", text: format({ profiles, live, resumable, closedUnavailable }) }],
				details: {
					callerAgentId: host.agentId,
					...(profiles === undefined ? undefined : { profiles }),
					...(live === undefined ? undefined : { live }),
					...(resumable === undefined ? undefined : { resumable }),
					...(closedUnavailable ? { closedUnavailable: true } : undefined),
				},
			};
		},
	};
}

function isRunning(entry: AgentTreeEntry): entry is AgentTreeRunningEntry {
	return entry.status === "running";
}

function isClosed(entry: AgentTreeEntry): entry is AgentTreeClosedEntry {
	return entry.status === "closed";
}

function countNested(entry: AgentTreeEntry): number {
	return entry.children.reduce((total, child) => total + 1 + countNested(child), 0);
}

/** ` (+N nested)`, or nothing when this entry is a leaf. */
function nestedSuffix(entry: AgentTreeEntry): string {
	const count = countNested(entry);
	return count === 0 ? "" : ` (+${count} nested)`;
}

function format(input: {
	readonly profiles: readonly AgentProfileBrief[] | undefined;
	readonly live: readonly AgentTreeRunningEntry[] | undefined;
	readonly resumable: readonly AgentTreeClosedEntry[] | undefined;
	readonly closedUnavailable: boolean;
}): string {
	const sections: string[] = [];
	if (input.profiles) sections.push(formatProfiles(input.profiles));
	if (input.live) sections.push(formatLive(input.live));
	if (input.resumable) sections.push(formatResumable(input.resumable, input.closedUnavailable));
	return sections.join("\n\n");
}

function formatProfiles(profiles: readonly AgentProfileBrief[]): string {
	if (profiles.length === 0) return "No agent profile is available to spawn from.";
	const lines = profiles.map((profile) => {
		const description = profile.description ? `: ${profile.description}` : "";
		const session = profile.persist ? "persistent session" : "ephemeral session";
		const head = `- ${profile.id} (${profile.label})${description} [${session}]`;
		if (!profile.whenToUse) return head;
		// Indented under its own entry: selection advice runs to a paragraph, and
		// unindented it would read as the start of the next profile.
		const advice = profile.whenToUse
			.split("\n")
			.map((line) => (line ? `  ${line}` : ""))
			.join("\n");
		return `${head}\n${advice}`;
	});
	return `Profiles you can spawn an agent from:\n${lines.join("\n")}`;
}

function formatLive(live: readonly AgentTreeRunningEntry[]): string {
	if (live.length === 0) return "You have no agents running.";
	const lines = live.map((entry) => {
		const state = entry.activity === "running" ? "working" : "idle";
		return `- agent ${entry.agentId} [profile ${entry.profileId}] ${state}${nestedSuffix(entry)}`;
	});
	if (live.some((entry) => countNested(entry) > 0)) {
		lines.push("+N counts the agents and sessions nested below an entry; ask a running agent to list its own.");
	}
	return `Agents you spawned that are running now:\n${lines.join("\n")}`;
}

function formatResumable(resumable: readonly AgentTreeClosedEntry[], closedUnavailable: boolean): string {
	if (closedUnavailable) {
		return "The sessions you could resume could not be read, so none are listed.";
	}
	if (resumable.length === 0) return "You have no sessions to resume.";
	// Newest first and capped: this section is the one that grows without bound
	// across runs, and an older session is the less likely one to be wanted.
	const ordered = [...resumable].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const shown = ordered.slice(0, MAX_RESUMABLE_ENTRIES);
	const lines = shown.map((entry) => {
		const agent = entry.sessionAgentId ? ` agent ${entry.sessionAgentId}` : "";
		const profile = entry.profileId ? ` [profile ${entry.profileId}]` : "";
		return `-${agent} ${entry.sessionRef}${profile} started ${entry.createdAt}${nestedSuffix(entry)}`;
	});
	if (ordered.length > shown.length) {
		lines.push(`${ordered.length - shown.length} older sessions are not listed.`);
	}
	lines.push(
		"None of these is running, so none can be watched or disposed as it stands. Send a message to one of the agent ids above and its session is reopened for you, with everything that agent had; pass an address to spawn_agent as resume to reopen one without a message.",
	);
	return `Sessions you can resume:\n${lines.join("\n")}`;
}
