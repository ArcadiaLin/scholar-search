import type { WidiTuiExtensionApi } from "../../../../../packages/widi/apps/widi/src/tui/extension-host/index.ts";
import { ANSWER_POOL_EVENT, type AnswerPoolSnapshot } from "../core/answer-pool.ts";
import { AnswerPoolPanel } from "./answer-pool-panel.ts";

/**
 * The terminal half: the answer pool as somewhere you can go and read.
 *
 * The pool is the episode's answer, and until now the only way to see it was the
 * tool result that changed it - a summary scrolled past among the searches that
 * produced it. What a reader wants is the opposite arrangement: the pool whole,
 * held still, while the search that is building it keeps running.
 *
 * The half holds no pool of its own. `answerPools` is core state, one Map per
 * agent, and the two halves are loaded by different hosts that never see each
 * other's modules; what arrives here is a snapshot pushed over the bus after
 * every committed change (`core/answer-pool.ts`, ANSWER_POOL_EVENT). So the
 * cache below is exactly what has been broadcast since the terminal started, and
 * an agent that has not touched its pool since then has no entry - which the
 * panel says, rather than showing an empty pool it cannot distinguish from one.
 */
export function activateScholarSearchTui(api: WidiTuiExtensionApi): void {
	const snapshots = new Map<string, AnswerPoolSnapshot>();
	let panel: AnswerPoolPanel | undefined;
	let overlay: ReturnType<WidiTuiExtensionApi["showOverlay"]> | undefined;

	const agentStrip = api.capability("agentStrip");
	const editor = api.capability("editor");

	const labelOf = (agentId: string): string =>
		agentStrip?.list().find((agent) => agent.agentId === agentId)?.label ?? agentId;

	const close = (): void => {
		overlay?.close();
		overlay = undefined;
		panel = undefined;
	};

	const open = (): void => {
		const agentId = agentStrip?.visibleAgentId();
		if (agentId === undefined) return;
		if (overlay !== undefined) return;
		panel = new AnswerPoolPanel({
			theme: api.theme,
			agentLabel: labelOf(agentId),
			snapshot: snapshots.get(agentId),
			onClose: () => close(),
		});
		// Dismissible, so escape and the interrupt path take it down before they
		// reach the agent: a reader closing a view they opened is not an abort.
		overlay = api.showOverlay(panel, { width: "94%", margin: 2, anchor: "center", dismissible: true });
	};

	api.onExtensionEvent(ANSWER_POOL_EVENT, (event) => {
		const snapshot = asSnapshot(event.payload);
		if (snapshot === undefined) return;
		snapshots.set(event.sourceAgentId, snapshot);
		if (panel === undefined || agentStrip?.visibleAgentId() !== event.sourceAgentId) return;
		panel.update(snapshot, labelOf(event.sourceAgentId));
		// Nothing was typed and no capability was written, so this is the one case
		// the terminal would not repaint on its own.
		api.requestRender();
	});

	// The panel belongs to the agent it was opened for. Following the strip
	// instead would silently reattribute a pool to whoever is on screen now.
	agentStrip?.onVisibleAgentChanged(() => {
		if (overlay !== undefined) close();
	});

	/*
	 * Left at the very start of the draft, which is a pi-tui no-op: there is
	 * nowhere further left to go, so taking the key there costs no behavior. The
	 * built-in `app.agents.open` claims the opposite end of the draft on the same
	 * argument (`views/editor.ts`), and this is its mirror. Anywhere else in the
	 * draft the handler declines and the editor moves the caret as it always did.
	 *
	 * Extension shortcuts are dispatched from the editor alone, so once the panel
	 * has focus this handler is out of the path entirely - which is why the way
	 * back out is the panel's own right-arrow rather than a second binding here.
	 */
	api.registerShortcut("answer-pool", {
		defaultKeys: "left",
		description: "Open the answer pool when the draft cursor is at the start",
		handler: () => {
			const cursor = editor?.getCursor();
			if (cursor === undefined || cursor.line !== 0 || cursor.col !== 0) return false;
			open();
			return true;
		},
	});

	api.registerCommand({
		kind: "action",
		agentPolicy: "active",
		name: "answer-pool",
		description: "Show what this agent has committed as its answer.",
		execute: () => {
			open();
			return Promise.resolve(undefined);
		},
	});

	api.onDispose(() => close());
}

/**
 * The bus hands back a frozen JSON copy, so the shape has to be re-established
 * here rather than assumed. Anything that fails is dropped: a malformed payload
 * on a bus every extension can emit onto is not worth a diagnostic per event.
 */
function asSnapshot(payload: unknown): AnswerPoolSnapshot | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const candidate = payload as Partial<AnswerPoolSnapshot>;
	if (typeof candidate.agentId !== "string") return undefined;
	if (!Array.isArray(candidate.papers) || !Array.isArray(candidate.removed)) return undefined;
	if (typeof candidate.note !== "string") return undefined;
	return candidate as AnswerPoolSnapshot;
}
