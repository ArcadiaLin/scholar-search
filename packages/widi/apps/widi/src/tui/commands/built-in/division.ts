import type { AgentOrchestrator } from "../../../core/agent-orchestrator.ts";
import type { ExtensionDivisionSelection, ExtensionDivisionSnapshot } from "../../../core/extension/index.ts";
import type { CandidateItem } from "../../../core/types.ts";
import { splitLeadingToken } from "../parse.ts";
import type { CommandContext, CommandDefinition, ResolveArgumentOutcome } from "../types.ts";

/**
 * The switchable parts of an extension. Core resolves them per agent from
 * settings rules; this is the only way to write those rules without editing
 * the settings file by hand.
 *
 * Picking a division toggles it. Rules land in the global settings and take
 * effect on the next runner, so the command reloads the current agent and then
 * reports the state it actually resolved to - a rule can lose to a project-level
 * rule or to a disabled ancestor, and reporting the request instead of the
 * result would be a claim rather than a fact.
 */
export const divisionCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "division",
	description: "Turn a part of an extension on or off.",
	argumentHint: "[default] <extension>/<division>",
	argumentCompletes: true,
	complete: async (context) => listDivisionCandidates(context),
	resolveArgument: (_context, argument, candidates) => resolveDivisionArgument(argument, candidates),
	execute: async (context, argument) => {
		const agentId = context.agentId;
		if (!agentId) throw new Error("Command /division requires an active agent.");
		if (argument.trim() === "") return "No extension declares a division.";

		const parsed = parseDivisionArgument(argument);
		if (!parsed) {
			throw new Error("Command /division takes <extension>/<division>, optionally preceded by 'default'.");
		}
		const { orchestrator } = context;
		const name = `${parsed.extensionId}/${parsed.divisionId}`;
		const before = findDivision(orchestrator, agentId, parsed.extensionId, parsed.divisionId);
		if (!before) throw new Error(`Agent ${agentId} has no division ${name}.`);

		const target = parsed.clear ? undefined : !before.enabled;
		const { settingManager } = orchestrator;
		settingManager.setExtensionDivisionSelections(
			withDivisionRule(
				settingManager.getGlobalExtensionDivisionSelections(),
				parsed.extensionId,
				parsed.divisionId,
				target,
			),
		);
		const written = target === undefined ? "rule removed from global settings" : "rule saved in global settings";

		const reload = await orchestrator.reloadExtensions({ agentIds: [agentId] });
		const reloaded = reload.agents[0];
		if (reloaded?.status !== "reloaded") {
			const why = reloaded ? (reloaded.reason ?? reloaded.status) : "no reload ran";
			return [`${name}: not applied yet.`, `${written} · ${agentId} was not reloaded (${why})`].join("\n");
		}

		const after = findDivision(orchestrator, agentId, parsed.extensionId, parsed.divisionId);
		if (!after) {
			return [`${name}: gone after the reload.`, `${written} · ${agentId} reloaded`].join("\n");
		}
		const state = after.enabled ? "on" : "off";
		const headline =
			target === undefined
				? `${name} is ${state} by default.`
				: after.enabled === target
					? `${name} is now ${state}.`
					: `${name} is still ${state}: ${whyUnchanged(after)}.`;
		return [headline, `${written} · ${agentId} reloaded`].join("\n");
	},
};

interface DivisionArgument {
	/** Drop the rule instead of writing one, back to what the extension declares. */
	readonly clear: boolean;
	readonly extensionId: string;
	readonly divisionId: string;
}

function parseDivisionArgument(argument: string): DivisionArgument | undefined {
	const trimmed = argument.trim();
	if (!trimmed) return undefined;
	const { token, rest } = splitLeadingToken(trimmed);
	const clear = token === "default" && rest.trim() !== "";
	const target = clear ? rest.trim() : trimmed;
	// Extension ids carry no "/" and division ids carry none either, so the
	// first slash is the boundary.
	const slash = target.indexOf("/");
	if (slash <= 0 || slash === target.length - 1 || /\s/u.test(target)) return undefined;
	return { clear, extensionId: target.slice(0, slash), divisionId: target.slice(slash + 1) };
}

/**
 * Candidates address a division, not an action: the verb is implied by the
 * state shown in the label, so one row reads as one switch.
 */
async function listDivisionCandidates(context: CommandContext): Promise<readonly CandidateItem[]> {
	if (!context.agentId) return [];
	return divisionSnapshots(context.orchestrator, context.agentId).map((division) => ({
		value: `${division.extensionId}/${division.id}`,
		label: `${division.enabled ? "on " : "off"} ${division.extensionId}/${division.id} · ${division.label}`,
		description: [division.description, describeSource(division)].filter(Boolean).join(" · "),
	}));
}

function resolveDivisionArgument(argument: string, candidates: readonly CandidateItem[]): ResolveArgumentOutcome {
	const parsed = parseDivisionArgument(argument);
	if (!parsed) return { kind: "open-selector", query: argument };
	const target = `${parsed.extensionId}/${parsed.divisionId}`.toLowerCase();
	const matches = candidates.filter((candidate) => candidate.value.toLowerCase() === target);
	const prefixed = matches.length > 0 ? matches : candidates.filter((c) => c.value.toLowerCase().startsWith(target));
	const match = prefixed.length === 1 ? prefixed[0] : undefined;
	if (!match) return { kind: "open-selector", query: argument };
	return { kind: "resolved", value: parsed.clear ? `default ${match.value}` : match.value };
}

function divisionSnapshots(orchestrator: AgentOrchestrator, agentId: string): readonly ExtensionDivisionSnapshot[] {
	return orchestrator.inspectAgent(agentId).extensions.divisions;
}

function findDivision(
	orchestrator: AgentOrchestrator,
	agentId: string,
	extensionId: string,
	divisionId: string,
): ExtensionDivisionSnapshot | undefined {
	return divisionSnapshots(orchestrator, agentId).find(
		(division) => division.extensionId === extensionId && division.id === divisionId,
	);
}

function describeSource(division: ExtensionDivisionSnapshot): string | undefined {
	if (division.source === "ancestor") return "off with an ancestor division";
	if (division.source === "settings") return "pinned by a settings rule";
	return division.declared ? undefined : "used but never declared";
}

/**
 * A rule at the exact id beats every ancestor rule, so the only ways the
 * resolved state can still disagree with it are a disabled ancestor gating the
 * whole subtree, or a project-level rule replacing this extension's rules.
 */
function whyUnchanged(division: ExtensionDivisionSnapshot): string {
	return division.source === "ancestor"
		? "an ancestor division is disabled"
		: "a project settings rule for this extension wins";
}

function withDivisionRule(
	selections: Record<string, ExtensionDivisionSelection>,
	extensionId: string,
	divisionId: string,
	enabled: boolean | undefined,
): Record<string, ExtensionDivisionSelection> {
	const next = structuredClone(selections);
	const current = next[extensionId];
	const enable = (current?.enable ?? []).filter((id) => id !== divisionId);
	const disable = (current?.disable ?? []).filter((id) => id !== divisionId);
	if (enabled === true) enable.push(divisionId);
	if (enabled === false) disable.push(divisionId);
	if (enable.length === 0 && disable.length === 0) {
		delete next[extensionId];
		return next;
	}
	next[extensionId] = { ...(enable.length > 0 ? { enable } : {}), ...(disable.length > 0 ? { disable } : {}) };
	return next;
}
