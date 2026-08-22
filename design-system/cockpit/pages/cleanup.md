# Cleanup — page rules

> Overrides `MASTER.md` where they disagree. Read that first.

**Route:** rail nav (trash mark) · `⌘K → "Cleanup"` · `View = { kind: 'cleanup' }`
**Shell:** `.ns-card` inside `.chat.settings-view` — the shared card width
(`min(760px, 94%)`), like Settings, Agents and Profile. Never give it its own width.

## What this view is

The one place that answers *"what has gone quiet, and what can safely go?"* across
every agent and every repository. It is a **disposal surface**, so its whole visual
job is to make consequence legible before a click, not after:

- **Two tiers, never blurred.** Archiving is reversible Cockpit config — a plain
  `.btn-ghost`. Deleting log files and removing worktrees are not — `.btn-ghost.danger`
  that arms into `.btn-danger` on first click (the `useArmedConfirm` hook, shared with
  `ConfirmRemove`). Nothing destructive is ever one click.
- **Blocks are shown, never overridden.** A row that can't be cleaned renders its
  reason in words (`.cl-block`, warn-toned italic) and disables its checkbox. There is
  no force affordance anywhere in this view — if git or the index objects, that is the
  answer.
- **Rows arrive pre-judged.** Main decides what is stale and what is safe
  (`cleanup.ts`); the view only lets the user choose among what it was handed. Don't
  add renderer-side staleness or safety logic here.

## Component vocabulary

New to this page — reuse rather than re-inventing:

| Class | Meaning |
|---|---|
| `.cl-row` | one disposable thing; the `.source-row` shell at 42px, with a leading picker |
| `.cl-pick` | the row's checkbox, `accent-color: var(--accent)`; disabled when blocked |
| `.cl-origin` | where a worktree came from — `cockpit` (accent) vs `external` (dim) |
| `.cl-block` | why it can't be cleaned, in words, `--warn` |
| `.cl-tag` | neutral state word (`archived`, `directory gone`) — quieter than a block |
| `.cl-unpushed` | commits no remote has, `--branch` |
| `.cl-path` | mono, `user-select: text` — paths are copied out of here |

Reused as-is: `.source-list` (row stack), `.tint-{agent}` on session rows,
`BranchChip`, `.repo-count` for session counts, `.ns-actions` for the button row.

## Rules specific to this page

- **Session rows carry agent identity** (`.tint-{provider}` + `ProviderLogo`); worktree
  rows carry **repo** identity (`RepoIcon`) — a worktree belongs to a repository, not to
  an agent, and tinting it by agent would be a lie.
- **`cockpit` vs `external` is the worktree list's most important column.** Cockpit
  cuts its own under userData; everything else (Claude Code's `.claude/worktrees`,
  hand-made ones) is found and cleanable but never assumed to be ours. Accent marks
  ours; dim marks everything else. Never hide the external ones.
- **Sizes are right-aligned tabular** (`.cl-size`, `font-variant-numeric: tabular-nums`)
  so a column of them scans. `—` when a size couldn't be measured — never `0`.
- **Ages are coarse** (`idle 47d` → `idle 8mo` → `idle 1.4y`). This view is about
  abandonment, not recency; minute precision would be false confidence.
- **The row list is a window, not the truth.** Main caps rows (`CLEANUP_ROW_CAP`);
  when it does, the view says so in a `.ns-hint` with the real total. Never present a
  capped list as complete.
- **Report the outcome after the rescan, not before.** Every action re-scans, and the
  scan clears the previous error on purpose — a refusal set before it would be wiped
  off the screen. Status goes to the `aria-live` summary line, refusals to `.new-error`
  with `role="alert"`.

## Checklist additions

- [ ] Every destructive control is two-step and says the count it will act on
- [ ] Every blocked row states its reason in words, and its picker is disabled
- [ ] "Select all" skips blocked rows — it must never arm something that will be refused
- [ ] Empty states are sentences, not blank space ("every checkout is still in use")
