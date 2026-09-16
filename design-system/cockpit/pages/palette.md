# ⌘K Palette (`CommandPalette.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** the keyboard door to the whole fleet — one modal input that jumps to any
session, starts a session in any repo, or opens any view. It is a *jump surface*, not an
action executor: no verbs (archive, create PR, …) live here, and results stay capped —
the sidebar remains the exhaustive, paginated session list. ⌘K toggles it from anywhere;
the same data path as everything else (`pageSessions`, never a shipped index).

It has a second mode, **transcripts**: the same input searching *inside* the
conversations, across all three agents at once — "where did I discuss X" is the one
question no vendor can answer for the other two. On demand (`searchTranscripts`,
`main/transcript-search.ts`), never from a shipped index; hits are capped, and the line
under them says how much was read and why a search stopped early.

## Structure

- `.palette-scrim` — full-window `--scrim` backdrop, z 70 (above `.select-pop`'s 60);
  `no-drag` so a dismiss click near the top edge can't start a window drag. Mousedown on
  the scrim itself closes (the Select outside-dismiss convention).
- `.palette` — `min(600px, 92vw)`, top-anchored (`clamp(48px, 14vh, 120px)`) so results
  grow downward. Frame = the composer card's *focused* recipe (top-lit `--bg3`→`--bg2`
  gradient, accent border, glow ring, `--shadow-pop`, `--radius-lg`): a modal input is
  permanently the focused surface, so it wears the focus treatment statically.
- `.palette-head` — the input row: `.palette-input` (borderless, `--fs-base` — a query
  field is chrome, not prose) under a hairline bottom divider, autofocused on mount,
  prior focus restored on close. In transcripts mode a `.palette-mode` chip (mono
  micro-label, accent wash, `SearchIcon`) sits before the input — the token-field
  convention: it is the only chrome the mode adds, clicking it or Backspace on an empty
  query removes it. `tabIndex={-1}`: Tab still closes the dialog.
- `.palette-list` — reuses the sidebar grammar wholesale: `.search-group` lowercase
  micro-caps group heads, `.tree-empty` for empty/overflow lines. Rows are
  `.palette-opt` at session-row scale (30px, `--radius-sm`); the active row wears the
  sidebar's selected-row recipe in neutral accent (glow gradient + 2px inset bar) —
  a `--bg3` wash would vanish against the card's own `--bg3`-topped gradient.

## Sections

- **Empty query — the board in miniature:** `flying now` (busy sessions, longest
  airborne first, livery `LiveDot`s) · `landed` (turns that ended unseen, newest first,
  solid livery dot) · `recent` (idle by recency, 8 total from one `pageSessions` call) ·
  `go to` (all views). The palette inherits the app's signature
  liveness; it adds no decoration of its own.
- **With a query:** `sessions` (server search, capped at 6; overflow states the count —
  "N more — keep typing to narrow") · `start a session in` (name-matched repos with a
  root, max 4) · `go to` (views matched on label *or* keywords — "skills" and "mcp"
  find Agents; keep keywords current when tabs change).
- **The door into transcripts:** every query also lists `in transcripts` → one row,
  `search transcripts for “q”` (`SearchIcon`, scope name as the `.palette-hint`), directly
  under the session hits so it is one ArrowDown from the name matches and the top row
  when nothing is named that way. "nothing matches" is about the rest of the list — the
  door always stands.
- **Transcripts mode:** one group, `transcripts in <scope>`, of `.palette-hit` rows plus a
  scope row. Scope defaults to the repo the window is on (`scopeRepo` from App: the open
  chat's repo, the new-session repo, a repo's agent setup) and is named in the group
  head, the placeholder and the door row; the scope row (`RepoIcon`, `all repos` /
  `only owner/repo`, hint `search scope`) widens or narrows it without leaving the mode.
  No repo on screen = global, no scope row. Below the rows, `TranscriptStatus` is the one
  `.tree-empty` line: the hint before a query (what is searched, that tool output stays
  out), `searching transcripts…` while the first scan runs, then `N hits in M sessions ·
  searched X of Y transcripts` with, when true, `stopped at the hit cap`, `ran out of
  time`, `K large transcripts read only in part` — a partial search never passes for a
  complete one. Hits stay up while the next scan runs (`· searching…` appended).
- View rows show their real shortcut (`⌘N`, `⌘,`) in the `.palette-meta` slot — never a
  binding that doesn't exist.

## Row grammar

Session rows reuse the established vocabulary — agent `ProviderLogo` · title ·
`BranchChip` · meta slot (`LiveDot` while flying, else timestamp; repo name appears as a
`.palette-hint` only in query mode). Repo rows: `RepoIcon` · dimmed-owner `owner/name` ·
"new session" hint. View rows: shared icons from `logos.tsx` (`AgentIcon`, `GraphIcon`,
`GearIcon`, `CockpitLogo`) — the same components the sidebar nav renders, so the two
surfaces can't drift.

## Hit rows (`.palette-hit`)

Two lines in one `.palette-opt`: the session it came from in the session-row grammar
(`ProviderLogo` · title · repo `.palette-hint` when the search is global · the message's
time in `.palette-meta`), then `.palette-snippet` — the message windowed around its first
match, `--fs-sm`, clamped to two lines, led by a mono `.palette-role` micro-label (`you` /
`agent` / `tool`) and with the match in a `<mark>` re-voiced as an accent wash under
`--fg` (the UA's yellow-on-black never shows). Picking a hit opens its session; the
transcript view has no per-message anchor yet, so it opens at the bottom like any
session. Row `aria-label` = `<Agent> session: <title> — <role>: <snippet>`.

## Keyboard & ARIA

- Input is `role="combobox"` with `aria-activedescendant`; focus never leaves it —
  options are marked active, not focused (the ARIA combobox pattern, unlike `Select`'s
  focus-the-listbox pattern, because here the user keeps typing).
- Arrows move and **clamp** at the ends (the house `Select` grammar — no wrap); Enter
  activates; Escape closes and returns focus (document-level listener with
  `stopPropagation`, the ProjectFilter pattern) — from transcripts mode too, the whole
  palette; Tab closes (single-field dialog — there is nowhere for Tab to go, the mode
  chip is deliberately not a stop). Backspace on an empty query in transcripts mode
  returns to jump. App ignores its other global shortcuts while the palette is open;
  ⌘K toggles.
- Enter on the door row or the scope row re-shapes the palette and keeps it open; focus
  never leaves the input. Every other row closes it.
- Mouse: hover sets active; mousedown picks (focus stays in the input until close).
- One polite `sr-only` status line announces the result count when a query settles.
- New results reset the cursor to the top hit; the active row scrolls into view
  (`block: 'nearest'`).

## Invariants

- Mounts only while open; state (query, results) resets by unmounting — every open is
  fresh.
- Fetch keeps previous results while a newer one is in flight — "searching…" may only
  show before the *first* results land, never as a flash between keystrokes.
- 120ms debounce (deliberately half the sidebar's 250ms: each keystroke fetches ≤6 rows,
  not a tree swap). Transcripts mode debounces 300ms — each keystroke there streams
  through every candidate file — and asks for ≤30 hits (`TRANSCRIPT_LIMIT`; main also
  caps per session, so one chatty transcript can't fill the list).
- Typing never scans transcripts on its own: the door has to be picked. Leaving the
  mode, changing the query or scope, and closing the palette all cancel the in-flight
  scan (`cancelTranscriptSearch`) — a search for nobody must not grind on through the
  remaining files.
- One polite status line: `searching transcripts` / `N transcript hits` in that mode.
- No entrance animation — Motion 2/10 applies to modals too.
