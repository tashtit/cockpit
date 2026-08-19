# Agents (`AiSetup.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** the standard card (`.ns-card`, the one shared width) with six tabs —
**Compare**, Instructions, MCP Servers, Skills, Plugins, Marketplace — one place to manage
the *shared setup every agent carries*. Compare is first and is the view's front door:
the per-kind tabs manage one thing at a time, Compare answers "are my agents the same?".
The user-facing label is **Agents** (nav icon: `AgentIcon`); the component file keeps
its historical `AiSetup.tsx` name, like the `'extensions'` view kind before it.

## Compare tab (`CompareAgents.tsx`)

- **Pattern: a matrix, not a list.** Rows are shared things (grouped by kind, in
  `KIND_ORDER`: instructions → MCP → skills → plugins → marketplaces), columns are the
  three agents. Fixed 84px agent columns (`.cmp-row` grid) so every state lines up
  vertically down the whole card — that alignment is what makes a gap readable at a
  glance, and it's why this view does **not** reuse `.ext-row`.
- **Four cell states**, one glyph each, color-coded, always with a `title`/`aria-label`
  carrying the detail: `✓` present (ok), `≠` differs (warn), `+` missing, `·` not
  supported (dim). `+` is the only affordance in the grid — a dashed accent
  `.cmp-add` button, the one place a dashed border is used, reading as "empty slot".
- **Parity is computed, never fetched**: `shared/parity.ts` derives the whole report
  from the inventory + instructions the view already holds. New kinds get a reader
  there, not a new IPC channel.
- **Row expands into the diff** (`.cmp-diff`): a field × agent table with the reference
  agent marked, and any row the agents disagree on tinted warn. The matrix says *that*
  something differs; this says *what*. Env var **values are never shown or compared** —
  only names.
- **Two safety lines, deliberately different:**
  - *additive* actions are one click — a cell's `+`, the row's "Sync all" (missing
    cells only), and the group's "Fill N gaps".
  - *destructive* actions (replacing an agent's own definition) live inside the
    expanded diff and use the Settings-style armed confirm (`Replace X's` → danger
    `replace?`, 4s / blur disarm) — never `window.confirm`.
- **Filter**: `.cmp-toggle` "Only differences", **on by default** — the view opens on
  the work, not the inventory. The all-aligned state gets its own `.tree-empty` line.
- Counts strip (`.cmp-counts`) reads `N shared · N aligned · N differ · N incomplete`,
  colored ok/warn/dim. Notices reuse `.ext-notice` and name the consequence.
- Long-running syncs (plugins/marketplaces shell out to the agent's CLI) disable every
  action while in flight and swap the label to `syncing…` / `filling…`.

## Instructions tab

- **Mental model shown to the user:** one shared baseline, fanned out into each agent's
  *native* file inside `<!-- cockpit:shared:start/end -->` markers. Content outside the
  markers belongs to the agent and is never touched. The hint states this explicitly.
- **Scope switcher** (`.inst-scope`): "Global — every session, all repos" + one option
  per indexed git repo (GitHub `owner/repo` name when known). Global targets the agent
  home files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.copilot/copilot-instructions.md`); repo scope targets `<root>/CLAUDE.md` +
  `<root>/AGENTS.md` — one AGENTS.md row carries both the Codex *and* Copilot logos
  because both read it natively. Never render a third copilot-specific file in repo scope.
- **Baseline editor**: the baseline is markdown, so it edits like markdown —
  GitHub-comment grammar. `.md-tabs` (Write | Preview, `aria-pressed` toggles) over a
  shared frame: Write = `.inst-baseline` mono textarea on the code-block paper
  (`--bg-deep`, 220px min); Preview = `.inst-preview.markdown` rendering the draft
  through the shared `Markdown` component (`Markdown.tsx` — the same pipeline as chat
  transcripts, so the two surfaces can't drift). Both states share the exact frame —
  toggling never shifts the card. Two actions, right-aligned: ghost "Save" (baseline
  only, enabled when dirty) and primary "Save & apply to all". Dirty state =
  `.inst-dirty` warn-colored "unsaved changes" pinned left of the buttons.
- **File rows** reuse `.ext-row`: agent logo(s) left, `~`-abbreviated mono path
  (`user-select: text`), then an `.inst-status` pill:
  - `in sync` (ok green) — managed block matches baseline; no action button.
  - `out of date` (warn) — block differs (stale or hand-edited) → "Re-apply".
  - `not applied` (dim) — file exists, no block → "Apply".
  - `no file yet` (dim italic) — → "Create & apply". Applying creates parent dirs.
  Apply buttons are ghost-small and disabled (with a title explaining why) while the
  saved baseline is empty.
- **Inline file editor**: each existing file row gets a `.inst-edit` `<details>`
  ("view / edit file") with a mono textarea + "Save file" (disabled until changed).
  Whole-file editing is deliberate — per-agent private content is edited here too.
- Notices reuse `.ext-notice` and always state the consequence ("running sessions pick
  it up on their next start").

## Other tabs

- Every list is `.ext-list` of `.ext-row`s: leading agent logo(s), `.ext-body`
  (bold name + dimmed mono detail), actions right. New tabs must keep this shape.
- **MCP**: each row shows one `.mcp-scope` chip per *presence* — every (agent, scope) the
  server is defined in: agent-tinted pill (10px logo + mono scope label: `global` or the
  project dirname, full path in the title) with its own remove `×`. Removal uses the
  Settings-style armed confirm (× → danger `remove?`, 4s / blur disarm) — never
  `window.confirm`. Share buttons stay ghost-small `+ <Agent>` for agents that *don't*
  have the server; absence is the affordance.
  Per-row **Reload** probes the server (spawns the stdio command / hits the URL with an
  MCP initialize) and reports via an `.mcp-status` pill next to the name: `connected`
  (ok), `needs login` (warn), `unreachable` (danger, detail in title), italic
  `checking…` while in flight. When a URL server reports `needs login`, ghost-small
  `Log in · <Agent>` buttons appear for agents with an `mcp login` CLI (Claude, Codex —
  never Copilot); the notice tells the user to finish the OAuth flow in the browser.
  A right-aligned ghost-small "Refresh list" above the list re-reads configs from disk.
- **Skills**: all three agents read `<home>/skills/<name>/SKILL.md`, so a skill copies
  to either of the other two via the same `+ <Agent>` affordance, hidden when that agent
  already has a same-named skill.
- **Marketplace / Plugins**: read from all three agents (claude JSON, codex
  `config.toml` sections, copilot's `installed-plugins/<marketplace>/<plugin>` tree) and
  keyed by the `<name>@<marketplace>` id every agent uses, so the same plugin lines up
  across columns in Compare. External links via `onOpenUrl` with trailing `↗`,
  `owner/repo` regex-validated before offering Open. Installing is never a file copy —
  Compare runs the target agent's own CLI.
- Hints name real config paths in `<code>` — this view's job is demystifying where
  things live.
- Loading: `.tree-empty` "loading…"; every tab keeps a specific empty-state line
  explaining *why* it might be empty. Heading focus-on-mount, same as Settings.
