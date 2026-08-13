import { createJiti } from "jiti";

export interface ExtensionModuleImporter {
	importModule(entryPath: string): Promise<unknown>;
	clearCache(): void;
}

export class JitiExtensionModuleImporter implements ExtensionModuleImporter {
	private readonly modules = new Map<string, unknown>();
	private readonly jiti = createJiti(import.meta.url, { moduleCache: false });
	private generation = 0;

	async importModule(entryPath: string): Promise<unknown> {
		const cacheKey = `${this.generation}:${entryPath}`;
		if (this.modules.has(cacheKey)) {
			return this.modules.get(cacheKey);
		}

		const module = await this.jiti.import(entryPath, { default: true });
		this.modules.set(cacheKey, module);
		return module;
	}

	/**
	 * The full module namespace, for a consumer that needs named exports beside
	 * the default one - the TUI extension host reads the `tui` export this way.
	 */
	async importModuleNamespace(entryPath: string): Promise<unknown> {
		const cacheKey = `namespace:${this.generation}:${entryPath}`;
		if (this.modules.has(cacheKey)) {
			return this.modules.get(cacheKey);
		}

		const module = await this.jiti.import(entryPath);
		this.modules.set(cacheKey, module);
		return module;
	}

	clearCache(): void {
		this.modules.clear();
		this.generation++;
	}
}
