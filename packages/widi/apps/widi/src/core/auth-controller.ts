import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { formatError } from "../utils/errors.ts";
import { type OrchestratorDiagnostic, OrchestratorError, toDiagnostic } from "./diagnostics.ts";
import type { HumanRequestBroker, HumanRequestDraft, HumanResponse } from "./human-request.ts";
import type { ModelRegistry } from "./model-registry.js";
import type { AgentId, CandidateItem, OrchestratorEvent } from "./types.ts";

export interface AuthProviderCandidateListResult {
	readonly providers: readonly CandidateItem[];
}

export interface AuthCredentialCandidateListResult {
	readonly providers: readonly CandidateItem[];
}

export interface AuthProviderLoginResult {
	readonly providerId: string;
	readonly providerName: string;
}

export interface AuthProviderLogoutResult {
	readonly providerId: string;
	readonly removed: boolean;
}

/** OAuth, credential mutation, and provider-auth interaction owner. */
export class AuthRuntimeController {
	private readonly _models: ModelRegistry;
	private readonly _humanRequests: HumanRequestBroker;
	private readonly _publish: (event: OrchestratorEvent) => Promise<void>;
	private readonly _diagnose: (diagnostic: OrchestratorDiagnostic) => Promise<void>;
	private readonly _diagnoseMany: (diagnostics: readonly OrchestratorDiagnostic[]) => Promise<void>;

	constructor(options: {
		readonly models: ModelRegistry;
		readonly humanRequests: HumanRequestBroker;
		readonly publish: (event: OrchestratorEvent) => Promise<void>;
		readonly diagnose: (diagnostic: OrchestratorDiagnostic) => Promise<void>;
		readonly diagnoseMany: (diagnostics: readonly OrchestratorDiagnostic[]) => Promise<void>;
	}) {
		this._models = options.models;
		this._humanRequests = options.humanRequests;
		this._publish = options.publish;
		this._diagnose = options.diagnose;
		this._diagnoseMany = options.diagnoseMany;
	}

	listProviders(): AuthProviderCandidateListResult {
		const storage = this._models.authStorage;
		return {
			providers: storage
				.getOAuthProviders()
				.map((provider) => ({
					value: provider.id,
					label: provider.name,
					description: storage.getAuthStatus(provider.id).configured ? "logged in" : undefined,
				})),
		};
	}

	async listCredentials(): Promise<AuthCredentialCandidateListResult> {
		const storage = this._models.authStorage;
		const providers = storage.getOAuthProviders();
		return {
			providers: (await storage.list()).map((info) => ({
				value: info.providerId,
				label: providers.find((provider) => provider.id === info.providerId)?.name ?? info.providerId,
			})),
		};
	}

	async login(providerId: string, options?: { readonly agentId?: AgentId }): Promise<AuthProviderLoginResult> {
		const storage = this._models.authStorage;
		const reference = providerId.trim();
		const provider = storage.getOAuthProviders().find((candidate) => candidate.id === reference);
		if (!provider) {
			throw new OrchestratorError({
				severity: "error",
				code: "auth.provider_unknown",
				message: `Unknown auth provider: ${reference || "(none)"}. Available providers: ${storage
					.getOAuthProviders()
					.map((candidate) => candidate.id)
					.join(", ")}.`,
				agentId: options?.agentId,
			});
		}
		const settle = new AbortController();
		try {
			await storage.login(provider.id, this._createCallbacks(provider.id, options?.agentId, settle.signal));
		} catch (error) {
			throw new OrchestratorError(
				toDiagnostic(error, {
					code: "auth.login_failed",
					message: `Login to ${provider.name} failed: ${formatError(error)}`,
					agentId: options?.agentId,
				}),
			);
		} finally {
			settle.abort();
			await this._diagnoseMany(storage.drainDiagnostics());
		}
		try {
			await this._models.refresh();
		} catch (error) {
			await this._diagnose({
				severity: "warning",
				code: "model.load_failed",
				message: `Model registry refresh after login failed: ${formatError(error)}`,
			});
		}
		return { providerId: provider.id, providerName: provider.name };
	}

	async logout(providerId: string): Promise<AuthProviderLogoutResult> {
		const storage = this._models.authStorage;
		const reference = providerId.trim();
		if (!reference) {
			throw new OrchestratorError({
				severity: "error",
				code: "auth.provider_unknown",
				message: "Auth provider reference must not be empty.",
			});
		}
		const removed = storage.has(reference);
		await storage.logout(reference);
		await this._diagnoseMany(storage.drainDiagnostics());
		return { providerId: reference, removed };
	}

	private _createCallbacks(providerId: string, agentId: AgentId | undefined, signal: AbortSignal): OAuthLoginCallbacks {
		const requestHuman = async (draft: HumanRequestDraft) =>
			await this._humanRequests.request({ ...draft, source: { kind: "human" }, signal }, { agentId });
		const inputValue = (response: HumanResponse) => (response.kind === "input" ? response.value : undefined);
		return {
			signal,
			onAuth: (info) => {
				void this._publish({
					type: "auth_login_url",
					providerId,
					agentId,
					url: info.url,
					instructions: info.instructions,
					createdAt: now(),
				});
			},
			onDeviceCode: (info) => {
				void this._publish({
					type: "auth_login_code",
					providerId,
					agentId,
					userCode: info.userCode,
					verificationUri: info.verificationUri,
					createdAt: now(),
				});
			},
			onProgress: (message) => {
				void this._publish({ type: "auth_login_progress", providerId, agentId, message, createdAt: now() });
			},
			onPrompt: async (prompt) => {
				const response = await requestHuman({ kind: "input", title: prompt.message, placeholder: prompt.placeholder });
				const value = inputValue(response);
				if (value !== undefined) return value;
				if (prompt.allowEmpty) return "";
				throw new Error("Login prompt was dismissed.");
			},
			onManualCodeInput: async () => {
				const response = await requestHuman({
					kind: "input",
					title: "Complete login in your browser, or paste the authorization code / redirect URL here:",
					provisional: true,
				});
				const value = inputValue(response);
				if (value === undefined) {
					throw new Error("Login input was dismissed.");
				}
				return value;
			},
			onSelect: async (prompt) => {
				const response = await requestHuman({
					kind: "select",
					title: prompt.message,
					options: prompt.options.map((option) => option.label),
				});
				const label = response.kind === "select" ? response.value : undefined;
				return prompt.options.find((option) => option.label === label)?.id;
			},
		};
	}
}

function now(): string {
	return new Date().toISOString();
}
