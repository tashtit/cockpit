# Home — Mission Control (`HomeView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** mission control, in a fixed order: **the board reads above, the composer is
docked to the bottom edge** — a chat's shape, which is what the view is. The board is the
app's signature element and the composer is the action, but the action is what the screen is
*for*, so it is the one thing that never moves: it lives outside the scroll entirely.

The order was a variable once (the board took the top whenever anything was flying or had
landed unseen) and that hid the composer exactly when work was busiest — at a 900px window a
full board pushed it to the bottom edge, at the 560×420 floor off screen entirely. Pinning
the composer to the *top* fixed that and cost the board: past ten rows it was the board that
fell off the bottom, and on a short window you scrolled the whole page to see what was
flying. Docking is what answers both — **nothing about the page scrolls, only the board's own
rows** — so neither half can push the other out of the window. Don't reintroduce a page-level
scroll here, and don't make either region's place depend on what is happening.

This is the only view allowed hero-scale type (`--fs-xl`) and a floating card shadow (the
composer card — the board is deliberately a quiet instrument surface, no shadow). Both
are spent once: the scale on the masthead's alarm, the shadow on the composer card.
Everything between them stays quiet.

## Layout

- `.home-view` is a frame, not a page: `display: flex; flex-direction: column;
  overflow: hidden`. Two children, and only one of them can give way.
- **One column, `--home-col` (780px), shared by the stack and the dock** — the board
  and the composer are the same width and read as one stack. Resist widening the board
  on its own: a row is a fixed lead and branch slot, a title, and a right-aligned repo
  pill + time, so past the width the title needs, every extra pixel opens a canyon down
  the middle of each row rather than showing more (at 1100px it was ~600px of nothing
  between the title and the time, and the row read as two disconnected clusters). If
  the board ever needs to be genuinely wide, the row grammar has to change first —
  more per row, or a meta column that doesn't hug the far edge. Wider is emptier here,
  not richer.
- `.home-stack` — the reading half: `flex: 1; min-height: 0`, holding `.home-inner`.
  Its content **hangs from the top** and the board grows downward into the room it has.
  The dock is already anchored to the bottom; anchoring the reading half to it as well
  left a full-screen window with everything piled at the bottom under 400px of nothing,
  and centring split that void in two.
- The stack keeps `overflow-y: auto` as a last-resort escape valve
  (`scrollbar-gutter: stable both-edges`, since it centers a column), but it is not the
  normal scroller: the board gives way first, and only a window too short for the
  masthead plus one row ever reaches it.
- `.home-dock` — the acting half: `flex: none`, the chat composer's chrome recipe
  (`border-top` + `--pane`) over `.home-dock-inner`. Its children carry
  `flex-shrink: 0` — without it the composer card (`overflow: hidden` → zero
  min-content) collapses to a sliver on short windows.
- Order, always: **stack** — the fleet (`.board`, which carries sessions and
  roundtables alike); **dock** — `.composer-card` → `.home-more` → YOLO hint → error
  line. The board renders whenever it has a row; what is happening changes the rows and
  their order, never either region's place on the page.
- **There is no hero.** A centred greeting used to open the view. It was the generic
  move, it was dropped at ≤600px height (a heading you delete under pressure is not a
  heading), it was centred over a left-aligned table, and once the composer moved to
  the dock it introduced nothing — it sat 700px from the thing it framed. Its two jobs
  went where they belong: the heading is now the board's masthead (below), and the ⌘K
  hint is the left anchor of `.home-more`. `firstName()` and `.home-hero` / `.home-sub`
  / `.hero-name` went with it; the person's identity is already on screen in the rail's
  footer. Don't reintroduce a page-level greeting without a job for it.
- **First run** (`.home-setup`, and only when there is no board): the two regions
  collapse into one and the setup card centres in the deck, without the dock's rule and
  pane. There is no fleet to list and the card *is* the content, so an anchored dock
  would just be a card hanging off an edge under an empty board area. Gated on
  `needsSetup`, which already waits for both accounts and the first scan — so it can
  never flash, and it is the one state where the action's placement varies.
- Short windows (≤600px height): `.home-stack` trims to `--s4` padding and the masthead
  sheds (below). Nothing else gives — the board and the composer are the priority.

## The board (`.board`)

- **The view's only scroll.** The board is a flex column (`min-height: 0`) whose
  `.board-head` is `flex: none` and whose `.board-list` carries `overflow-y: auto`: it
  takes whatever height the window leaves above the dock and gives way by scrolling its
  rows, never by shrinking its head — the counts are what the head is for. At the floor
  and at 200% zoom that is two or three rows, with the next one half-shown; that cut row
  is the scroll affordance, don't pad it away. On a full screen the same board runs from
  the hero to the dock, which is why the row budget below is 30 and not ten.
- Grammar per row (`.board-row`, a button that opens the session): status dot ·
  `.board-agent` placard (`.board-lead`, fixed 68px column, uppercase micro-caps) ·
  `.board-branch` slot (fixed 150px, holding the `BranchChip`) · title (truncates) ·
  `.board-repo` pill · `.board-meta` (mono, `tabular-nums`). The branch slot renders
  **even when empty**, so every title starts on one grid line; roundtable rows put their
  seat cluster in the same `.board-lead` column.
- **Waiting on you** (its agent stopped to ask a question or for a permission, from
  `useLandedMap()` kind `asks` — whether or not its process is still up): the question
  glyph in the agent's livery (`LandingMark`), the livery inset bar, and `asks you` or
  `needs permission` in the meta slot; the question itself is in the tooltip. **Flying**
  (session's provider process running, from the `useBusyMap()` store): `LiveDot`
  pulse + placard lit in the agent's livery color + elapsed time (`fmtElapsed`, ticks at
  1s only while ≥1 session is flying). **Red PR** (an open pull request on its branch has
  failing checks or changes requested, kind `pr`): GitHub's x in `--danger`, a `--danger`
  inset bar — it is the branch that needs you, not the agent — and `#57 checks failing` /
  `#57 changes requested` in the meta slot. **Landed** (its turn ended and nobody has
  opened it since, kind `landed`): a solid, unpulsing livery dot, a livery inset bar instead
  of flying's wash, and `landed <time>` in the meta slot. In every case the word carries
  the state, so colour never carries it alone. **On the ground:** dim static dot, dim
  placard, last-activity `fmtTime`.
- Ordering: waiting on you first (newest question on top), then flying (longest airborne
  on top, then any roundtable mid-round), then red PRs and landings (red first, then most
  recent first), then the ground — sessions and roundtables interleaved by recency. One
  list; a session carries one state, its most urgent.
- **Roundtables are rows, not a second panel** (`TableRow`, `.board-row-table`): the seat
  cluster sits in the `.board-lead` column where a session has its placard; a running round
  pulses accent (no single agent owns a table), counts as flying, and holds the meta slot
  with "in round". A table is work in flight like a session — two panels in the same
  grammar made the eye compare them instead of reading one board.
- **Row budget:** flying and landed rows always show; the ground fills what is left of
  `BOARD_ROWS`, which is also the `pageSessions({ limit })` size — one number, two uses.
  It is 30, and it is a budget in rows for a panel measured in pixels: the board takes
  the height the window leaves and scrolls the rest, so the number only has to be deep
  enough to fill the tallest window anyone flies in (a full-screen 16" is ~25 rows of
  region). It was ten while the board had to fit *under* the composer, and ten left a
  full screen two-thirds empty once it no longer did. The sidebar is still the
  exhaustive list — this is a taste, not the index; don't grow it past what a screen
  can hold. The one addition: a session that needs you but is not on that page is
  fetched by id (`getSession`), so every banner and Dock count has its row.
- **The masthead** (`.board-mast`, the h2 — the view's only heading, in the mono
  placard voice, aligned with the rows' own left edge). **Its size is the alarm.** One
  quiet `--fs-lg` line while nothing needs you — "2 flying · 22 on the ground", or
  "all 22 on the ground" when nothing is flying either. The moment something does need
  you it gains the `alarm` class: the urgent phrase jumps to `--fs-xl` in full `--fg`
  (`.mast-lead`) and everything else drops to a `--fs-sm` sub-line under it
  (`.mast-rest`). This is the view's one bold move and the one place it spends scale,
  because "does anything need me?" is the one question this screen exists to answer —
  readable across a room, and never carried by colour (the phrase says what it is).
  The lead is the most urgent non-zero of **waiting on you → red PRs → landed**, the
  same order a session's own state resolves in; **flying never leads** — an agent
  working is the normal condition, not news. K comes from the page total and every zero
  count is dropped. Polite `aria-live`: turn starts, completions and questions announce
  the new counts.
- ≤600px height the masthead sheds in order — `.mast-rest` first (the counts that
  aren't urgent; the rows say the rest), then the alarm's scale back to `--fs-lg`, then
  the head's block padding. The urgent phrase itself never goes: at that height it is
  the only thing on screen that says so. Unlike the hero it replaced, the view now
  keeps a heading at the floor and at 200% zoom.
- ≤780px the row sheds `.board-repo` first — the branch chip carries more identity;
  ≤700px the `.board-branch` slot goes too, because on a ~360px pane the task title is
  the row's content.

## First run (`Setup`, `.setup-card`)

- When Cockpit cannot start anything — no agent signed in, or no repository indexed —
  the composer card is **replaced** in the dock by the same card shape, which names
  itself: `.setup-head` ("Three things and you fly") over a `.setup-blurb`, and the
  section takes its accessible name from that heading (`aria-labelledby`, not an
  `aria-label`). It holds the three things Cockpit needs: sign in to an agent · point Cockpit at your work · connect GitHub for PRs.
  A disabled Start button that says nothing is an accurate screen that helps nobody.
- Steps already satisfied stay on screen, ticked (`CheckIcon` in `--ok`, the title
  quieted, an `sr-only` "— done"): the card is a progress readout, not a gate that
  empties as you go. Only an unsatisfied step carries its note and its action.
- Three states, each shown only on evidence. **Composer** the moment
  `accounts.accounts.length > 0 && selectable.length > 0`. **Setup** only once accounts
  have loaded *and* the index has finished its first scan (`indexed`, from
  `api.whenIndexed()`) and one of those is still missing — before the scan, no repos
  means "not read yet". **Neither** until then: the slot and the sub-line stay empty
  for the moment it takes. Guessing either way is a flash — a composer swapped for setup
  on a first run, or setup swapped for a composer on a cold index. GitHub missing alone
  does **not** show the card: sessions run fine without `gh`, only PRs need it.
- The composer takes focus when it first appears, not when the view mounts — and never
  takes it off anything already focused, since "first appears" can be seconds after the
  view opened (it waits on the accounts answer and the first repos). It takes focus only
  while focus is still where the view left it (the body, or nothing at all) and nothing
  is layered over the home: a `[role="dialog"]` anywhere — the ⌘K palette, a popover —
  means the home is not what the person is using, even in the beat before that surface
  has focused its own field.
- Per-agent absence keeps its old, quieter signal: with one agent signed in, the
  composer's `.no-acct` dot and "not signed in" chip say the rest.
- The hero's sub line swaps to what this screen is waiting for.

## Composer card

- `.composer-card` = borderless textarea on top, `.composer-bar` control strip below a
  hairline divider. Focus ring lives on the **card** (`:focus-within`), not the textarea.
- Bar order is fixed: repo icon + repo select · `.composer-identity` (agent picker +
  account select fused into one bordered control — they answer one question, "who runs
  this") · permission mode select · `.btn-primary` pushed right with `margin-left: auto`.
- `.home-more`: the dock's footer line, directly under the card. `.home-kbd`
  ("⌘K jump anywhere") anchors it left on `margin-right: auto`; the `.link-btn`s sit
  right — "All options — branch name, model, custom model provider…" is the
  discoverable path into the full New session form; it carries the typed draft over, so clicking it never loses work. Kept
  out of the bar on purpose: the bar is width-budgeted and must stay one line.
- Agent picker: `.composer-agent` logo buttons, `aria-pressed` + `aria-label`; active =
  agent-tinted background + 1.5px inset ring in the agent color. Signed-out agents get the
  `.no-acct` red dot — never disable them (clicking reveals the "not signed in" chip).
- ⌘Enter submits; the button label is the action: "Start with Claude Code", or "Starting…"
  while busy. Errors render in `.new-error` directly under the card, never a toast.
- Mode options and hints come from the shared `MODES` table (exported by NewSession);
  choosing YOLO shows the `.ns-hint.yolo` warning line under the card — the bypass mode is
  never silent.
- Prompt textarea autofocuses when the composer appears, unless focus is already
  elsewhere or a surface is layered over the view (see First run) — on a normal first
  paint the user should be able to type immediately.
- Pasting an image attaches it, exactly like the chat composer (shared
  `useImageAttachments` + `AttachRow` from `attachments.tsx`): a `.composer-attach` chip
  row appears as the card's first child (padded to the textarea's inset). An image-only
  start is allowed; "All options" hands pending attachments to the full form along with
  the draft.

## Invariants

- Provider, mode, and per-provider account choices persist to
  `localStorage` (`cockpit:provider`, `cockpit:mode`, `cockpit:account:<provider>`) on
  start — HomeView, NewSession, and ChatView must stay in sync on these keys.
- Start is disabled until: prompt non-empty (or an image attached), a repo selected, and
  (once accounts have loaded) an account resolved. While `accounts === null` (still loading), don't flash the
  missing-account state.
- The keyboard hint uses `.home-kbd` mono in `.home-more`, and must match a real
  binding. It is ⌘K alone: ⌘N was dropped with the hero, since on this view the
  composer *is* the new task and the placeholder already carries ⌘Enter.
