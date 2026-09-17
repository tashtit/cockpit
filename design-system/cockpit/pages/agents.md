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
- ≤700px the search box drops to its own full-width line under the scope switch — beside
  Global and a project picker it was a 16px sliver at the window floor.
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
- **The section blurb says what the chips do.** Every switchable section's `.pnl-blurb`
  ends "Click an agent to switch it on or off there." — the chips are self-labelling but
  not self-explaining, and a first visit has no other legend. Needs you says what it
  holds and what to do ("Open a row to settle it"). A pill's count is left off at zero:
  "Instructions 0" as the only pill on a first run reads like a fault. Arrow keys walk
  the pills.
- **The agent chip (`.ag-chip`) is the signature**: the app's own identity colours doing
  the labelling. Each control says its own agent's name, so the list needs no column
  header, no lane, and no legend — "who runs this" reads as three brand-coloured tokens.
  On = agent tint + solid agent border + full-opacity mark; off = deep paper, dim mark;
  not applicable (`.na`, a kind the agent has no switch for) = dashed border, legible
  `--fg-dim` name, an `sr-only` "not available — <reason>" and the reason as `title` —
  never opacity on the text, which is how it once sat at 1.6:1 with a hover-only
  explanation.
  - Drift adds an amber border **and must out-specify the agent colours**
    (`.ag-chip.on.drift`, not `.ag-chip.drift`) — `.ag-chip.on.ag-*` is 0,3,0 and silently
    wins otherwise, which is exactly how the warning went missing once already.
- **One word per row** (`.pnl-flag`, amber, right-aligned): the ringed chip already says
  *which* agent, so the row only has to say *what* — `not applied` / `differs` /
  `added outside`.
- **Two safety lines.** Flipping a chip is one click, because it is reversible. Turning a
  plugin or marketplace off, and "Remove everywhere", use the armed-confirm grammar.
- **Disagreement has no house answer.** The detail asks which agent is right and offers
  one button per holder ("Use Claude's") plus the honest third answer, **"Keep as they
  are"**: the agents are meant to differ. Never add a "use Cockpit's version" button —
  Cockpit keeps a backup, not a version.
- **A kept difference is settled, not muted.** "Keep as they are" remembers, per
  differing agent, the fingerprint of the definition on screen (`LibraryEntry.kept`,
  `fieldsKey`); the row's flag, amber ring and Needs you entry go away, and the detail
  shows a quiet `.pnl-kept` line — "Copilot runs its own github on purpose." with a
  `link-btn` "Treat as drift again". The moment that agent runs something else the
  fingerprint no longer matches and it is `differs` again — a warning the user can
  clear, never one they can only silence. Matching every agent to one definition, or
  switching a kept agent off, forgets the kept difference.
- **Remove everywhere is recoverable**, under a `Removed` section with *Put it back*.
- Rows are a plain hairline-separated list on one surface (`.pnl-list`). No grid, no
  column rules, no lanes: with self-labelling controls there is nothing left to align to.
- **Narrow windows (≤780px) reflow the row, they don't shrink it.** Three self-labelling
  chips plus a name plus a flag stop fitting one line right about there. The dimmed
  provenance tags shed first — `.pnl-def`, then `.pnl-kind` (both are `nowrap` and
  unshrinkable, so left in they paint straight over `.pnl-flag`; the section pill above
  already says what a cross-section row is). Then `.pnl-chips` drops to a second line
  beneath the title — `flex-basis: 100%` forces the break, `order: 1` keeps `.pnl-flag`
  up on the title's line instead of wrapping to a third. Only once both tags are gone
  does an unusually long `.pnl-title` ellipsise: shed decoration first, truncate last.
  Never solve this by squeezing `.pnl-entry` — at the 560px floor it collapses to the
  caret and the title spills over the chips. Rules live with the other shed media
  queries at the end of `style.css`.

## Instructions tab

- **Mental model shown to the user:** one shared baseline, fanned out into each agent's
  *native* file inside `<!-- agent-parity:shared:start/end -->` markers — the pair the
  agent-parity plugin writes, so the two tools manage one block rather than one each.
  Content outside the markers belongs to the agent and is never touched. The hint states
  this explicitly, and says that the older `cockpit:shared` pair is read as the same block
  and renamed on the next apply.
- **Scope comes from the card**, never from a second selector inside the tab. Global
  targets the agent home files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.copilot/copilot-instructions.md`); a project scope targets `<root>/CLAUDE.md` +
  `<root>/AGENTS.md` — one AGENTS.md row carries both the Codex *and* Copilot logos
  because both read it natively. Never render a third copilot-specific file in repo scope.
  A `CLAUDE.md` that is a symlink to `AGENTS.md`, or imports it with `@AGENTS.md` and has
  no block of its own, gets no row: Claude's logo joins the AGENTS.md row and an
  `.inst-via` note after the status pill says why ("CLAUDE.md imports this file" /
  "CLAUDE.md links here"), in the row and in its `InstructionDiff` head alike. Writing
  that file too would have Claude load the text twice.
- **Baseline editor**: the baseline is markdown, so it edits like markdown —
  GitHub-comment grammar. `.md-tabs` (Write | Preview, `aria-pressed` toggles) over a
  shared frame: Write = `.inst-baseline` mono textarea on the code-block paper
  (`--bg-deep`, 220px min); Preview = `.inst-preview.markdown` rendering the draft
  through the shared `Markdown` component (`Markdown.tsx` — the same pipeline as chat
  transcripts, so the two surfaces can't drift). Both states share the exact frame —
  toggling never shifts the card. Two actions, right-aligned: ghost "Save" (baseline
  only, enabled when dirty) and primary "Save & apply to all". Dirty state =
  `.inst-dirty` warn-colored "unsaved changes" pinned left of the buttons.
- **Sharing is a PR, and only in a repo scope**: a third action, ghost "Save & open PR"
  (disabled label "Opening PR…" while busy), sits between Save and the primary — a repo's
  instructions belong in the repo, and a global baseline has nowhere to go, so the button
  is absent there. Its outcome is a `Notice` with a `link` (`link-btn` → `openExternal`,
  "Open pull request"), never a bare URL in prose; a failure shows the git or `gh` message
  verbatim, because "permission denied" is already the whole explanation.
- **Drift runs both ways**: a `drifted` file may hold a teammate's merged update that
  arrived with a pull, so every drifted row carries a `link-btn` "use this file's version"
  beside *see changes* (and beside the apply button in the panel's `.idiff-list`) whose
  `aria-label` names the file. Never offer it on a synced row — there is nothing to take.
- **Changes tab** (`.inst-changes`) — the PR's own third tab, and the review before
  the write. Same frame as Write/Preview (edge to edge, `padding: 0`), a one-line
  total (`.inst-changes-sum`: "Writes 2 of 3 files", a `DiffStat`, and the
  warn-coloured "comparing with your unsaved draft" when the editor is dirty), then
  one `InstructionDiff` block per agent file. The tab's own count (`.md-tab-n`, mono)
  is the number of files an apply would write; an empty draft shows the Preview's
  empty-state line instead. The comparison is always against the **draft** — the text
  about to be written — never the stored status, so a file "in sync" with the saved
  baseline reads "rewrites block" the moment the draft differs.
- **`InstructionDiff`** (`.idiff`) — the review's unit, drawn the way the contract
  reads: the agent's own lines folded into counted **bands** (`.idiff-band`,
  "12 lines outside the markers stay as they are"), two **marker rails**
  (`.idiff-rail`, the real `<!-- agent-parity:shared:start/end -->` text with a dashed
  hairline), and the shared block diffed between them. A file holding the block twice —
  one copy per marker spelling — gets a third band under the closing rail, "a second copy
  of the block is dropped", in the band's voice: a fact about the write, not a diff line. Inside the rails it is
  GitHub's line grammar — `+`/`−` gutter, `rgba(--ok-rgb, 0.12)` / `rgba(--danger-rgb,
  0.12)` washes, context lines in `--fg-dim` — because that is the diff every user
  here already reads; the rails and bands are the part that is Cockpit's. Quiet
  stretches of three lines or more fold into an accent-tinted `.idiff-fold` button
  ("⋯ 8 unchanged lines", 24px, `aria-expanded`); two lines of context stay around
  every change. The head reuses the file-row vocabulary — logos, `.idiff-path`,
  `DiffStat`, an `.inst-status` pill re-worded as the verb of the write (`no changes` /
  `rewrites block` / `adds block` / `creates file`) — and carries the agent tint
  (`.tint-*`; `.plain` for the two-agent AGENTS.md). Added/removed lines carry an
  `sr-only` "added:"/"removed:" so colour and glyph never carry the state alone.
  Line text wraps (`pre-wrap` + `overflow-wrap: anywhere`): the review never scrolls
  sideways, at any width.
  - **Unified | Split** (`DiffLayoutToggle`, `.idiff-layout`): one segmented pair in the
    scope switch's grammar at 24px, one choice for every diff in the app, remembered in
    localStorage (`diff-layout.ts`, `cockpit:diff-layout`). Split lays the n-th removed
    line across from the n-th added one (`.idiff-pair`, two `minmax(0,1fr)` columns with a
    hairline between); a change with no counterpart leaves a `--surface` blank cell rather
    than sliding the column; context, folds, bands and rails span both sides. The toggle
    sits at the right of `.inst-changes-sum` (with the dirty note, in
    `.inst-changes-right`) and above the panel's `.idiff-list` (`.idiff-tools`), and is
    absent when nothing would be written.
- **The panel's instructions row** opens to the same blocks (`.idiff-list`, framed)
  against the *saved* baseline, each non-synced file with its own ghost-small apply
  button — the field table the other kinds get would only list file paths here.
- **In its own section the row is not repeated.** The editor above already is that row,
  opened — same files, same drift, same diffs — so the Instructions section keeps only
  what the editor lacks: one `.pnl-sync` line, "Kept in sync for" and the row's
  `AgentSwitches` (whose file takes part in the baseline). The full row still appears in
  Needs you and in search results, where it has no editor beside it.
- **File rows** reuse `.ext-row`: agent logo(s) left, `~`-abbreviated mono path
  (`user-select: text`), then an `.inst-status` pill:
  - `in sync` (ok green) — managed block matches baseline; no action button.
  - `out of date` (warn) — block differs (stale or hand-edited) → "Re-apply".
  - `not applied` (dim) — file exists, no block → "Apply".
  - `no file yet` (dim italic) — → "Create & apply". Applying creates parent dirs.
  Apply buttons are ghost-small and disabled (with a title explaining why) while the
  saved baseline is empty; while the draft is dirty their title says they write the
  *saved* baseline. Every non-synced row also carries a `see changes` link-button
  (`.inst-see`) that switches to the Changes tab and focuses that file's block.
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
