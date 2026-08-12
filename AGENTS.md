# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, GitHub Copilot) when working with code in this repository. `CLAUDE.md` is a symlink to this file.

## Commands

- `npm run dev` — Electron app with HMR
- `npm run typecheck` — `tsc --noEmit` (there is no linter; this is the static gate)
- `npm test` — all vitest tests (unit + component tiers)
- `npm run test:unit` / `npm run test:component` — one tier
- `npm run test:coverage` — unit + component with a combined v8 coverage report in `coverage/`
- `npm run test:coverage:unit` / `npm run test:coverage:component` — one tier, scoped to the code it exercises (`coverage/unit`, `coverage/component`); these are what CI uploads
- `npm run test:e2e` — Playwright E2E against the built app (run `npm run build` first)
- `npx vitest run tests/indexer.test.ts` — one test file
- `npx vitest run -t "pattern"` — tests matching a name
- `npm run build` — production build into `out/`

Both `npm run typecheck` and `npm test` must pass before delivering.

## Architecture

Cockpit is an Electron desktop hub that indexes and drives Claude Code / Codex / Copilot CLI sessions (macOS-focused, dark-only). Three processes with a strict boundary:

- **main** (`src/main/`) — all Node work: fs scanning, git, spawning provider CLIs.
- **preload** (`src/preload/index.ts`) — contextBridge exposing `window.cockpit`.
- **renderer** (`src/renderer/src/`) — React 19 UI, fully sandboxed (`contextIsolation`, `sandbox: true`, navigation blocked). No Node access, hand-written CSS (no Tailwind, no component library).

The entire IPC surface is the `CockpitApi` interface in `src/shared/types.ts`. Adding a capability means touching four places, in order:

1. types + `CockpitApi` method in `src/shared/types.ts`
2. `ipcMain.handle(...)` in `src/main/index.ts`
3. bridge method in `src/preload/index.ts`
4. renderer call via `src/renderer/src/api.ts`

**Renderer input is untrusted.** Any path arriving over IPC must be validated against roots the indexer itself derived — see `assertKnownRepoRoot` in `src/main/index.ts`. Never act on an arbitrary renderer-supplied path.

### Indexing pipeline (the core data flow)

`SessionIndexer` (`src/main/indexer.ts`) walks registered source dirs (`~/.claude`, `~/.codex`, `~/.copilot`, plus extras from config) → per-provider parsers in `src/main/parsers/` produce `SessionMeta` → `repos.ts` resolves each session's cwd to its git repo (worktree-aware: linked worktrees group under the main repo; GitHub `owner/repo` read from the origin remote) → the renderer only ever sees `RepoGroup`s and paged `SessionPage`s. Sessions archived or deleted in the provider's own app are dropped (`provider-archived.ts`), and the history-window setting (`historyDays` in config) hides sessions idle longer than N days.

Performance invariants — all deliberate, keep them:

- The full index is never shipped to or rendered by the UI. Always paginate.
- Meta parsing reads at most 256KB per file. Parsers are failure-tolerant: session log formats are provider-internal and drift between releases, so skip anything unreadable rather than fail the scan.
- The stat-cache (mtime+size, persisted to userData) means restarts only re-parse changed files; scans yield to the event loop so IPC never blocks.
- Only per-provider session roots are walked/watched (never `pkg/`, `repos/`, logs, or SQLite files). Watching uses Node's `fs.watch(root, {recursive: true})` — chokidar was dropped on purpose (its bundled fsevents broke on the Electron 43 upgrade); the indexer does its own debouncing.

### Other main-process subsystems

- `chat.ts` — spawns provider CLIs headless (`claude -p --output-format stream-json`, `codex exec --json`, `copilot -p`) and parses their stream events. Both old (`msg.type`) and new (`thread.started`/`item.completed`) Codex event shapes must stay handled.
- `instructions-core.ts` vs `instructions.ts` — the shared-instructions marker/drift logic is deliberately IO-free in `-core.ts` (that's what the tests target); keep IO in `instructions.ts`.
- `workspace.ts` — "always worktrees, always PRs": new sessions get a `cockpit/<name>` branch in an isolated worktree under the app's userData, never in the user's checkout; PRs go through `gh`.
- `extensions.ts` — MCP/skills/plugins inventory and cross-agent sharing; each agent has its own config format (`~/.claude.json`, `~/.codex/config.toml`, `~/.copilot/mcp-config.json`).
- `accounts.ts` — who each agent CLI is signed in as, per config home (Claude `.claude.json` OAuth, Codex `auth.json` JWT, Copilot's multi-account `config.json`), plus the `gh` user for repo operations.
- `usage.ts` — subscription usage per provider without touching credentials: Claude measured locally from session JSONLs, Codex from the rate-limit snapshots its CLI persists, Copilot via the GitHub billing API (fails soft).
- `provider-archived.ts` — reads each provider's own archived/deleted state (Copilot `data.db`, Codex `archived_sessions/`, the Claude desktop app's session store) so those sessions never appear in Cockpit.
- `env.ts` — `cliEnv()`: GUI apps on macOS get a minimal PATH; use it for every spawned CLI.

### Tests

Three tiers; CI (`.github/workflows/ci.yml`) runs all of them:

- **unit** (`tests/*.test.ts`, node env) — real tmpdir fixtures: tests write fake session logs and fake `.git/config` files to disk and run the real indexer/parsers over them. No mocking framework; follow that pattern for new tests.
- **component** (`tests/component/`, jsdom) — renderer components against the stubbed `window.cockpit` in `tests/component/stub-api.ts`.
- **e2e** (`tests/e2e/`, Playwright) — drives the built Electron app; requires `npm run build` first.

## UI work

Before touching anything in `src/renderer/`, read `design-system/cockpit/MASTER.md`. Per-view rules in `design-system/cockpit/pages/<view>.md` override it. Canonical design tokens live in the `:root` block of `src/renderer/src/style.css` — components use tokens only, never raw hex. Dark mode only.

## Repo skills

Project skills (Agent Skills standard, `SKILL.md` format) live in **`.agents/skills/`** — the single source of truth. Codex and Copilot read that directory natively; `.claude/skills` is a symlink to it for Claude Code. Add new skills there, one directory per skill:

- `add-ipc-capability` — the four-file recipe for extending the renderer↔main IPC surface
- `add-session-parser` — provider log parser rules (bounded reads, failure tolerance, fixtures)
- `cockpit-ui` — design-system compliance for renderer work

## Conventions

- Conventional Commits (`feat(indexer): …`, `docs: …`), matching existing history.
- No AI attribution: no `Co-Authored-By` lines or "Generated with" footers in commits or PRs.

### File naming

- Non-component modules and tests: lowercase, kebab-case when multiword (`dev-window.ts`, `instructions-core.ts`, `stub-api.ts`).
- React components: PascalCase `.tsx`, named for the component (`ChatView.tsx`). A `.tsx` file that is not itself a single component stays lowercase (`logos.tsx`, `main.tsx`).
- Tests are named after the module under test, kebab-cased (`home-view.test.tsx` for `HomeView.tsx`); `.test.ts(x)` for vitest tiers, `.spec.ts` for Playwright e2e.
- Entry points are `index.ts` / `main.tsx`; directories are single lowercase words.
- CSS class names are kebab-case; symbols follow standard TS style (camelCase values, PascalCase types/components, SCREAMING_SNAKE module-level constants).

### Code style

- **`type`, not `interface`.** Declare object shapes as type aliases; compose with intersections
  (`type B = A & {…}`) instead of `extends`. The one exception is declaration merging that
  TypeScript only allows through interfaces (e.g. the `declare global { interface Window }`
  augmentation in `src/renderer/src/api.ts`).
- **`readonly` properties by default.** Every property of a shared or exported type is `readonly`
  unless in-place mutation is the point (e.g. a main-process cache/accumulator) — leave a comment
  on the property when you opt out. To derive a mutable working shape from a readonly type, map it
  (`{ -readonly [K in keyof T]: T[K] }`) rather than duplicating the shape.
- **Max 3 function parameters.** A signature that wants a 4th parameter gets restructured instead:
  keep the 1–2 primary arguments positional and gather the rest into a single (usually optional)
  options object. Never grow trailing boolean/optional parameter lists.
