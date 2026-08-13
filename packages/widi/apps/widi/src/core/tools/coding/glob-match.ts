/**
 * Gitignore-style glob matching for the find tool.
 *
 * The find tool matches globs in WIDI instead of passing them to ripgrep:
 * positive `rg --glob` patterns override all ignore logic (documented rg
 * behavior), which would resurface gitignored files. Matching here keeps
 * `rg --files` as a pure gitignore-aware file lister.
 *
 * Supported syntax: `*` (within a segment), `?`, `**` (across segments),
 * character classes `[...]` / `[!...]`, alternation `{a,b}`, and `\` escapes.
 */

/**
 * Compile a find pattern into a matcher over POSIX paths relative to the
 * search root. A pattern without `/` matches file basenames anywhere; a
 * pattern with `/` matches relative paths at any depth unless it starts with
 * `/`, which anchors it to the search root. Throws on invalid patterns.
 */
export function compileFindPattern(pattern: string): (relativePosixPath: string) => boolean {
	if (pattern.length === 0) {
		throw new Error("Invalid glob pattern: pattern is empty");
	}
	if (!pattern.includes("/")) {
		const regex = compileGlob(pattern);
		return (relativePosixPath) => {
			const lastSlash = relativePosixPath.lastIndexOf("/");
			return regex.test(relativePosixPath.slice(lastSlash + 1));
		};
	}
	let normalized = pattern;
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	} else if (!normalized.startsWith("**")) {
		normalized = `**/${normalized}`;
	}
	const regex = compileGlob(normalized);
	return (relativePosixPath) => regex.test(relativePosixPath);
}

/** Compile a glob into an anchored regular expression. */
export function compileGlob(pattern: string): RegExp {
	return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

const REGEXP_SPECIALS = new Set([".", "+", "^", "$", "(", ")", "|", "\\", "[", "]", "{", "}", "*", "?"]);

function escapeRegExpChar(char: string): string {
	return REGEXP_SPECIALS.has(char) ? `\\${char}` : char;
}

function globToRegExpSource(pattern: string): string {
	let source = "";
	let index = 0;
	let braceDepth = 0;

	while (index < pattern.length) {
		const char = pattern[index];
		switch (char) {
			case "*": {
				if (pattern[index + 1] === "*") {
					const atSegmentStart = index === 0 || pattern[index - 1] === "/";
					if (atSegmentStart && pattern[index + 2] === "/") {
						// `**/` matches zero or more whole segments.
						source += "(?:.*/)?";
						index += 3;
					} else {
						source += ".*";
						index += 2;
					}
				} else {
					source += "[^/]*";
					index += 1;
				}
				break;
			}
			case "?": {
				source += "[^/]";
				index += 1;
				break;
			}
			case "[": {
				const { classSource, nextIndex } = parseCharacterClass(pattern, index);
				source += classSource;
				index = nextIndex;
				break;
			}
			case "{": {
				braceDepth += 1;
				source += "(?:";
				index += 1;
				break;
			}
			case "}": {
				if (braceDepth === 0) {
					throw new Error(`Invalid glob pattern: unmatched '}' in "${pattern}"`);
				}
				braceDepth -= 1;
				source += ")";
				index += 1;
				break;
			}
			case ",": {
				source += braceDepth > 0 ? "|" : ",";
				index += 1;
				break;
			}
			case "\\": {
				const escaped = pattern[index + 1];
				if (escaped === undefined) {
					throw new Error(`Invalid glob pattern: trailing '\\' in "${pattern}"`);
				}
				source += escapeRegExpChar(escaped);
				index += 2;
				break;
			}
			default: {
				source += escapeRegExpChar(char);
				index += 1;
			}
		}
	}

	if (braceDepth > 0) {
		throw new Error(`Invalid glob pattern: unclosed '{' in "${pattern}"`);
	}
	return source;
}

function parseCharacterClass(pattern: string, openIndex: number): { classSource: string; nextIndex: number } {
	let body = "";
	let index = openIndex + 1;
	if (pattern[index] === "!" || pattern[index] === "^") {
		body += "^";
		index += 1;
	}
	// A `]` directly after the opening (and optional negation) is a literal.
	if (pattern[index] === "]") {
		body += "\\]";
		index += 1;
	}
	while (index < pattern.length && pattern[index] !== "]") {
		const char = pattern[index];
		body += char === "\\" ? "\\\\" : char;
		index += 1;
	}
	if (index >= pattern.length) {
		throw new Error(`Invalid glob pattern: unclosed character class in "${pattern}"`);
	}
	if (body === "" || body === "^") {
		throw new Error(`Invalid glob pattern: empty character class in "${pattern}"`);
	}
	return { classSource: `[${body}]`, nextIndex: index + 1 };
}
