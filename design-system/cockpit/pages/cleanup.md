# Cleanup — page rules

> Overrides `MASTER.md` where they disagree. Read that first.

**Route:** rail nav (trash mark) · `⌘K → "Cleanup"` · `View = { kind: 'cleanup' }`
**Shell:** `.ns-card` inside `.chat.settings-view` — the shared card width
(`min(760px, 94%)`), like Settings, Agents and Profile. Never give it its own width.

## What this view is

The one place that answers *"what has gone quiet, and what can safely go?"* across
every agent and every repository. Three ideas hold it together:

- **The unit is a piece of work, not a file.** A session and the worktree it ran in
  are one thing: the worktree rides on its session's row (`.cl-carry` — "takes its
  worktree · 412 MB") and goes with it. The second list is only the leftovers.
  Every worktree appears exactly once across the view — never in both places.
- **Two tiers, never blurred.** Archive is reversible Cockpit config that frees
  nothing — a plain `.btn-ghost`. Delete is not — `.btn-ghost.danger` arming into
  `.btn-danger` (the `useArmedConfirm` hook, shared with `ConfirmRemove`). Nothing
  destructive is ever one click, and the armed label names the count.
- **Blocks are shown, never overridden.** A row that can't be cleaned renders its
  reason in words (`.cl-block`, warn-toned italic) and disables its checkbox. There
  is no force affordance anywhere in this view — if git or the index objects, that
  is the answer.

Rows arrive pre-judged from main (`cleanup.ts`); the view only lets the user choose
among what it was handed. Don't add renderer-side staleness or safety logic here.

## Component vocabulary

New to this page — reuse rather than re-inventing:

| Class | Meaning |
|---|---|
| `.cl-row` | one disposable thing; the `.source-row` shell at 42px, with a leading picker |
| `.cl-row.picked` | selected — accent border + wash, so agent-tinted rows keep their inset bar |
| `.cl-pick` | the row's checkbox, `accent-color: var(--accent)`; disabled when blocked |
| `.cl-head` | sticky group head: master toggle, what is selected and what it frees, actions |
| `.cl-carry` | what this row takes with it (the worktree), branch-blue |
| `.cl-shared` | that worktree hosts other sessions — warn-toned, it only goes when all do |
| `.cl-origin` | where a worktree came from — `cockpit` (accent) vs `external` (dim) |
| `.cl-block` | why it can't be cleaned, in words, `--warn` |
| `.cl-tag` | neutral state word (`archived`, `directory gone`) — quieter than a block |
| `.cl-hidden` | selected rows the current filter is hiding — disclosed, never silent |

Reused as-is: `FilterBar` (see below), `.source-list` (row stack), `.tint-{agent}` on
session rows, `BranchChip`, `.repo-count`, `.ns-card`/`.ns-label`/`.ns-hint`.

## Filtering — the `FilterBar` contract

Both lists use the shared `FilterBar`; this page is its reference implementation.

- **Free text sits leftmost**, divided from the pills by a `.fb-divider` hairline. It
  narrows the same list but is not a dimension, so it never becomes a pill.
- **One pill per dimension**, and the pill *is* the active-filter chip. Never add a
  second row of "active filters" tokens — the summary (`Any` → `web` → `not docs` →
  `2 selected, 1 excluded`) is the whole disclosure.
- **Every option can be excluded**, through a quiet `.fb-option-ex` revealed on row
  hover or focus. Excluded values render `line-through`, never colour alone.
- **Dimension values come from the rows themselves** (`presentOptions`), so a pill
  never offers a value that would match nothing.
- **A dimension carrying a value stays on the bar** whether pinned or not — the bar
  must never hide something that is shaping the list.

## Selection rules

- The `.cl-head` master checkbox acts on **the filtered rows only**. "Filter, then
  select all" is the point of the bar; a select-all that reached hidden rows would
  make it a trap.
- **Shift extends from the last row touched**, mouse or keyboard. Read the anchor
  before calling the state setter — inside the updater it is already the new row and
  every range collapses to one.
- Blocked rows are unselectable by every path: click, range, and master toggle.
- Selections survive a filter change, and the head discloses what it is holding
  off-screen (`3 not shown`). Never act on a hidden selection without saying so.
- The head totals what the selection actually frees, worktrees included — and counts
  a shared worktree only once every session in it is picked, matching main's rule.
  The number beside a destructive button has to be the truth.

## Rules specific to this page

- **Session rows carry agent identity** (`.tint-{provider}` + `ProviderLogo`); worktree
  rows carry **repo** identity (`RepoIcon`) — a worktree belongs to a repository, not
  to an agent, and tinting it by agent would be a lie.
- **Sizes are tabular** (`.cl-size`), `—` when unmeasurable, never `0`. One decimal at
  most and never a bare `.0`: "400 MB", not "400.0 MB".
- **Ages are coarse** (`idle 47d` → `idle 8mo` → `idle 1.4y`). This view is about
  abandonment, not recency; minute precision would be false confidence.
- **The row list is a window, not the truth.** Main caps rows (`CLEANUP_ROW_CAP`);
  when it does, say so with the real total. Never present a capped list as complete.
- **Report the outcome after the rescan, not before.** Every action re-scans, and the
  scan clears the previous error on purpose — a refusal set before it would be wiped
  off the screen. Status goes to the `aria-live` summary line, refusals to
  `.new-error` with `role="alert"`.

## Checklist additions

- [ ] Every destructive control is two-step and names the count it will act on
- [ ] Every blocked row states its reason in words, and its picker is disabled
- [ ] Select-all reaches exactly the filtered, unblocked rows — no more, no less
- [ ] A row that takes something else with it says so before the click, not after
- [ ] Empty states are sentences ("every checkout is still in use"), not blank space
