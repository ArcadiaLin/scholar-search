#!/usr/bin/env node

/**
 * Lint the preference carriers for leaked answers.
 *
 * `widis/.widi-<namespace>/preference/np-*.md` holds $NP_k$: strategy that is
 * reused across episodes. A specific paper identifier has no business in it - an
 * entry naming a paper is not a strategy, it is the answer to one question, and
 * it will look like it works on exactly that question (the reasoning is in
 * `docs/reviewer-design.md` §3.1, and the mistake was made and caught once
 * already).
 *
 * This is deliberately a separate step rather than a rule inside
 * `scripts/widis-quality.mjs`: that script drives biome and tsgo over code, and
 * neither of them reads markdown prose. Bolting a prose check onto a formatter
 * driver would hide it.
 *
 * Scope: this catches identifier shapes and nothing more. An entry carrying a
 * specific paper title or a specific query string is the same violation and this
 * cannot see it; that still needs a reader.
 *
 * Usage: node scripts/preference-lint.mjs [--fix-nothing]
 * Exit code 1 on any finding.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widisRoot = join(repositoryRoot, "widis");

/**
 * Identifier shapes that must not appear in an entry.
 *
 * The bare `NNNN.NNNNN` form is the one that matters most: it is what an agent
 * writes when it quotes a result back, and it does not look like an identifier
 * at a glance.
 */
const FORBIDDEN = [
	{ label: "arXiv id", pattern: /\b(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?\b/gi },
	{ label: "arXiv DOI", pattern: /\b10\.48550\/arxiv\.\S+/gi },
];

/** A line inside a fenced code block is an illustration, not an entry. */
function stripFencedBlocks(lines) {
	let inFence = false;
	return lines.map((line) => {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			return "";
		}
		return inFence ? "" : line;
	});
}

/**
 * Entries marked `kind: example` are exempt, because an example's whole job is to
 * be concrete - but only when it says where it came from. An example with no
 * `origin` is indistinguishable from an entry someone wrote from the answer.
 */
function exemptRanges(lines) {
	const ranges = [];
	let start = -1;
	let hasOrigin = false;
	for (const [index, line] of lines.entries()) {
		const isEntryStart = /^\s*-\s+\[[a-z0-9-]+\]/i.test(line);
		if (isEntryStart) {
			if (start >= 0 && hasOrigin) ranges.push([start, index - 1]);
			start = /kind:\s*example/.test(lines.slice(index, index + 4).join("\n")) ? index : -1;
			hasOrigin = false;
		}
		if (start >= 0 && /origin:/.test(line)) hasOrigin = true;
	}
	if (start >= 0 && hasOrigin) ranges.push([start, lines.length - 1]);
	return ranges;
}

function lintFile(path) {
	const findings = [];
	const raw = readFileSync(path, "utf8").split(/\r?\n/);
	const lines = stripFencedBlocks(raw);
	const exempt = exemptRanges(raw);
	const isExempt = (index) => exempt.some(([from, to]) => index >= from && index <= to);

	for (const [index, line] of lines.entries()) {
		if (line === "" || isExempt(index)) continue;
		for (const { label, pattern } of FORBIDDEN) {
			for (const match of line.matchAll(pattern)) {
				findings.push({ path, line: index + 1, label, text: match[0], context: raw[index]?.trim() ?? "" });
			}
		}
	}
	return findings;
}

function collectTargets() {
	const targets = [];
	let namespaces = [];
	try {
		namespaces = readdirSync(widisRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(".widi-"))
			.map((entry) => join(widisRoot, entry.name));
	} catch {
		return targets;
	}
	for (const namespace of namespaces) {
		const directory = join(namespace, "preference");
		let entries = [];
		try {
			entries = readdirSync(directory);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.startsWith("np-") || !name.endsWith(".md")) continue;
			const path = join(directory, name);
			if (statSync(path).isFile()) targets.push(path);
		}
	}
	return targets;
}

const targets = collectTargets();
if (targets.length === 0) {
	process.stdout.write("No preference carrier found under widis/.widi-*/preference/np-*.md\n");
	process.exit(0);
}

const findings = targets.flatMap(lintFile);
for (const finding of findings) {
	process.stderr.write(
		`${relative(repositoryRoot, finding.path)}:${finding.line}: ${finding.label} '${finding.text}' ` +
			"must not appear in a preference entry - NP_k is strategy reused across episodes, and a paper " +
			"identifier in it is one question's answer.\n" +
			`    ${finding.context}\n`,
	);
}

process.stdout.write(
	`preference-lint: ${targets.length} file(s) checked, ${findings.length} finding(s)\n` +
		(findings.length === 0
			? "  (identifier shapes only; a specific title or query string still needs a reader)\n"
			: ""),
);
process.exit(findings.length === 0 ? 0 : 1);
