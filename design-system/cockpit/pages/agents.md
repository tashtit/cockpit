# Agents (`AiSetup.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** wide card (`.ns-card.wide`, 760px) with five tabs — **Instructions**, MCP
Servers, Skills, Plugins, Marketplace — one place to manage the *shared setup every
agent carries*. Instructions is first: it's the reason the view exists.
The user-facing label is **Agents** (nav icon: `AgentIcon`); the component file keeps
its historical `AiSetup.tsx` name, like the `'extensions'` view kind before it.

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
- **Baseline editor** (`.inst-baseline`): mono textarea. Two actions, right-aligned:
  ghost "Save" (baseline only, enabled when dirty) and primary "Save & apply to all".
  Dirty state = `.inst-dirty` warn-colored "unsaved changes" pinned left of the buttons.
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
- **Skills**: claude ↔ copilot copy via the same `+ <Agent>` affordance, hidden when the
  other agent already has a same-named skill. Codex never gets a skills button.
- **Marketplace / Plugins**: unchanged from the old Extensions rules — external links via
  `onOpenUrl` with trailing `↗`, `owner/repo` regex-validated before offering Open.
- Hints name real config paths in `<code>` — this view's job is demystifying where
  things live.
- Loading: `.tree-empty` "loading…"; every tab keeps a specific empty-state line
  explaining *why* it might be empty. Heading focus-on-mount, same as Settings.
