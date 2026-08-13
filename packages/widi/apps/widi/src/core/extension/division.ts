import { utf8ByteLength } from "../../utils/text.ts";
import type {
	ExtensionDivisionDeclaration,
	ExtensionDivisionSelection,
	ExtensionDivisionSelections,
	ExtensionDivisionSnapshot,
	ExtensionDivisionSource,
} from "./types.ts";

const DIVISION_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_DIVISION_ID_BYTES = 128;

export function validateDivisionId(id: string): string | undefined {
	if (!id) return "Division id must not be empty.";
	if (utf8ByteLength(id) > MAX_DIVISION_ID_BYTES) {
		return `Division id '${id}' exceeds ${MAX_DIVISION_ID_BYTES} UTF-8 bytes.`;
	}
	for (const segment of id.split(".")) {
		if (!DIVISION_ID_SEGMENT_PATTERN.test(segment)) {
			return `Division id '${id}' must be dot-separated segments of letters, digits, '_' or '-'.`;
		}
	}
	return undefined;
}

export interface ValidatedDivisionDeclarations {
	readonly divisions: readonly ExtensionDivisionDeclaration[];
	/** One message per dropped declaration. */
	readonly issues: readonly string[];
}

/**
 * Drop malformed or duplicate declarations rather than failing the whole
 * extension: one bad entry should cost that division, not the integration.
 *
 * The input is whatever the extension module exported, so every field is
 * unknown until checked here - a malformed declaration must produce an issue,
 * never a thrown TypeError that takes the catalog load down with it.
 */
export function validateDivisionDeclarations(declarations: unknown): ValidatedDivisionDeclarations {
	if (declarations === undefined) return { divisions: [], issues: [] };
	if (!Array.isArray(declarations)) {
		return { divisions: [], issues: ["divisions must be an array of division declarations."] };
	}

	const divisions: ExtensionDivisionDeclaration[] = [];
	const issues: string[] = [];
	const seen = new Set<string>();

	for (const entry of declarations) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			issues.push("Each division declaration must be an object.");
			continue;
		}
		const declaration = entry as Record<string, unknown>;

		const id = typeof declaration.id === "string" ? declaration.id.trim() : undefined;
		const invalid = validateDivisionId(id ?? "");
		if (invalid) {
			issues.push(invalid);
			continue;
		}
		if (seen.has(id as string)) {
			issues.push(`Duplicate division id '${id}'.`);
			continue;
		}
		const label =
			typeof declaration.label === "string" && declaration.label.trim() ? declaration.label.trim() : undefined;
		if (!label) {
			issues.push(`Division '${id}' must declare a non-empty label.`);
			continue;
		}
		if (declaration.description !== undefined && typeof declaration.description !== "string") {
			issues.push(`Division '${id}' description must be a string.`);
			continue;
		}
		if (declaration.enabledByDefault !== undefined && typeof declaration.enabledByDefault !== "boolean") {
			issues.push(`Division '${id}' enabledByDefault must be a boolean.`);
			continue;
		}

		seen.add(id as string);
		divisions.push({
			id: id as string,
			label,
			description: declaration.description as string | undefined,
			enabledByDefault: declaration.enabledByDefault as boolean | undefined,
		});
	}

	return { divisions, issues };
}

export function joinDivisionId(parentId: string | undefined, id: string): string {
	const normalized = id.trim();
	return parentId ? `${parentId}.${normalized}` : normalized;
}

interface DivisionState {
	readonly enabled: boolean;
	readonly source: ExtensionDivisionSource;
}

/**
 * Resolves one extension's division states for one agent.
 *
 * Rules apply to the named division and its whole subtree, so the nearest
 * matching rule wins, and `disable` beats `enable` on the same id. A
 * resolved-disabled ancestor is then a hard gate: a descendant cannot re-enable
 * itself past it, which keeps "turn this part off" meaning the whole part.
 *
 * Division ids used at activation but never declared resolve enabled by
 * default (fail-open): silently dropping contributions an author registered
 * would be worse than an unlisted toggle.
 */
export class ExtensionDivisionResolver {
	readonly extensionId: string;

	private readonly _declared = new Map<string, ExtensionDivisionDeclaration>();
	private readonly _settings: ExtensionDivisionSelection | undefined;
	private readonly _used = new Set<string>();
	private readonly _states = new Map<string, DivisionState>();

	constructor(options: {
		extensionId: string;
		declarations?: readonly ExtensionDivisionDeclaration[];
		selections?: ExtensionDivisionSelections;
	}) {
		this.extensionId = options.extensionId;
		for (const declaration of options.declarations ?? []) {
			this._declared.set(declaration.id, declaration);
		}
		this._settings = options.selections?.settings?.[options.extensionId];
	}

	/** Records the id as used, so it appears in inspect facts either way. */
	isEnabled(id: string): boolean {
		this._used.add(id);
		return this._resolve(id).enabled;
	}

	listUndeclaredIds(): string[] {
		return [...this._used].filter((id) => !this._declared.has(id)).sort((left, right) => left.localeCompare(right));
	}

	/** Selection rules naming a division that neither exists nor was used. */
	listUnknownSelectionIds(): string[] {
		const known = new Set([...this._declared.keys(), ...this._used]);
		const unknown = new Set<string>();
		for (const id of [...(this._settings?.enable ?? []), ...(this._settings?.disable ?? [])]) {
			if (!known.has(id)) unknown.add(id);
		}
		return [...unknown].sort((left, right) => left.localeCompare(right));
	}

	snapshots(): ExtensionDivisionSnapshot[] {
		const ids = new Set([...this._declared.keys(), ...this._used]);
		return [...ids]
			.sort((left, right) => left.localeCompare(right))
			.map((id) => {
				const declaration = this._declared.get(id);
				const state = this._resolve(id);
				return {
					extensionId: this.extensionId,
					id,
					label: declaration?.label ?? id,
					description: declaration?.description,
					enabled: state.enabled,
					declared: declaration !== undefined,
					source: state.source,
				};
			});
	}

	private _resolve(id: string): DivisionState {
		const cached = this._states.get(id);
		if (cached) return cached;

		// Seed the cache before recursing so a malformed cyclic id cannot loop.
		this._states.set(id, { enabled: true, source: "default" });
		let state = this._resolveOwn(id);
		for (const ancestorId of ancestorIds(id)) {
			if (!this._resolve(ancestorId).enabled) {
				state = { enabled: false, source: "ancestor" };
				break;
			}
		}
		this._states.set(id, state);
		return state;
	}

	private _resolveOwn(id: string): DivisionState {
		for (const candidateId of [id, ...ancestorIds(id).reverse()]) {
			const settings = ruleFor(this._settings, candidateId);
			if (settings !== undefined) {
				return { enabled: settings, source: "settings" };
			}
		}
		return { enabled: this._declared.get(id)?.enabledByDefault ?? true, source: "default" };
	}
}

function ruleFor(selection: ExtensionDivisionSelection | undefined, id: string): boolean | undefined {
	if (!selection) return undefined;
	if (selection.disable?.includes(id)) return false;
	if (selection.enable?.includes(id)) return true;
	return undefined;
}

/** Ancestors of `a.b.c`, outermost first: `["a", "a.b"]`. */
function ancestorIds(id: string): string[] {
	const segments = id.split(".");
	const ancestors: string[] = [];
	for (let index = 1; index < segments.length; index += 1) {
		ancestors.push(segments.slice(0, index).join("."));
	}
	return ancestors;
}
