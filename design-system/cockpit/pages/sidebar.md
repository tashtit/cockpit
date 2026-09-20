# Sidebar — Repo/Session Tree (`TreeSidebar.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** GitHub-first navigation tree, flattened: one **`owner/repo` row per
repository** (dimmed owner prefix, no separate org header level) with its sessions
directly under it, ordered by last activity. The repo rows themselves **never move on
activity** — a busy repo jumping to the top shifts every row under the cursor: they sort
A→Z by `owner/repo` (`src/shared/repo-order.ts`) or in the order the user dragged them
into. Sessions with no repo don't get a faux
repo nesting — they live in a flat **Chats** section pinned last: a section-style
header with the sessions directly under it. The sidebar is the exhaustive session list
(Home shows only a taste).

## Structure

- The sidebar is the **rail**: darker glass than the content panes (`color-mix` of
  `--bg-deep`), so the window reads as two materials. Its only filled control is the
  `.new-task-btn`.
- `.tree-top` (drag region, 40px top padding clears macOS traffic lights — the pad
  drops to `--s3` when the dev `.dev-banner` row already provides that clearance):
  app title button (→ home; the wordmark speaks the mono placard voice) · zoom chip
  (only when zoom ≠ 100%, warn-colored, click resets) · a `.tree-nav` group holding
  the Agents, Profile, Cleanup and Settings `.nav-btn`s (shared icons from
  `logos.tsx` — the same marks the ⌘K palette renders, so nav and palette can't
  drift). The top row is wordmark + navigation only.
  - **It gives way to the rail, not to the window.** The rail is `clamp()`ed off the
    viewport and zoom divides the viewport, so a `@media` width answers the wrong
    question — at 120% in a 1100pt window the viewport is still 916 CSS px while the
    rail has already clamped to 240px, and the nav keys used to walk across the
    rail's border onto the deck. `.tree-sidebar` is a `container: rail / inline-size`
    and the three tiers are `@container` rules at the end of style.css, each set to
    the width the row measurably stops fitting at: **≤282cqi** the wordmark's text
    sheds while the chip is up (the mark, which is the way home, stays), **≤237cqi**
    it sheds regardless, and **≤210cqi** — the 200px rail with a chip in it, which
    still wants 211 — `.tree-top` wraps and `.tree-nav` takes its own line,
    right-aligned. Nothing shrinks and nothing is taken away in that last tier on
    purpose: the person reading at 175% is the last one to hand a smaller target to.
    Without a chip the row is one line at every reachable rail width, which is the
    layout the floor is audited and screenshotted at. The open view's icon stays
  quietly lit (`.active` soft accent tint, no underline, `aria-current="page"`),
  and re-clicking it backs out (toggle); the footer and empty-state Settings
  entries stay open-only.
- `.search-row` — the tree's three controls on one line, in reading order: the eye
  project filter (scopes the tree), the search input (searches it), and
  `.new-task-btn`, an icon-only `.btn-primary` square (`aria-label="New task"`,
  ⌘N in the tooltip — creates). Icon-only on purpose — the accent fill alone says
  "this one creates"; keep it off the app-name row, which stays purely the
  wordmark. Everything else that starts a session is hover-revealed or keyboard.
- `.search` input, 250ms debounce (⌘K belongs to the palette, not this field —
  the search filters the tree in place; the palette jumps). Non-empty search swaps the
  whole tree for `SearchResults` grouped by repo name.
- Tree rows, in visual grammar:
  - `.section-row` — sticky (`top: 0`, opaque so scrolling rows pass under it), lowercase
    micro-caps, plain-text session count (the Chats header). Its fill is `--bg-deep`, the
    rail's own near-black, so at rest it is invisible and only the divider and the placard
    voice mark it: a `--bg2` fill on the darker rail read exactly like a selected row.
  - `.repo-row` — chevron, repo icon, `owner/name` (owner prefix in dimmed `.repo-owner`;
    local repos show just the name), tiny per-provider logos (10px), bordered
    `.repo-count` pill = session count (the pill shape is reserved for this meaning).
  - `.session-row` — indented under a 1px left indent guide (`.repo-children`), agent
    logo, title, optional `.acct-chip` (only on a **non-default** account's rows when that
    provider has several — the exception is what gets marked; the provider prefix is
    dropped, so `claude-work` reads `work`),
    then the exclusive meta slot, in order of urgency: the `.asks-mark` question glyph in
    the agent's color while its agent waits on you (`useSessionLanded` kind `asks` — it
    beats running, because the process is up but going nowhere), else agent-colored
    `LiveDot` while the session's provider process runs, else the rest of `LandingMark`
    while the session has something unseen — GitHub's x `.fix-mark` in `--danger` for a red
    pull request on its branch, a solid `.landed-dot` in the agent's color for a turn that
    ended — each with the full reason as its `aria-label` ("asks you: <question>",
    "PR #57 checks failing", "finished — not opened yet") and in the row's tooltip,
    else compact `PrBadge` (number, then an open PR's checks glyph,
    unresolved-thread count and changes-requested mark — each spelled out in its
    `aria-label`; ≤780px the row sheds the count's digits, `.pr-threads-n`, and keeps
    the glyph, or the badge takes half the row at the 560px floor), else timestamp. Archived = strikethrough + dimmed,
    plus an `sr-only` "(archived)" — the strikethrough is the only visual signal, so it
    can't be the only signal.
  - Chats section — split off the repo tree by a full-bleed hairline divider + extra gap
    (`.chats-section`, suppressed when it's the only section): a `.section-row` header
    (comment icon, per-provider logos, session count as plain text) whose
    `.repo-children` are the sessions themselves: no repo row in between, same
    pagination and archived toggle as a repo.
- Project order: a `.repo-row` is `draggable`; the whole `.repo-node` is the drop target
  (its upper 15px or half = before, the rest = after), marked by a 2px accent hairline
  (`.drop-before`/`.drop-after`) while the dragged node dims. ⌥↑/⌥↓ on a focused repo row
  is the keyboard equivalent and is announced in an `sr-only` status. A drop saves every
  project's key (`setRepoOrder`, config `repoOrder`); projects indexed later follow A→Z.
  The eye popover's header carries a quiet `sort A→Z` button only while the order differs
  from A→Z — it clears the saved order.
- Hover/focus-within actions (`+` new session, archive) float in `.row-actions` over the
  row's right edge — nothing reflows.
- `.sidebar-footer`: two quiet bar controls, 26px each, never taller. `.footer-usage`
  (`UsageMeters.tsx`) rides on top only while a subscription reports numbers: one
  `.usage-cell` per provider in livery order — 12px logo, a `.usage-mini` fill bar in
  the agent color when the provider reports a percentage, the reading (`42%`, or a
  compact count like `1.2M` tokens / `310` requests when no limit is known). The
  tightest window wins the cell; every window and its reset time sit in the cell's
  tooltip. Warning (≥80%, or copilot requests billed beyond the plan) = warn color
  **and** a triangle glyph, with "(warning)" in the button's name — never color alone.
  The bars shed at ≤700px (200px rail); the numbers stay. Clicking the row opens
  Settings at the usage section. Below it the `.footer-ids` identity bar — agent logos,
  then the GitHub login (`@login`, or red "gh: not signed in") right-aligned in mono;
  per-account detail in the tooltip, click opens Settings. Don't grow either back into
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
