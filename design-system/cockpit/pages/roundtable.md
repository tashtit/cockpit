# Roundtable (`RoundtableView.tsx`, `NewRoundtable.tsx`)

> Extends `MASTER.md`. Rules here win for these views.

**Pattern:** the multi-agent counterpart to Chat: one shared transcript, several agent
seats speaking in turn. It reuses the chat vocabulary wholesale — this view adds
attribution, never a parallel message grammar.

## The table (signature element)

- `.rt-table` sits between header and transcript: an SVG arc (the tabletop edge,
  `--border` at 1px) with every seat placed around it via `arcPoint()`. Seats carry a
  26px identity tile, the seat name, and a mono-uppercase status caption in the
  board-masthead voice: `thinking…` (accent, provider pulse on the tile), `agrees`
  (`--ok`), `not yet`, `spoke`, `quiet`.
- The arc's accent overlay breathes only while a round runs (`rt-breathe`, disabled
  under `prefers-reduced-motion`); below 640px the arc yields to a flat seat row.
- Everything on the table is derived from transcript + live state — it never shows
  anything the data doesn't know.

## Identity

- The view belongs to the app accent, not one agent: `.badge-roundtable` is the outline
  accent badge (solid `.badge-{agent}` fills stay per-agent); its svg inherits accent.
- `.rt-seats` — the seat cluster used by board/tree rows: one bordered tile per seat,
  each `plogo-{agent}` colored (a provider may appear twice — twin seats).
- `.rt-speaker` — the attribution line above each contribution, in the agent's identity
  color at `--fs-xs`/700. This is what makes a shared transcript scannable; never drop it.
- A running round pulses **accent** (plain `.pulse`) in Home's roundtable strip — no
  single agent owns a multi-agent table. The thinking line inside the view names the
  current seat and uses its `.pulse-{agent}`.

- The header names the table's directory the way Chat does (`cwdLabel`): a repo-backed
  table reads `worktree` (or `worktree · <slug>`), a repo-less one `scratch room` — the
  words the creation form used. Where a table's room *lives* is never the headline; the
  full path stays in the tooltip and is what a click copies.

## Transcript

- Row vocabulary is ChatView's: user → `.bubble-user`; agent → avatar + `.rt-speaker` +
  `.markdown` body via `MarkdownBody` (one markdown pipeline, exported from ChatView);
  failed turns → `.sys-row` annotations ("<Agent> turn failed: …"), never bubbles; live
  tool calls → the shared `Message` tool rows, transient (cleared when the entry lands).
- Streaming renders plain text (`.streaming-plain`) like chat — markdownify on entry.
- DOM bound: the last 200 entries, with the explicit "(showing the last N of M)" sys-row.
- Auto-scroll pins to bottom unless the user scrolled up (same 48px rule as chat).

## Composer / rounds

- A user message opens a **parallel wave**: every seat streams at once, each in its own
  live block (`.rt-live`, `display: contents` so blocks join the transcript flow), in
  seat order. The thinking line names every active seat ("Claude and Codex are
  thinking…"); a single active seat pulses its own color, several pulse accent.
- Enter sends; the action slot swaps Send ↔ Stop in place. "One more round" is a ghost
  button, idle-only: it runs a **sequential discussion round** with no new user message —
  each seat sees what the earlier seats said this round, so they answer each other.
- The round loop lives in main (`RoundtableManager`); the renderer never relays text
  between agents. Events are round/turn/turn-end/delta/tool/entry; entry indexes are
  absolute so the view dedupes against its snapshot, and turn-end clears a seat's live
  block even when its turn produced no entry.

## In the tree

- A roundtable is an **item, not a category**: grounded tables render inside their
  project's children, repo-less ones inside Chats (which materializes if needed).
  Rows are `.session-row.rt-row` — seat cluster, title, time/pulse; selection uses the
  accent treatment, never one agent's color.
- The row's chevron expands the **seat-sessions** the table spawned (a debug view).
  Those sessions are excluded from every normal listing (board, tree, search) and open
  **read-only** — `.composer-readonly` replaces the composer, and main refuses
  `chat:send` into any table cwd.

- A table **archives like a session**: the same archive button in `.row-actions`, the
  same strikethrough plus an `sr-only` "(archived)", and it hides inside the group's
  Archived disclosure, whose count covers archived tables as well as sessions. Reversible
  Cockpit config (`archivedRoundtables`) — the table file, its room and its seat logs all
  stay where they are, and the board drops it because the board is about what is in the
  air. A table mid-round refuses to be archived: stop the round first.

- Deleting a table is Cleanup's business, not this view's: an archived table — or one
  idle past the threshold — appears under **Roundtables** there and goes with its seats and its room
  (`pages/cleanup.md`). Archiving is the reversible step in front of it.

## Consensus mode ("Reach an understanding")

- Goal picker at creation: **Free discussion** (rounds run when the user says so) vs
  **Reach an understanding** — the table runs discussion rounds *by itself* until every
  seat ends its reply with `CONSENSUS: agree — <its one-line position>`, or the round
  cap (2–5) hits.
- The protocol line is parsed off and never rendered as prose: the stance becomes a
  chip on the attribution line (`· agrees` in `--ok`, `· not yet` in `--fg-dim`) and
  the one-liner is kept as the entry's `stanceNote`.
- **The conclusion is app-assembled, never AI-written.** No extra summarizing turn
  runs and no seat speaks for the table: `.rt-outcome` is a ledger the renderer builds
  from each seat's own closing line — avatar, name, stance chip, its `stanceNote` (or
  the first line of its final reply). Header: "Shared understanding" when every seat
  agrees, "No full agreement" when the cap closed a split table — never dress a split
  as agreement.
- While a cycle runs, the thinking line carries `.rt-progress` ("round 2 of ≤3"); Stop
  halts the auto-loop immediately, and a new user message reopens a concluded table.

## Creation form (`NewRoundtable.tsx`)

- `.ns-card` grammar, in this order: Topic · Seats · The table (goal, round cap, project)
  · Roundtable spending limits · the pinned footer.
- **Topic first**, as in New session: it is why the form is open. The last seating is
  restored (`cockpit:rt-seats`), so a repeat table is a topic and ⌘↵.
- **The seats are the hero, so there is no second agent picker above them.** New
  session's big `.ns-provider` tiles are its hero because choosing the agent *is* that
  form's decision; here each seat already names its agent. Adding a seat is the
  `.rt-seats-head` row: the "Seats · N" label and, right-aligned, three dashed `.fb-add`
  pills (`+ <logo> Claude`) — the FilterBar's "add another" shape, meaning the same thing.
  They disarm at `ROUNDTABLE_MAX_SEATS` = 8.
- **Every seat is a `.rt-seat-card` in its agent's `.tint-{agent}`** (the rest-intensity
  identity: 2px inset bar + faint gradient), so a column of seats scans by colour *and*
  by name. Head: logo, the agent picker as a `quiet` `Select` (the seat's title,
  changeable in place — switching resets the seat), the ordinal when the agent sits
  twice, the duplicate chip, then — right-aligned — the on/off knob only that CLI has as
  a checkbox (`.rt-seat-flag`: Codex **fast** with its "~2× usage" note, Copilot **long
  context**; a two-value dropdown for a boolean is the wrong control), **Copy** (a
  `.btn-ghost.small` that inserts an identical seat right after) and remove.
- Body: `.rt-seat-grid`, four labelled cells — Model, Thinking, Account, Model provider.
  **Four across, two by two, or stacked; never three and one.** The card is a
  `container: seat` and the grid asks it (`@container seat`), since the card's width is
  the window less a draggable sidebar; thresholds are measured in the stylesheet
  comment. Nothing about a seat is a hidden default: the Model provider cell exists even
  with no custom provider configured (an inert `.ns-account-single` reading
  "<Agent> (own)", its tooltip saying why and where to add one), and the model is a
  `Select` over *every* model the agent offers under the seat's account
  (`listAgentModels`) or the custom provider's catalog — **never a text field**. Thinking
  lists the chosen model's own levels when its source says (Codex) and names the default
  ("default · low"); a choice the new model doesn't take falls back to default rather than
  being sent.
- **The footer is pinned** (`.rt-footer`, sticky to the bottom of the view, spanning the
  card's padding on `--bg2` under a hairline): the bill on the left ("4 seats · up to 12
  agent turns a message"), Cancel and Open on the right as one `.rt-footer-keys` group,
  so a narrow card puts the bill on its own line and never strands Open. However many
  seats, the cost and the way to open the table stay in sight.
- **An exact repeat is allowed, marked and confirmed.** A seat equal to an earlier one in
  agent, account, model provider, model, thinking level and knobs carries the warn chip (`.acct-chip.missing`,
  "duplicate") and a warn border; only the later seat is marked. Open stays disabled
  until the `.rt-dup-confirm` checkbox ("Seat the duplicate on purpose") is ticked.
- **Spending limits live on this form, per table** — "Roundtable spending limits": agent
  turns per message and for the whole table. One `.ns-hint` under them spells the bill
  out (seats × rounds for a consensus table, and about how many messages the table
  ceiling buys) — the footer carries its short form; the round-cap picker only offers what the per-message ceiling allows. Last
  choice is remembered for the next table. Never in Settings: Settings is app-wide, and
  these belong to a table.
- **On the table**, each seat on the arc carries `.rt-table-setup` — its model, thinking
  level and knobs in one mono line (tooltip only in the flat row below 640px). `.rt-budget` in the header reads "N of M agent turns" (warn once
  another round would not fit) and opens `.rt-limits`, the in-place editor. A table out
  of turns says so in a `.sys-row` before the user tries, with a "Raise the limit"
  `.link-btn` — a refusal always carries its way on.
- **No permission mode exists.** Roundtables are discussion-only: every turn runs
  'safe', codex is sandboxed read-only, and the framing tells seats the workspace is
  read-only. A roundtable decides; a normal session ships.
- Repo is optional: "no repository — pure discussion" runs in a scratch room,
  otherwise the seats share one isolated read-only worktree on a `cockpit/` branch.
