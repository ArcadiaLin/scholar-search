/**
 * scholar-search: the WIDI Core-half extension carrying $T^M$, the Main Search
 * Agent's tool set (`docs/design.md` §4, `docs/prototype.md` §7.1).
 *
 * Registered so far:
 *
 *   list_providers   runtime capability table + quota, from the Search Service
 *
 * `list_providers` comes first because it is the precondition for every other
 * tool that lets the agent write a provider-native query: the agent cannot pick
 * a source, a syntax or a field before it knows what exists and what is left of
 * the quota (`docs/prototype.md` §7.1, "provider 语法的载体").
 *
 * Retrieval logic lives in `core/` as pure functions; this file only adapts them
 * to the WIDI tool contract. Parameter schemas are hand-written JSON Schema:
 * jiti cannot resolve a bare "typebox" import from `widis/`, and WIDI treats the
 * schema as plain JSON Schema anyway (typebox's `TSchema` is structurally empty
 * in the pinned version).
 */

import {
	EXTENSION_API_VERSION,
	type ExtensionDefinition,
} from "../../../../packages/widi/apps/widi/src/core/extension/api.ts";
import {
	createServiceClient,
	type ProviderRecord,
	resolveServiceBaseUrl,
	SERVICE_URL_ENV_VAR,
	ServiceRequestError,
} from "./core/service-client.ts";

/**
 * Tools bound their own output size: a candidate list or a capability table that
 * grows with the corpus must not decide how much of the agent's context is left
 * (`docs/design.md` §4.1). The full record still travels in `details`, which the
 * trajectory and the UI read but the model's context does not.
 */
const MAX_FIELDS_PER_PROVIDER = 12;
const MAX_OUTPUT_CHARS = 6_000;

function formatCost(record: ProviderRecord): string {
	const endpoints = Object.entries(record.costModel);
	if (endpoints.length === 0) return "cost: not declared";
	const parts = endpoints.map(([endpoint, cost]) => {
		const quota = cost.dailyQuota === null ? "no daily quota" : `${cost.dailyQuota}/day`;
		return `${endpoint} ($${cost.usdPerCall}/call, ${quota}, ${cost.rateLimitRps} rps)`;
	});
	return `cost: ${parts.join("; ")}`;
}

function formatQuota(record: ProviderRecord): string {
	const entries = Object.entries(record.quotaRemaining);
	if (entries.length === 0) return "quota remaining: not tracked by the service";
	const parts = entries.map(([key, remaining]) => `${key}=${remaining === null ? "unknown" : remaining}`);
	return `quota remaining: ${parts.join(", ")}`;
}

/**
 * The unified field names this provider can populate. Reported as the unified
 * vocabulary rather than the provider's own keys because that is the vocabulary
 * every other tool in $T^M$ speaks.
 */
function formatFields(record: ProviderRecord): string {
	const unified = [...new Set(Object.values(record.fieldMap))].sort();
	if (unified.length === 0) return "fields: not declared";
	const shown = unified.slice(0, MAX_FIELDS_PER_PROVIDER);
	const omitted = unified.length - shown.length;
	return `fields: ${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function formatProvider(record: ProviderRecord): string {
	const capabilities =
		record.enabledCapabilities.length === 0 ? "none advertised" : record.enabledCapabilities.join(", ");
	return [
		`- ${record.name} [${record.enabled ? "enabled" : "disabled"}]`,
		`  capabilities: ${capabilities}`,
		`  ${formatFields(record)}`,
		`  ${formatCost(record)}`,
		`  ${formatQuota(record)}`,
	].join("\n");
}

/**
 * Turn a client-side failure into something the agent can act on rather than
 * retry blindly: which service was dialled, what kind of failure it was, and
 * which knob changes the answer.
 */
function describeFailure(error: ServiceRequestError): string {
	const where = `Search Service at ${error.url}`;
	const hint = `Set ${SERVICE_URL_ENV_VAR} if the service is somewhere else.`;
	switch (error.kind) {
		case "network":
			return `${error.message} The ${where} is unreachable - it may not be running. ${hint}`;
		case "timeout":
			return `${error.message} The ${where} accepted the connection but did not answer in time.`;
		case "http": {
			const body = error.bodySnippet === undefined ? "" : ` Body: ${error.bodySnippet}`;
			return `${error.message}${body}`;
		}
		case "parse":
			return `${error.message} This is a service/extension contract mismatch, not something to retry.`;
	}
}

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => {
		api.registerTool({
			name: "list_providers",
			label: "List Providers",
			description:
				"List every search provider the Search Service has configured, with the capabilities it advertises, " +
				"the unified fields it can populate, its cost model and its remaining quota. " +
				"This is the runtime source of truth for what the sources can do: call it before choosing a source " +
				"or writing a provider-native query, and do not assume a capability that is not listed here.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute(_toolCallId, _params, context) {
				context.signal?.throwIfAborted();
				// Resolved per call, not captured at activation: the address is
				// environment, and a tool that cached it would keep dialling a service
				// the user has since moved.
				const baseUrl = resolveServiceBaseUrl(process.env);
				const client = createServiceClient({ baseUrl });

				let providers: readonly ProviderRecord[];
				try {
					providers = await client.listProviders({ signal: context.signal ?? undefined });
				} catch (error) {
					// A failed tool throws: swallowing it here would show the agent an
					// empty provider list, which reads as "there are no sources".
					if (error instanceof ServiceRequestError) throw new Error(describeFailure(error));
					throw error;
				}

				if (providers.length === 0) {
					const text =
						`The Search Service at ${client.baseUrl} is reachable but has no providers configured. ` +
						"No source-backed retrieval is possible until one is enabled.";
					return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, providers: [] } };
				}

				const enabled = providers.filter((provider) => provider.enabled);
				const header =
					`${providers.length} provider(s) configured at ${client.baseUrl}, ` +
					`${enabled.length} enabled. Disabled providers cannot serve a query.`;
				let text = `${header}\n\n${providers.map(formatProvider).join("\n")}`;
				if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;

				return { content: [{ type: "text", text }], details: { baseUrl: client.baseUrl, providers } };
			},
		});
	},
};

export default extension;
