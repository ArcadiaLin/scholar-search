import type { CommandEngine } from "../commands/engine.ts";
import type { LayoutSlotEntry } from "../layout/slots.ts";
import type { SelectorHintContext } from "../selectors/hints.ts";
import { hasDockedFocus, type TuiApplicationState } from "../state.ts";
import type { AgentStripView } from "./agent-strip.ts";
import { ChatView } from "./chat.ts";
import type { WidiEditor } from "./editor.ts";
import { FooterView } from "./footer.ts";
import { HeaderView } from "./header.ts";
import type { HumanRequestMenu } from "./human-request.ts";
import { NoticeView } from "./notices.ts";
import { OperationHintView } from "./operation-hint.ts";
import { QueuedInputView } from "./queued-input.ts";
import type { SelectorDock } from "./selector-dock.ts";
import { StagedInputView } from "./staged-input.ts";
import { StatusView } from "./status.ts";
import { WorkingLineView } from "./working-line.ts";

/**
 * What the application lends its views. The four components it holds itself
 * are passed in rather than constructed here: it drives them directly (focus,
 * open/close, submit callbacks), so their lifetime is longer than the layout's.
 */
export interface SlotDeps {
	readonly state: TuiApplicationState;
	readonly engine: CommandEngine;
	readonly cwd: string;
	readonly editor: WidiEditor;
	readonly humanRequests: HumanRequestMenu;
	readonly selectorDock: SelectorDock;
	readonly agentStrip: AgentStripView;
	requestRender(): void;
	/** Hint context of the selector currently docked in the editor's place. */
	selectorHint(): SelectorHintContext | undefined;
}

/**
 * Every mounted view as a slot entry, in render order. Order is a property of
 * this list, not of when a view happens to be constructed, which is why the
 * entries live together instead of beside each view.
 */
export function widiSlots(deps: SlotDeps): readonly LayoutSlotEntry[] {
	return [
		{ key: "header", slot: "header", scope: "global", factory: () => new HeaderView(deps.state) },
		{ key: "notices", slot: "notices", scope: "global", factory: () => new NoticeView(deps.state) },
		{ key: "chat", slot: "chat", scope: "global", factory: () => new ChatView(deps.state) },
		{ key: "status", slot: "status", scope: "global", factory: () => new StatusView(deps.state) },
		// The working line sits directly under the transcript because that is
		// what it continues: the run the transcript is being written by. Below
		// it, closer to the editor means more settled - a request is still
		// waiting on the human, staged text can still be rewritten, and the
		// queue is decided and only waiting for its turn. The dock is last
		// because it takes the editor's own place.
		{
			key: "workingLine",
			slot: "aboveEditor",
			order: 0,
			scope: "global",
			factory: () => new WorkingLineView({ state: deps.state, engine: deps.engine, editor: deps.editor }),
		},
		{ key: "humanRequests", slot: "aboveEditor", order: 1, scope: "global", factory: () => deps.humanRequests },
		{
			key: "stagedInput",
			slot: "aboveEditor",
			order: 2,
			scope: "global",
			factory: () => new StagedInputView(deps.state),
		},
		{
			key: "queuedInput",
			slot: "aboveEditor",
			order: 3,
			scope: "global",
			factory: () => new QueuedInputView(deps.state),
		},
		{ key: "selectorDock", slot: "aboveEditor", order: 4, scope: "global", factory: () => deps.selectorDock },
		{
			key: "editor",
			slot: "editor",
			scope: "global",
			factory: () => deps.editor,
			// Like pi's showSelector, an open command selector takes the editor's
			// place: the editor leaves the layout while the dock holds a view.
			// Being preempted does not give the place back — the dock still
			// holds the view, it just is not the one reading keys.
			visible: (state) => !hasDockedFocus(state, "selector"),
		},
		{
			key: "footer",
			slot: "footer",
			scope: "global",
			factory: () => new FooterView(deps.state, deps.cwd, () => deps.requestRender()),
		},
		{
			key: "operationHint",
			// Below the footer, not below the editor: it has always rendered
			// there, and "belowEditor" is now literally the editor/footer gap.
			slot: "belowFooter",
			scope: "global",
			factory: () =>
				new OperationHintView({
					state: deps.state,
					engine: deps.engine,
					editor: deps.editor,
					selectorHint: () => deps.selectorHint(),
				}),
		},
		{ key: "agentStrip", slot: "agentStrip", scope: "global", factory: () => deps.agentStrip },
	];
}
