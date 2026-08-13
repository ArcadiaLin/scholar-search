# Development Rules

## Repository Context

`widi` is an npm workspace monorepo derived from `pi`.

Workspace packages:

- `apps/widi`: WIDI terminal coding harness. This is the active product code.
- `packages/agent`: `@arcadialin/agent-core`, a fork of `@earendil-works/pi-agent-core` vendored at pi `v0.83.0`.

`@earendil-works/pi-ai` and `@earendil-works/pi-tui` are ordinary dependencies installed from the registry at exact versions. They are not workspace packages and their source is not in this repository.

The upstream pi repository is no longer part of this repository. Clone it into `reference/pi` (gitignored, never built, safe to pull or check out at any ref) when you need upstream history for a cherry-pick or the reference implementation (`packages/coding-agent`) that WIDI calibrates behavior against. The vendored baseline is recorded in `docs/pi-fork.md`, not in a submodule pointer.

`pi-agent-harness` specifically refers to `packages/agent/src/harness`, the harness module inside `@arcadialin/agent-core`.

Why the fork exists, its complete divergence from upstream, the invariants that keep it working, and the re-sync conditions: `docs/pi-fork.md`. Read it before changing anything under `packages/agent`, the pi dependency versions, or `biome.json`.

## Current Focus

- Default all runtime design and implementation work to `apps/widi`.
- Treat `packages/agent` as vendored upstream code. Keep it byte-identical to upstream except for the divergences recorded in `docs/pi-fork.md`; every gratuitous edit costs a conflict on the next cherry-pick. Do not modify it unless the user explicitly asks.
- Treat `reference/*` as read-only upstream mirrors. Do not modify them; read `reference/pi/packages/*` as reference code only.
- Scratch space is `notes/` (gitignored): working notes, drafts, throwaway analysis. Do not invent new ignored paths for them - that is how the old ignore list accumulated a dozen dead entries. Anything worth keeping gets promoted into `docs/` (repo-level) or `apps/widi/docs/` (runtime docs).

## Project Shape

- Root package: private ESM package named `widi`.
- Node engine: `>=22.19.0`.
- Root TypeScript config maps `@arcadialin/agent-core` imports to `packages/agent/src`; `pi-ai` and `pi-tui` resolve from `node_modules` through their published type declarations.
- Root check covers `packages/agent/{src,test}` and `apps/widi/{src,tests}`. The app's own `check` script only sees the app, and the app's `tsconfig.build.json` deliberately has no path mappings so it resolves exactly what the runtime resolves.
- Root `biome.json` partitions formatting: `apps/**` uses WIDI's defaults (tab, width 2, line width 80), `packages/agent/**` keeps upstream's settings (tab, width 3, line width 120) plus upstream's lint relaxations. Never reformat `packages/agent` into WIDI style.
- `apps/widi` builds from `src` to `dist` with `tsgo`.
- `apps/widi` exposes the `widi-harness` binary from `dist/cli.js`; `src/cli.ts` is the single command entry and routes straight into the TUI (the old minimal line CLI was removed).
- Root `npm run tui` starts the TUI against the repo-local `.widi` config (vllm local model by default; `moonshot`/`anthropic` providers activate via `$MOONSHOT_API_KEY`/`$ANTHROPIC_API_KEY`). Override with `--agent-dir`/`--profile`; the runtime cwd is inherited from the terminal.
- `pi-ai` and `pi-tui` ship prebuilt dists, and `pi-ai` ships its generated model catalogs in `dist/providers/data/*.json`. No model-data generation and no network access are needed to build. Only `packages/agent` is built locally, by `npm --workspace apps/widi run build:deps`.
- `pi-ai` and `pi-tui` are pinned to exact versions, never caret ranges, and `typebox` must stay at exactly the version published `pi-ai` pins (1.3.7 today) because `TSchema` crosses the package boundary. `docs/pi-fork.md` explains both failure modes.
- `.widi/extensions/` holds the checked-in extensions loaded through the repo-local agent dir; it is gitignore-excepted from the blanket `.widi/*` ignore rule. The MCP and plan-demo samples were removed - `drill` is the one demonstration extension.

## Dependencies

`apps/widi` depends on:

- Agent core: `@arcadialin/agent-core` (workspace).
- Pi packages from the registry, pinned exactly: `@earendil-works/pi-ai`, `@earendil-works/pi-tui`.
- Model/runtime packages: `openai`, `@anthropic-ai/sandbox-runtime`.
- Config/schema utilities: `dotenv`, `smol-toml`, `typebox`.
- Test tooling: `vitest`.

Before using an external API, check installed package types or source in `node_modules`; do not guess.

## Conversational Style

- Keep answers short and direct.
- Use technical prose. Avoid fluff.
- No emojis in commits, issues, PR comments, docs, or code.
- Answer user questions first before running commands or making edits.
- When responding to user feedback or analysis, explicitly say whether you agree or disagree before describing changes.

## Code Quality

- Read files in full before broad changes, before editing files not yet inspected, and when investigating or auditing.
- Do not rely on search snippets for broad changes.
- Write Human-readable code.
- Write few comments. Do not comment what the code already says: no restating a signature, no narrating an obvious branch, no section banners over self-evident blocks. Comment only what the code cannot carry - why a non-obvious choice was made, an invariant a reader would otherwise break, a constraint imposed from outside. When in doubt, leave it out.
- Avoid `any` unless there is no practical typed alternative.
- Inline single-use, single-line helpers.
- Use top-level imports only. Do not use `await import()`, `import("pkg").Type`, or dynamic type imports.
- Never remove or downgrade code to hide type errors from outdated dependencies; upgrade the dependency instead.
- Use only erasable TypeScript syntax in code covered by the root config: no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or constructs that require JS emit.
- Use explicit fields plus constructor assignments instead of parameter properties.
- Ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`; add defaults to configurable keybinding maps instead.
- The harness session write API (`AgentHarness.appendMessage`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendLabel`, `setSessionName`) is the only supported way into a live session branch, and writing to a branch is not free: the entry is replayed into context on every resume, forked into every child session, and cannot be removed. Use it only for facts that must live on the branch; keep everything else in memory or beside the session. Report every new call site to the user, with what it writes and why the branch is the right place. Background: `docs/pi-fork.md`, "The session write surface".

## Commands

Skip the run check for experimental code changes and allow the code to contain errors.

For most of cases, run from the repository root:

```bash
npm run check
```

`npm run check` runs Biome formatting/linting and TypeScript checking for the monorepo. Documentation-only changes do not require checks unless the user asks.

Useful package commands:

```bash
npm --workspace apps/widi run build
npm --workspace apps/widi run check
npm --workspace apps/widi run test
npm --workspace @arcadialin/agent-core run test
npm run test                                  # both workspaces
```

Run package tests only when relevant or requested. Do not run long-lived dev servers unless the user asks. Never commit unless the user asks.

## Git Rules

- Never use destructive commands such as `git reset --hard`, `git checkout .`, or `git clean -fd` unless the user explicitly asks.
- Do not use `git add -A` or `git add .` when committing. Stage only files intentionally changed.
- Before staging or committing, run `git status` and verify unrelated changes are not included.
- Leave unrelated local changes alone.
- If a conflict appears in a file you did not touch, stop and ask the user.

## User Override

If the user asks for something that conflicts with these rules, explain the conflict and ask for confirmation before proceeding.
