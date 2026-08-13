/**
 * Named pieces of text other runtimes add to the composed rows: the header, the
 * footer, the hint line, the status panel, the working line.
 *
 * One store rather than five hand-written surfaces, because those five
 * components differ in how they paint a row and not at all in what they are
 * being asked for - a short piece of text, under a name, that can be replaced
 * or taken away. Where they do differ is what a narrow terminal drops first,
 * and that stays with each component.
 *
 * Text, not components. These are single composed lines; a component dropped
 * into one would have to negotiate width with everything beside it. Drawing
 * something of your own is what wrapping a slot is for.
 */

export interface Segment {
	/** Namespaced by the writer, so two of them cannot claim the same name. */
	readonly id: string;
	readonly text: string;
	/** Lower sorts first; equal orders keep the order they were set in. */
	readonly order: number;
}

/**
 * Segments per slot key, in sorted order. Slot keys are the layout's, so a
 * segment goes in under the same name the component is registered and wrapped
 * under.
 */
export class SegmentStore {
	private readonly bySlot = new Map<string, Segment[]>();
	private sequence = 0;
	private readonly sequences = new Map<string, number>();

	/** Add or replace one segment. Replacing keeps its original position. */
	set(slot: string, segment: Segment): void {
		const segments = this.bySlot.get(slot) ?? [];
		const index = segments.findIndex((candidate) => candidate.id === segment.id);
		if (index >= 0) segments[index] = segment;
		else {
			segments.push(segment);
			this.sequences.set(`${slot} ${segment.id}`, this.sequence++);
		}
		segments.sort(
			(left, right) => left.order - right.order || this.sequenceOf(slot, left) - this.sequenceOf(slot, right),
		);
		this.bySlot.set(slot, segments);
	}

	remove(slot: string, id: string): void {
		const segments = this.bySlot.get(slot);
		if (!segments) return;
		const index = segments.findIndex((candidate) => candidate.id === id);
		if (index < 0) return;
		segments.splice(index, 1);
		this.sequences.delete(`${slot} ${id}`);
		if (segments.length === 0) this.bySlot.delete(slot);
	}

	list(slot: string): readonly Segment[] {
		return this.bySlot.get(slot) ?? [];
	}

	/** Just the text, for a component that only wants to join and paint. */
	texts(slot: string): readonly string[] {
		return this.list(slot).map((segment) => segment.text);
	}

	private sequenceOf(slot: string, segment: Segment): number {
		return this.sequences.get(`${slot} ${segment.id}`) ?? 0;
	}
}
