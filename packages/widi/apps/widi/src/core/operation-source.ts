export type OperationSource =
	| { readonly kind: "human"; readonly adapterId?: string }
	| { readonly kind: "agent"; readonly agentId: string }
	| { readonly kind: "extension"; readonly extensionId: string }
	| { readonly kind: "tool"; readonly agentId: string; readonly toolCallId: string; readonly toolName: string }
	| { readonly kind: "system" }
	| { readonly kind: "external"; readonly id: string };

/** Extract the acting agent's id when the source is agent- or tool-scoped. */
export function agentIdFromOperationSource(source: OperationSource | undefined): string | undefined {
	if (!source) return undefined;
	if (source.kind === "agent" || source.kind === "tool") {
		return source.agentId;
	}
	return undefined;
}
