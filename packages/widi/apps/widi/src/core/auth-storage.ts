/**
 * Credential storage for API keys and OAuth tokens.
 *
 * The file backend uses the shared ExecutionEnv for file I/O so auth storage,
 * model registry, and config resolution can all run through the same runtime
 * boundary. API key template resolution stays at the AuthStorage layer through
 * ConfigValueResolver.
 */

import type { ExecutionEnv } from "@arcadialin/agent-core";
import type {
	AuthInteraction,
	CredentialInfo,
	CredentialStore,
	OAuthAuth,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Credential as PiCredential,
} from "@earendil-works/pi-ai";
import { AsyncLock } from "../utils/async-lock.ts";
import { DEFAULT_AGENT_DIR } from "./constants.js";
import type { CoreDiagnostic } from "./diagnostics.ts";
import type { ConfigValueResolver } from "./resolve-config-value.js";

export type ApiKeyCredential = { type: "api_key"; key: string };

export type OAuthCredential = { type: "oauth" } & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export type LockResult<T> = { result: T; next?: string };

export type AuthDiagnostic = CoreDiagnostic;

const DEFAULT_AUTH_PATH = `${DEFAULT_AGENT_DIR}/auth.json`;

export interface AuthStorageBackend {
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/**
 * Credential storage backed by an auth.json file.
 *
 * The in-process lock serializes writes for this backend today. It does not
 * make shared auth.json writes safe across WIDI processes. A later ExecutionEnv
 * implementation can add multi-process locking behind the same read/write
 * boundary without changing AuthStorage's public API.
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	private readonly executionEnv: ExecutionEnv;
	private readonly authPath: string;
	private readonly lock = new AsyncLock();

	constructor(executionEnv: ExecutionEnv, authPath: string = DEFAULT_AUTH_PATH) {
		this.executionEnv = executionEnv;
		this.authPath = authPath;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		return await this.lock.run(async () => {
			await this.ensureFileExists();
			const current = await this.readCurrent();
			const { result, next } = await fn(current);
			if (next !== undefined) {
				await this.writeNext(next);
			}
			return result;
		});
	}

	private async ensureFileExists(): Promise<void> {
		const existsResult = await this.executionEnv.exists(this.authPath);
		if (!existsResult.ok) {
			throw existsResult.error;
		}
		if (existsResult.value) {
			return;
		}
		await this.writeNext("{}");
	}

	private async readCurrent(): Promise<string | undefined> {
		const readResult = await this.executionEnv.readTextFile(this.authPath);
		if (readResult.ok) {
			return readResult.value;
		}
		if (readResult.error.code === "not_found") {
			return undefined;
		}
		throw readResult.error;
	}

	private async writeNext(next: string): Promise<void> {
		const writeResult = await this.executionEnv.writeFile(this.authPath, next);
		if (!writeResult.ok) {
			throw writeResult.error;
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private readonly lock = new AsyncLock();

	constructor(data?: AuthStorageData) {
		if (data) {
			this.value = JSON.stringify(data, null, 2);
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		return await this.lock.run(async () => {
			const { result, next } = await fn(this.value);
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		});
	}
}

export interface AuthStorageOptions {
	configValueResolver: ConfigValueResolver;
}

/**
 * OAuth capability of a runtime provider, exposed to AuthStorage by the
 * ModelRegistry so login and token refresh can reach the provider-owned
 * OAuthAuth implementation.
 */
export interface OAuthProviderSource {
	id: string;
	name: string;
	oauth: OAuthAuth;
}

export class AuthStorage implements CredentialStore {
	private data: AuthStorageData = {};
	private readonly runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private oauthProvidersSource?: () => readonly OAuthProviderSource[];
	private loadError: Error | null = null;
	private loadDiagnostic: AuthDiagnostic | undefined;
	private errors: Error[] = [];
	private diagnostics: AuthDiagnostic[] = [];
	private readonly storage: AuthStorageBackend;
	private readonly configValueResolver: ConfigValueResolver;

	private constructor(storage: AuthStorageBackend, options: AuthStorageOptions) {
		this.storage = storage;
		this.configValueResolver = options.configValueResolver;
	}

	static create(executionEnv: ExecutionEnv, options: AuthStorageOptions, authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(executionEnv, authPath), options);
	}

	static fromStorage(storage: AuthStorageBackend, options: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, options);
	}

	static inMemory(options: AuthStorageOptions, data: AuthStorageData = {}): AuthStorage {
		return AuthStorage.fromStorage(new InMemoryAuthStorageBackend(data), options);
	}

	/**
	 * Load credentials from storage after construction.
	 *
	 * Construction stays synchronous-ish so callers can build the storage graph
	 * first, then explicitly await runtime I/O at the application boundary.
	 */
	async initialize(): Promise<void> {
		await this.reload();
	}

	/**
	 * Set a runtime API key override. This is intentionally not persisted.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 *
	 * ModelRegistry uses this for provider API keys declared in models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Set the live source of OAuth-capable runtime providers.
	 *
	 * ModelRegistry wires this to the Models runtime so AuthStorage can drive
	 * OAuth login and token refresh without owning provider registrations.
	 */
	setOAuthProvidersSource(source: () => readonly OAuthProviderSource[]): void {
		this.oauthProvidersSource = source;
	}

	private getOAuthProviderSource(providerId: string): OAuthProviderSource | undefined {
		return this.oauthProvidersSource?.().find((source) => source.id === providerId);
	}

	private recordError(
		error: unknown,
		code: "auth.load_failed" | "auth.persist_failed" | "auth.oauth_refresh_failed",
		provider?: string,
	): AuthDiagnostic {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
		const diagnostic = createAuthDiagnostic(code, normalizedError, provider);
		this.diagnostics.push(diagnostic);
		return diagnostic;
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from the backend.
	 */
	async reload(): Promise<void> {
		let content: string | undefined;
		try {
			await this.storage.withLockAsync(async (current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
			this.loadDiagnostic = undefined;
		} catch (error) {
			this.loadError = error as Error;
			this.loadDiagnostic = this.recordError(error, "auth.load_failed");
		}
	}

	private async persistProviderChange(provider: string, credential: AuthCredential | undefined): Promise<void> {
		if (this.loadError) {
			return;
		}

		try {
			await this.storage.withLockAsync(async (current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error, "auth.persist_failed", provider);
		}
	}

	/**
	 * Get the stored credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set and persist the stored credential for a provider.
	 */
	async set(provider: string, credential: AuthCredential): Promise<void> {
		this.data[provider] = credential;
		await this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove and persist the stored credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		delete this.data[provider];
		await this.persistProviderChange(provider, undefined);
	}

	/**
	 * CredentialStore read path used by Pi's Models runtime.
	 *
	 * Stored API key values may be WIDI config values, so request-time reads
	 * expose the resolved key while keeping the persisted credential unchanged.
	 */
	async read(providerId: string): Promise<PiCredential | undefined> {
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return { type: "api_key", key: runtimeKey };
		}
		return await this.resolveCredentialForRead(this.data[providerId]);
	}

	/**
	 * Serialized CredentialStore write path.
	 *
	 * Pi's Models runtime uses this for OAuth refresh, where the callback must
	 * see the current raw credential and the returned credential must be
	 * persisted atomically with that read.
	 */
	async modify(
		providerId: string,
		fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
	): Promise<PiCredential | undefined> {
		let postCredential: AuthCredential | undefined;
		let recordedFailure = false;
		try {
			await this.storage.withLockAsync(async (current) => {
				const currentData = this.parseStorageData(current);
				this.data = currentData;
				this.loadError = null;
				this.loadDiagnostic = undefined;

				let nextCredential: PiCredential | undefined;
				try {
					nextCredential = await fn(currentData[providerId]);
				} catch (error) {
					if (currentData[providerId]?.type === "oauth") {
						this.recordError(error, "auth.oauth_refresh_failed", providerId);
						recordedFailure = true;
					}
					throw error;
				}
				if (nextCredential === undefined) {
					postCredential = currentData[providerId];
					return { result: postCredential };
				}

				const merged: AuthStorageData = { ...currentData, [providerId]: nextCredential as AuthCredential };
				this.data = merged;
				postCredential = merged[providerId];
				return { result: postCredential, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			if (!recordedFailure) {
				this.recordError(error, "auth.persist_failed", providerId);
			}
			throw error;
		}
		return postCredential;
	}

	async delete(providerId: string): Promise<void> {
		await this.remove(providerId);
	}

	/**
	 * List stored credential metadata without exposing secrets.
	 */
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	/**
	 * Check whether auth.json contains a credential for this provider.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check whether any auth source is configured for this provider.
	 *
	 * Unlike getApiKey(), this does not refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all stored credentials. OAuth refresh helpers need the full map.
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	private async resolveCredentialForRead(credential: AuthCredential | undefined): Promise<PiCredential | undefined> {
		if (!credential || credential.type !== "api_key") {
			return credential;
		}
		return { ...credential, key: await this.configValueResolver.resolveConfigValue(credential.key) };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLoadDiagnostic(): AuthDiagnostic | undefined {
		return this.loadDiagnostic;
	}

	drainDiagnostics(): AuthDiagnostic[] {
		const drained = [...this.diagnostics];
		this.diagnostics = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider and persist the returned credentials.
	 */
	async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		const source = this.getOAuthProviderSource(providerId);
		if (!source) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credential = await source.oauth.login(oauthLoginCallbacksToInteraction(callbacks));
		await this.set(providerId, credential);
	}

	/**
	 * Logout from a provider by removing its stored credential.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	/**
	 * Refresh an OAuth token while holding the backend lock.
	 *
	 * The lock is deliberately owned by the backend so a future file backend can
	 * coordinate multiple WIDI processes without changing this method.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: string,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const source = this.getOAuthProviderSource(providerId);
		if (!source) {
			return null;
		}

		return await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;
			this.loadDiagnostic = undefined;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				const apiKey = (await source.oauth.toAuth(cred)).apiKey;
				if (apiKey === undefined) {
					return { result: null };
				}
				return { result: { apiKey, newCredentials: cred } };
			}

			const newCredentials = await source.oauth.refresh(cred);
			const apiKey = (await source.oauth.toAuth(newCredentials)).apiKey;
			if (apiKey === undefined) {
				return { result: null };
			}

			const merged: AuthStorageData = { ...currentData, [providerId]: newCredentials };
			this.data = merged;
			this.loadError = null;
			this.loadDiagnostic = undefined;
			return { result: { apiKey, newCredentials }, next: JSON.stringify(merged, null, 2) };
		});
	}

	/**
	 * Get an API key for a provider.
	 *
	 * Priority:
	 * 1. Runtime override
	 * 2. Stored API key
	 * 3. Stored OAuth token, refreshing with backend locking when needed
	 * 4. Fallback resolver, unless disabled by the caller
	 *
	 * Ambient sources (env vars, cloud profiles) are not consulted here; they
	 * resolve through the provider-owned auth on the Models runtime.
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return await this.configValueResolver.resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			const source = this.getOAuthProviderSource(providerId);
			if (!source) {
				return undefined;
			}

			if (Date.now() >= cred.expires) {
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error, "auth.oauth_refresh_failed", providerId);
					// Refresh failed. Re-read storage in case another backend actor refreshed first.
					await this.reload();
					const updatedCred = this.data[providerId];
					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another actor refreshed successfully; use those credentials.
						return (await source.oauth.toAuth(updatedCred)).apiKey;
					}
					return undefined;
				}
			}

			return (await source.oauth.toAuth(cred)).apiKey;
		}

		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all OAuth-capable runtime providers.
	 */
	getOAuthProviders(): { id: string; name: string }[] {
		return (this.oauthProvidersSource?.() ?? []).map(({ id, name }) => ({ id, name }));
	}
}

function createAuthDiagnostic(
	code: "auth.load_failed" | "auth.persist_failed" | "auth.oauth_refresh_failed",
	error: Error,
	provider: string | undefined,
): AuthDiagnostic {
	return { severity: "error", code, message: provider ? `${provider}: ${error.message}` : error.message };
}

/**
 * Adapt the legacy extension-style OAuth login callbacks to the pi-ai
 * AuthInteraction surface expected by provider-owned OAuthAuth flows.
 */
function oauthLoginCallbacksToInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
	return {
		signal: callbacks.signal,
		prompt: async (prompt) => {
			switch (prompt.type) {
				case "text":
				case "secret":
					return await callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
				case "manual_code":
					if (callbacks.onManualCodeInput) {
						return await callbacks.onManualCodeInput();
					}
					return await callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
				case "select": {
					const selected = await callbacks.onSelect({
						message: prompt.message,
						options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
					});
					if (selected === undefined) {
						throw new Error("Login cancelled");
					}
					return selected;
				}
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode({
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						intervalSeconds: event.intervalSeconds,
						expiresInSeconds: event.expiresInSeconds,
					});
					break;
				case "info":
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
	};
}
