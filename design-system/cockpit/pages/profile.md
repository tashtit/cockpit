# Profile — cross-agent work (`ProfileView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** a read-only instrument panel: a contribution heatmap and headline numbers, the
familiar shape of a developer profile. The reason this view exists is what a single-agent
tool cannot show: **the same work split across three agents**. When deciding what to
add here, prefer whatever sharpens the Claude-vs-Codex-vs-Copilot comparison — and a number
that looks comparable across agents but is counted differently for each is worse than no
number (see Honesty rules).

Local-only by design — nothing is published, exported, or fetched. Every number is computed
in `src/main/profile.ts` from logs already on disk. The user guide's page is
`docs/guide/profile.md`.

## Layout

Reuses the standard secondary-view shell (`.chat.settings-view` > `.ns-card`), same as
Settings, Agents and Cleanup: `.ns-head` (h2 + Close), the identity line (`.ns-hint.ns-prose`),
then `.pv-stats` — the headline numbers over the agent mix, which every tab keeps — then the
card tabs (`tablist` "Profile sections") over one panel.

Tabs and order are fixed:

- **Activity** — By day (the heatmap + legend) → By hour (rhythm): *when* you work.
- **Agents** — By agent (the comparison table) → Roundtables → Models → Accounts: *who* did it,
  on what, as whom.
- **Code** — Languages → Top repos: *what* it touched.

The tab is the panel's name, so no group heading repeats it ("Activity" under Activity
read as noise — hence By day / By hour / By agent). Each group is dropped entirely when it
has no data, and a tab left with none (Code, with no languages and no repos) is dropped
with it; the identity line and `.pv-stats` are unconditional. A group's explanation is
`.ns-hint.ns-prose` (body size, MASTER's rule for a section's explanation); only the
peak-hour line under the rhythm strip is a plain `.ns-hint` readout note.

## One color grammar

Every split on the page — the headline's mix bar, the heatmap squares, the rhythm's stacked
bars, the model, language and repo bars — paints the three agent colors
(`rgba(var(--{agent}-rgb), α)`, inline) **in one order: most sessions first**, the order main
ranks `providers` in. That is what lets the headline's key (`.pv-mix`) explain all of them,
so no list below carries a legend of its own. Every split is also said in words — a `title`
on the row or square, and an `sr-only` span or the image's `aria-label` — because color
must never be the only thing that says which agent.

## Headline (`.pv-stats`)

- `.pv-nums` is a `<dl>`: each `.pv-stat` is `dt` (label) then `dd` (value) in the DOM, shown
  value-over-label by `column-reverse`, so a screen reader hears "sessions, 23". The `dt` is
  a placard (mono, in the identity layer at the end of style.css).
- **lines edited** is shown as `+added −removed` (`.pv-diff`), never one number: a bare sum of
  additions read as "lines of code".
- `.pv-mix` — one `.pv-bar` of sessions cut by agent, and under it the key: a
  `sessions by agent` placard (`.pv-mix-label`) and a `ul` "Sessions by agent" of swatch +
  name + share. Shares are whole percents; a non-zero share never reads "0%" (`<1%`).

## The heatmap (`.pv-heat`)

- A day counts every session **worked in** that day: the day it started, and every day it was
  sent a prompt (`DeepStats.promptTimes`). Counting start days alone left a session resumed all
  week as one square — on a real machine half the sessions spanned several days, and the grid
  showed 28 active days of 55. Active days and both streaks are counted the same way.
- GitHub's grid geometry: 7 rows (Mon–Sun, `Mon`/`Wed`/`Fri` labelled), one column per week,
  oldest column left, capped at 53 weeks. Leading blanks (`.pv-sq-pad`) pad the first week so
  weekdays line up down every column.
- **Squares carry the agent's identity color, not the accent** — hue = the agent that ran
  most that day, so the grid doubles as an at-a-glance agent mix. Intensity is 4 steps against
  the busiest day *in the grid*, on a **square root**: linear, one 15-session day put every
  one- and two-session day on the faintest step and the year read as one bright square.
- Squares are the one place agent tints exceed MASTER's 0.10–0.16 range (0.30 → 0.95). That
  range exists to keep text legible on a tint; these are graphics with no text on them. The
  first step is deliberately visible — "did I work that day" is the grid's first read.
- The legend's Less→More swatches wear the **leading agent's** hue, the one most squares wear.
  (They were accent blue, a color that appeared nowhere in the grid.) The headline key names
  the other hues.
- Empty days are `--surface` + `--border`, never absent: `profile.ts` returns a dense day
  range so the grid can never grow a hole.
- Sizing: `.pv-heat-scroll` is an inline-size container (`pv-heat`) and the grid fits it — a
  week's pitch is `(100cqi − --pv-lead) / --pv-weeks`, the gap takes ~27% of it (1–4px), the
  square the rest (3–11px). `--pv-lead` is the fixed 28px weekday column plus its 6px gap, less
  the smallest gap; widening the column means updating both. A full year fits the 286px card
  at the window floor, so `overflow-x: auto` is only a fallback below the floor, and
  `overflow-y` is pinned `hidden` so a horizontal bar can never breed a vertical one. The page
  itself must never scroll sideways (MASTER).
- Labels are what stop fitting, not squares. A month label is dropped when its month starts
  in the grid's last 4 weeks (it overhung the edge and bred a scrollbar), and `.pv-months`
  clips. A long grid (`.pv-heat-long`, over 44 weeks) under 352px of box sheds its weekday
  column — the 34px go to the squares — and every other month name. Measured, and written
  beside the rule at the end of style.css.
- Accessibility: the grid is one `role="img"` whose label counts the active days and says in
  words which agent led how many; every square carries a `title` naming the date, count and
  per-agent split. Don't make squares focusable — 371 tab stops would wreck keyboard
  navigation for no gain.

## By hour — rhythm (`.pv-rhythm`)

**Prompts sent** per local hour — when you are at the keyboard; a session's start said only when
it began, and a long one spans the day. 24 bars on a `--surface` strip, each stacked by agent
(`.pv-hour-fill`, leading agent at the bottom). A quiet instrument readout, not a chart — no
gridlines, no y-axis; the peak hour is named in the `.ns-hint` line below instead. Bars and
the mono axis marks (00/06/12/18) share one 24-column grid, so a mark sits under its own
hour; every hour keeps a 2px `--border` baseline, so an empty one still reads as a slot. The
strip is one `role="img"` with the peak in its label; per-hour detail lives in `title`s.

## By agent — the comparison (`.pv-compare`)

A real `<table>`: **agents as columns** (`th scope="col"`, logo + name on a 0.12 tint with a
2px agent-colored underline), **one measure per row** (`th scope="row"`), so reading across
a row is reading Claude against Codex against Copilot. It replaced three per-agent cards whose
numbers sat at different x in each and couldn't be compared by eye. Rows, in order: Sessions,
Active days, Prompts per session, Tool calls per prompt, Lines edited, Files edited, Top tools.

- Rates divide by `readSessions` (sessions the deep pass could read) — a session whose log it
  couldn't open contributed nothing, so it must not dilute the rate.
- Fixed layout: no cell can widen its column. Top tools are the top 3, mono, truncating with
  an ellipsis (the list's `title` holds all 8); the header wraps logo over name when a column
  is too narrow for both.
- `.pv-compare-wrap` is the size container (`pv-compare`) — the card's width is the rail's
  question, not the window's. Under 330px of table the measure column narrows and the cell
  padding halves; the thresholds are measured and written beside the rule at the end of
  style.css.
- **Two distinct empty states, never conflated:**
  - `deepUnavailable` → `.source-warn` in the Lines row ("logs unreadable"), `.pv-na` "—" in
    the other log-derived rows (its reason in the `title`). Sessions and Active days come off
    the index and stay.
  - zero lines with no failure → `.pv-untracked` "none measured". Not a failure: an agent that
    edits through shell commands leaves nothing countable in its log. Never render a bare
    `+0 −0` or `0 files` — it reads as a bug. A rate with no denominator is "—", never 0.

## Roundtables

A roundtable's seats are agent sessions, but a seat is prompted by its table rather than by
the person, so none of them are in any other number on the page — counting them made a
three-seat table three sessions and its relays the person's prompts. They are reported apart,
right under the comparison they would distort: one `.ns-hint.ns-prose` line with the tables,
the seat sessions and the split in words (`ProfileStats.roundtables`), and the group is
dropped when no table has run a seat.

## Bar lists (`.pv-bars`) — Models, Languages, Top repos

One grammar for all three: name | `SplitBar` | count. The `ul` is a grid and each `li` a
`subgrid` row, so every track starts and ends at the same x whatever its count says (they
were ragged). Both text columns are `fit-content()` — a name takes up to 45% then truncates
(its `title` keeps it), a count up to 35% then wraps at its "·" (counts join number and noun
with a no-break space, so "1 line" never parts) — so the list holds at the floor intrinsically.
The fill's length is the row's share of the longest row; its segments are the agent split.

- **Models** — mono names (machine identifiers), counted in assistant messages ("msgs") — a
  proxy for use, never "requests" or "tokens". Split by agent because model families cross
  agent boundaries: Copilot serves claude-opus, Claude serves fable. The `<synthetic>`
  placeholder Claude writes for injected turns is filtered in main, not here.
- **Languages** — mono `.ext`, lines added · files.
- **Top repos** — `owner/`**name** like the sidebar (`.repo-owner`), `Chats` for the no-repo
  bucket, and the count as the `.repo-count` pill (MASTER: a bordered pill is a session
  count on a repo).

Counts agree with their nouns everywhere: "1 line", "1 file", "1 msg" — "1 lines · 1 files"
read as a bug.

## Accounts (`.pv-accounts`)

One row per config home that produced sessions: provider logo, identity as the standard
`.acct-chip.acct-{agent}` (or `.acct-chip.missing` "not signed in" — an honest gap, not an
error), the config home's label, when it was last used (`fmtAgo`), session count pill. This
is the "which users" answer for a local app. The list is its own size container
(`pv-accounts`): below 304px the last-used time — the row's decoration — sheds first.

## Honesty rules (load-bearing — don't soften these)

Line counts come from each agent's own edit-tool inputs. They measure **edits performed**, not
diff that survived to a commit: rewriting a file twice counts twice, and nothing is reconciled
against git. The standing hint under **By agent** says exactly this and must stay. Label these
numbers "lines edited" — never "lines shipped", "lines of code", or anything implying merged
work.

**Prompts** are what the person sent, counted alike for every agent (`ProviderProfile.prompts`,
from the deep pass): Claude `user` entries that are neither tool results, `isMeta` notes,
compaction summaries nor `<…>` markup (a `<command-…>` slash command is input and counts);
Codex `user_message` events, or its user `message` items less the injected
`<environment_context>`/AGENTS.md ones where a rollout wrote no events; every Copilot
`user.message`. The index's `messageCount` must never stand in: it counts log records, and
Claude writes one per tool call and one per result, so "turns per session" built on it read
Claude as several times chattier than the others — a comparison that measured the log format.

The profile deliberately covers **all** history, ignoring the `historyDays` display window
that trims the sidebar tree. A profile's job is the long view; that setting exists to keep the
tree short.

**Archived sessions count** — Cockpit's own archive and each provider's (the Claude desktop
app's `isArchived`, Copilot's archived rows and workspaces, Codex's `archived_sessions/`):
archiving is how a session ends (the desktop app archives one when its PR closes), and the
work in it happened. Excluding them hid 276 of 301 Claude sessions on a real machine. Only a
session **deleted** in its provider's app stays out (`ProviderHidden.deleted`), and a log
that is gone is gone. The indexer hands the profile its own list (`ownSessions`); every other
listing still hides archived sessions as before.

Each transcript is read **whole**, streamed a line at a time up to 256MB, Codex 64MB (the largest seen is
~110MB). The old 2MB head read missed everything after a long session's first megabytes — a
third of real Claude transcripts are bigger, a screenshot being a megabyte of base64. Reading
a machine's logs cold takes seconds (7s over 1.4GB, measured), so what each file said is
persisted to `userData/profile-cache.json` keyed on (mtime, size): a relaunch re-reads only
what changed (11ms, measured). The loading line covers the first open.
