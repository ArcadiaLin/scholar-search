/**
 * The structured answer pool: $SO$ as data rather than as prose.
 *
 * The reason this exists is measurement, not tidiness. To score a run against
 * AutoScholarQuery the only previously available method was a regular expression
 * over the agent's closing prose, and that instrument degrades silently: the agent
 * writes "MetaBox+ I could not find" and the regex counts it as a hit
 * (`docs/develop/plan.md` §3.5). A pool the agent writes through a tool call is a
 * record with a defined content, and Recall@k over it is a well-defined quantity.
 *
 * Three properties this module has to hold, all of them easy to lose:
 *
 * - **The pool is not the answer.** $SO$ = prose + pool. The pool is citable
 *   substrate; the grouping and the argument live in the prose and, per entry, in
 *   `why`. Flattening the 2026-08-21 session's direction groups into a list would
 *   have thrown away the informative half (`plan.md` §3.2).
 * - **Identity is not decided here.** Entries are keyed by the `canonicalId` the
 *   Search Service computed. Re-deriving it in this process would put a domain
 *   algorithm in the extension and let the two definitions drift
 *   (`AGENTS.md` §3.2, `docs/develop/decisions.md` D-13).
 * - **A removal is evidence.** An entry added and later withdrawn *with a reason*
 *   is a negative example with a provenance, which is what `docs/design.md` §6
 *   requires of $NP^{judge}$ examples and what nobody wants to assemble by hand
 *   (`plan.md` §3.5). So removals are logged, not deleted.
 *
 * Pure functions and an injected clock: what the pool does with a given sequence
 * of calls is testable without a model, a service or a filesystem.
 */

/** How many papers one episode may commit to. A pool that grows with the corpus is a corpus. */
const DEFAULT_MAX_PAPERS = 200;
const MAX_WHY_CHARS = 600;
const MAX_REASON_CHARS = 400;
const MAX_NOTE_CHARS = 1_000;
const MAX_TITLE_CHARS = 300;
const MAX_AUTHORS = 5;

/**
 * One committed paper.
 *
 * Every field is written on the way in even though today only a few are read.
 * Backfilling one later means re-running the episode, while writing six more now
 * costs nothing (`plan.md` §3.3).
 */
export interface AnswerPoolEntry {
	/** The service's cross-source identity. This is the key. */
	readonly canonicalId: string;
	/** The identifier the agent actually cited, kept so its own reference resolves. */
	readonly paperId: string;
	readonly arxivId: string | null;
	readonly doi: string | null;
	readonly openalexId: string | null;
	readonly title: string;
	readonly authors: readonly string[];
	readonly year: number | null;
	readonly venue: string | null;
	readonly url: string | null;
	/** Why this paper answers the question. Carries the grouping the prose argues. */
	readonly why: string;
	readonly addedAt: string;
	/** Which call added it - the hook back into $\bar{\tau}_t$, so provenance is answerable. */
	readonly addedByToolCall: string;
}

/** A withdrawal, with its reason. A negative example with an address in the trajectory. */
export interface AnswerPoolRemoval {
	readonly canonicalId: string;
	readonly paperId: string;
	readonly title: string;
	readonly reason: string;
	readonly removedAt: string;
	readonly removedByToolCall: string;
	/** Which call had added it, so the pair reads as one decision reversed. */
	readonly addedByToolCall: string;
}

export interface AnswerPoolSnapshot {
	readonly agentId: string;
	readonly updatedAt: string | null;
	/** The agent's own note about the pool as a whole, latest wins. */
	readonly note: string;
	readonly papers: readonly AnswerPoolEntry[];
	readonly removed: readonly AnswerPoolRemoval[];
}

/** What a paper looks like to this module: identity, a citation line, nothing more. */
export interface PoolPaperInput {
	readonly canonicalId: string | null;
	readonly paperId: string;
	readonly arxivId?: string | null;
	readonly doi?: string | null;
	readonly openalexId?: string | null;
	readonly title?: string;
	readonly authors?: readonly string[];
	readonly year?: number | null;
	readonly venue?: string | null;
	readonly url?: string | null;
}

export type AddOutcome = "added" | "updated";
export type RemoveOutcome = "removed" | "absent";

export interface AnswerPool {
	/** Add or, for a paper already committed, update its `why`. Returns which happened. */
	add(paper: PoolPaperInput, why: string, toolCallId: string): { outcome: AddOutcome; entry: AnswerPoolEntry };
	/** Withdraw a paper. `reason` is required by construction, not by convention. */
	remove(identifier: string, reason: string, toolCallId: string): { outcome: RemoveOutcome; canonicalId: string };
	setNote(note: string): void;
	snapshot(): AnswerPoolSnapshot;
	size(): number;
	/** True once the pool has been full and refused a further paper. */
	full(): boolean;
}

export interface AnswerPoolOptions {
	readonly agentId: string;
	/** Injected so the record is deterministic under test. */
	readonly now: () => string;
	readonly maxPapers?: number;
}

function clamp(value: unknown, maxChars: number): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

/**
 * The key for a paper the agent asked to add or remove.
 *
 * `canonicalId` when the service supplied one; otherwise the string the agent
 * used. Falling back rather than refusing keeps a paper the service could not
 * resolve out of the pool's way, but it does mean two spellings of an unresolved
 * paper are two entries - which is visible in the record rather than silent.
 */
function keyOf(paper: PoolPaperInput): string {
	const canonical = clamp(paper.canonicalId, 300);
	return canonical === "" ? paper.paperId.trim() : canonical;
}

export function createAnswerPool(options: AnswerPoolOptions): AnswerPool {
	const maxPapers = options.maxPapers ?? DEFAULT_MAX_PAPERS;
	const papers = new Map<string, AnswerPoolEntry>();
	const removed: AnswerPoolRemoval[] = [];
	let note = "";
	let updatedAt: string | null = null;
	let refusedForSize = false;

	const touch = (): string => {
		const stamp = options.now();
		updatedAt = stamp;
		return stamp;
	};

	return {
		add(paper, why, toolCallId) {
			const key = keyOf(paper);
			const existing = papers.get(key);
			const stamp = touch();
			if (existing !== undefined) {
				// Same work, said again. The later `why` is the current judgement, but
				// the provenance stays with the call that first committed to it.
				const entry: AnswerPoolEntry = { ...existing, why: clamp(why, MAX_WHY_CHARS) || existing.why };
				papers.set(key, entry);
				return { outcome: "updated", entry };
			}
			if (papers.size >= maxPapers) {
				refusedForSize = true;
				throw new Error(
					`The answer pool already holds ${papers.size} papers, which is its ceiling. ` +
						"Remove the weakest entries with a reason before adding more - a pool that grows without " +
						"bound is a candidate set, not an answer.",
				);
			}
			const entry: AnswerPoolEntry = {
				canonicalId: key,
				paperId: paper.paperId.trim(),
				arxivId: paper.arxivId ?? null,
				doi: paper.doi ?? null,
				openalexId: paper.openalexId ?? null,
				title: clamp(paper.title, MAX_TITLE_CHARS),
				authors: (paper.authors ?? []).slice(0, MAX_AUTHORS),
				year: paper.year ?? null,
				venue: paper.venue ?? null,
				url: paper.url ?? null,
				why: clamp(why, MAX_WHY_CHARS),
				addedAt: stamp,
				addedByToolCall: toolCallId,
			};
			papers.set(key, entry);
			return { outcome: "added", entry };
		},

		remove(identifier, reason, toolCallId) {
			const wanted = identifier.trim();
			// The agent may withdraw a paper by whatever id it cited, which is not
			// necessarily the canonical one it was stored under.
			const found =
				papers.get(wanted) ??
				[...papers.values()].find(
					(entry) =>
						entry.paperId === wanted ||
						entry.arxivId === wanted ||
						entry.doi === wanted ||
						entry.openalexId === wanted,
				);
			if (found === undefined) return { outcome: "absent", canonicalId: wanted };
			const stamp = touch();
			papers.delete(found.canonicalId);
			removed.push({
				canonicalId: found.canonicalId,
				paperId: found.paperId,
				title: found.title,
				reason: clamp(reason, MAX_REASON_CHARS),
				removedAt: stamp,
				removedByToolCall: toolCallId,
				addedByToolCall: found.addedByToolCall,
			});
			return { outcome: "removed", canonicalId: found.canonicalId };
		},

		setNote(value) {
			note = clamp(value, MAX_NOTE_CHARS);
			touch();
		},

		snapshot() {
			return { agentId: options.agentId, updatedAt, note, papers: [...papers.values()], removed: [...removed] };
		},

		size: () => papers.size,
		full: () => refusedForSize,
	};
}

/**
 * The pool as the agent is allowed to read it back: counts, ids, titles.
 *
 * Not the entries. A read that returned whole records would put the pool's
 * content back into the context on every call, which is the growth the summary
 * views exist to prevent (`plan.md` §3.6, first point).
 */
export function renderPoolSummary(snapshot: AnswerPoolSnapshot, options: { maxListed?: number } = {}): string {
	const maxListed = options.maxListed ?? 50;
	const lines = [`Answer pool: ${snapshot.papers.length} paper(s) committed, ${snapshot.removed.length} withdrawn.`];
	if (snapshot.note !== "") lines.push(`note: ${snapshot.note}`);
	for (const entry of snapshot.papers.slice(0, maxListed)) {
		lines.push(`  ${entry.canonicalId} :: ${entry.title}`);
	}
	if (snapshot.papers.length > maxListed) {
		lines.push(`  ... ${snapshot.papers.length - maxListed} more not listed`);
	}
	if (snapshot.papers.length === 0) {
		lines.push(
			"  (empty - an episode that ends with an empty pool has produced no answer that can be scored)",
		);
	}
	return lines.join("\n");
}
