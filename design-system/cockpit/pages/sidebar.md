# Sidebar — Repo/Session Tree (`TreeSidebar.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** GitHub-first navigation tree, flattened: one **`owner/repo` row per
repository** (dimmed owner prefix, no separate org header level) with its sessions
directly under it, ordered by last activity. Sessions with no repo don't get a faux
repo nesting — they live in a flat **Chats** section pinned last: a section-style
header with the sessions directly under it. The sidebar is the exhaustive session list
(Home shows only a taste).

## Structure

- `.tree-top` (drag region, 40px top padding clears macOS traffic lights): app title
  button (→ home) · zoom chip (only when zoom ≠ 100%, warn-colored, click resets) ·
  Extensions and Settings `.icon-btn`s with octicon-style SVGs.
- `.search` input with ⌘K hint, 250ms debounce. Non-empty search swaps the whole tree for
  `SearchResults` grouped by repo name.
- Tree rows, in visual grammar:
  - `.section-row` — sticky (`top: 0`, solid `--bg2` so scrolling rows pass under it),
    lowercase micro-caps, plain-text session count (the Chats header).
  - `.repo-row` — chevron, repo icon, `owner/name` (owner prefix in dimmed `.repo-owner`;
    local repos show just the name), tiny per-provider logos (10px), bordered
    `.repo-count` pill = session count (the pill shape is reserved for this meaning).
  - `.session-row` — indented under a 1px left indent guide (`.repo-children`), agent
    logo, title, optional `.acct-chip` (only when that provider has multiple accounts),
    compact `PrBadge` **or** timestamp (exclusive slot), archived = strikethrough + dimmed.
  - Chats section — split off the repo tree by a full-bleed hairline divider + extra gap
    (`.chats-section`, suppressed when it's the only section): a `.section-row` header
    (comment icon, per-provider logos, session count as plain text) whose
    `.repo-children` are the sessions themselves: no repo row in between, same
    pagination and archived toggle as a repo.
- Hover/focus-within actions (`+` new session, archive) float in `.row-actions` over the
  row's right edge — nothing reflows.
- `.sidebar-footer`: one compact `.footer-ids` identity bar — agent logos, then the
  GitHub login (`@login`, or red "gh: not signed in") right-aligned in mono. Per-account
  detail lives in the tooltip; clicking the bar opens Settings. Don't grow this back into
  per-account rows — the footer is a glance, Settings is the manager.

## Pagination (product rule: always paginate)

- Sessions load `PAGE` (20) at a time via `pageSessions`; `.tree-more` shows
  `more… (loaded/total)`. Hard clamp `MAX_LOADED` (1000) matches the server-side page cap.
- Search caps at 100 items and says `N more — refine your search` — it never dumps everything.
- Live-index refetches must not churn row identity: `sameList` keeps the previous array
  when nothing visible changed. Preserve this when touching fetch logic.

## Keyboard & ARIA

- Container is `role="tree"` and the single Tab stop (`tabIndex={0}`): rows are
  `role="treeitem"` with `tabIndex={-1}` (roving focus). Focusing the tree forwards focus
  to the selected row, else the first row. Section/repo rows carry `aria-expanded` +
  `aria-level={1}`, sessions `aria-selected` + `aria-level={2}` (1 in flat search results).
- Arrow Up/Down/Home/End move focus across all visible rows (handled on `.tree`);
  Enter/Space activate; ArrowRight/Left expand/collapse repos. Extend this handler if new
  focusable row types appear — don't add per-row key handlers that fight it; new row types
  keep `tabIndex={-1}` so Tab never walks the list.
- First repo auto-expands exactly once; a later index update must never undo the user's
  collapse-all (the `autoExpanded` ref guards this).

## Selection identity

- Selected session = agent-colored gradient + 2px inset bar via `:has(.plogo-*)` —
  the agent's identity survives selection. New agents must slot into the same pattern
  (`--<agent>-rgb` token + `:has` rule), not a new selection style.
