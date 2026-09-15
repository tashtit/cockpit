# Chat — Session View (`ChatView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** transcript reader for agent sessions. Optimized for scanning long agent
output: assistant prose is the wide column, tool noise collapses to one-liners, user
turns are compact right-aligned bubbles.

## Header (`.chat-header`)

Identity + situation in one row, left to right:
solid agent `.badge` · `.acct-chip` ("running as" — shows the identity's local part,
full identity in the tooltip; shed entirely ≤780px) · title + sub (branch chip, clickable
cwd that copies its path — displayed `~`-abbreviated via `shortPath`, the full path in the
tooltip — and "· not started" when no native session yet) · PR affordance · `Changes` ·
`Continue in…`.
Header min-height is 52px — it's the drag region, keep it a real grab target.

- **The header is identity, never settings.** The permission mode lives in the composer
  (see below); a header that also carried it lost the session title entirely at the
  560px floor.
- **Labels shed to their marks before the title truncates** — ≤780px the `Changes` and
  `Continue in…` keys fold to 28px squares (`.lbl` hidden; `DiffIcon`/`HandoffIcon`
  stay, each with an `aria-label`), and an open PR's badge drops its state word
  (`.pr-word`) to keep the number beside its checks glyph and review mark — the state
  stays in the badge's `aria-label` and tooltip; ≤700px the agent badge drops
  `.badge-text` to its titled mark. The title is the one thing the header exists to
  say; it must survive the minimum window.

- The PR slot is exclusive: a `PrBadge` when the branch has a PR, else green `.btn-pr`
  "Create PR" (GitHub merge-button semantics), else nothing. Never both.
- Header is a window drag region; every interactive child opts out (`no-drag`), and the
  cwd/branch subtitle is selectable text.

## The conversation column

- The exchange reads in a centered column: `.messages` and `.composer` share
  symmetric `padding-inline: max(floor, calc((100% - var(--chat-col)) / 2))`, so on
  large displays user bubbles stay right-aligned *within the column*, next to the
  replies — never stranded at the window edge.
- `--chat-col` comes from the user's **Chat width** preference (Settings → Display:
  narrow 680 / comfortable 860 (default) / wide 1120 / full). It lives in
  `chat-width.ts` — a localStorage-backed `useSyncExternalStore` store, so an open
  chat re-columns live when Settings changes it. The header stays full-width on
  purpose (it is chrome, not reading material).

## Transcript (`.messages`)

- Row vocabulary — do not invent new message shapes:
  - user → `.bubble-user` right-aligned, accent tint, `max-width: min(74%, 60ch)`
  - assistant → avatar + `.markdown` body, `max-width: min(85%, 76ch)`; `.streaming`
    shows the accent left border; `.reasoning` dims + italicizes
  - tool call → `.tool-row` collapsed `<details>`: gear chip + mono 120-char preview —
    the humanized headline (`SessionMessage.preview`: Bash command, Edit/Read/Write path,
    Copilot's `bash`/`edit`/`create` too, from `toolPreview()` in main) when available,
    else the raw input. **The result that answers a call folds into the call's row**: its
    first line rides the right of the summary as the verdict (`.tool-peek`, "20 passed"),
    and expanding shows the raw input over the full output (`.tool-full` then
    `.tool-full.tool-out`, 260px max each). A call and its result are one event — two
    rows per tool call doubled the noise. Only an orphan result gets its own `↳` row.
  - paths under the session's cwd render relative to it (`Message`'s `cwd` prop) — the
    header already names the directory
  - system → `.sys-row` dotted-left-border annotation, aligned with the assistant column
- Tool/system glyphs are text-presentation unicode (`⚙︎` with U+FE0E, `↳`) — if these
  ever grow, switch to SVGs from `logos.tsx`; never bare emoji-presentation glyphs.
- **DOM bound:** only the last `RENDER_LAST` (400) messages render, with an explicit
  `(showing the last N of M messages)` sys-row. Keep both when touching this.
- Consecutive duplicate system notices are filtered — providers repeat them.
- `Message` is memoized; keys are absolute log offsets (`log.length - visible.length + i`),
  stable because the log is append-only. Don't "fix" this to item ids or bare indexes.
- Auto-scroll pins to bottom on new messages/busy; busy shows `.pulse` +
  "<Agent> is working…" — the `.thinking` line renders in the placard register
  (mono uppercase annunciator; the transform is CSS, the DOM text stays sentence
  case for screen readers).
- Assistant avatars carry a quiet livery ring (`.avatar.plogo-*` border tint) — the
  authoring agent reads at a glance without leaving the rest-intensity tint range.
- `.messages > * { flex-shrink: 0 }` is load-bearing: without it, flex children shrink
  toward min-content before the container scrolls, and tool-rows (`overflow: hidden`)
  compress to unreadable slivers in long transcripts. Any new scrollable column flex
  container needs the same guard.
- Code blocks get a hover/focus Copy button; highlight.js tokens map to app palette
  variables — no imported highlight theme.

## Review (`ReviewPanel.tsx`, `.review`)

The **Changes** key in the header (`.btn-review`, ⌘D) swaps the transcript for the
worktree's changes — the review before the PR. The composer stays: notes go to the
agent through it. Offered only when the session has a repository and takes input;
a seat session's tree belongs to its table. The key is `aria-pressed` while the
review is open and sheds its word (`.lbl`) ≤780px, keeping the diff glyph
(`DiffIcon`, the octicon +/−).

- `.review` sits in the transcript's column (same `padding-inline` recipe as
  `.messages`, `scrollbar-gutter: stable`, `flex-shrink: 0` children).
- `.review-bar`: the scope switch (`.idiff-layout` grammar — **Branch** = everything
  since the base branch, what a PR would carry; **Staged**; **Unstaged** = working-tree
  edits plus untracked files) · `.review-sum` in the mono readout voice (`DiffStat`,
  file count, `N ahead, M behind origin/main`, a warn `uncommitted changes` when
  Create PR would refuse) · right: **Send N notes to <Agent>** (`.btn-ghost.small`,
  only once a note exists), refresh (`.icon-btn.small`), `DiffLayoutToggle`. Every
  control in the row is 24px.
- Files are `<details class="idiff review-file">` blocks in an `.idiff-list`, open by
  default (binaries closed), each summary drawing its own ▸: `.idiff-path`
  (`old → new` for renames) · `.review-kind` pill only when the file is not a plain
  modification (`added` ok / `deleted` danger / `untracked` warn / `renamed`,
  `binary` dim — the instructions status pill's grammar) · `DiffStat`.
- Inside: the instructions review's line grammar (`.idiff-line` add/del washes,
  context in `--fg-dim`, `+`/`−` gutter, `sr-only` "added:"/"removed:") plus two
  `.idiff-no` line-number columns (old, new; one per side in split) and a hunk rail
  (`.idiff-rail.review-hunk`, git's `@@` range and context). Rows are 24px so the
  note key is a real target. Unified | Split follows the app-wide diff preference.
  A capped file ends in an `.idiff-band` naming the real total; a capped listing ends
  in one naming the files not shown.
- **Notes** (`.review-note-btn`, the `+` that appears on hover/focus at the row's
  left edge; removed lines are addressed on the old side, everything else on the
  new): opens a `.review-note` editor under the line (sans — the reviewer's prose,
  not code; Enter keeps, Esc discards), kept notes stay as accent-tinted rows with
  Edit / Remove. **Send** formats them as one message (`formatNotes`: path:line,
  the quoted line, the note) into the composer, appended to any draft, and focuses
  it — the reviewer gets the last word before it goes.
- Reloads on scope change, on refresh, and whenever a running turn settles (never
  mid-turn — the tree is changing under the reader). Errors from main render as a
  `.review-error` alert, unwrapped.

### The open PR (`PrStrip.tsx`, `.review-pr`)

When the branch has an **open** PR (merged/closed: nothing — the header badge already
says so), the review leads with it, framed like the file list below:

- `.review-pr-head`: `PrBadge` · `.review-sum` readout, each word in its tone
  (`2 of 7 checks failing` danger / `3 of 7 checks running` warn / `7 checks passed`
  ok / `no checks` dim · `changes requested` danger · `N unresolved threads` warn ·
  `conflicts with main` danger — separated by silent middle dots) · **Fix with <Agent>** (`.btn-ghost.small`, only when
  something is actionable — `needsFix` in `src/shared/pr-feedback.ts`, the same verdict
  main's prompt uses; disabled mid-turn; "Gathering what failed…" with a pulse while main
  reads the logs).
- `.review-pr-list`: one 28px row per failing check (`.review-kind.tone-danger` state
  word — failed / timed out / cancelled — · mono name · dim workflow), per change request
  (`changes` · @author · one-line excerpt) and per unresolved thread (`thread` warn /
  `outdated` dim · `path:line` · @author · excerpt), each ending in a 24px
  external-link key; five per kind, then "N more on GitHub". ≤780px the excerpts and
  authors shed first.
- **Fix** puts one prompt in the composer (never sends it): conflicts, failing checks
  with their failed step's output, change requests, threads — built in main
  (`pr-feedback-core.ts`), capped per section. What it couldn't include (an unreadable
  log) shows as a warn `.review-pr-notice`.
- Read on demand (panel open, refresh, a turn settling) — never polled.

### Reviewers' threads (`.review-thread`)

In the **Branch** scope only (the index's line numbers are not the PR's), each
unresolved thread renders under the line GitHub anchored it to — LEFT side under the
removed line, RIGHT under the added or context line: every comment as `@author` (mono,
dim) + body (sans, pre-wrap), "N more replies", Open on GitHub. Quiet `--bg2` surface
with a 2px warn inset bar (still open); read-only — the reviewer's words, not the
user's. The file head counts the threads it shows (`.review-kind.tone-warn`); outdated
threads have no line and live in the strip's list only.

## Composer

- Textarea: Enter sends, Shift+Enter newlines (stated in the placeholder),
  `field-sizing: content` between 2.4lh and 12lh. Focus lands here whenever a session
  opens or starts.
- The permission mode `Select` sits between the textarea and the action button — it
  governs the *next* turn, so it lives beside the button that sends it (Home's composer
  bar grammar). Persists to `cockpit:mode`; hints in `title`, labels one word. A
  read-only seat session renders neither.
- A session started from a typed task shows that task as its title (`taskTitle`) until
  the index catches up, and its worktree branch is cut from it (`branchHint` in
  `task-names.ts`: first meaningful words → `cockpit/add-changelog-entry-retry-fix`,
  never an opaque `cockpit/ws-…` unless the task has no words).
- The action button swaps in place: `.btn-primary` Send ↔ `.btn-danger` Stop while busy —
  same slot, no layout shift.
- Pasting an image attaches it: a full-width `.composer-attach` chip row appears above
  the textarea, one `.attach-chip` (24px thumbnail + name + × remove) per image, save
  failures as an inline `.attach-error`. Chips clear on send and on session switch; a
  message may be images-only. Attached paths ride `ChatRequest.images` and reach the
  agent as file references appended to the prompt. The mechanics live in
  `attachments.tsx` (`useImageAttachments` + `AttachRow`) and are shared with the home
  quick composer and the New-session form — never reimplement them per view.

## Accessibility

- One `sr-only` `role="status" aria-live="polite"` region announces turn completion or
  failure — never per streamed token. Keep announcements at that granularity.
- Avatar SVGs are `aria-hidden`; the textarea carries `aria-label="Message <Agent>"`.
