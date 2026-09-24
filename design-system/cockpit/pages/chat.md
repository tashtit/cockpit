# Chat — Session View (`ChatView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** transcript reader for agent sessions. Optimized for scanning long agent
output: assistant prose is the wide column, tool noise collapses to one-liners, user
turns are compact right-aligned bubbles.

## Header (`.chat-header`)

Identity + situation in one row, left to right:
solid agent `.badge` · `.acct-chip` ("running as" — shows the identity's local part,
full identity in the tooltip; shed entirely ≤780px) · title + sub (lineage chips that open
the related session — `from <Agent>` for a handoff, `by <title>` (`.parent-chip`, which
gives way like the branch chip) for a session another session started — then branch chip, clickable
cwd that copies its full path — displayed via `cwdLabel`: a worktree as `worktree · <slug>`, or bare
`worktree` when the slug is the branch chip's own name (its location is only where a tool keeps
worktrees), anything else `~`-abbreviated; the full path is always in the tooltip — and "· not started" when no native session yet) · PR affordance · `Changes` ·
`Work` (only once the transcript carries a plan, to-dos or an edit) · `Continue in…`.
Header min-height is 52px — it's the drag region, keep it a real grab target.

- **The header is identity, never settings.** The permission mode lives in the composer
  (see below); a header that also carried it lost the session title entirely at the
  560px floor.
- **Labels shed to their marks before the title truncates** — ≤780px the `Changes`
  and `Continue in…` keys fold to 28px squares (`.lbl` hidden; `DiffIcon`/`HandoffIcon`
  stay, each with an `aria-label`). The `Work` key (`.btn-review.btn-work`) is that
  square at every width — `WorkIcon`, named by its `aria-label` and tooltip: a fourth
  label cost the title ~70px at 900px, and the rows are the way in. An open PR's badge drops its state word
  (`.pr-word`) to keep the number beside its checks glyph, unresolved-thread count
  (`.pr-threads`) and review mark — the state stays in the badge's `aria-label` and
  tooltip; ≤700px the agent badge drops
  `.badge-text` to its titled mark. The title is the one thing the header exists to
  say; it must survive the minimum window.
- **The branch chip gives way before the path, but never below six characters** —
  `.chat-sub .branch-chip` shrinks first (the full branch stays in its tooltip) with a
  floor of `calc(6ch + 27px)`, the 27px being the chip's own paddings, icon and gap:
  a floor measured on the chip alone left two characters, so `main` read `m…` beside a
  long path. In the header the chip may also grow to forty characters
  (`calc(40ch + 27px)`) — the 180px cap it wears in the board and the palette is a
  column width, and the header has no column, so a whole worktree branch shows where
  the row has the room.

- The PR slot is exclusive: a `PrBadge` when the branch has a PR, else green `.btn-pr`
  "Create PR" (GitHub merge-button semantics), else nothing. Never both.
- **Create PR is not offered on the branch a PR would target** — a session in the main
  checkout on `main` can only fail, because `gh` refuses a PR from a branch onto itself.
  The default comes from `getDefaultBranch` (git's own `origin/HEAD`, else the
  conventional name that exists on the remote); when git can't say, the button stays —
  a missing answer must never hide a working affordance.
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
    Copilot's `bash`/`edit`/`create` and Codex's `shell`/`exec_command`/`apply_patch` too — the script inside Codex's `bash -lc` wrapper, a patch named by the files it touches — from `toolPreview()`/`shellPreview()` in main, for saved history and the live stream alike) when available,
    else the raw input. **The result that answers a call folds into the call's row**: its
    first line rides the right of the summary as the verdict (`.tool-peek`, "20 passed"),
    and expanding shows the raw input over the full output (`.tool-full` then
    `.tool-full.tool-out`, 260px max each). A call and its result are one event — two
    rows per tool call doubled the noise. Only an orphan result gets its own `↳` row.
    **In a narrow row the verdict gives way to the command**: `.tool-row` is a
    `container: tool`, and under 400px of row (the floor, 200% zoom, a rail dragged
    wide) a peek longer than twelve characters collapses to zero width while a short
    one (`.tool-peek-short` — `ok`, `20 passed`) keeps its place; at 40% each, the
    command and the verdict were both twelve characters and neither could be read.
  - **a tool call that carries work → `.tool-row.tool-open`**, the same one-line
    grammar as one `<button>` instead of a `<details>`: chip · headline · `DiffStat` for
    an edit · `didn't apply` (warn, the word itself) for a failed call · the `WorkIcon`
    at the right edge, accent on hover. The headline is the artifact's own: a plan's
    title, `3 of 7 done`, the task it adds, the files an edit touched. A click opens the
    Work panel at that row (below); there is no raw JSON to expand — the panel is the
    detail. A blank 10px lead keeps its chip in line with the ▸ of the rows around it.
    Roundtables pass no `onOpenWork`, so their rows stay ordinary `.tool-row`s.
  - paths under the session's cwd render relative to it (`Message`'s `cwd` prop) — the
    header already names the directory
  - **four or more tool rows in a row fold into one `.tool-run`** — `⚙︎ work · 5 steps ·
    Bash ×2 · Read · Grep · Edit`, opening to the rows themselves (`foldToolRuns`,
    `runSummary`). A twelve-step run between two paragraphs buried the paragraphs. The
    fold breaks wherever the agent speaks, so prose is never swallowed, and the **tail
    run of a live turn never folds** — watching the steps arrive is the point while a
    turn runs. Earlier runs in that same turn still fold. A plan row never folds either:
    a plan is a message of its own, like the agent's prose.
  - system → `.sys-row` dotted-left-border annotation, aligned with the assistant column
  - **a question waiting on you → `.ask-card`** (`AskPicker.tsx`), the one tool call that
    never collapses: the agent's own options are the message, so a `⚙︎` one-liner would
    hide the point. Sits in the assistant column (`margin-left: 32px`, `min(85%, 76ch)`)
    wearing the agent's livery (`.tint-*`), led by the `asks you` placard with the same
    question glyph the "needs you" rows use. Each question is a `<fieldset>`: uppercase
    legend (the agent's `header`, else `Question N`), the question at `--fs-prose`, then
    full-width option rows — native radios, or checkboxes when the agent allowed several
    (`accent-color`, so the control is the OS's and the row is the target). A picked row
    takes the accent tint. **Send answer** is disabled until every question has a pick and
    while a turn runs; the note beside it says the pick sends as the next message, and
    sheds to its own line ≤700px. Only the *last* row qualifies, and only while nothing
    has answered it (`isPendingAsk` — a folded `tool_result` is the answer); an older
    question is history and renders as the ordinary tool row. A read-only seat session
    gets none: the table owns that conversation. Parsed in main
    (`src/shared/asks.ts` — Claude's `AskUserQuestion`/`ExitPlanMode`, Codex's
    `request_user_input`), never from the raw JSON in the renderer. **A plan gate shows
    the plan** above its two answers (`.ask-plan-body`: the plan's markdown on
    `--bg-deep`, 320px max, a named, focusable `role=region` so the keyboard can scroll
    it), with `Open in the Work panel` (`.btn-ghost.small`) under it — approving a title
    was approving something unread.
- Tool/system glyphs are text-presentation unicode (`⚙︎` with U+FE0E, `↳`) — if these
  ever grow, switch to SVGs from `logos.tsx`; never bare emoji-presentation glyphs.
- **DOM bound, with a way up:** only the last `RENDER_LAST` (400) messages render, and
  the sys-row that says so (`EarlierRow`, `transcript-window.tsx`: "showing the last
  400 of 1,200 messages · show 400 earlier") is the control that shows the next batch.
  Rows prepend above the viewport, so `useTranscriptWindow` re-adds the height that
  landed above the reader in a layout effect and `.messages` carries
  `overflow-anchor: none` — one adjustment, not the browser's and ours. The window
  resets when the conversation changes. Keep all of it when touching this.
- **A transcript-search hit opens at its message.** The palette hands the hit over as
  the chat's `anchor` (`TranscriptAnchor`, `chat-binding.ts`); once the log is in,
  `findAnchor` (`transcript-anchor.ts`) names the row by its words, speaker and time —
  never by index, since the searcher and the parser count messages differently — the
  window is raised to hold it with `ANCHOR_CONTEXT` rows above, it scrolls to the
  middle (`data-log-key` on every row is what finds it), wears `.anchored` — an accent
  halo, `ANCHOR_RING_MS` — and the `role=status` region says so. Applied once per
  anchor: the log keeps growing under a live session and must not re-scroll. Words the
  log no longer says open at the bottom as before.
- Consecutive duplicate system notices are filtered — providers repeat them.
- `Message` is memoized; keys are absolute log offsets (`log.length - visible.length + i`),
  stable because the log is append-only. Don't "fix" this to item ids or bare indexes.
- A session flying **elsewhere** (`busy.ts`: the observed entry, never Cockpit's own turn)
  is the same annunciator with different words — `.thinking` + `.pulse`, "Claude is working
  elsewhere…", `title` explaining why — and the transcript re-reads from disk as the index
  sees each write (App's `diskLogRef`), so the log grows under the reader as a turn of
  Cockpit's own would. Cockpit's own turn outranks it: one line, never two.
- **A way down for a reader who scrolled up:** the auto-scroll never hijacks a
  scroll-up, so rows arriving below are news — `useUnseenBelow` marks them the moment
  the log grows while the scroller is off the bottom, and `JumpToLatest` (`.jump-latest`,
  the transcript's last child: a sticky zero-height line whose `.btn-ghost.small` "New
  messages" key hangs above the bottom edge without moving a row) takes them there.
  Reaching the bottom by hand clears it. Hidden it is `visibility: hidden` and out of
  the tab order; the status region already announced the turn, so the key is the way
  there, not the announcement. Shared with the roundtable — never rebuild it per view.
- **The pin is per conversation, never per binding object.** App re-makes the binding
  mid-turn (the native id from the CLI's first event, a parent chip arriving), and a
  reset keyed on the object re-pinned the transcript to the bottom — so a reader who had
  scrolled up was yanked back on the next row, exactly the hijack the rule forbids.
  `atBottomRef` and the DOM window reset on `conversation` (provider · cwd · native id)
  instead; the probe in the tour's `chat-new-below` shot is what caught it.
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

## Work panel (`WorkPanel.tsx`, `.work-panel`)

What the agent handed the person to look at — a plan, a to-do list, edits — beside the
conversation. Everything in it comes from the agents' own tool calls, parsed in main
(`src/main/parsers/artifacts.ts` → `SessionMessage.artifact`, bounded there) and folded
in the renderer (`work.ts`), never from raw JSON in the renderer.

- **Beside, not instead of.** Under the header the chat is a row, `.chat-deck`: the
  conversation (`.chat-main` — transcript or review, the permission card, the composer)
  and the panel (`clamp(300px, 38%, 460px)`, hairline left border, `--pane`). The deck is
  a `container: chat-deck`, and under 720px of it (the panel's 300px floor beside ~420px
  of conversation) the panel covers `.chat-main` instead, on solid `--bg` — the way
  Changes takes the transcript's place. Asked of the deck, never the window: the rail is
  dragged. Changes (header, ⌘D, or the Edits tab's link) closes a panel that covers the
  conversation first — it would otherwise open unseen behind it; beside the
  conversation the panel stays, so what the agent said and what is on disk read side
  by side.
- Opened by the header's **Work** key (`.btn-review.btn-work`, `aria-pressed`, ⌘J —
  offered only once the transcript carries something for it) on the tab that matters
  now (`defaultTab`: a plan waiting for approval, else a list still under way, else the
  edits), or by a `.tool-open` row at that row. Opening moves focus to the selected tab;
  Escape (or the ×, `XIcon`) closes it and hands focus back to what opened it. It closes
  when the session's directory changes, like review.
- **Tabs** are the card tabs (`TabList`, `.pnl-pill`) without the card's rule under
  them: **Plan** (amber dot while a plan waits for approval), **To-dos** (count = steps
  not done), **Edits** (count = files). The body (`.work-body`) is the panel's one
  scroller, `tabIndex=0` so a keyboard reaches it, and goes back to the top on a tab
  switch. Each tab leads with a `.work-meta` readout in the mono voice; an empty tab
  says, in one sentence, what would appear there (`.work-empty`).
- **Plan**: the plan's markdown at `--fs-prose`. Earlier versions are one step away
  (`Earlier` / `version 2 of 3` / `Later`, `.btn-ghost.small`); a row opens its own
  version. `waiting for your approval` (`.work-flag`, warn) while it is the pending ask.
- **To-dos**: an `<ol>` of `.work-todo` rows, the state as a shape (`TodoMark`: ring,
  ring with a dot, ring with a check) *and* an `sr-only` word; the step under way wears
  an accent tint, done steps dim their text. `todos` artifacts replace the list; Claude's
  `TaskCreate`/`TaskUpdate` fold into it by task number.
- **Edits**: `N edits · M files` + `DiffStat`, then a `.work-note` that the edits are as
  the calls described them — with a `Changes` link to the worktree's real diff where
  there is one. Files are review file blocks (`.idiff.review-file.work-file` in an
  `.idiff-list`), open by default while there are three or fewer (files that arrive
  mid-turn follow the same default; only what the person toggled is remembered); each edit under an
  `.idiff-rail` (time · tool, `didn't apply` in warn when the call failed), its hunks in
  the shared `DiffLines` grammar, unified only. A row that opened the panel opens its
  file and rings its edit (`.work-edit.ringed`, an accent inset) for two seconds.

## Permission prompt (`PermissionAsk`, `.perm-card`)

A turn Cockpit drives over ACP can stop mid-turn and ask (`session/request_permission`).

**Sibling of `.ask-card`, deliberately not the same component.** `.ask-card` answers a
question *read out of a transcript*, by composing the next message — which is how a
session running in someone's terminal gets answered at all. This one is a process
Cockpit is holding open: the answer goes back down the protocol, so it is one decision
rather than a form, it can never be left half-filled, and it is docked rather than
placed in the transcript. Same livery, different mechanism; keep both.

- **It is docked, not logged.** The card sits between the transcript and the composer —
  not in the message list — because it is a thing that is true *now*: nothing else in the
  turn moves until it is answered, and the question has no meaning once it is. The
  *answer* does go into the transcript, as a `.sys-row` ("Allow once — Run the test
  suite"), since it is what the rest of the turn was conditioned on.
- It carries the agent's livery via `.tint-{provider}` — the same signal the sidebar's
  asks-mark and `.ask-card` use for a session waiting on you. No new token.
- **Allow is the only affirmative.** Options whose `kind` starts with `allow` render
  `.btn-primary`; every other answer is `.btn-ghost`. The safe answer must never be the
  one styled to be clicked without reading.
- The headline is the agent's own `title` (`.perm-what`, one line, ellipsised); the raw
  tool input rides the `title` attribute so a click is informed. The tool kind sits left
  in the micro-label register (`.perm-tool`).
- It never autofocuses. A question that arrives while someone is typing must not steal
  the caret out of the composer.
- The `aria-live` status announces the question over the generic working line — a blocked
  agent is the most important thing on the screen.
- ≤620px the headline takes its own row and the answers split the next one evenly.
  Nothing sheds: both halves are load-bearing while the agent waits.

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
- **≤700px the composer stacks**: the textarea takes the whole row and the controls (mode
  select, Send/Stop — or One more round and Send at a roundtable) follow on their own line,
  right-aligned. Beside them a ~360px pane left the textarea ~180px wide and its
  placeholder wrapping to five lines.
- The permission mode `Select` sits between the textarea and the action button — it
  governs the *next* turn, so it lives beside the button that sends it (Home's composer
  bar grammar). Persists to `cockpit:mode`; hints in `title`, labels one word. A
  read-only seat session renders neither.
- A session started from a typed task shows that task as its title (`taskTitle`) until
  the index catches up, and its worktree branch is cut from it (`branchHint` in
  `task-names.ts`: first meaningful words → `cockpit/add-changelog-entry-retry-fix`,
  never an opaque `cockpit/ws-…` unless the task has no words).
- The action button swaps in place: `.btn-primary` Send ↔ `.btn-danger` Stop while busy —
  same slot, no layout shift. While the session flies elsewhere, Send stays and is
  **disabled** (`title` says who is working and that Send waits): there is nothing of ours
  to stop, and a turn resumed under a running one would write a second turn on the same
  log. The textarea keeps taking the draft; Enter does nothing until the log goes quiet.
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
