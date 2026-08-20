# Agents (`AiSetup.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** the standard card (`.ns-card`), three bands deep and no deeper — a heading,
one **scope line**, and the panel. It used to stack a scope switch over a tab bar over
section pills: three bars in three visual languages all answering "where am I", which is
why nothing below them could be read. Scope is the only thing above the panel now,
because it is the only thing that changes what every row underneath *means*.
The user-facing label is **Agents** (nav icon: `AgentIcon`); the component file keeps its
historical `AiSetup.tsx` name.

## Scope line (`.scope-line`)

- `Global` and a project `Select` in one 28px segmented control (`.scope-seg`), with the
  search box filling the rest of the line. The active half lifts to `--bg3` under an
  `inset 0 2px 0 var(--accent)` rule. Never render this as a dropdown with "global" as an
  option — Global and a project are two places, not two values.
- A `.scope-blurb` under it always states the consequence in plain words: what Global
  covers, or which repo a project covers *and* that global still applies on top.
- Reachable three ways: the rail's Agents icon (Global), a `SlidersIcon` in each repo
  row's `.row-actions` (that repo), and ⌘K's "agent setup for" group.
- A repo that leaves the index falls back to Global rather than showing an empty scope.

## The panel (`AgentPanel.tsx`)

**One row is one object, and everything about that object lives in its row** — where it
runs, what each agent is actually running, whether the server answers, how to remove it.
There are no tabs: MCP health is a block in a server's own row, and the instructions
editor is what the Instructions *section* shows. Sections (`.pnl-pill`) are the only
navigation, in the app's placard voice, carrying their own counts and an amber dot when
that section holds a disagreement.

- **The panel lands on "Needs you"** — every drifted row across all sections — whenever
  there is one, and on the first section otherwise. **Instructions always has a section**
  even with no baseline written: writing one is the point, and an empty screen should be
  an invitation rather than an absence.
- **Search looks everywhere**, not just the section showing. Results carry a `.pnl-kind`
  tag; single-section views never do, because the pill above already said it.
- **The agent chip (`.ag-chip`) is the signature**: the app's own identity colours doing
  the labelling. Each control says its own agent's name, so the list needs no column
  header, no lane, and no legend — "who runs this" reads as three brand-coloured tokens.
  On = agent tint + solid agent border + full-opacity mark; off = deep paper, dim mark.
  - Drift adds an amber border **and must out-specify the agent colours**
    (`.ag-chip.on.drift`, not `.ag-chip.drift`) — `.ag-chip.on.ag-*` is 0,3,0 and silently
    wins otherwise, which is exactly how the warning went missing once already.
- **One word per row** (`.pnl-flag`, amber, right-aligned): the ringed chip already says
  *which* agent, so the row only has to say *what* — `not applied` / `differs` /
  `added outside`.
- **Two safety lines.** Flipping a chip is one click, because it is reversible. Turning a
  plugin or marketplace off, and "Remove everywhere", use the armed-confirm grammar.
- **Disagreement has no house answer.** The detail asks which agent is right and offers
  one button per holder ("Use Claude's"). Never add a "use Cockpit's version" button —
  Cockpit keeps a backup, not a version.
- **Remove everywhere is recoverable**, under a `Removed` section with *Put it back*.
- Rows are a plain hairline-separated list on one surface (`.pnl-list`). No grid, no
  column rules, no lanes: with self-labelling controls there is nothing left to align to.

## Instructions tab

- **Mental model shown to the user:** one shared baseline, fanned out into each agent's
  *native* file inside `<!-- cockpit:shared:start/end -->` markers. Content outside the
  markers belongs to the agent and is never touched. The hint states this explicitly.
- **Scope comes from the card**, never from a second selector inside the tab. Global
  targets the agent home files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.copilot/copilot-instructions.md`); a project scope targets `<root>/CLAUDE.md` +
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

## MCP health tab

- Only what a switch can't tell you: whether the server *answers*. Per-row **Check**
  probes it and reports through an `.mcp-status` pill — `connected` (ok), `needs login`
  (warn), `unreachable` (danger, detail in title), italic `checking…` in flight. When a
  URL server reports `needs login`, ghost-small `Log in · <Agent>` buttons appear for
  agents with an `mcp login` CLI (Claude, Codex — never Copilot).
- `.mcp-scope` chips stay, read-only: they say *where* a server is defined. Turning it
  on and off belongs to the Panel, and this tab must never grow a second way to do it.

## Shared list vocabulary

- Lists here are `.ext-list` of `.ext-row`s: leading agent logo(s), `.ext-body`
  (bold name + dimmed mono detail), actions right. New lists must keep this shape.
- Hints name real config paths in `<code>` — this view's job is demystifying where
  things live.
- Loading: `.tree-empty` "loading…"; every tab keeps a specific empty-state line
  explaining *why* it might be empty. Heading focus-on-mount, same as Settings.
