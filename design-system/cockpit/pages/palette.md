# ⌘K Palette (`CommandPalette.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** the keyboard door to the whole fleet — one modal input that jumps to any
session, starts a session in any repo, or opens any view. It is a *jump surface*, not an
action executor: no verbs (archive, create PR, …) live here, and results stay capped —
the sidebar remains the exhaustive, paginated session list. ⌘K toggles it from anywhere;
the same data path as everything else (`pageSessions`, never a shipped index).

## Structure

- `.palette-scrim` — full-window `--scrim` backdrop, z 70 (above `.select-pop`'s 60);
  `no-drag` so a dismiss click near the top edge can't start a window drag. Mousedown on
  the scrim itself closes (the Select outside-dismiss convention).
- `.palette` — `min(600px, 92vw)`, top-anchored (`clamp(48px, 14vh, 120px)`) so results
  grow downward. Frame = the composer card's *focused* recipe (top-lit `--bg3`→`--bg2`
  gradient, accent border, glow ring, `--shadow-pop`, `--radius-lg`): a modal input is
  permanently the focused surface, so it wears the focus treatment statically.
- `.palette-input` — borderless, `--fs-base` (a query field is chrome, not prose),
  hairline bottom divider. Autofocused on mount; prior focus restored on close.
- `.palette-list` — reuses the sidebar grammar wholesale: `.search-group` lowercase
  micro-caps group heads, `.tree-empty` for empty/overflow lines. Rows are
  `.palette-opt` at session-row scale (30px, `--radius-sm`); the active row wears the
  sidebar's selected-row recipe in neutral accent (glow gradient + 2px inset bar) —
  a `--bg3` wash would vanish against the card's own `--bg3`-topped gradient.

## Sections

- **Empty query — the board in miniature:** `flying now` (busy sessions, longest
  airborne first, livery `LiveDot`s) · `recent` (idle by recency, 8 total from one
  `pageSessions` call) · `go to` (all views). The palette inherits the app's signature
  liveness; it adds no decoration of its own.
- **With a query:** `sessions` (server search, capped at 6; overflow states the count —
  "N more — keep typing to narrow") · `start a session in` (name-matched repos with a
  root, max 4) · `go to` (views matched on label *or* keywords — "skills" and "mcp"
  find Agents; keep keywords current when tabs change).
- View rows show their real shortcut (`⌘N`, `⌘,`) in the `.palette-meta` slot — never a
  binding that doesn't exist.

## Row grammar

Session rows reuse the established vocabulary — agent `ProviderLogo` · title ·
`BranchChip` · meta slot (`LiveDot` while flying, else timestamp; repo name appears as a
`.palette-hint` only in query mode). Repo rows: `RepoIcon` · dimmed-owner `owner/name` ·
"new session" hint. View rows: shared icons from `logos.tsx` (`AgentIcon`, `GraphIcon`,
`GearIcon`, `CockpitLogo`) — the same components the sidebar nav renders, so the two
surfaces can't drift.

## Keyboard & ARIA

- Input is `role="combobox"` with `aria-activedescendant`; focus never leaves it —
  options are marked active, not focused (the ARIA combobox pattern, unlike `Select`'s
  focus-the-listbox pattern, because here the user keeps typing).
- Arrows move and **clamp** at the ends (the house `Select` grammar — no wrap); Enter
  activates; Escape closes and returns focus (document-level listener with
  `stopPropagation`, the ProjectFilter pattern); Tab closes (single-field dialog —
  there is nowhere for Tab to go). App ignores its other global shortcuts while the
  palette is open; ⌘K toggles.
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
  not a tree swap).
- No entrance animation — Motion 2/10 applies to modals too.
