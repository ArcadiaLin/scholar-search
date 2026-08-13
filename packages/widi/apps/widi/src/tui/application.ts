import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	Container,
	ProcessTerminal,
	ScrollView,
	setKeybindings,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import { DEFAULT_AGENT_DIR } from "../core/constants.js";
import { type OrchestratorDiagnostic, OrchestratorError } from "../core/diagnostics.ts";
import { type MessageSink, messageBindingFor } from "../core/message.ts";
import { createWidiRuntime, type WidiRuntime } from "../core/runtime-service.ts";
import type { AgentActivitySnapshot, CandidateItem, OrchestratorEvent, RuntimeModel } from "../core/types.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { forkSourceAgentId } from "./agent-identity.ts";
import { buildAgentTree, flattenAgentTree } from "./agent-tree.ts";
import { WidiCommandAutocompleteProvider } from "./autocomplete.ts";
import {
	APPLICATION_CALLER,
	type CommandRunOutcome,
	SEGMENT_SLOTS,
	type StagedInputEntry,
	TuiCapabilityRegistry,
} from "./capabilities.ts";
import { widiCommands } from "./commands/built-in/index.ts";
import { CommandEngine } from "./commands/engine.ts";
import { parseLineCommand } from "./commands/parse.ts";
import type { CommandDefinition, CommandError, EngineOutcome } from "./commands/types.ts";
import { applyAgentSnapshot, EventProjector } from "./event-projector.ts";
import { TuiExtensionHost } from "./extension-host/index.ts";
import { FatalErrorView } from "./fatal-error.ts";
import { createWidiKeybindings, loadUserKeybindings } from "./keybindings.ts";
import { agentLabel, maintenanceLabel } from "./labels.ts";
import { type AppOverlayHandle, OverlayStack } from "./layout/overlay-stack.ts";
import { LayoutSlots } from "./layout/slots.ts";
import { PendingAgentController, type PendingAgentDisplay } from "./pending-agent.ts";
import { hasLiveTransientQuip, setSteadyQuip, setTransientQuip } from "./quips.ts";
import type { SelectorHintContext } from "./selectors/hints.ts";
import { ListSelector, type ListSelectorRequest } from "./selectors/list-selector.ts";
import { TreeNavigationSelector } from "./selectors/tree-navigation.ts";
import { TreeSelector } from "./selectors/tree-selector.ts";
import { hydrateSessionEntries } from "./session-hydrator.ts";
import { buildSessionEntryRows } from "./session-tree.ts";
import { StartupHumanPrompt } from "./startup-human-prompt.ts";
import {
	type AgentViewState,
	clearDockedFocus,
	createTuiApplicationState,
	type ExtensionOutputItem,
	ensureAgentProjection,
	type NoticeItem,
	type NoticeTextMode,
	type StagedDraft,
	setActiveAgent,
	type TuiApplicationState,
	topDockedFocus,
} from "./state.ts";
import { flushStreaming, STREAM_FLUSH_MS } from "./streaming-flush.ts";
import { getAllThemes, loadThemes, setTheme, theme } from "./theme/theme.ts";
import { AgentStripView } from "./views/agent-strip.ts";
import { WidiEditor } from "./views/editor.ts";
import { HumanRequestMenu } from "./views/human-request.ts";
import { widiSlots } from "./views/index.ts";
import { SelectorDock } from "./views/selector-dock.ts";

const NOTIFICATION_TTL_MS = 5_000;
/** Staged drafts held for one agent before the buffer lands itself. */
const MAX_STAGED_DRAFTS = 20;
/** Spinner frame cadence while the visible agent is running. */
const SPINNER_TICK_MS = 160;
/** Repaint cadence while the working line is holding a line that expires. */
const QUIP_TICK_MS = 250;
/** Interrupts or steers inside this window before the agent says something about it. */
const POKE_WINDOW_MS = 10_000;
const POKE_THRESHOLD = 3;

export interface WidiTuiOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	readonly runtime?: WidiRuntime;
}

export class WidiTuiApplication {
	readonly runtime: WidiRuntime;
	readonly orchestrator: AgentOrchestrator;
	readonly state: TuiApplicationState;
	readonly tui: TuiAltScreen;
	/** Everything this shell puts into an agent's context goes through here. */
	readonly messages: MessageSink;

	private readonly projector: EventProjector;
	private readonly editor: WidiEditor;
	/** Application overlay stack: the fatal boundary and extension overlays. Command selectors dock instead. */
	private readonly overlays: OverlayStack;
	private readonly humanRequests: HumanRequestMenu;
	/** Docked command-selector host: the open selector takes the editor's place. */
	private readonly selectorDock: SelectorDock;
	private readonly agentPanel: AgentStripView;
	private readonly pendingAgents: PendingAgentController;
	/** Unknown "/" input awaiting a confirming second enter (v2 §11.2). */
	private pendingUnknownCommand?: { scopeId: string; text: string };
	/** The line a command is executing under, so the command can hand it back. */
	private runningSubmit?: { readonly rawText: string; readonly agentId: string | undefined };
	private readonly engine = new CommandEngine();
	private unsubscribeEvents?: () => void;
	private unregisterClient?: () => void;
	private readonly hydrationGeneration = new Map<string, number>();
	private readonly hydratedAgents = new Set<string>();
	private readonly notificationTimers = new Map<string, NodeJS.Timeout>();
	private streamingFlushTimer?: NodeJS.Timeout;
	private animationTicker?: NodeJS.Timeout;
	private animationTickerInterval?: number;
	/** Layout assembly: every mounted view is a registered slot entry. */
	readonly layout = new LayoutSlots();
	/** What the layout's named parts can be told to do; see capabilities.ts. */
	readonly capabilities = new TuiCapabilityRegistry();
	/** The selection a capability caller opened, so its close() cannot take down a command's. */
	private capabilitySelector?: { readonly view: Component; readonly settle: (value?: string) => void };
	private readonly visibleAgentListeners = new Set<(agentId: string | undefined) => void>();
	private notifiedVisibleAgentId?: string;
	private readonly pendingTasks = new Set<Promise<unknown>>();
	private readonly lifecycleTasks = new Set<Promise<unknown>>();
	private readonly drafts = new Map<string, string>();
	private nextPendingFollowUpId = 1;
	private nextStagedId = 1;
	/** Recent interrupt/steer timestamps behind the "stop poking me" line. */
	private pokes: number[] = [];
	private started = false;
	private shutdownPromise?: Promise<void>;
	private resolveClosed?: () => void;
	private readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});
	private readonly onSigterm = () => {
		void this.shutdown("SIGTERM").catch(() => {});
	};
	private readonly onSigint = () => {
		void this.shutdown("SIGINT").catch(() => {});
	};
	private fatalOverlayShown = false;
	/** TUI extension host, activated in create(); undefined until then. */
	private extensionHost?: TuiExtensionHost;
	/** Diagnostics from user TUI config (keybindings, themes) and command registration, projected on run. */
	private readonly userConfigDiagnostics: OrchestratorDiagnostic[] = [];
	private readonly onUncaughtError = (error: unknown) => {
		// The fatal application-error boundary (v2 §13.1): state may be corrupt,
		// so the modal overlay only offers Quit or read-only diagnostics. If the
		// overlay itself cannot be shown, fall back to stderr instead of dying
		// inside the uncaught-error handler.
		try {
			this.showFatalOverlay("application.unexpected_error", errorMessage(error));
		} catch {
			try {
				process.stderr.write(`Fatal application error: ${errorMessage(error)}\n`);
			} catch {
				// Nothing left to report through.
			}
		}
	};

	private constructor(runtime: WidiRuntime) {
		this.runtime = runtime;
		this.orchestrator = runtime.orchestrator;
		this.messages = this.orchestrator.messageSinkFor(messageBindingFor({ kind: "human" }));
		this.state = createTuiApplicationState();
		this.projector = new EventProjector(this.state);
		this.pendingAgents = new PendingAgentController(this.state, this.orchestrator, this.defaultPendingDisplay());

		// Built-ins go through the same runtime registration path extension
		// commands will use (Step 6); a name conflict becomes a startup
		// diagnostic instead of a silent override.
		for (const command of widiCommands({
			quit: () => {
				void this.shutdown("user exit").catch(() => {});
			},
			newAgent: async (profileId) => {
				await this.beginNewAgent(profileId);
			},
			newSession: async (sourceAgentId) => {
				await this.beginNewSession(sourceAgentId);
			},
			setWorkspace: async (path) => await this.setPendingWorkspace(path),
			setPendingModel: (model) => this.setPendingModel(model),
			setTheme: (name) => this.applyTheme(name),
			disposeAgent: async (agentId) => {
				await this.disposeAgent(agentId);
			},
			switchToAgent: async (agentId) => {
				await this.activateNavigationAgent(agentId);
			},
			setEditorText: (text) => {
				this.editor.setText(text);
			},
			restoreSubmittedText: () => {
				if (this.runningSubmit) this.restoreEditor(this.runningSubmit.rawText, this.runningSubmit.agentId);
			},
			diagnostics: this.state.diagnostics,
			copyText: (text) => copyToClipboard(text),
		})) {
			const diagnostic = this.engine.register(command);
			if (diagnostic) this.userConfigDiagnostics.push(diagnostic);
		}

		// User keybindings load after the extension host activates (create()),
		// because extension shortcut actions are only valid override targets once
		// they exist; the constructor starts on defaults.
		setKeybindings(createWidiKeybindings());
		this.userConfigDiagnostics.push(...loadThemes(runtime.services.agentDir));
		// Before the editor is built: it captures the editor sub-theme, and while
		// that reference is live, starting on the wrong palette would still paint
		// one frame in it.
		const savedTheme = runtime.services.settingManager.getTheme();
		if (savedTheme !== undefined && !setTheme(savedTheme)) {
			this.userConfigDiagnostics.push({
				severity: "warning",
				code: "theme.unknown",
				message: `Settings name the theme "${savedTheme}", which no themes directory provides; the default is used.`,
			});
		}
		this.tui = new TuiAltScreen(new ProcessTerminal(), undefined, undefined, {
			wheelScrollLines: runtime.services.settingManager.getTerminalSettings().wheelScrollLines,
		});
		this.editor = new WidiEditor(this.tui, theme.editorTheme, { autocompleteMaxVisible: 8 });
		this.editor.onExtensionShortcut = (data) => this.extensionHost?.handleShortcut(data) ?? false;
		this.editor.setArgumentHintProvider((text) => {
			const name = /^\/(\S+)\s*$/.exec(text)?.[1];
			return name ? this.engine.get(name)?.argumentHint : undefined;
		});
		this.editor.setCommandRecognizer((name) => this.engine.get(name) !== undefined);
		this.humanRequests = new HumanRequestMenu({
			host: this.tui,
			state: this.state,
			resolveAgentLabel: (agentId) => this.resolveAgentLabel(agentId),
			restoreFocus: () => this.overlays.restoreFocus(),
		});
		this.selectorDock = new SelectorDock({
			host: this.tui,
			state: this.state,
			restoreFocus: () => this.overlays.restoreFocus(),
		});
		this.agentPanel = new AgentStripView(
			this.state,
			this.tui,
			(agentId) => this.switchAgent(agentId),
			() => {
				this.overlays.restoreFocus();
			},
		);
		this.overlays = new OverlayStack({
			host: this.tui,
			state: this.state,
			editor: this.editor,
			dockedFocusTarget: () => this.dockedFocusTarget(),
		});

		// The built-in views dogfood the same slot registry extension widgets
		// will use; registration order is the render order the hardcoded
		// addChild sequence used to fix.
		for (const entry of widiSlots({
			state: this.state,
			engine: this.engine,
			cwd: this.runtime.services.cwd,
			editor: this.editor,
			humanRequests: this.humanRequests,
			selectorDock: this.selectorDock,
			agentStrip: this.agentPanel,
			requestRender: () => {
				this.tui.requestRender();
			},
			selectorHint: () => this.topSelectorHint(),
		})) {
			this.layout.register(entry);
		}
		this.publishCapabilities();
		const transcript = new Container();
		const dock = new Container();
		this.layout.mount({ transcript, dock }, this.state);
		const transcriptScrollView = new ScrollView(transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
		});
		this.tui.setLayoutRoot(
			new VStack([
				{ component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.tui.setFocus(this.editor);

		this.editor.onSubmit = (text) => {
			this.track(this.submit(text));
		};
		this.editor.onChange = (text) => {
			const agentId = this.state.activeAgentId;
			if (agentId) this.drafts.set(agentId, text);
			else if (this.state.pendingAgent) this.state.pendingAgent.draft = text;
		};
		this.editor.onOpenAgents = () => this.agentPanel.open();
		this.editor.onToggleToolOutput = () => {
			this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
			this.tui.requestRender();
		};
		this.editor.onInterrupt = () => this.interrupt();
		this.editor.onSteer = () => this.steerFromEditor();
		this.editor.onOpenRequests = () => this.humanRequests.openLatest();
		this.editor.onOpenTree = () => this.track(this.openTreeSelectorDirect());
		this.editor.onViewSystemPrompt = () => this.track(this.printSystemPrompt());
		this.editor.onEditStaged = () => this.takeStagedIntoEditor();
		this.editor.onExit = () => {
			void this.shutdown("user exit").catch(() => {});
		};
	}

	/**
	 * Publish the control surfaces under the same keys `registerBuiltInSlots`
	 * uses. Every mutating method goes through `schedule`, so a capability call
	 * made from inside a render lands after the frame instead of re-entering it.
	 */
	private publishCapabilities(): void {
		this.capabilities.publish("editor", {
			getText: () => this.editor.getText(),
			setText: (text) => this.scheduleEditorEdit(() => this.editor.setText(text)),
			insertAtCursor: (text) => this.scheduleEditorEdit(() => this.editor.insertTextAtCursor(text)),
			clear: () => this.scheduleEditorEdit(() => this.editor.setText("")),
		});
		for (const slot of SEGMENT_SLOTS) {
			this.capabilities.publishScoped(slot, (caller) => ({
				set: (id, text, options) =>
					this.schedule(() => {
						this.state.segments.set(slot, { id: scopedId(caller, id), text, order: options?.order ?? 0 });
						this.tui.requestRender();
					}),
				remove: (id) =>
					this.schedule(() => {
						this.state.segments.remove(slot, scopedId(caller, id));
						this.tui.requestRender();
					}),
				list: () => this.state.segments.list(slot).filter((segment) => segment.id.startsWith(scopedId(caller, ""))),
			}));
		}
		this.capabilities.publishScoped("chat", (caller) => ({
			insert: (id, text, options) =>
				this.schedule(() => {
					const agent = this.capabilityAgent(options?.agentId);
					if (!agent) return;
					const itemId = scopedId(caller, id);
					const at = agent.timeline.findIndex((candidate) => candidate.id === itemId);
					const previous = at === -1 ? undefined : agent.timeline[at];
					const item: ExtensionOutputItem = {
						type: "extension-output",
						id: itemId,
						presentationId: itemId,
						durability: "ephemeral",
						createdAt: new Date().toISOString(),
						extensionId: caller,
						text,
						// New text is not a request to collapse a row someone opened.
						...(previous?.type === "extension-output" && previous.expanded !== undefined
							? { expanded: previous.expanded }
							: undefined),
					};
					if (at === -1) agent.timeline.push(item);
					else agent.timeline[at] = item;
					this.tui.requestRender();
				}),
			remove: (id, options) =>
				this.schedule(() => {
					const agent = this.capabilityAgent(options?.agentId);
					if (!agent) return;
					agent.timeline = agent.timeline.filter((item) => item.id !== scopedId(caller, id));
					this.tui.requestRender();
				}),
			setExpanded: (id, expanded, options) =>
				this.schedule(() => {
					const itemId = scopedId(caller, id);
					const item = this.capabilityAgent(options?.agentId)?.timeline.find((candidate) => candidate.id === itemId);
					if (item?.type !== "extension-output") return;
					item.expanded = expanded;
					this.tui.requestRender();
				}),
		}));
		this.capabilities.publishScoped("stagedInput", (caller) => {
			// The application staging on its own behalf is the human's own text,
			// which is exactly what an absent producer means to the branch.
			const owner = caller === APPLICATION_CALLER ? undefined : caller;
			const owned = (id: number) =>
				this.capabilityAgent(undefined)?.staged.find((draft) => draft.id === id && draft.extensionId === owner);
			return {
				list: () => stagedEntries(this.capabilityAgent(undefined)),
				add: (text) =>
					new Promise((resolve) => {
						this.schedule(() => resolve(this.stageDraft(text, owner)?.id));
					}),
				update: (id, text) =>
					this.schedule(() => {
						const draft = owned(id);
						const body = text.trim();
						if (!draft || !body) return;
						draft.text = body;
						this.tui.requestRender();
					}),
				remove: (id) =>
					this.schedule(() => {
						const agent = this.capabilityAgent(undefined);
						const draft = owned(id);
						if (!agent || !draft) return;
						agent.staged = agent.staged.filter((candidate) => candidate !== draft);
						this.tui.requestRender();
					}),
			};
		});
		this.capabilities.publishScoped("notices", (caller) => ({
			post: (id, text, options) =>
				this.schedule(() => {
					const noticeId = scopedId(caller, id);
					const notice: NoticeItem = {
						id: noticeId,
						kind: "extension-notification",
						createdAt: new Date().toISOString(),
						text,
						extensionId: caller,
					};
					const existing = this.state.globalNotices.findIndex((candidate) => candidate.id === noticeId);
					if (existing === -1) this.state.globalNotices.push(notice);
					else this.state.globalNotices[existing] = notice;
					if (options?.ttlMs !== 0) this.expireNotification(noticeId, options?.ttlMs);
					this.tui.requestRender();
				}),
			dismiss: (id) =>
				this.schedule(() => {
					const noticeId = scopedId(caller, id);
					const timer = this.notificationTimers.get(noticeId);
					if (timer) clearTimeout(timer);
					this.notificationTimers.delete(noticeId);
					this.state.globalNotices = this.state.globalNotices.filter((notice) => notice.id !== noticeId);
					this.tui.requestRender();
				}),
		}));
		this.capabilities.publishScoped("humanRequests", (caller) => ({
			list: () => this.humanRequests.pending,
			present: (presenter) => {
				// Reported once: a presenter that throws will throw on every frame,
				// and the panel is not the place to watch it happen.
				let reported = false;
				return this.humanRequests.present((request, width) => {
					try {
						return presenter(request, width);
					} catch (error) {
						if (!reported) {
							reported = true;
							this.reportHostDiagnostic({
								severity: "warning",
								code: "tui_extension.request_presenter_failed",
								message: `Extension '${caller}' failed to render inside a human request: ${errorMessage(error)}`,
								extensionId: caller,
							});
						}
						return undefined;
					}
				});
			},
		}));
		this.capabilities.publish("selectorDock", {
			isOpen: () => this.selectorDock.isOpen,
			open: (request) =>
				new Promise((resolve, reject) => {
					this.schedule(() => {
						if (this.selectorDock.isOpen) {
							reject(new Error("Another selection is already docked."));
							return;
						}
						let decided = false;
						const settle = (value?: string) => {
							if (decided) return;
							decided = true;
							this.capabilitySelector = undefined;
							resolve(value);
						};
						const view = new ListSelector({
							title: request.title,
							items: request.choices.map((choice) => ({
								value: choice.value,
								label: choice.label ?? choice.value,
								description: choice.description,
							})),
							...(request.description === undefined
								? undefined
								: { operation: { description: request.description, confirmVerb: "apply" } }),
							...(request.filter ? { initialFilter: request.filter } : undefined),
							onClose: () => this.selectorDock.close(),
							onSelect: (item) => settle(item.value),
							onCancel: () => settle(),
						});
						this.capabilitySelector = { view, settle };
						// The selector's own close runs before it reports the answer, so
						// the leaving-the-dock fallback has to wait a turn: by then a
						// decision has settled this and there is nothing left to cancel.
						this.selectorDock.open(view, () => this.schedule(() => settle()));
						this.tui.requestRender();
					});
				}),
			close: () =>
				this.schedule(() => {
					if (this.capabilitySelector?.view !== this.selectorDock.current) return;
					this.selectorDock.close();
				}),
		});
		this.capabilities.publish("queuedInput", {
			list: (options) => {
				const agent = this.capabilityAgent(options?.agentId);
				return {
					steer: agent?.queue.steer ?? [],
					followUp: agent?.queue.followUp ?? [],
					unacknowledged: agent?.pendingFollowUps.map((pending) => pending.text) ?? [],
				};
			},
			steer: (options) =>
				new Promise((resolve, reject) => {
					this.schedule(() => {
						const agentId = options?.agentId ?? this.state.activeAgentId;
						if (!agentId) {
							reject(new Error("No agent is visible to steer."));
							return;
						}
						this.orchestrator.steerQueuedFollowUps(agentId).then(resolve, reject);
					});
				}),
		});
		this.capabilities.publish("agentStrip", {
			list: () =>
				flattenAgentTree(buildAgentTree(this.state)).map((entry) => ({
					agentId: entry.agent.agentId,
					label: agentLabel(entry.agent),
					depth: entry.depth,
					status: entry.agent.status,
					spawnedBy: entry.agent.spawnedBy,
					unreadCount: entry.agent.unreadCount,
				})),
			visibleAgentId: () => this.state.activeAgentId,
			switchTo: (agentId) =>
				this.schedule(() => {
					if (!this.state.agents.has(agentId)) throw new Error(`No agent ${agentId} is on the strip.`);
					this.switchAgent(agentId);
				}),
			dispose: (agentId) =>
				new Promise((resolve, reject) => {
					this.schedule(() => this.disposeAgent(agentId).then(resolve, reject));
				}),
			onVisibleAgentChanged: (listener) => {
				this.visibleAgentListeners.add(listener);
				return () => {
					this.visibleAgentListeners.delete(listener);
				};
			},
		});
		this.capabilities.publish("commands", {
			list: () => {
				const agentId = this.state.activeAgentId;
				return this.engine.list(toCommandActivity(agentId ? this.state.agents.get(agentId) : undefined));
			},
			run: (input) =>
				new Promise((resolve, reject) => {
					this.schedule(async () => {
						try {
							resolve(await this.runExtensionCommand(input));
						} catch (error) {
							reject(error instanceof Error ? error : new Error(errorMessage(error)));
						}
					});
				}),
		});
	}

	/**
	 * Which projection a transcript-writing capability call lands in. A pending
	 * session has no projection to write to, and materializing one to hold an
	 * extension's row would start a conversation nobody asked for.
	 */
	private capabilityAgent(agentId: string | undefined): AgentViewState | undefined {
		const target = agentId ?? this.state.activeAgentId;
		return target ? this.state.agents.get(target) : undefined;
	}

	private scheduleEditorEdit(edit: () => void): void {
		this.schedule(() => {
			edit();
			this.tui.requestRender();
		});
	}

	/**
	 * The capability half of `submit`. It shares the engine call and its
	 * transcript bookkeeping and stops where attribution starts: prompt text
	 * goes back to the caller instead of to the model, and a missing argument
	 * comes back as candidates instead of a docked picker the human did not ask
	 * for.
	 */
	private async runExtensionCommand(input: string): Promise<CommandRunOutcome> {
		const text = input.trim();
		if (!text || !parseLineCommand(text)) return { kind: "not-a-command" };

		const agentId = this.state.activeAgentId;
		const outcome = await this.runCommandInput(agentId, text);
		this.tui.requestRender();
		switch (outcome.kind) {
			case "pass":
				return { kind: "not-a-command" };
			case "expanded":
				return { kind: "expanded", text: outcome.text };
			case "executed":
				return { kind: "executed", name: outcome.name, value: outcome.value, display: outcome.display };
			case "failed":
				return { kind: "failed", name: outcome.name, error: outcome.error.message };
			case "needs-argument":
			case "open-selector":
				return { kind: "needs-argument", name: outcome.command.name, candidates: outcome.candidates };
		}
	}

	/** The docked component the focus stack says should be taking keys. */
	private dockedFocusTarget(): Component | undefined {
		switch (topDockedFocus(this.state)) {
			case "selector":
				return this.selectorDock;
			case "human-request":
				return this.humanRequests;
			case "agent-panel":
				return this.agentPanel;
			default:
				return undefined;
		}
	}

	/** Hint context of the selector currently docked in the editor's place, if any. */
	private topSelectorHint(): SelectorHintContext | undefined {
		const view = this.selectorDock.current;
		if (view instanceof ListSelector || view instanceof TreeSelector || view instanceof TreeNavigationSelector) {
			return view.hintContext;
		}
		return undefined;
	}

	static async create(options: WidiTuiOptions): Promise<WidiTuiApplication> {
		if (options.runtime) {
			const application = new WidiTuiApplication(options.runtime);
			await application.activateTuiExtensions();
			return application;
		}
		const startupPrompt = new StartupHumanPrompt();
		try {
			const runtime = await createWidiRuntime({
				cwd: options.cwd,
				agentDir: options.agentDir ?? join(homedir(), DEFAULT_AGENT_DIR),
				defaultProfileId: options.profileId,
				requestHuman: startupPrompt.requestHuman,
			});
			const application = new WidiTuiApplication(runtime);
			await application.activateTuiExtensions();
			return application;
		} finally {
			startupPrompt.dispose();
		}
	}

	/**
	 * Activate the TUI halves of the extensions the core pipeline discovered,
	 * then rebuild keybindings: extension shortcut actions are known now, so
	 * keybindings.json is validated against them and the manager picks up both
	 * the user's bindings and the extension definitions. Host failures are
	 * diagnostics, never a startup abort.
	 */
	private async activateTuiExtensions(): Promise<void> {
		try {
			this.extensionHost = new TuiExtensionHost({
				identities: this.runtime.services.extensionLoad.loaded,
				commandEngine: this.engine,
				layout: this.layout,
				capabilities: this.capabilities,
				overlays: this.overlays,
				requestRender: () => this.tui.requestRender(),
				reportDiagnostic: (diagnostic) => this.reportHostDiagnostic(diagnostic),
				stageMessage: (extensionId, text) => {
					this.stageDraft(text, extensionId);
				},
				events: {
					// The visible agent is the attribution a TUI half gets: it belongs
					// to no agent of its own, and the one on screen is what its action
					// is about. Core requires a live agent, so refuse plainly rather
					// than emit under a stale id.
					emit: async (extensionId, name, payload) => {
						const agentId = this.state.activeAgentId;
						if (!agentId) {
							throw new Error(`Extension '${extensionId}' cannot emit '${name}': no agent is visible yet.`);
						}
						await this.orchestrator.emitExtensionEvent(agentId, extensionId, name, payload);
					},
					subscribe: (handler) => this.orchestrator.registerExtensionEventSubscriber({ deliver: handler }),
				},
			});
			await this.extensionHost.activate();
		} catch (error) {
			this.reportHostDiagnostic({
				severity: "error",
				code: "tui_extension.host_failed",
				message: `TUI extension host activation failed: ${errorMessage(error)}`,
			});
		}
		const userKeybindings = loadUserKeybindings(
			this.runtime.services.agentDir,
			this.extensionHost?.keybindingDefinitions,
		);
		this.userConfigDiagnostics.push(...userKeybindings.diagnostics);
		setKeybindings(createWidiKeybindings(userKeybindings.bindings, this.extensionHost?.keybindingDefinitions));
		this.extensionHost?.setUserKeybindings(userKeybindings.bindings);
	}

	/** Host diagnostics join the startup batch before run() and project live after it. */
	private reportHostDiagnostic(diagnostic: OrchestratorDiagnostic): void {
		if (this.started) {
			this.projectDiagnostic(diagnostic);
			this.tui.requestRender();
			return;
		}
		this.userConfigDiagnostics.push(diagnostic);
	}

	async run(): Promise<void> {
		if (this.started) return await this.closed;
		this.started = true;
		this.installLifecycleHandlers();
		this.unsubscribeEvents = this.orchestrator.subscribe((event) => {
			this.handleEvent(event);
		});
		this.unregisterClient = this.orchestrator.registerClient({
			id: "tui",
			requestHuman: (request, signal) => this.humanRequests.request(request, signal),
		});

		this.tui.start();
		this.tui.terminal.setTitle("WIDI");
		// The startup boot prompt is gone by now, so this shell is the only human
		// a workspace opened later can be asked about.
		this.runtime.services.workspaces.confirmTrust = async (cwd) => await this.confirmProjectTrust(cwd);
		// Every startup diagnostic is a warning or error and gets projected;
		// the routine resolution facts collapse to one synthesized summary line.
		for (const diagnostic of this.runtime.diagnostics) {
			this.projectDiagnostic(diagnostic);
		}
		for (const diagnostic of this.userConfigDiagnostics) {
			this.projectDiagnostic(diagnostic);
		}
		this.state.diagnostics.phase = "runtime";
		this.addStartupSummary();
		this.configurePendingEditor();
		this.updateEditorAvailability();
		this.tui.requestRender();
		return await this.closed;
	}

	async shutdown(reason = "tui exit"): Promise<void> {
		if (this.shutdownPromise) return await this.shutdownPromise;
		this.shutdownPromise = this.performShutdown(reason);
		return await this.shutdownPromise;
	}

	private async performShutdown(reason: string): Promise<void> {
		this.state.shuttingDown = true;
		this.editor.disableSubmit = true;
		this.agentPanel.close();
		this.humanRequests.close();
		this.unregisterClient?.();
		this.unregisterClient = undefined;
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		for (const timer of this.notificationTimers.values()) clearTimeout(timer);
		this.notificationTimers.clear();
		if (this.streamingFlushTimer) {
			clearTimeout(this.streamingFlushTimer);
			this.streamingFlushTimer = undefined;
		}
		if (this.animationTicker) {
			clearInterval(this.animationTicker);
			this.animationTicker = undefined;
			this.animationTickerInterval = undefined;
		}
		for (const agent of this.state.agents.values()) flushStreaming(agent);
		this.removeLifecycleHandlers();
		// The extension host disposes its tui halves (reverse activation order)
		// before the runtime goes away; it isolates its own failures.
		await this.extensionHost?.dispose();
		try {
			await this.orchestrator.disposeAll(reason);
			// Bounded, because a tracked task is not always one that ends. A command
			// that waits on a person - an extension walking someone through
			// something - is still pending when they decide to quit, and waiting on
			// it forever would make exit the one thing they cannot do.
			await Promise.race([
				Promise.allSettled([...this.lifecycleTasks, ...this.pendingTasks]),
				delay(SHUTDOWN_TASK_GRACE_MS),
			]);
			await this.orchestrator.disposeAll(`${reason} (final cleanup)`);
		} catch {
			// Shutdown is best-effort; terminal restoration is mandatory.
		} finally {
			// Leave the shell exactly as WIDI found it. pi-tui's default is to
			// replay the last frame into the primary buffer on the way out, which
			// in fullscreen mode is not a transcript - the transcript never left
			// the alternate screen - but a stray copy of the editor rules, footer
			// and agent strip, repeated once per run.
			this.tui.stop({ preserveScreen: true });
			this.resolveClosed?.();
			this.resolveClosed = undefined;
		}
	}

	private handleEvent(event: OrchestratorEvent): void {
		this.projector.apply(event);
		this.updateAnimationTicker();

		switch (event.type) {
			case "agent_spawned":
			case "agent_resumed":
				this.schedule(() => this.syncAgent(event.agentId));
				this.schedule(() => this.hydrateAgent(event.agentId));
				break;
			case "agent_status_changed":
				this.schedule(() => this.syncAgent(event.agentId));
				this.updateEditorAvailability();
				// A turn this shell did not start (another agent's message, an
				// extension prompt) begins inside core, where the buffer is not
				// visible. Landing it now puts it after that turn rather than
				// before it: late, but never lost. A turn the shell did start has
				// already flushed, so there is nothing here to do.
				if (event.activity === "running" && !event.maintenance) {
					this.track(this.flushStaged(event.agentId));
				}
				break;
			case "agent_disposed":
				// Not only `/dispose`: another agent's `dispose_agent` call, or a
				// subtree dispose taken above this one, ends an agent this shell is
				// still showing.
				if (event.intent === "removed") this.schedule(() => this.releaseDisposedAgent(event.agentId));
				break;
			case "agent_session_info_changed":
				if (event.agentId === this.state.activeAgentId) {
					this.refreshVisibleAgent();
				}
				break;
			case "agent_session_forked":
				this.projector.beginHydration(event.agentId);
				this.schedule(() => this.hydrateAgent(event.agentId));
				break;
			case "extension_notification":
				this.expireNotification(event.presentationId);
				break;
			case "auth_login_url":
				this.addApplicationNotice(
					event.instructions ? `Login: open ${event.url} — ${event.instructions}` : `Login: open ${event.url}`,
					event.agentId,
					{ pin: true, textMode: "full" },
				);
				break;
			case "auth_login_code":
				this.addApplicationNotice(
					`Login: open ${event.verificationUri} and enter code ${event.userCode}`,
					event.agentId,
					{ pin: true, textMode: "full" },
				);
				break;
			case "auth_login_progress":
				this.addApplicationNotice(`Login: ${event.message}`, event.agentId, { pin: true });
				break;
			case "human_request_timeout":
			case "human_request_cancelled":
				this.humanRequests.cancelRequest(event.requestId);
				break;
			case "runtime_shutdown_requested":
				// Core only publishes the request; the terminal and the process are
				// ours to wind down. Say who asked before the screen goes away.
				this.addApplicationNotice(
					event.reason
						? `Shutting down at the request of extension ${event.requestedBy}: ${event.reason}`
						: `Shutting down at the request of extension ${event.requestedBy}`,
					undefined,
					{ pin: true, textMode: "full" },
				);
				void this.shutdown(`extension ${event.requestedBy} requested shutdown`).catch(() => {});
				break;
			case "agent_harness_event":
				if (event.event.type === "message_update" || event.event.type === "tool_execution_update") {
					// Streaming deltas are buffered by the projector; re-render on the
					// flush timer instead of per event. Thinking indicators update the
					// timeline immediately, so they keep their per-event render.
					this.scheduleStreamingFlush();
					if (
						event.event.type === "message_update" &&
						(event.event.assistantMessageEvent.type === "thinking_start" ||
							event.event.assistantMessageEvent.type === "thinking_end")
					) {
						this.tui.requestRender();
					}
					return;
				}
				if (event.event.type === "session_tree" || event.event.type === "session_compact") {
					this.projector.beginHydration(event.agentId);
					this.schedule(() => this.hydrateAgent(event.agentId));
				}
				break;
			default:
				break;
		}

		this.tui.requestRender();
	}

	/**
	 * Coalesce streaming deltas into one timeline write per interval. Only a
	 * flush that actually changed the visible agent's timeline re-renders.
	 */
	private scheduleStreamingFlush(): void {
		if (this.streamingFlushTimer) return;
		this.streamingFlushTimer = setTimeout(() => {
			this.streamingFlushTimer = undefined;
			let activeWrote = false;
			for (const agent of this.state.agents.values()) {
				if (flushStreaming(agent) && agent.agentId === this.state.activeAgentId) {
					activeWrote = true;
				}
			}
			if (activeWrote) this.tui.requestRender();
		}, STREAM_FLUSH_MS);
		this.streamingFlushTimer.unref();
	}

	/**
	 * Tick re-renders while anything animated is on screen. The visible running
	 * agent has spinner frames advancing every 160ms; a working line still
	 * saying what just happened has to be repainted once its line expires, or
	 * "Job's done." stays up until the next keystroke. The interval is rebuilt
	 * when the cadence changes and stopped when nothing needs it.
	 */
	private updateAnimationTicker(): void {
		const activeAgent = this.state.activeAgentId ? this.state.agents.get(this.state.activeAgentId) : undefined;
		const hasVisibleRunningAgent = activeAgent?.status === "running";
		const interval = hasVisibleRunningAgent
			? SPINNER_TICK_MS
			: hasLiveTransientQuip(activeAgent?.quip)
				? QUIP_TICK_MS
				: undefined;
		if (interval === this.animationTickerInterval) return;
		if (this.animationTicker) {
			clearInterval(this.animationTicker);
			this.animationTicker = undefined;
		}
		this.animationTickerInterval = interval;
		if (interval !== undefined) {
			// Recomputed from inside the tick as well: a quip expiring is not
			// an event, so nothing else would ever wind this cadence back down.
			this.animationTicker = setInterval(() => {
				this.tui.requestRender();
				this.updateAnimationTicker();
			}, interval);
			this.animationTicker.unref();
		}
	}

	private async submit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.state.shuttingDown) return;

		// Unknown "/name" input never reaches the model on the first enter: a
		// local notice asks for a confirming second submit (v2 §11.2).
		const parsed = parseLineCommand(text);
		const matchedCommand = parsed ? this.engine.match(text) : undefined;
		const initialAgentId = this.state.activeAgentId;
		const scopeId = initialAgentId ?? "pending";
		// Submitting a staged draft is the human adopting it: it leaves the
		// buffer for good and lands as their own input, attribution included.
		const editingAgent = initialAgentId ? this.state.agents.get(initialAgentId) : undefined;
		if (editingAgent) editingAgent.stagedEditing = undefined;
		if (parsed && !matchedCommand) {
			const pending = this.pendingUnknownCommand;
			if (pending?.scopeId !== scopeId || pending.text !== text) {
				this.pendingUnknownCommand = { scopeId, text };
				this.restoreEditor(rawText, initialAgentId);
				this.addApplicationNotice(
					`Unknown command /${parsed.name}. Press enter again to send it as a prompt.`,
					initialAgentId,
				);
				return;
			}
		}
		this.pendingUnknownCommand = undefined;

		let agentId = initialAgentId;
		const materializesPendingAgent =
			!agentId && (!parsed || !matchedCommand || materializesOnSubmit(matchedCommand, parsed.argument));
		if (materializesPendingAgent) {
			agentId = await this.materializePendingAgent(rawText);
			if (!agentId) return;
		}

		const agent = agentId ? ensureAgentProjection(this.state, agentId) : undefined;
		if (agent && agent.status === "disposed") {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(`Agent ${agentLabel(agent)} cannot accept input (${agent.status}).`, agentId);
			return;
		}

		let outcome: EngineOutcome;
		this.runningSubmit = { rawText, agentId };
		try {
			outcome = await this.runCommandInput(agentId, text);
		} catch (error) {
			this.restoreEditor(rawText, agentId);
			this.addApplicationNotice(errorMessage(error), agentId);
			return;
		} finally {
			this.runningSubmit = undefined;
		}

		switch (outcome.kind) {
			case "pass":
			case "expanded": {
				if (!agentId || !agent) {
					this.restoreEditor(rawText, agentId);
					this.addApplicationNotice("No active agent is available.");
					return;
				}
				const prompt = outcome.kind === "expanded" ? outcome.text : text;
				if (agent.status === "running") {
					await this.submitFollowUp(agentId, rawText, prompt);
					return;
				}
				await this.submitPrompt(agentId, rawText, prompt);
				return;
			}
			case "executed": {
				this.editor.addToHistory(rawText);
				this.tui.requestRender();
				return;
			}
			case "failed": {
				this.editor.addToHistory(rawText);
				this.tui.requestRender();
				return;
			}
			case "needs-argument":
				await this.openCommandSelector(agentId, rawText, outcome.command, outcome.candidates);
				return;
			case "open-selector":
				await this.openCommandSelector(agentId, rawText, outcome.command, outcome.candidates, outcome.query);
				return;
		}
	}

	/**
	 * Runs input through the command engine and keeps the transcript in step: a
	 * running row per started command, replaced by its result, and dropped again
	 * when the input turns out to be prompt text after all.
	 *
	 * What follows from the outcome is the caller's, because the callers differ
	 * exactly there - a human submit may fall through to the model and open a
	 * selector, an extension may do neither.
	 */
	private async runCommandInput(agentId: string | undefined, text: string): Promise<EngineOutcome> {
		const startedCommands: Array<{ commandId: string; argument: string }> = [];
		const forget = (except?: string) => {
			this.removeCommandItems(
				agentId,
				startedCommands.filter((started) => started.commandId !== except).map((started) => started.commandId),
			);
		};

		let outcome: EngineOutcome;
		try {
			outcome = await this.engine.handleInput(
				text,
				{
					agentId,
					orchestrator: this.orchestrator,
					pendingModel: this.state.pendingAgent?.display.model,
					workspaceCwd: this.currentWorkspaceCwd(),
				},
				{
					onCommandStart: (commandId, name, argument) => {
						startedCommands.push({ commandId, argument });
						this.upsertCommandItem(agentId, commandId, { name, argument, status: "running" });
						this.tui.requestRender();
					},
				},
			);
		} catch (error) {
			forget();
			throw error;
		}

		switch (outcome.kind) {
			case "executed":
				this.upsertCommandItem(agentId, outcome.commandId, {
					name: outcome.name,
					status: "completed",
					result: outcome.value,
					display: outcome.display,
				});
				break;
			case "failed": {
				const failedStart = startedCommands.find((started) => started.commandId === outcome.commandId);
				forget(outcome.commandId);
				this.upsertCommandItem(agentId, outcome.commandId, {
					name: outcome.name,
					argument: failedStart?.argument ?? parseLineCommand(text)?.argument,
					status: "failed",
					error: outcome.error,
				});
				break;
			}
			default:
				// A prompt command starts before it expands, so its row exists and has
				// to go: the prompt itself is the transcript entry. The remaining
				// outcomes never reached onCommandStart and have nothing to drop.
				forget();
				return outcome;
		}

		return outcome;
	}

	private async materializePendingAgent(rawText: string): Promise<string | undefined> {
		// Do not let a second submit replace the pending intent while core is
		// creating the session that the first submit requested.
		this.editor.disableSubmit = true;
		this.tui.requestRender();
		try {
			const agentId = await this.trackLifecycle(this.pendingAgents.materialize());
			if (this.state.shuttingDown) return undefined;
			applyAgentSnapshot(this.state, this.orchestrator.inspectAgent(agentId));
			this.drafts.set(agentId, "");
			this.switchAgent(agentId);
			return agentId;
		} catch (error) {
			this.restoreEditor(rawText);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(`Agent startup failed: ${errorMessage(error)}`);
			}
			this.configurePendingEditor();
			this.updateEditorAvailability();
			this.tui.requestRender();
			return undefined;
		}
	}

	/**
	 * Hold text back from the branch until the next human-initiated turn, so a
	 * human can still read, rewrite or drop it. Producers are TUI-side only
	 * (an extension's tui half today): core-side producers must land on the
	 * branch whether or not a human ever types again.
	 */
	stageDraft(text: string, extensionId?: string): StagedDraft | undefined {
		const agentId = this.state.activeAgentId;
		const body = text.trim();
		if (!agentId || !body) return undefined;
		const agent = ensureAgentProjection(this.state, agentId);
		const draft: StagedDraft = {
			id: this.nextStagedId,
			text: body,
			...(extensionId === undefined ? undefined : { extensionId }),
		};
		this.nextStagedId += 1;
		agent.staged.push(draft);
		if (agent.staged.length > MAX_STAGED_DRAFTS) {
			// Same discipline as every other payload bound: over the limit it
			// lands rather than being dropped or held forever.
			this.projectDiagnostic({
				severity: "warning",
				code: "tui.staging_overflow",
				message: `More than ${MAX_STAGED_DRAFTS} staged messages; the buffer was sent to the branch.`,
				agentId,
				...(extensionId === undefined ? undefined : { extensionId }),
			});
			this.track(this.flushStaged(agentId));
		}
		this.tui.requestRender();
		return draft;
	}

	/**
	 * Land the staged buffer on the branch in order, ahead of whatever the
	 * caller is about to send. Each draft goes out through its own producer's
	 * sink, so what the branch records is the producer, not this shell.
	 */
	private async flushStaged(agentId: string): Promise<void> {
		const agent = this.state.agents.get(agentId);
		if (!agent) return;
		while (agent.staged.length > 0) {
			const draft = agent.staged[0];
			if (!draft) break;
			try {
				const sink =
					draft.extensionId === undefined
						? this.messages
						: this.orchestrator.messageSinkFor(
								messageBindingFor({ kind: "extension", extensionId: draft.extensionId }),
							);
				const outcome = await sink.send({
					targetAgentId: agentId,
					body: draft.text,
					mode: "precede",
					...(draft.editedByHuman === undefined ? undefined : { editedByHuman: draft.editedByHuman }),
				});
				if (outcome.kind === "blocked") this.addApplicationNotice(blockedInputNotice(outcome), agentId);
			} catch (error) {
				// It has not landed, and dropping it is the one thing staging
				// promises never to do. Leaving it at the head keeps the order for
				// the next flush.
				this.addApplicationNotice(`Staged message not sent: ${errorMessage(error)}`, agentId);
				return;
			}
			const index = agent.staged.indexOf(draft);
			if (index >= 0) agent.staged.splice(index, 1);
		}
		this.tui.requestRender();
	}

	/**
	 * app.staged.edit: take the newest staged draft out of the buffer and into
	 * the editor. Out of the buffer, because a draft left in it could be
	 * flushed halfway through being rewritten.
	 */
	private takeStagedIntoEditor(): void {
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.stagedEditing) return;
		const index = agent.staged.length - 1;
		const draft = agent.staged[index];
		if (!draft) return;
		if (this.editor.getText().trim()) {
			this.addApplicationNotice(
				"Send or clear your own draft first; editing a staged message needs the editor.",
				agentId,
			);
			return;
		}
		agent.staged.splice(index, 1);
		agent.stagedEditing = { draft, index };
		this.editor.setText(draft.text);
		this.tui.requestRender();
	}

	/**
	 * Esc while the editor holds a staged draft puts it back where it came
	 * from, edits included. Emptying the editor first is the discard gesture,
	 * and the only one: nothing else throws staged text away.
	 */
	private returnStagedDraft(): boolean {
		const agentId = this.state.activeAgentId;
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		const editing = agent?.stagedEditing;
		if (!agent || !agentId || !editing) return false;
		const text = this.editor.getText().trim();
		agent.stagedEditing = undefined;
		this.editor.setText("");
		this.drafts.set(agentId, "");
		if (text === "") {
			this.addApplicationNotice("Staged message discarded.", agentId);
		} else {
			const draft = editing.draft;
			if (text !== draft.text) {
				draft.text = text;
				// Only worth recording when someone else produced it: the branch
				// would otherwise file the human's words under that producer.
				if (draft.extensionId !== undefined) draft.editedByHuman = true;
			}
			agent.staged.splice(Math.min(editing.index, agent.staged.length), 0, draft);
		}
		this.tui.requestRender();
		return true;
	}

	private async submitPrompt(agentId: string, rawText: string, text: string): Promise<void> {
		await this.flushStaged(agentId);
		const agent = ensureAgentProjection(this.state, agentId);
		agent.pendingInput = { originalText: rawText, submittedAt: new Date().toISOString() };
		this.editor.addToHistory(rawText);
		this.tui.requestRender();
		try {
			const outcome = await this.messages.prompt({ targetAgentId: agentId, body: text, mode: "next_turn" });
			if (outcome.kind === "blocked") {
				agent.pendingInput = undefined;
				this.restoreEditor(rawText, agentId);
				this.addApplicationNotice(blockedInputNotice(outcome), agentId);
			}
		} catch (error) {
			const pending = ensureAgentProjection(this.state, agentId).pendingInput;
			ensureAgentProjection(this.state, agentId).pendingInput = undefined;
			if (pending) this.restoreEditor(rawText, agentId);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
		}
		this.tui.requestRender();
	}

	/**
	 * Default running-agent path (v2 §11.2): plain text joins the core followUp
	 * queue and is consumed automatically when the run ends. The queued texts
	 * come back through queue_update and feed the QueuedInputView.
	 *
	 * Routed through sendMessage rather than followUpAgent so this text meets the
	 * same input policy as a prompt: an extension that blocks or rewrites human
	 * input must not be bypassed by typing while the agent happens to be running.
	 */
	private async submitFollowUp(agentId: string, rawText: string, text: string): Promise<void> {
		await this.flushStaged(agentId);
		this.editor.addToHistory(rawText);
		const pending = { id: this.nextPendingFollowUpId, text: rawText };
		this.nextPendingFollowUpId += 1;
		ensureAgentProjection(this.state, agentId).pendingFollowUps.push(pending);
		this.tui.requestRender();
		try {
			const outcome = await this.messages.send({ targetAgentId: agentId, body: text, mode: "next_turn" });
			if (outcome.kind === "blocked") {
				this.restoreEditor(rawText, agentId);
				this.addApplicationNotice(blockedInputNotice(outcome), agentId);
			}
		} catch (error) {
			this.restoreEditor(rawText, agentId);
			if (error instanceof OrchestratorError) {
				this.projectDiagnostic(error.diagnostic);
			} else {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
		} finally {
			const agent = this.state.agents.get(agentId);
			if (agent) {
				agent.pendingFollowUps = agent.pendingFollowUps.filter((item) => item.id !== pending.id);
			}
		}
		this.tui.requestRender();
	}

	/**
	 * app.steer: send the editor text as an immediate steer instead of queueing.
	 * With an empty editor it promotes what the user already queued with enter,
	 * which is the same intent one keystroke later.
	 */
	private steerFromEditor(): void {
		if (this.state.shuttingDown) return;
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.status !== "running") {
			this.addApplicationNotice("Steer needs a running agent.", agentId);
			return;
		}
		const text = this.editor.getText().trim();
		// Maintenance work (compaction, tree navigation) has no agent loop to
		// steer into; the steer key degrades to the follow-up queue Enter uses.
		if (agent.maintenance) {
			if (!text) {
				this.addApplicationNotice(`${maintenanceLabel(agent.maintenance)} in progress; steer is unavailable.`, agentId);
				return;
			}
			this.editor.setText("");
			this.drafts.set(agentId, "");
			this.track(this.submitFollowUp(agentId, text, text));
			this.tui.requestRender();
			return;
		}
		if (!text) {
			if (agent.queue.followUp.length > 0) {
				this.steerQueuedFollowUps(agentId);
				return;
			}
			this.addApplicationNotice("Type a message to steer the running agent.", agentId);
			return;
		}
		this.editor.setText("");
		this.drafts.set(agentId, "");
		this.editor.addToHistory(text);
		this.notePoke(agent);
		this.track(
			this.flushStaged(agentId)
				.then(() => this.messages.send({ targetAgentId: agentId, body: text, mode: "interrupt" }))
				.then((outcome) => {
					if (outcome.kind !== "blocked") return;
					this.restoreEditor(text, agentId);
					this.addApplicationNotice(blockedInputNotice(outcome), agentId);
					this.tui.requestRender();
				})
				.catch((error) => {
					this.restoreEditor(text, agentId);
					this.addApplicationNotice(errorMessage(error), agentId);
				}),
		);
		this.tui.requestRender();
	}

	/** Hand the already-queued follow-ups to the running agent as steering. */
	private steerQueuedFollowUps(agentId: string): void {
		this.track(
			this.orchestrator
				.steerQueuedFollowUps(agentId)
				.then((count) => {
					if (count === 0) return;
					this.addApplicationNotice(
						count === 1 ? "Queued message promoted to steering." : `${count} queued messages promoted to steering.`,
						agentId,
					);
				})
				.catch((error) => {
					this.addApplicationNotice(errorMessage(error), agentId);
				}),
		);
		this.tui.requestRender();
	}

	private upsertCommandItem(
		agentId: string | undefined,
		commandId: string,
		update: {
			name: string;
			argument?: string;
			status: "running" | "completed" | "failed";
			result?: unknown;
			display?: string;
			error?: CommandError;
		},
	): void {
		// A command can retire the agent it ran in (/new, /clear): its result
		// belongs to whatever the user is looking at now, not to a projection
		// resurrected for a conversation that is over.
		const originalTimeline = agentId ? this.state.agents.get(agentId)?.timeline : this.state.pendingAgent?.timeline;
		const activeTimeline = this.state.activeAgentId
			? this.state.agents.get(this.state.activeAgentId)?.timeline
			: undefined;
		const timeline = originalTimeline ?? activeTimeline ?? this.state.pendingAgent?.timeline;
		if (!timeline) return;
		const existing = timeline.find((item) => item.type === "command-result" && item.commandId === commandId);
		if (existing?.type === "command-result") {
			existing.status = update.status;
			existing.result = update.result;
			existing.display = update.display;
			existing.error = update.error;
			return;
		}
		timeline.push({
			type: "command-result",
			id: commandId,
			commandId,
			durability: "ephemeral",
			createdAt: new Date().toISOString(),
			name: update.name,
			argument: update.argument ?? "",
			status: update.status,
			result: update.result,
			display: update.display,
			error: update.error,
		});
	}

	private removeCommandItems(agentId: string | undefined, commandIds: readonly string[]): void {
		if (commandIds.length === 0) return;
		const ids = new Set(commandIds);
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		if (agent) {
			agent.timeline = agent.timeline.filter((item) => item.type !== "command-result" || !ids.has(item.commandId));
		} else if (this.state.pendingAgent) {
			this.state.pendingAgent.timeline = this.state.pendingAgent.timeline.filter(
				(item) => item.type !== "command-result" || !ids.has(item.commandId),
			);
		}
	}

	private async openCommandSelector(
		agentId: string | undefined,
		originalText: string,
		command: CommandDefinition,
		candidates: readonly CandidateItem[],
		initialFilter?: string,
	): Promise<void> {
		if (candidates.length === 0) {
			// Nothing to pick from: an empty selector is a dead end, a usage line
			// is not. A completer that returned nothing counts too — that is what
			// a misconfigured resource directory looks like from here.
			this.restoreEditor(originalText, agentId);
			this.addApplicationNotice(
				`Command /${command.name} needs an argument: /${command.name} ${command.argumentHint ?? "<argument>"}`,
				agentId,
			);
			return;
		}
		const items = candidates.map((candidate) => ({
			value: candidate.value,
			label: candidate.label ?? candidate.value,
			description: candidate.description,
		}));
		const request: ListSelectorRequest = {
			title: `/${command.name}`,
			items,
			operation: { description: command.description, confirmVerb: "apply" },
			...(initialFilter !== undefined && initialFilter !== "" ? { initialFilter } : {}),
			onClose: () => this.selectorDock.close(),
			onSelect: (item) => {
				// Space syntax cannot express an explicit empty argument (submit
				// trims it away); the colon form keeps "use current position"
				// distinct from a bare command.
				this.track(this.submit(item.value === "" ? `/${command.name}:` : `/${command.name} ${item.value}`));
			},
			onCancel: () => this.restoreEditor(originalText, agentId),
		};
		let view: Component;
		try {
			view = command.selector
				? await command.selector(request, {
						agentId,
						orchestrator: this.orchestrator,
						pendingModel: this.state.pendingAgent?.display.model,
						workspaceCwd: this.currentWorkspaceCwd(),
					})
				: new ListSelector(request);
		} catch (error) {
			// A factory that cannot load its data (e.g. the agent's session tree)
			// fails like the empty-candidate path: the command goes back to the
			// editor with a notice instead of a dock stuck half-built.
			this.restoreEditor(originalText, agentId);
			this.addApplicationNotice(`Command /${command.name} selector failed: ${errorMessage(error)}`, agentId);
			return;
		}
		this.selectorDock.open(view);
		this.tui.requestRender();
	}

	/**
	 * app.tree.open: the tree navigator without going through the editor, so the
	 * unsubmitted draft survives both the selector and the navigation (pi opens
	 * its tree the same way, from a keybinding rather than a submitted command).
	 */
	private async openTreeSelectorDirect(): Promise<void> {
		const agentId = this.state.activeAgentId;
		if (!agentId || this.selectorDock.isOpen) return;
		try {
			const tree = await this.orchestrator.getAgentSessionTree(agentId);
			const rows = buildSessionEntryRows(tree);
			if (rows.length === 0) {
				this.addApplicationNotice("No entries in this session tree.", agentId);
				return;
			}
			const view = new TreeNavigationSelector({
				title: "/tree",
				rows,
				onClose: () => this.selectorDock.close(),
				// The draft never left the editor, so cancel has nothing to restore.
				onNavigate: (entryId, summarize, customInstructions) =>
					this.track(this.applyTreeNavigation(agentId, entryId, summarize, customInstructions)),
			});
			this.selectorDock.open(view);
			this.tui.requestRender();
		} catch (error) {
			this.addApplicationNotice(`Session tree failed: ${errorMessage(error)}`, agentId);
		}
	}

	/** Shared tail of both tree navigation paths: navigate, then surface the result. */
	private async applyTreeNavigation(
		agentId: string,
		entryId: string,
		summarize: boolean,
		customInstructions?: string,
	): Promise<void> {
		try {
			const result = await this.orchestrator.navigateAgentTree(
				agentId,
				entryId,
				summarize
					? { summarize: true, ...(customInstructions === undefined ? {} : { customInstructions }) }
					: undefined,
			);
			if (result.cancelled) {
				this.addApplicationNotice("Navigation cancelled.", agentId);
				return;
			}
			if (result.editorText !== undefined) this.editor.setText(result.editorText);
			this.addApplicationNotice(result.summaryEntry ? "Navigated (branch summarized)." : "Navigated.", agentId);
		} catch (error) {
			this.addApplicationNotice(errorMessage(error), agentId);
		}
	}

	private async activateNavigationAgent(agentId: string): Promise<void> {
		await this.syncAgent(agentId);
		if (!this.state.agents.has(agentId)) return;
		this.switchAgent(agentId);
	}

	/**
	 * /new: stage a second conversation beside the current one. The live agent
	 * keeps its place in the strip, so its draft is parked the way switching
	 * away parks it.
	 */
	private async beginNewAgent(profileId: string | undefined): Promise<void> {
		const resolved = profileId ?? this.runtime.services.defaultProfile.id;
		const candidates = await this.orchestrator.listAgentProfileCandidates();
		const label = candidates.profiles.find((profile) => profile.value === resolved)?.label ?? resolved;
		if (this.state.activeAgentId) this.drafts.set(this.state.activeAgentId, this.editor.getText());
		const model = this.orchestrator.getDefaultModel();
		this.pendingAgents.beginNewSession(
			{ profileId: resolved, model },
			{
				profileId: resolved,
				profileLabel: label,
				cwd: this.currentWorkspaceCwd(),
				model,
				thinkingLevel: this.orchestrator.getDefaultThinkingLevel(),
			},
		);
		this.showPendingAgent();
	}

	/**
	 * /clear: close the current conversation and open an empty one on the same
	 * role. The agent and its context are gone from the runtime - only its
	 * session file remains, resumable through /resume - so the source facts are
	 * captured before the dispose, not read back from it afterwards.
	 */
	private async beginNewSession(sourceAgentId: string | undefined): Promise<void> {
		const source = sourceAgentId ? this.newSessionSource(sourceAgentId) : undefined;
		if (!sourceAgentId || !source) {
			this.beginDefaultSession();
			return;
		}
		await this.closeAgentForNewSession(sourceAgentId);
		this.pendingAgents.beginNewSession({ profileId: source.profileId, model: source.display.model }, source.display);
		this.showPendingAgent();
	}

	/** The same question startup asks, for a project opened after startup. */
	private async confirmProjectTrust(cwd: string): Promise<boolean> {
		try {
			const response = await this.humanRequests.request({
				id: `project-trust:${cwd}`,
				createdAt: new Date().toISOString(),
				source: { kind: "system" },
				kind: "confirm",
				title: "Trust this project?",
				message: `WIDI found project-local configuration in ${cwd} (settings, profiles, skills, prompts, extensions). It stays disabled until the project is trusted.\n\nTrust this project and remember the decision?`,
			});
			return response.kind === "confirm" && response.confirmed;
		} catch {
			// Dismissed or aborted: stay untrusted rather than block the move.
			return false;
		}
	}

	/**
	 * /workspace: move the staged session to another directory.
	 *
	 * Trust is resolved here rather than at spawn because everything the user
	 * does next depends on the answer - which profiles are offered, which
	 * instruction files load - and because being asked about a project after
	 * typing the first message is too late to be a decision.
	 */
	private setPendingModel(model: RuntimeModel): string {
		this.pendingAgents.setModel(model);
		this.tui.requestRender();
		return `Staged session will use ${model.provider}/${model.id}`;
	}

	private async setPendingWorkspace(path: string): Promise<string> {
		if (!this.state.pendingAgent) throw new Error("There is no staged session to move.");
		const resolved = await this.orchestrator.executionEnv.absolutePath(path);
		if (!resolved.ok) throw new Error(`Cannot resolve ${path}: ${resolved.error.message}`);
		const info = await this.orchestrator.executionEnv.fileInfo(resolved.value);
		if (!info.ok || info.value.kind !== "directory") {
			throw new Error(`Not a directory: ${resolved.value}`);
		}
		const workspace = await this.runtime.services.workspaces.resolve(resolved.value);
		this.pendingAgents.setWorkspace(workspace.cwd);
		// `@file` completes against the project the next prompt will run in.
		this.configurePendingEditor();
		this.tui.requestRender();
		return workspace.trust.trusted
			? `Staged session will open in ${workspace.cwd}`
			: `Staged session will open in ${workspace.cwd} (untrusted: project-local settings, profiles, skills and prompts stay disabled)`;
	}

	/**
	 * /theme: repaint in a registered scheme and remember the choice.
	 *
	 * Every view paints through the live `theme` holder, so the switch itself is
	 * one assignment; the render that follows is what makes it visible.
	 */
	private applyTheme(name: string): string {
		if (!setTheme(name)) {
			const known = getAllThemes()
				.map((entry) => entry.name)
				.join(", ");
			throw new Error(`Unknown theme "${name}". Registered: ${known}`);
		}
		this.runtime.services.settingManager.setTheme(name);
		this.tui.requestRender();
		return `Theme set to ${name}`;
	}

	/**
	 * Disposing a parent takes its descendants with it: left alone they would
	 * keep running with nobody to report back to, and the strip would promote
	 * them to roots the user never opened.
	 *
	 * The call answers with everything it destroyed, which is what the subtree is
	 * read from here rather than from the events it also publishes. Where the
	 * user lands is this path's own: someone who disposes a fork means to go back
	 * to what they forked.
	 */
	private async disposeAgent(agentId: string): Promise<void> {
		const sourceAgentId = forkSourceAgentId(this.state, ensureAgentProjection(this.state, agentId));
		const disposedIds = new Set(
			await this.orchestrator.disposeAgent(agentId, {
				intent: "removed",
				reason: "Disposed from the TUI.",
				scope: "subtree",
			}),
		);
		disposedIds.add(agentId);
		for (const id of disposedIds) {
			const agent = this.state.agents.get(id);
			if (agent) agent.status = "disposed";
			await this.syncAgent(id);
		}
		const source = sourceAgentId ? this.state.agents.get(sourceAgentId) : undefined;
		if (source && !disposedIds.has(source.agentId) && isLiveAgent(source)) {
			this.switchAgent(source.agentId);
			return;
		}
		this.landOnRemainingAgent(disposedIds);
	}

	/**
	 * An agent on screen can be destroyed by something other than the user: a
	 * `dispose_agent` call in another agent's turn, or a subtree dispose taken
	 * above this one. The projection is already marked, so what is left is to
	 * stop showing an agent that no longer exists.
	 */
	private releaseDisposedAgent(agentId: string): void {
		this.updateEditorAvailability();
		if (this.state.activeAgentId !== agentId) {
			this.tui.requestRender();
			return;
		}
		this.landOnRemainingAgent();
	}

	/**
	 * `gone` names agents this call knows are destroyed regardless of what their
	 * projection still says: a snapshot read taken while the teardown is in
	 * flight can answer with the activity the agent had a moment ago.
	 */
	private landOnRemainingAgent(gone?: ReadonlySet<string>): void {
		const remaining = [...this.state.agents.values()].find((agent) => !gone?.has(agent.agentId) && isLiveAgent(agent));
		if (remaining) {
			this.switchAgent(remaining.agentId);
			return;
		}
		this.beginDefaultSession();
	}

	private beginDefaultSession(): void {
		this.pendingAgents.beginDefault(this.defaultPendingDisplay());
		this.showPendingAgent();
	}

	/** Put the staged agent on screen, whatever staged it. */
	private showPendingAgent(): void {
		this.updateAnimationTicker();
		this.pendingUnknownCommand = undefined;
		this.editor.setText("");
		this.configurePendingEditor();
		this.refreshVisibleAgent();
		this.updateEditorAvailability();
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private defaultPendingDisplay(): PendingAgentDisplay {
		return {
			profileId: this.runtime.services.defaultProfile.id,
			profileLabel: this.runtime.services.defaultProfile.id,
			cwd: this.currentWorkspaceCwd(),
			model: this.orchestrator.getDefaultModel(),
			thinkingLevel: this.orchestrator.getDefaultThinkingLevel(),
		};
	}

	/**
	 * Where the next staged session should open: wherever the user is working
	 * right now. Following the open agent matters most after a /clear or a
	 * dispose, when the agent that named the directory is already gone and the
	 * startup cwd would silently move the user back to where they began.
	 */
	private currentWorkspaceCwd(): string {
		const agent = this.state.activeAgentId ? this.state.agents.get(this.state.activeAgentId) : undefined;
		return agent?.display.cwd ?? this.state.pendingAgent?.display.cwd ?? this.runtime.services.cwd;
	}

	/**
	 * The role and model a new session should reopen with, read off the agent it
	 * replaces. Undefined when that agent can no longer be inspected, which
	 * leaves the caller with the runtime default.
	 */
	private newSessionSource(
		sourceAgentId: string,
	): { readonly profileId: string; readonly display: PendingAgentDisplay } | undefined {
		const projection = this.state.agents.get(sourceAgentId);
		let snapshot = projection?.snapshot;
		if (!snapshot) {
			try {
				snapshot = this.orchestrator.inspectAgent(sourceAgentId);
			} catch {
				return undefined;
			}
		}
		const reference = snapshot.profile.reference;
		return {
			profileId: reference.id,
			display: {
				profileId: reference.id,
				profileLabel: reference.label ?? reference.id,
				// The replaced agent's own workspace: /clear reopens the same
				// conversation elsewhere only if the user asks for that.
				cwd: snapshot.cwd,
				model: projection?.display.model ?? snapshot.model,
				thinkingLevel: this.orchestrator.getDefaultThinkingLevel(),
			},
		};
	}

	/**
	 * Retire an agent the user replaced rather than closed: unlike /dispose it
	 * leaves no projection behind, so the agent strip shows the new conversation
	 * alone instead of a tombstone nobody can return to.
	 */
	private async closeAgentForNewSession(agentId: string): Promise<void> {
		await this.orchestrator.disposeAgent(agentId, { intent: "removed", reason: "Closed for a new session." });
		this.state.agents.delete(agentId);
		this.drafts.delete(agentId);
		this.hydratedAgents.delete(agentId);
		this.hydrationGeneration.delete(agentId);
		if (this.state.activeAgentId === agentId) {
			this.state.activeAgentId = undefined;
		}
	}

	private configurePendingEditor(): void {
		this.editor.setAutocompleteProvider(
			new WidiCommandAutocompleteProvider({
				engine: this.engine,
				orchestrator: this.orchestrator,
				getActivity: () => undefined,
				getPendingModel: () => this.state.pendingAgent?.display.model,
				// The staged session's directory, so `@file` completes against the
				// project the next prompt will actually run in.
				cwd: this.currentWorkspaceCwd(),
			}),
		);
	}

	private switchAgent(agentId: string): void {
		const previousAgentId = this.state.activeAgentId;
		if (previousAgentId) {
			this.drafts.set(previousAgentId, this.editor.getText());
		}
		this.dropStagedAgent();
		const agent = setActiveAgent(this.state, agentId);
		// An agent nobody has looked at yet has never had a transition to roll on.
		setSteadyQuip(agent, agent.status === "running" ? "working" : "idle");
		this.updateAnimationTicker();
		this.editor.setText(this.drafts.get(agentId) ?? "");
		clearDockedFocus(this.state);
		this.updateEditorAvailability();
		this.editor.setAutocompleteProvider(
			new WidiCommandAutocompleteProvider({
				engine: this.engine,
				agentId,
				orchestrator: this.orchestrator,
				getActivity: () => toCommandActivity(this.state.agents.get(agentId)),
				cwd: this.state.agents.get(agentId)?.display.cwd ?? this.runtime.services.cwd,
			}),
		);
		this.refreshVisibleAgent();
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
		if (!this.hydratedAgents.has(agentId) && agent.hydration !== "pending") {
			this.projector.beginHydration(agentId);
			this.schedule(() => this.hydrateAgent(agentId));
		}
	}

	/**
	 * Leaving a staged session throws it away; it has no id to come back to.
	 * Text the user already typed into it goes with it, which is worth saying
	 * out loud - everywhere else in the shell a draft survives being left.
	 */
	private dropStagedAgent(): void {
		const staged = this.state.pendingAgent;
		if (!staged) return;
		const draft = (staged.draft || this.editor.getText()).trim();
		this.pendingAgents.cancel();
		if (draft) {
			this.addApplicationNotice(`Dropped the staged ${staged.display.profileId} session and the text typed into it.`);
		}
	}

	private async syncAgent(agentId: string): Promise<void> {
		try {
			applyAgentSnapshot(this.state, this.orchestrator.inspectAgent(agentId));
		} catch {
			return;
		}
		this.updateAnimationTicker();
		this.updateEditorAvailability();
		this.tui.requestRender();
	}

	private async hydrateAgent(agentId: string): Promise<void> {
		const generation = (this.hydrationGeneration.get(agentId) ?? 0) + 1;
		this.hydrationGeneration.set(agentId, generation);
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.hydration !== "pending") this.projector.beginHydration(agentId);
		try {
			const snapshot = await this.orchestrator.getAgentSession(agentId);
			const result = hydrateSessionEntries(snapshot.pathToRoot);
			const statuses = this.orchestrator.listExtensionStatuses(agentId);
			if (this.hydrationGeneration.get(agentId) !== generation) return;
			result.display.sessionName ??= snapshot.name;
			this.projector.completeHydration(agentId, result, statuses);
			this.hydratedAgents.add(agentId);
		} catch (error) {
			if (this.hydrationGeneration.get(agentId) !== generation) return;
			this.projector.failHydration(agentId, `Could not restore session history: ${errorMessage(error)}`);
		}
		this.tui.requestRender();
	}

	/**
	 * Overlay is reserved for failures the application cannot continue from:
	 * an uncaught fatal error (v2 §13.1).
	 */
	private showFatalOverlay(code: string, message: string): void {
		if (this.state.shuttingDown || this.fatalOverlayShown) return;
		this.fatalOverlayShown = true;
		let handle: AppOverlayHandle | undefined;
		const view = new FatalErrorView({
			code,
			message,
			onQuit: () => {
				void this.shutdown("fatal error").catch(() => {});
			},
			onViewDiagnostics: () => {
				this.fatalOverlayShown = false;
				handle?.close();
				// The overlay is only the way in; what it opens is the same
				// /diagnostics selector the command opens, submitted the same way
				// so cancelling behaves the way cancelling any selector does.
				this.track(this.submit("/diagnostics"));
			},
		});
		handle = this.overlays.show(view, { width: "70%", minWidth: 36, maxHeight: "70%", anchor: "center", margin: 1 });
	}

	private projectDiagnostic(diagnostic: OrchestratorDiagnostic): void {
		this.projector.apply({ type: "diagnostic", diagnostic, createdAt: new Date().toISOString() });
	}

	private addStartupSummary(): void {
		// The one-line summary is always synthesized from the resolved services.
		const services = this.runtime.services;
		const modelText = services.defaultModel.provider
			? `${services.defaultModel.provider}/${services.defaultModel.modelId}`
			: "no model";
		const text = `${services.defaultProfile.id} · ${modelText} · thinking ${services.defaultThinkingLevel.level}`;
		this.state.globalNotices.push({
			id: "startup:summary",
			kind: "startup",
			createdAt: new Date().toISOString(),
			text,
		});
	}

	/**
	 * What the next turn would be built with, printed into the transcript
	 * rather than an overlay: pi-tui has no scrollable view, and a system prompt
	 * is thousands of lines. In the transcript the terminal's own scrollback is
	 * the pager, and the text is selectable the way any other output is.
	 */
	private async printSystemPrompt(): Promise<void> {
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		try {
			const prompt = await this.orchestrator.getAgentSystemPrompt(agentId);
			this.addApplicationNotice(`System prompt of the next turn:\n\n${prompt}`, agentId, { textMode: "full" });
		} catch (error) {
			this.addApplicationNotice(errorMessage(error), agentId);
		}
	}

	private addApplicationNotice(
		text: string,
		agentId?: string,
		options: { pin?: boolean; textMode?: NoticeTextMode } = {},
	): void {
		const createdAt = new Date().toISOString();
		if (agentId) {
			// Agent-scoped operation feedback belongs in that agent's transcript at
			// the moment it happened, not pinned above the chat.
			const agent = ensureAgentProjection(this.state, agentId);
			agent.timeline.push({
				type: "application-notice",
				id: `application-notice:${agentId}:${agent.nextLiveItemId++}`,
				durability: "ephemeral",
				createdAt,
				text,
				textMode: options.textMode,
			});
		} else {
			const id = `application:${createdAt}:${this.state.globalNotices.length}`;
			this.state.globalNotices.push({ id, kind: "application", createdAt, text, textMode: options.textMode });
			// Pinned notices (e.g. OAuth login links) must not vanish while the
			// user is still completing the flow in a browser.
			if (!options.pin) this.expireNotification(id);
		}
		this.tui.requestRender();
	}

	private expireNotification(id: string, ttlMs = NOTIFICATION_TTL_MS): void {
		const existing = this.notificationTimers.get(id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.notificationTimers.delete(id);
			this.state.globalNotices = this.state.globalNotices.filter((notice) => notice.id !== id);
			this.tui.requestRender();
		}, ttlMs);
		timer.unref();
		this.notificationTimers.set(id, timer);
	}

	private interrupt(): void {
		if (this.overlays.dismiss()) return;
		// Docked claimants go away one layer at a time before the running agent
		// is aborted, same as the dismissible overlay a selector used to be.
		// Closing skips onCancel, so a submitted command is not restored. The
		// human request menu is absent on purpose: it holds focus while it is
		// on top and answers app.interrupt itself.
		switch (topDockedFocus(this.state)) {
			case "selector":
				this.selectorDock.close();
				return;
			case "agent-panel":
				this.agentPanel.close();
				return;
		}
		// A staged draft held in the editor goes back to the buffer before esc
		// means anything to the agent: it is the only thing on screen that would
		// be lost by moving on.
		if (this.returnStagedDraft()) return;
		const agentId = this.state.activeAgentId;
		if (!agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.status === "running") {
			// Aborting maintenance does not cancel it (the summarization request
			// carries no abort signal) but does clear the queued follow-ups, so
			// refuse it instead of silently eating the queue.
			if (agent.maintenance) {
				this.addApplicationNotice(`${maintenanceLabel(agent.maintenance)} in progress; abort is unavailable.`, agentId);
				return;
			}
			this.notePoke(agent);
			this.track(
				this.orchestrator.abortAgent(agentId, "human").catch((error) => {
					this.addApplicationNotice(errorMessage(error), agentId);
				}),
			);
		}
	}

	/**
	 * Count the times in a row the user grabbed a running agent by the collar.
	 * Purely a TUI observation: nothing about the run changes, the agent just
	 * says something about being poked. The window resets on the third, so a
	 * long argument is one remark rather than a running commentary.
	 */
	private notePoke(agent: AgentViewState): void {
		const at = Date.now();
		const recent = this.pokes.filter((poke) => at - poke < POKE_WINDOW_MS);
		recent.push(at);
		if (recent.length >= POKE_THRESHOLD) {
			setTransientQuip(agent, "poked", at);
			this.pokes = [];
			this.updateAnimationTicker();
			return;
		}
		this.pokes = recent;
	}

	private updateEditorAvailability(): void {
		const agentId = this.state.activeAgentId;
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		this.editor.disableSubmit =
			this.state.shuttingDown || (!this.state.pendingAgent && (!agent || agent.status === "disposed"));
	}

	private restoreEditor(text: string, agentId?: string): void {
		if (!agentId) {
			if (this.state.pendingAgent && !this.state.pendingAgent.draft.trim()) {
				this.state.pendingAgent.draft = text;
			}
			if (!this.editor.getText().trim()) this.editor.setText(text);
			return;
		}
		const currentDraft = this.drafts.get(agentId);
		if (!currentDraft?.trim()) this.drafts.set(agentId, text);
		if (this.state.activeAgentId === agentId && !this.editor.getText().trim()) {
			this.editor.setText(this.drafts.get(agentId) ?? text);
		}
	}

	private resolveAgentLabel(agentId: string | undefined): string {
		if (!agentId) return "unknown";
		const projection = this.state.agents.get(agentId);
		if (projection) return agentLabel(projection);
		try {
			const snapshot = this.orchestrator.inspectAgent(agentId);
			applyAgentSnapshot(this.state, snapshot);
			return snapshot.profile.reference.label ?? snapshot.profile.reference.id ?? agentId;
		} catch {
			return agentId;
		}
	}

	/**
	 * The one funnel every change of the visible agent passes through, which is
	 * why the capability's listeners hang off it rather than off each caller.
	 * A session rename comes through here too and notifies nobody: the id is
	 * what the listeners are watching.
	 */
	private refreshVisibleAgent(): void {
		const agentId = this.state.activeAgentId;
		const agent = agentId ? this.state.agents.get(agentId) : undefined;
		this.tui.terminal.setTitle(agent ? `WIDI - ${agentLabel(agent)}` : "WIDI");
		if (agentId === this.notifiedVisibleAgentId) return;
		this.notifiedVisibleAgentId = agentId;
		for (const listener of [...this.visibleAgentListeners]) {
			try {
				listener(agentId);
			} catch (error) {
				this.addApplicationNotice(errorMessage(error), agentId);
			}
		}
	}

	private schedule(task: () => void | Promise<void>): void {
		queueMicrotask(() => {
			try {
				const result = task();
				if (result instanceof Promise) this.track(result);
			} catch (error) {
				this.addApplicationNotice(errorMessage(error));
			}
		});
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.pendingTasks.add(promise);
		void promise.then(
			() => this.pendingTasks.delete(promise),
			(error) => {
				this.pendingTasks.delete(promise);
				if (!this.state.shuttingDown) {
					this.addApplicationNotice(errorMessage(error));
				}
			},
		);
		return promise;
	}

	private trackLifecycle<T>(promise: Promise<T>): Promise<T> {
		this.lifecycleTasks.add(promise);
		void promise.then(
			() => this.lifecycleTasks.delete(promise),
			() => this.lifecycleTasks.delete(promise),
		);
		return promise;
	}

	private installLifecycleHandlers(): void {
		process.once("SIGTERM", this.onSigterm);
		process.once("SIGINT", this.onSigint);
		process.on("uncaughtException", this.onUncaughtError);
		process.on("unhandledRejection", this.onUncaughtError);
	}

	private removeLifecycleHandlers(): void {
		process.off("SIGTERM", this.onSigterm);
		process.off("SIGINT", this.onSigint);
		process.off("uncaughtException", this.onUncaughtError);
		process.off("unhandledRejection", this.onUncaughtError);
	}
}

export async function runWidiTui(options: WidiTuiOptions): Promise<void> {
	const application = await WidiTuiApplication.create(options);
	await application.run();
}

/** How long shutdown gives in-flight tasks to settle before it stops waiting. */
const SHUTDOWN_TASK_GRACE_MS = 2_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether submitting this command should start the staged session.
 *
 * A `materialize` command needs an agent to act on, but its bare form is often a
 * picker rather than the command itself: `/model` with nothing after it asks
 * which model, and spawning a session to answer a question the human may cancel
 * would charge them for the question. So the test is not whether an argument was
 * typed, it is whether the engine will run the command or stop to ask for one -
 * the same predicate the engine itself uses to answer `needs-argument`. A
 * command that takes no argument at all therefore materializes on a bare submit,
 * which is the only way one can ever run from a cold start.
 */
function materializesOnSubmit(command: CommandDefinition, argument: string): boolean {
	if (command.agentPolicy !== "materialize") return false;
	return argument.trim() !== "" || (command.requiresArgument !== true && command.complete === undefined);
}

/** Somewhere the user can be put: still in the runtime, and past its build. */
function isLiveAgent(agent: AgentViewState): boolean {
	return agent.status === "idle" || agent.status === "running";
}

/**
 * The command engine asks about a live agent's activity; the view's own
 * `creating` and `disposed` have no activity to report and read as idle, which
 * is what the availability rules already assumed.
 */
function toCommandActivity(agent: AgentViewState | undefined): AgentActivitySnapshot | undefined {
	if (!agent) return undefined;
	return agent.status === "running"
		? { activity: "running", ...(agent.maintenance === undefined ? undefined : { maintenance: agent.maintenance }) }
		: { activity: "idle" };
}

/**
 * The staging buffer as the capability reports it. A draft a human took into
 * the editor is listed at the slot it will go back to rather than left out: an
 * extension polling the buffer would otherwise watch its own text disappear and
 * stage it a second time.
 */
function stagedEntries(agent: AgentViewState | undefined): readonly StagedInputEntry[] {
	if (!agent) return [];
	const entries: StagedInputEntry[] = agent.staged.map((draft) => ({ ...draft }));
	const editing = agent.stagedEditing;
	if (editing) {
		entries.splice(Math.min(editing.index, entries.length), 0, { ...editing.draft, heldInEditor: true });
	}
	return entries;
}

/** Namespaces the ids a capability caller chooses, so two callers cannot collide. */
function scopedId(caller: string, id: string): string {
	return `ext:${caller}:${id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Shared notice for every human-input path an extension policy can block. */
function blockedInputNotice(blocked: { reason?: string; blockedBy: string }): string {
	return blocked.reason
		? `Input blocked by ${blocked.blockedBy}: ${blocked.reason}`
		: `Input blocked by ${blocked.blockedBy}.`;
}
