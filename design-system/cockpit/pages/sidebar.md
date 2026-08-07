# Sidebar — Org/Repo/Session Tree (`TreeSidebar.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** GitHub-first navigation tree: org (owner) → repo → sessions, ordered
GitHub orgs first, then Local, each by last activity. Sessions with no repo don't get a
faux org/repo nesting — they live in a flat **Chats** section pinned last: an org-style
header with the sessions directly under it. The sidebar is the exhaustive session list
(Home shows only a taste).

## Structure

- `.tree-top` (drag region, 40px top padding clears macOS traffic lights): app title
  button (→ home) · zoom chip (only when zoom ≠ 100%, warn-colored, click resets) ·
  Extensions and Settings `.icon-btn`s with octicon-style SVGs.
- `.search` input with ⌘K hint, 250ms debounce. Non-empty search swaps the whole tree for
  `SearchResults` grouped by repo name.
- Tree rows, in visual grammar:
  - `.org-row` — sticky (`top: 0`, solid `--bg2` so scrolling rows pass under it),
    lowercase micro-caps, plain-text repo count.
  - `.repo-row` — chevron, repo icon, name, tiny per-provider logos (9px), bordered
    `.repo-count` pill = session count (the pill shape is reserved for this meaning).
  - `.session-row` — indented under a 1px left indent guide (`.repo-children`), agent
    logo, title, optional `.acct-chip` (only when that provider has multiple accounts),
    compact `PrBadge` **or** timestamp (exclusive slot), archived = strikethrough + dimmed.
  - Chats section — an `.org-row` header (comment icon, per-provider logos, session
    count as plain text) whose `.repo-children` are the sessions themselves: no repo row
    in between, same pagination and archived toggle as a repo.
- Hover/focus-within actions (`+` new session, archive) float in `.row-actions` over the
  row's right edge — nothing reflows.
- `.sidebar-footer`: who each agent runs as (always visible), plus GitHub identity from
  `gh` — `@login` or red "gh: not signed in".

## Pagination (product rule: always paginate)

- Sessions load `PAGE` (20) at a time via `pageSessions`; `.tree-more` shows
  `more… (loaded/total)`. Hard clamp `MAX_LOADED` (1000) matches the server-side page cap.
- Search caps at 100 items and says `N more — refine your search` — it never dumps everything.
- Live-index refetches must not churn row identity: `sameList` keeps the previous array
  when nothing visible changed. Preserve this when touching fetch logic.

## Keyboard & ARIA

- Container is `role="tree"`; org/repo/session rows are `role="treeitem"` with
  `tabIndex={0}`; org/repo carry `aria-expanded`, sessions `aria-selected`.
- Arrow Up/Down/Home/End move focus across all visible rows (handled on `.tree`);
  Enter/Space activate; ArrowRight/Left expand/collapse repos. Extend this handler if new
  focusable row types appear — don't add per-row key handlers that fight it.
- First repo auto-expands exactly once; a later index update must never undo the user's
  collapse-all (the `autoExpanded` ref guards this).

## Selection identity

- Selected session = agent-colored gradient + 2px inset bar via `:has(.plogo-*)` —
  the agent's identity survives selection. New agents must slot into the same pattern
  (`--<agent>-rgb` token + `:has` rule), not a new selection style.
