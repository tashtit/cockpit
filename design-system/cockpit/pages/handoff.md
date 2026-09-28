# Handoff (`HandoffView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** focused form card (`.ns-card` inside `.chat.new-session-view`, headed
"Continue in another agent") that continues the open session with another agent: a
**new** session in the source's own directory, on its branch, whose first prompt is a
briefing built from the source's transcript. The deliberate difference from New session:
no repo, branch or task fields — the workspace already exists, and the briefing is the
task. Reached from the chat header's `Continue in…` key (`.btn-handoff`, `HandoffIcon`),
shown once the session has a native id and never on a roundtable seat, and from the
*Continue it with another agent…* link a session gets when no ACP agent drives its agent.
Opening refuses while a turn is in flight; Escape and Cancel back out to the chat.

## Form grammar

Top to bottom — the source, then who continues it, then what they are told:

- **From** — `.handoff-source`, one row: the source agent as an `.acct-chip.acct-{agent}`
  with its logo, the title (`.handoff-source-title`, one line, ellipsis, the whole title in
  its tooltip) and its `BranchChip`. Under it an `.ns-hint` says the consequence in words —
  same worktree, same branch, no new workspace — naming the directory as `.handoff-cwd`:
  mono, selectable, home collapsed to `~` (`shortPath`), the absolute path in the tooltip.
- **Continue with** — the New session form's own pieces (`agent-options.tsx`: `AgentCards`,
  `AccountField`, `AgentOptionsFields`, `ModeField`, `ModeHint`, `AgentOptionsHints`), so
  the two forms can't drift; see `pages/new-session.md` for the cards and the option grid.
  It opens on the first of the three CLIs that is not the source's agent — continuing on the
  same one is allowed, but the point is usually the switch. Account shows only for a CLI
  Cockpit drives; an agent an ACP agent drives gets no Account, Model or Thinking, starts
  with empty options, and its hint says its model and account are its own.
- **Briefing** — `.handoff-brief-head` (the label, then its controls) over a 12-row
  `textarea.handoff-brief` at `--fs-sm`/1.5. The briefing is built in main (`getHandoffBriefing`, `handoff-core.ts`)
  and keeps absolute paths — the agent reads it, and never gets a `~`. While it builds, the
  textarea is disabled with *Building briefing…* as its placeholder.
  - `Improve with AI` (`.btn-ghost.small`) asks the source session to write its own
    briefing, which resumes it in its own CLI — so it shows only when the source's agent is
    one Cockpit drives. It reads *Asking <Agent>…* and disables the editor while it runs.
  - A rewrite keeps the text it replaced: `Revert to extracted` (`.link-btn`) appears beside
    the label and puts it back.
- Under the briefing, in order: a failed build as an `ErrorAlert` in main's words
  (`ipcErrorText`) with a **Retry** link — the editor stays usable, a briefing can be written
  by hand; main's warnings as `.ns-hint`s; and, when the source's directory is gone, an
  `ErrorAlert` saying a handoff needs it.
- **What should the agent do next** — an optional 3-row textarea; ⌘Enter starts from it.
  When filled, it is appended to the briefing under a `## What to do next` heading.
- `.ns-actions`, right-aligned: ghost Cancel, primary `Continue in <Agent>` (*Starting…*
  while it starts). A failed start shows its reason in an `ErrorAlert` above them.

## Invariants

- Start is disabled while the briefing builds or is being improved, while it is empty, when
  the source's directory is gone, and when the chosen model provider needs a model that is
  not picked (`modelMissing`).
- Starting remembers the agent, mode and account through `rememberChoice` (`agent-choice.ts`),
  the one memory Home and New session share.
- The new session opens in the chat as a conversation Cockpit started: a system row
  (*Continuing from <Agent> in <dir> — same worktree, same branch.*), then the briefing as
  the person's first message; the chat header's lineage chip (`from <Agent>`) leads back to
  the source, and the sidebar threads the source under its continuation.
- A failed Improve keeps the current text and says *Improve failed: …*; nothing the person
  typed is ever lost to a failed call.
- The tour shoots it from a Copilot session and from a Gemini CLI one (`handoff`,
  `handoff-from-gemini`, desktop size only — it is not in the floor audit);
  `a11y.spec.ts` audits it.
