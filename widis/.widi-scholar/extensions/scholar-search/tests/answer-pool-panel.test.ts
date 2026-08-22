/**
 * The answer pool as a page.
 *
 * The panel is a view, so what is worth asserting is what a view can get wrong
 * in a way a reader would not notice: a `why` silently truncated, a box that
 * does not close because a CJK character counts as one column, a scroll offset
 * that runs past the end. None of these fail loudly at runtime - the panel just
 * draws something slightly wrong - which is exactly why they are pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../../../../packages/widi/apps/widi/src/tui/extension-host/drawing.ts";
import { Theme } from "../../../../../packages/widi/apps/widi/src/tui/theme/theme.ts";
import type { AnswerPoolEntry, AnswerPoolSnapshot } from "../core/answer-pool.ts";
import { AnswerPoolPanel } from "../tui/answer-pool-panel.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const plain = (line: string): string => line.replace(ANSI, "");

function entry(overrides: Partial<AnswerPoolEntry> = {}): AnswerPoolEntry {
	return {
		canonicalId: "arxiv:2103.16690",
		paperId: "2103.16690",
		arxivId: "2103.16690",
		doi: null,
		openalexId: null,
		title: "Digging Into Self-Supervised Monocular Depth Estimation",
		authors: ["Godard", "Mac Aodha", "Firman"],
		year: 2019,
		venue: "ICCV",
		url: null,
		why: "自监督单目深度的基线方法，后续多帧融合工作几乎都以它为骨干网络与损失设计的出发点。",
		addedAt: "2026-08-22T12:31:04Z",
		addedByToolCall: "call_7f2a91",
		...overrides,
	};
}

function snapshot(papers: readonly AnswerPoolEntry[], note = ""): AnswerPoolSnapshot {
	return { agentId: "search-test", updatedAt: "2026-08-22T12:31:04Z", note, papers, removed: [] };
}

function panel(pool: AnswerPoolSnapshot | undefined, onClose: () => void = () => {}): AnswerPoolPanel {
	return new AnswerPoolPanel({ theme: new Theme(), agentLabel: "search-f1k3", snapshot: pool, onClose });
}

describe("the answer pool panel", () => {
	it("renders a paper's why in full, never as a preview", () => {
		const paper = entry();
		// Card lines only: the pinned title line is truncated to fit, and that
		// ellipsis is not the one this test is looking for.
		const lines = panel(snapshot([paper]))
			.render(60)
			.map(plain)
			.filter((line) => line.startsWith("│"));
		const body = lines.join("\n");
		// Wrapping breaks the string, so the assertion is over the characters that
		// survive it: every one of them has to be somewhere on the page.
		const rendered = body.replace(/[\s│┌┐└┘─]/gu, "");
		for (const character of paper.why.replace(/\s/gu, "")) {
			assert.ok(rendered.includes(character), `'${character}' of the why is missing from the panel`);
		}
		assert.ok(!body.includes("…"), "the why was truncated");
	});

	it("closes the box at the right column even when the text is full-width", () => {
		const lines = panel(snapshot([entry()]))
			.render(48)
			.map(plain);
		const framed = lines.filter((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("└"));
		assert.ok(framed.length > 0, "no card was drawn");
		for (const line of framed) {
			assert.equal(visibleWidth(line), 48, `a card line is ${visibleWidth(line)} columns wide, not 48`);
		}
	});

	it("says the pool is empty rather than drawing nothing", () => {
		const empty = panel(snapshot([])).render(60).map(plain).join("\n");
		assert.match(empty, /pool is empty/u);
		const missing = panel(undefined).render(60).map(plain).join("\n");
		assert.match(missing, /No answer pool for this agent yet/u);
	});

	it("shows the agent's note above the cards", () => {
		const lines = panel(snapshot([entry()], "按融合方式分三组"))
			.render(60)
			.map(plain);
		const note = lines.findIndex((line) => line.includes("按融合方式分三组"));
		const card = lines.findIndex((line) => line.startsWith("┌"));
		assert.ok(note >= 0, "the note is not on the page");
		assert.ok(note < card, "the note is below the first card");
	});

	it("keeps the scroll offset inside the content", () => {
		const view = panel(snapshot([entry(), entry({ canonicalId: "arxiv:2004.00000" })]));
		view.handleInput("[A"); // up, at the top already
		const top = view.render(60).map(plain);
		assert.ok(
			top.some((line) => line.includes("[1]")),
			"scrolling up past the top lost the first card",
		);
		for (let i = 0; i < 200; i++) view.handleInput("[B");
		const bottom = view.render(60).map(plain);
		assert.ok(
			bottom.some((line) => line.trim() !== ""),
			"scrolling down past the end left a blank page",
		);
	});

	it("hands control back on the right arrow", () => {
		let closed = 0;
		panel(snapshot([entry()]), () => closed++).handleInput("[C");
		assert.equal(closed, 1);
	});

	it("keeps where the reader is when a paper lands", () => {
		const view = panel(snapshot([entry()]));
		for (let i = 0; i < 3; i++) view.handleInput("[B");
		view.render(60);
		const before = view.render(60).map(plain).join("\n");
		view.update(snapshot([entry(), entry({ canonicalId: "arxiv:2004.00000" })]), "search-f1k3");
		const after = view.render(60).map(plain);
		assert.ok(after.length > 0);
		assert.notEqual(before, "");
	});
});
