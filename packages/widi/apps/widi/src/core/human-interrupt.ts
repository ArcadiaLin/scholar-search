/**
 * "The human is trying to break in" as an observable fact.
 *
 * A steer never preempts a turn already in flight: the agent loop reads its
 * steering queue only at a turn boundary. A tool that deliberately blocks
 * therefore holds the turn open long after the user typed, and from the user's
 * side the steer looks lost. This registry is the missing signal: the orchestrator records a human
 * steer the moment the harness accepts it, and a blocking tool can stop waiting
 * and hand the turn back so the loop reaches the boundary that drains it.
 *
 * It carries no message text and no delivery authority. The steer itself is
 * already queued in the harness; this only answers "is one waiting?".
 *
 * The interface lives here rather than in the orchestrator so the dependency
 * edge stays one way, exactly like `agent-host.ts`: the orchestrator implements
 * the registry, the tool layer only references the watch.
 */

import type { AgentId } from "./types.ts";

/** One agent's view of pending human interrupts, handed to its tool calls. */
export interface HumanInterruptWatch {
	/**
	 * True when a human steer has been accepted by the harness and the agent
	 * loop has not drained it yet. A tool that is about to block should check
	 * this first: the steer may have arrived while an earlier tool call ran.
	 */
	pending(): boolean;
	/**
	 * Call `listener` when a human steer is accepted for this agent. Returns the
	 * unsubscribe function; listeners never throw into the notifier.
	 */
	subscribe(listener: () => void): () => void;
}

/** Per-agent bookkeeping of pending human steers, owned by the orchestrator. */
export class HumanInterruptRegistry {
	private readonly _pending = new Set<AgentId>();
	private readonly _listeners = new Map<AgentId, Set<() => void>>();
	private readonly _clearRevisions = new Map<AgentId, number>();
	private _nextClearRevision = 1;

	/**
	 * Snapshot the latest evidence that this agent's steering queue was empty.
	 * Capture immediately before adding a human steer, then use
	 * {@link notifyIfUncleared} after the harness has acknowledged the update.
	 */
	captureClearRevision(agentId: AgentId): number {
		return this._clearRevisions.get(agentId) ?? 0;
	}

	/** A human steer was accepted by this agent's harness. */
	notify(agentId: AgentId): void {
		this._pending.add(agentId);
		for (const listener of this._listeners.get(agentId) ?? []) {
			try {
				listener();
			} catch {
				// A blocked waiter that cannot be woken is not a reason to fail the
				// delivery that woke it.
			}
		}
	}

	/**
	 * Notify only if no empty queue update arrived after the caller's snapshot.
	 *
	 * Harness queue observers are awaited. The agent loop can therefore drain a
	 * newly queued steer and report an empty queue before `steer()` resolves. A
	 * late unconditional notify would resurrect an interrupt that was already
	 * consumed and make every later barrier yield immediately.
	 */
	notifyIfUncleared(agentId: AgentId, clearRevision: number): boolean {
		if (this.captureClearRevision(agentId) !== clearRevision) return false;
		this.notify(agentId);
		return true;
	}

	/** The agent loop drained its steering queue; nothing is waiting anymore. */
	clear(agentId: AgentId): void {
		this._pending.delete(agentId);
		this._invalidateSnapshot(agentId);
	}

	/** Drop everything for a disposed agent, including still-attached watchers. */
	forget(agentId: AgentId): void {
		this._pending.delete(agentId);
		this._listeners.delete(agentId);
		this._invalidateSnapshot(agentId);
	}

	watch(agentId: AgentId): HumanInterruptWatch {
		return {
			pending: () => this._pending.has(agentId),
			subscribe: (listener) => {
				const listeners = this._listeners.get(agentId) ?? new Set<() => void>();
				listeners.add(listener);
				this._listeners.set(agentId, listeners);
				return () => {
					const current = this._listeners.get(agentId);
					if (!current) return;
					current.delete(listener);
					if (current.size === 0) this._listeners.delete(agentId);
				};
			},
		};
	}

	private _invalidateSnapshot(agentId: AgentId): void {
		this._clearRevisions.set(agentId, this._nextClearRevision);
		this._nextClearRevision += 1;
	}
}
