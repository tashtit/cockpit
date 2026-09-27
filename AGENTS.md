# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, GitHub Copilot) working in this repository;
`CLAUDE.md` is a symlink to this file. It holds what to know *before* opening a file: the
commands, the map, and the rules that span modules. **A module's header comment is its spec** —
read it before changing the module, and keep it true in the same commit. Setup, packaging and
release mechanics for people are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

- `npm run dev` — Electron app with HMR
- `npm run typecheck` — `tsc --noEmit`, the static gate (there is no linter; `noUnusedLocals` fails an unused import or local)
- `npm test` — unit + component tiers; `npm run test:unit` / `npm run test:component` — one tier
- `npx vitest run tests/indexer.test.ts` — one file; `npx vitest run -t "pattern"` — tests matching a name
- `npm run test:coverage` — combined v8 report in `coverage/`; `test:coverage:unit` / `test:coverage:component` — one tier, scoped to the code it exercises (what CI uploads)
- `npm run build` — production build into `out/`; `npm run test:e2e` — Playwright against it (build first)
- `npm run sounds` — rewrites the notification sounds in `resources/sounds/` from their definitions in `scripts/sounds-core.mts`
- `npm run package` — macOS dmg + zip into `dist/` (unsigned without Apple credentials; version `0.0.0` outside a release); `npm run test:packaged` — opt-in smoke test of that `.app`, on the real userData dir
- `npm run ui:tour` — builds, then screenshots every view and state against a hermetic fixture world into `test-results/ui-tour/index.html`; `-- --only chat,settings` narrows it, `-- --no-live` skips the live turns
- `npm run docs:dev` — the user guide (VitePress, `docs/`); `docs:build` / `docs:preview` for the built site
- `npm run stats` — adoption numbers from read-only `gh api` calls, no telemetry

Both `npm run typecheck` and `npm test` must pass before delivering.

## Architecture

Cockpit is an Electron desktop hub that indexes and drives Claude Code / Codex / Copilot CLI
sessions (macOS-focused, dark-only). Three processes with a strict boundary:

- **main** (`src/main/`) — all Node work: fs scanning, git, spawning provider CLIs.
- **preload** (`src/preload/index.ts`) — contextBridge exposing `window.cockpit`.
- **renderer** (`src/renderer/src/`) — React 19, fully sandboxed (`contextIsolation`, `sandbox: true`, navigation blocked). No Node access, hand-written CSS (no Tailwind, no component library).

### IPC

The whole surface is the `CockpitApi` type in `src/shared/contract.ts`, and the
`add-ipc-capability` skill is the recipe. A capability is four edits, in order: `contract.ts`
(the method and its `CH` channel, `PUSH` for an event; request/response types in `types.ts`) →
`ipcMain.handle(CH.x, …)` in `src/main/index.ts` → the bridge in `src/preload/index.ts` →
`tests/component/stub-api.ts`. Components then call `api.x()`; `src/renderer/src/api.ts` is
never edited.

- Channel names are never string literals: `tests/ipc-channels.test.ts` fails on a bare literal, on a `CH` member only one side uses, and on a name off the `domain:verb` shape.
- **Renderer input is untrusted.** Coerce every argument, and validate any path against roots main derived itself (`assertKnownRepoRoot`, `assertKnownCwd`, `assertKnownConfigDir` in `src/main/index.ts`). Never act on an arbitrary renderer-supplied path.

### `src/shared/` — pure, and the first place to look for a helper

Every module imports only its siblings — no `node:*`, no `electron`, nothing from `src/main` or
`src/renderer` — so the sandboxed renderer loads the same file main does. The layering is
one-way: `types.ts` (the domain vocabulary) imports nothing, `library.ts` and `mcp-source.ts`
import `types.ts`, `contract.ts` imports both. `tests/shared-purity.test.ts` pins both rules,
since TypeScript compiles a type-only cycle happily. Several of these modules exist because the
same rule was about to be written twice, once per process, and drift — check them before
writing a helper:

`asks.ts` (the questions agents stop to ask, and what a pick becomes) · `endpoints.ts` (BYOK
validation, env, `/models`) · `acp.ts` (ACP agent definitions and their sanitizer) ·
`agent-auth.ts`, `agent-cli.ts`, `agent-models.ts` (sign-in verdicts, CLI install and update
rules, built-in models and `EFFORT_LEVELS`) · `library.ts`, `mcp-source.ts` (Cockpit's config
against each agent's) · `marketplace.ts` (a marketplace's catalogue, and the GitHub repo a
source names) · `updates-digest.ts` (the home's one line of what is out of date) · `instruction-markers.ts`, `instruction-changes.ts`, `line-diff.ts` ·
`repo-order.ts` · `roundtable.ts` (seat identity, limits) · `side-chat.ts` (which agents can have one) · `branch-prefix.ts` (the prefix of the branches Cockpit cuts) · `pr-feedback.ts` · `work.ts` (the
Work fold, shared with the handoff briefing) · `cleanup.ts` (how cleanup speaks) · `window.ts`
(the 560×420 floor, the zoom range, the restored placement) · `feedback.ts`.

### Indexing — the core data flow

`SessionIndexer` (`indexer.ts`) walks the registered source dirs → per-provider parsers
(`parsers/`) produce `SessionMeta` → `repos.ts` resolves each cwd to its repo and branch
(worktree-aware) → the renderer only ever sees `RepoGroup`s and paged `SessionPage`s.
Invariants, all deliberate:

- The full index is never shipped to or rendered by the UI. Always paginate.
- Meta parsing reads at most 256KB per file, and parsers are failure-tolerant: provider log formats drift between releases, so skip anything unreadable rather than fail the scan (the `add-session-parser` skill). A parser reports only what its log states (`logBranch`); everything derived from the checkout is the indexer's `annotate()`, recomputed on every scan.
- A session can span several files (Codex paginates long threads): read or remove a session's log through `sessionLogFiles`, never `sourcePath` alone. Bump `CACHE_VERSION` when parser output changes.
- Only the providers' session roots are walked and watched (never `pkg/`, `repos/`, logs or SQLite files), with `fs.watch(root, {recursive: true})`.
- What a tool call hands the person — a plan, to-dos, an edit, a check, a shared file, a follow-up — rides its transcript row as `SessionMessage.artifact`, read and bounded in main (`parsers/artifacts.ts`, `parsers/checks.ts`) and folded by `src/shared/work.ts`. The renderer never parses tool JSON, and a check's verdict comes from the runner's own output or a stated exit code — never a guess.

### Main-process map

Each file's header comment has the detail. A `-core.ts` file is the IO-free half of the module
it is named for and is what the unit tests target; keep IO in the sibling without the suffix.

- **Sessions**: `indexer.ts`, `repos.ts`, `parsers/` (one per provider, plus `artifacts`, `checks`, `util`), `provider-archived.ts` (what the providers' own apps archived or deleted), `liveness` (busy state of sessions Cockpit did not spawn, from their log tails), `transcript-search.ts`, `session-control-core.ts` (who drives a session), `session-files.ts` (files a session shared), `handoff`, `profile.ts`, `config.ts`
- **Driving agents**: `chat.ts` (headless CLI turns, one process per turn), `claude-permissions.ts` (a Claude turn's permission prompts, answered in the chat), `side-chat.ts` (a question asked of a throwaway copy of a session — nothing reaches its log), `acp` (the Agent Client Protocol transport), `roundtable` (several agents, one transcript), `chat-images.ts`, `endpoint-models.ts` + `secrets.ts` (BYOK model catalogs, keychain-encrypted keys)
- **Agents & accounts**: `accounts.ts`, `agent-auth`, `agent-cli`, `agent-models`, `usage.ts`
- **Library**: `extensions` (MCP / skills / plugins inventory and sharing), `library.ts`, `mcp.ts`, `mcp-versions.ts`, `toml.ts`, `marketplace.ts` (what a marketplace offers — read from the agent's clone, from GitHub only on a click), `updates-digest.ts` (everything that could be brought up to date, for the home — on demand, never polled), `instructions` + `instructions-share.ts` (shared instructions, and sharing them to a repo by PR)
- **Git & GitHub**: `workspace.ts` (worktrees and PRs), `diff` (the review before landing), `pr-feedback` (the loop after the PR opens), `github` (PR badges)
- **Housekeeping**: `cleanup`, `cleanup-reminder`, `backup`
- **App**: `index.ts` (bootstrap and every IPC handler), `attention` (notifications, sounds, the Dock badge), `updates.ts` + `update-install` (self-update), `dev-window.ts`, `link-guard.ts`, `env.ts`, `replace-file.ts`, `paths.ts`

### Rules that span modules

- **One way to do each thing.** Run a CLI with `execText` and give every spawn `cliEnv()` (`env.ts`) — never another `execFile` wrapper. `cliEnv()` carries the person's login-shell PATH, read once at launch, so a launch-time probe of an agent CLI waits on `loginPathReady` first. Write a whole file with `writeFileAtomic` / `replaceFile` (`replace-file.ts`) — never another temp-and-rename. Check path containment with `paths.ts`.
- **One session, one turn.** `chat:send` refuses to resume a session whose turn is still in flight, or one held by its agent (`session-control-core.ts`). Busy state is Cockpit's spawned turns merged with those observed in the logs (`mergeBusy`; spawned wins).
- **Roundtable seat sessions are not independent work**: they stay out of every listing, page only under `SessionQuery.roundtableId`, and `chat:send` refuses their cwd. Only the roundtable manager sets `research` and only `side-chat:ask` sets `sideFork` (`chat:send` strips both); research never grants the shell — no rule keeps a command read-only.
- **Git is never forced.** Sessions work in worktrees under userData on a `<prefix><name>` branch (config `branchPrefix`, `cockpit/` when unset), never the user's checkout. Never `git worktree prune`, never `--force` a worktree removal, delete branches only through `git branch -d`, stop processes with SIGTERM only, and never give a sandboxed agent a writable `.git` — hooks or objects it can write are a way out of the sandbox.
- **Secrets stay out of config.** BYOK keys live in the keychain (`secrets.ts`); a turn sets every credential variable its CLI reads, the unused ones empty. `sanitizeAcpAgent` is the most security-sensitive check in the app: an agent definition is "run this binary".
- **Attention is quiet outside a packaged app.** An unflipped switch is on only there, so dev, e2e and the tour never notify; what is on screen in a focused window is never news.
- **A staged update bundle is removed with `/bin/rm` (`removeTree`), never `fs.rm`**: Electron's fs reads `app.asar` as a directory, which the unit tier (plain Node) cannot see.

## Tests

Three tiers; CI (`.github/workflows/ci.yml`) runs all of them.

- **unit** (`tests/*.test.ts`, node) — real tmpdir fixtures: tests write fake session logs and fake `.git` files and run the real code over them. No mocking framework; follow that pattern.
- **component** (`tests/component/`, jsdom) — renderer components against the stubbed `window.cockpit` in `tests/component/stub-api.ts`.
- **e2e** (`tests/e2e/`, Playwright) — the built app. Every launch gets a fresh empty `HOME` from `launchEnv` (`tests/e2e/launch-env.ts`) unless the spec seeds its own: main resolves every agent path through `os.homedir()`, so an inherited HOME tests this machine's agents rather than the spec's. Tear every app down with `closeApp` (`tests/e2e/close-app.ts`), never a bare `app.close()` or a SIGKILL of `app.process()`. `a11y.spec.ts` checks hand-written rules, each one a bug this app already shipped — no audit engine.

Not a tier, but the check for anything a person *sees*: `npm run ui:tour`. Tests assert
behaviour; the tour shows what renders. Its world is a fake `HOME` + `COCKPIT_USER_DATA` + stub
agent CLIs first on `PATH` (`scripts/ui-tour/world.mts`), and `tests/ui-tour-world.test.ts`
parses it with the real parsers, so log-format drift fails a test instead of emptying the
screenshots.

## Packaging & releases

The mechanics are in CONTRIBUTING.md and `electron-builder.config.js`. The rules:

- Production `dependencies` ship in the asar — main requires them at load, so one dropped from it throws at startup as a modal with no window.
- Signing turns on only with all five Apple secrets. Never make a credential-less build fail.
- Third-party notices are generated (`scripts/licenses/`), never hand-written; artwork or fonts copied into the source need an entry in `fixedNotices`.
- `build/icon.icns` is committed, packed by `npm run icon`. Never let electron-builder render it from a PNG; rerun after changing the artwork and commit both outputs.
- The notification sounds are synthesized by `scripts/sounds-core.mts`, never recorded or downloaded, so they need no notice — keep it that way: that module imports nothing, borrows only Freeverb's public-domain tuning numbers, and no motif may echo a registered sound mark. The `.wav`s are committed and ship outside the asar (`afplay` can't read inside one); `tests/sounds.test.ts` fails when a file and its definition disagree, so change the definition, rerun `npm run sounds`, and commit both.
- `package.json` stays `0.0.0`: semantic-release derives the version from commit types (`feat` minor; `fix` / `perf` / `revert` / `build` patch; `!` major), so a misnamed commit is a wrong version.

## UI work

Before touching anything in `src/renderer/`, read `design-system/cockpit/MASTER.md`; per-view
rules in `design-system/cockpit/pages/<view>.md` override it (the `cockpit-ui` skill). Canonical
tokens live in the `:root` block of `src/renderer/src/style.css` — components use tokens only,
never raw hex. Dark mode only. `tests/style-reachability.test.ts` fails on any class in
`style.css` that no source could emit: delete the rule, or, if something really does render it,
add the reason to that test.

## Running the app

Every session that touches this repo shows the person its work in a running app before
reporting, no exceptions: `npm run dev` from the session's own worktree, started detached and
left running. The branch banner across the top of every unpackaged window is how the person
tells one session's app from another's — don't hide or skip it.

Every window a session opens — `npm run dev`, the e2e tier, `npm run ui:tour`, a Playwright
driver script — goes to the display in `COCKPIT_DEV_DISPLAY` and never takes focus. Launch
with the inherited environment: never unset `COCKPIT_DEV_DISPLAY`, never set
`COCKPIT_DEV_BACKGROUND=0` (or use `npm run dev:fg`) unless the person asks, and build a
driver's env from `launchEnv` in `tests/e2e/launch-env.ts` (or the same spread of
`process.env`). `COCKPIT_E2E_TAKE_FOCUS=1` is the one switch that fronts a window, for the
full-screen specs; don't set it unasked.

## Probing an agent CLI

Every `claude`, `codex` or `copilot` run saves a session into the person's real history, and
their Cockpit lists it: a batch of probes from a scratch folder lands in Chats as a column of
look-alike rows, and each ending can raise a landing. Probe with `claude -p
--no-session-persistence` or `codex exec --ephemeral`, which save nothing; drop the switch only
when resuming is what the probe tests. Copilot has no such switch, and neither do the turns a
dev app spawns against the real `HOME` (a roundtable's seats included) — keep those few, prefer
the ui-tour world's stub CLIs when no real model is needed, and name in the report what ran so
the person can archive it.

## Documentation

The user guide is a VitePress site in `docs/` (`docs/guide/`, one page per feature), published
to https://tashtit.github.io/cockpit/ on every push to `main` that touches it; pull requests only
build it, which fails on a dead link. It has no analytics and none is wanted.

Keep it current in the same commit as the change: anything that alters what a user sees or does —
a new view, a renamed control, a changed default, a new setting — updates its page under
`docs/guide/`. Nothing in CI checks this, so the rule is the only thing that catches drift. Pages
compile as Vue templates: a bare `<placeholder>` outside a code span is an unclosed element that
fails `docs:build`, so write it `&lt;placeholder&gt;`.

## Repo skills

Project skills (Agent Skills standard, `SKILL.md`) live in **`.agents/skills/`**, the single
source of truth: Codex and Copilot read that directory natively, and `.claude/skills` is a
symlink to it for Claude Code. Add new skills there, one directory per skill.

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
