# widi

`widi` is the core of WIDI: a multi-agent runtime built natively on Pi's
`AgentHarness` (`@earendil-works/pi-agent-core`).

Pi's harness is kept as the single-agent execution kernel — model turns, the
session tree, resources, tools, and stream lifecycle. `widi` adds the
runtime around it, with one design rule throughout: multi-agent orchestration
is a first-class, observable, recoverable capability of the runtime, not an
external script or subprocess trick.

## What the core provides

- **Orchestrator** (`src/core/agent-orchestrator.ts`): cross-agent lifecycle,
  harness assembly, text input with extension interception, human request
  routing, client event fanout, and structured diagnostics on one observable
  main path.
- **Agent profiles** (`src/core/agent-profile.ts`): declarative agent
  configuration (system prompt, tools, skills, prompt templates, extensions)
  with a registry that handles source priority, duplicates, and parse or
  validation diagnostics.
- **Sessions** (`src/core/session-manager.ts`): persistent
  JSONL sessions that keep Pi's session tree semantics and can be resumed into
  a fresh harness — including reloading the profile the session was created
  with (see "Session storage" below).
- **Tool registry** (`src/core/tool-registry.ts`, `src/core/tools/`): seven
  built-in coding tools, with a patch pipeline so extensions can rewrap any
  tool's backend. Agent collaboration tools are the next core milestone.
- **Extension loader/runner** (`src/core/extension/`): API v1 for tools,
  commands, resources, providers, observers/interceptors, scoped actions, and
  small session-local state via Pi custom entries.
- **Runtime composition** (`src/core/runtime-service.ts`): wires settings,
  profiles, resources, model/auth, sessions, tools, extensions, and the
  orchestrator into one runtime.

## Status

Work proceeds through three high-level milestones: the minimal MultiAgent
collaboration loop, diagnostic construction closer to domain runtimes, and
core readability improvements. See the
[`Chinese milestone document`](docs/zh-CN/TODO.md).

## Session storage

Persistent sessions are plain Pi JSONL session files. The only difference is
an optional, opaque `metadata` object on the header line, used to store the
context needed to rebuild a harness on resume — currently the agent profile
reference, readable at list time without scanning entries.

WIDI uses Pi's `JsonlSessionRepo` directly. Header metadata remains an opaque,
small recovery-reference field rather than a second session protocol. Design
notes: [`sessions-and-runtime.md`](docs/zh-CN/core/sessions-and-runtime.md).

## Documentation

Documentation has a stable language entry at [`docs/`](docs/); the current
canonical set is Simplified Chinese under `docs/zh-CN/`. Code, identifiers,
and diagnostics are English throughout.

- [`docs/zh-CN/DESIGN.md`](docs/zh-CN/DESIGN.md) — core design boundaries and settled
  decisions (command, coding tools, collaboration).
- [`docs/zh-CN/core/`](docs/zh-CN/core/) — canonical runtime, extension,
  profile/resource, session, tool, diagnostics, and upstream mechanism notes.
- [`docs/zh-CN/core/pi-upstream-roadmap.md`](docs/zh-CN/core/pi-upstream-roadmap.md) —
  primitives WIDI deliberately does not fake locally and hopes to see settle
  in Pi upstream (ExecutionEnv locking, interactive shell sessions, harness
  queue control, provider scope).
- [`../../CONTEXT.md`](../../CONTEXT.md) — the glossary that pins down core
  terms (in English).

## Bootstrap

```bash
npm install
npm --workspace apps/widi run test
```

Tests run the vendored agent core from source, so no build step is needed first. `@earendil-works/pi-ai` and `@earendil-works/pi-tui` come from the registry as prebuilt packages; see [`../../docs/pi-fork.md`](../../docs/pi-fork.md) for why only the harness is vendored.

Run the monorepo check before committing code changes:

```bash
npm run check
```
