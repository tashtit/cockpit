# Agents (`AiSetup.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** the standard card (`.ns-card`, the one shared width) under a **scope
switch**, with three tabs — **Panel**, Instructions, MCP health. The scope switch is the
first thing on the card because "which of these applies where?" was the question this
view kept failing to answer; everything below it means something different depending on
which half is lit. The user-facing label is **Agents** (nav icon: `AgentIcon`); the
component file keeps its historical `AiSetup.tsx` name.

## Scope switch (`.scope-switch`)

- **Two halves, not a dropdown.** `GLOBAL / every session` and `PROJECT` + a repo
  `Select`. Equal-weight halves on a 1px `--border` seam; the active half lifts to
  `--bg3` with an `inset 0 2px 0 var(--accent)` top rule. Mono placard for the two names
  (`.scope-name`), sans for the sub-labels. Never render this as one control with a
  "global" option in the list — the point is that these are two places, not two values.
- A `.scope-blurb` under it always states the consequence in plain words: what Global
  covers, or which repo a project scope covers *and* that global still applies on top.
- Reachable three ways: the rail's Agents icon (Global), a `SlidersIcon` button in each
  repo row's `.row-actions` (that repo), and ⌘K's "agent setup for" group.
- A repo that leaves the index falls back to Global rather than showing an empty scope.

## Panel tab (`AgentPanel.tsx`)

The view's signature element. Each row is one entry in Cockpit's own config
(`config.library`); each agent column is a switch saying **where that thing is applied**.

**Cockpit keeps a backup, not a version.** The copy it stores is refreshed from whatever
the agents run, and exists so a switch has something to write and a removed entry can come
back. It is never rendered as a column to compare against, and it never breaks a tie —
the agents are compared *with each other*. The one exception is the shared instructions,
whose baseline really is authored in Cockpit: an `Actual.mismatch` flag lets that reader
say outright who is out of step, and it supersedes peer comparison for that row.

- **One section at a time.** The whole setup in one scroll was a wall, so kinds are
  `.pnl-pill` tabs carrying their own counts (and an amber `.pnl-pill-dot` when that kind
  has a disagreement). The panel lands on **Needs you** — every drifted row across all
  kinds — whenever there is one, and on the first section otherwise. A `.pnl-blurb` under
  the pills says what the current view is.
- **Search (`.pnl-search`) looks everywhere**, not just the section showing: you rarely
  know which section a server ended up in. It matches name, Cockpit's definition and the
  kind. While searching, the pills dim (`.pnl-tabs.searching`) — they aren't filtering
  any more, and pretending otherwise would be a lie.
- In any view that mixes kinds (search, Needs you) each row carries a `.pnl-kind` tag.
  Single-section views never do — the pill above already said it.
- **One row per managed thing**: the name plus Cockpit's own definition in mono
  (`.pnl-def`) — that is what the switches write.

### The bank

The panel is drawn as an instrument bank. This is the one place in the app that renders
a **lane**, and it earns it because the data really is columnar — one entry, three
agents, read top to bottom. The lanes are the design; everything else is kept quiet on
purpose, because four competing rule weights and amber in four places is what made the
first version read as a spreadsheet.

- **Lanes are painted on the bank, not on cells.** `.pnl-bank` carries a right-anchored
  `linear-gradient` whose stops are the grid's own column widths, so the channels are
  continuous by construction and no horizontal rule ever crosses them. The widths live
  in `--pnl-lane` / `--pnl-state` on `.pnl-bank` and are read by *both* the gradient and
  `grid-template-columns` — they can never fall out of step. Never put a lane color back
  on a cell, and never give a cell its own background: a fill there punches a hole in
  the channel.
- **The header is inside the bank**, as its cap: the same gradient at 0.13, on
  `--bg-deep`, closed with a `--border-strong` rule. It is the only rule that crosses
  the lanes, which is what makes it read as a cap.
- **One horizontal rule, and it stops at the first lane.** Row separators are an
  `inset 0 1px 0` on `.pnl-name-cell` only. The entries are a list; the lanes are an
  instrument; a line across both would make it a table.
- **Hover and open light the entry, never the lanes** — same reason.
- **Rows keep one height** (32px) no matter how many disagreements are lit. A bank of
  switches that jogs as states change is unreadable.
- **Disagreement has no house answer.** When the agents split, the detail asks which one
  is right and offers one button per holder ("Use Claude's"). With a clear majority the
  odd ones out are flagged; with two agents and two answers *both* are flagged, because
  there is nothing to break the tie with. Never add a "use Cockpit's version" button.
- **Cockpit's copy is taken lazily**, at the only two moments it is needed: the last
  agent copy of a skill going away, and removing everywhere. Copying every skill folder
  on first read cost a folder copy per skill for a backup almost none of them would use.
- **Remove everywhere is recoverable.** It takes the entry out of every agent and keeps
  it, under a `Removed` section with *Put it back*, which restores the same agents. This
  is the entire justification for Cockpit holding a copy — if removal were permanent, the
  library would be bookkeeping with no purpose.
- **Two signals for drift, not four**: an amber ring on the switch (which lane) and a
  placard in the right-hand slot (what happened). No row stripe, no badge box, no filled
  chip. `.pnl-flag` is **printed text, not a badge** — the agent name in `--fg-dim`, the
  state word in `--warn`. Amber is the only mustard in the panel, so the word alone is
  unmistakable and a box would only add weight.
- **The placard lane collapses when nothing is lit** (`.pnl-bank.quiet` drops
  `--pnl-state` to 24px). A healthy section shouldn't reserve a void for warnings it
  doesn't have.
- **Two mono registers in the row**, exactly as `MASTER.md` has it: the definition is a
  machine identifier (normal case, `.pnl-def`), the section tag is a placard (uppercase,
  tracked, `.pnl-kind`). The entry name is the row's only sans. Three type treatments in
  one row is one too many.
- A write in flight is a small pulsing accent lamp in the corner of its lane
  (`.pnl-lamp`), never a caption that would shift the row.
- **The opened row is a drawer over the panel face** (`--bg-deep`): it interrupts the
  lanes, which is what a drawer physically does, and they resume below it.

- **Search (`.pnl-search`) looks everywhere**, not just the section showing: you rarely
  know which section a server ended up in. It matches name, Cockpit's definition and the
  kind. While searching, the pills dim (`.pnl-tabs.searching`) — they aren't filtering
  any more, and pretending otherwise would be a lie.
- In any view that mixes kinds (search, Needs you) each row carries a `.pnl-kind` tag.
  Single-section views never do — the pill above already said it.
- **One row per managed thing**: the name plus Cockpit's own definition in mono
  (`.pnl-def`) — that is what the switches write.

### The bank

The panel is drawn as an instrument bank, not a list of cards. This is the one place
in the app that renders a **lane**, and the pattern only earns its keep because the
data really is columnar — one entry, three agents, read top to bottom.

- **One surface, hairline-separated.** `.pnl-table` is a single `--surface` panel with
  a border and `overflow: hidden`; rows are divided by a 1px `--border` rule. Never go
  back to per-row bordered pills with gaps — the gaps break the lanes, which is the
  whole point.
- **Three lanes**, one per agent, washed at `rgba(var(--*-rgb), 0.05)` and divided by a
  hairline, running the full height of the bank. The header row is their **cap**, not a
  label floating above them: `--bg-deep`, `--border-strong` bottom rule, and the same
  lane washes at 0.09. The far-right lane is capped `State`.
- **Rows keep one height** (32px) no matter how many disagreements are lit. A bank of
  switches that jogs as states change is unreadable, which is why the drift caption
  left the lane.
- **Drift reads in one slot.** `.pnl-flag` placards sit in the row's right-hand lane —
  agent name at 0.75 opacity plus the state word — and the row takes a 2px amber
  `inset` stripe on its left edge. A placarded switch, not a shouting box: never put a
  full warn border on the row.
- The switch keeps a warn ring so you can still tell *which* lane; a write in flight is
  a small pulsing accent lamp in the corner of its lane (`.pnl-lamp`), never a caption
  that would shift the row.
- **The opened row insets into the bank** (`--bg-deep` with an inset top rule) rather
  than floating below it as a separate card.
- **One column header for the whole panel**, not per group: every section shares the
  `.pnl-row` grid, and each switch carries its agent's identity color, so repeating the
  header five times would be five rows of the same thing. The grid is *not* a table in
  the a11y tree — the header sits outside it, and each switch's `aria-label`
  ("`<name>` in `<Agent>`") is the real label. Only the diff is a real `<table>`.
- **The switch (`.sw`)** is a 32×18 rocker: off = `--bg-deep` track, grey nub left; on =
  the agent's own tint with a solid agent-colored nub right. **The nub does not
  animate** — a cockpit rocker snaps, and transforms aren't on this system's transition
  list anyway; only the track's color travels.
- **The lamp (`.pnl-lamp`)** is dark unless the agent disagrees with its switch, then
  amber and specific: `not applied` (on, but the agent hasn't got it), `differs` (on,
  but the agent has another definition), `added outside` (off, yet the agent has it).
  The switch takes a warn ring, the row a warn border, and a `.pnl-alert` `!` opens it.
  Never show a lamp for an agent that *can't* hold the entry — that's `na`, a dim `—`
  with the reason in its title.
- **Two safety lines.** Flipping a switch is one click, because it is reversible: off
  takes the entry out of that agent and Cockpit keeps it. The two that aren't cheap ask
  first, with the armed-confirm grammar (→ danger `remove?`, 4s / blur disarm): turning
  a **plugin or marketplace** off (it runs an uninstall), and **Remove everywhere**
  inside the row detail (it takes the entry out of every agent and forgets it).
- **The row detail** leads with a **Cockpit** column (`.pnl-src`, accent, accent inset
  rule), then one column per agent that has it. Cockpit is the source of truth, not one
  opinion among four. Rows nobody fills in are dropped; a field an agent doesn't record
  reads `not recorded`, never as a difference. Env var **values are never shown or
  compared** — only names.
- **Every disagreement gets its own `.pnl-fix` block**: a plain sentence naming what
  happened, and the only two honest answers — "Write Cockpit's version" (push) or "Take
  this agent's version" (pull). Adopt is hidden when the agent has nothing to take.
- Actions never guess: each one resolves with the freshly reconciled scope, and a
  failure restores the real state and says what went wrong.

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
