# Roundtable (`RoundtableView.tsx`, `NewRoundtable.tsx`)

> Extends `MASTER.md`. Rules here win for these views.

**Pattern:** the multi-agent counterpart to Chat: one shared transcript, several agent
seats speaking in turn. It reuses the chat vocabulary wholesale — this view adds
attribution, never a parallel message grammar.

## The table (signature element)

- `.rt-table` sits between header and transcript: an SVG arc (the tabletop edge,
  `--border` at 1px) with every seat placed around it via `arcPoint()`. Seats carry a
  26px identity tile, the seat name, and a mono-uppercase status caption in the
  board-eyebrow voice: `thinking…` (accent, provider pulse on the tile), `agrees`
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

- `.ns-card` grammar; the provider cards are **add-seat buttons** (2–4 seats total, a
  provider may sit twice with different models — twin seats get ordinals). Each seat
  row: identity, account, model, remove.
- **No permission mode exists.** Roundtables are discussion-only: every turn runs
  'safe', codex is sandboxed read-only, and the framing tells seats the workspace is
  read-only. A roundtable decides; a normal session ships.
- Repo is optional: "no repository — pure discussion" runs in a scratch room,
  otherwise the seats share one isolated read-only worktree on a `cockpit/` branch.
