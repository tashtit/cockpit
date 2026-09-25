# Cockpit Design System — Master File

> **LOGIC:** When building a specific page/view, first check `design-system/cockpit/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

> **SOURCE OF TRUTH:** The canonical tokens live in `src/renderer/src/style.css` (`:root` block).
> This file documents them and the rules for using them. If the two ever disagree, style.css wins —
> then update this file to match.

---

**Project:** Cockpit — unified Electron desktop hub for Claude Code, Codex, and GitHub Copilot sessions
**Category:** Developer Tool / IDE (desktop, dark-only)
**Stack:** Electron + React 19 + Vite, hand-written CSS (no Tailwind, no component library)
**Design Dials:** Motion 2/10 (Subtle) | Density 8/10 (Dense / Dashboard)
**Product direction:** GitHub-first; agent/GitHub visual identity; always worktrees + PRs

---

## Design Language

Instrument-HUD dark (the 2026-08 bolder pass): a near-black base (`--bg` → `--bg-deep`)
under a static night-flight atmosphere — the aurora doubles as a radar source, with
faint concentric range rings (`--grid-line`) radiating across the glass, and a faint
horizon glow below. Rings, not graph paper: the texture is Cockpit's own. The window reads as two
materials: the **rail** (sidebar — darker glass, `color-mix` of `--bg-deep`) and the
**deck** (content panes on `--pane`). Elevated translucent surfaces, hairline rgba
borders, one steel-blue accent, and **per-agent identity colors** used consistently
everywhere an agent appears. Micro-labels and the hero speak the mono *placard* voice. Neutrals, surfaces, and borders all carry a subtle steel
cast (tinted rgba, not pure white/grey) so the whole app harmonizes with the accent —
primaries connect with the UI rather than shouting over it.
GitHub PR-state colors match github.com exactly.

- Dark mode only. Never add a light theme without a full contrast re-audit.
- Density is intentionally high (11–13px UI chrome, 28–30px rows). This is a pro desktop tool, not a marketing site. The one deliberate exception: transcript prose and composer text read at `--fs-prose` (14px/1.6) — chrome is scanned, prose is read.
- Motion is subtle: 160ms `--ease` transitions on background/border/color only. No entrance choreography, no scroll reveals, no layout-shifting transforms (pressed state = `filter: brightness(0.88)`).

## Color Tokens (actual values from style.css)

| Role | Value | Token |
|------|-------|-------|
| Background (gradient top) | `#0c1219` | `--bg` |
| Background (gradient bottom) | `#03070c` | `--bg-deep` |
| Range-ring line (decorative) | `rgba(156,178,198,0.035)` | `--grid-line` |
| Elevated surface 1 / 2 | `#131a23` / `#1d2733` | `--bg2` / `--bg3` |
| Translucent surface | `rgba(156,178,198,0.05)` | `--surface` |
| Border / strong border | `rgba(156,178,198,0.11)` / `0.19` | `--border` / `--border-strong` |
| Foreground / dim | `#e8edf2` / `#96a5b4` | `--fg` / `--fg-dim` |
| Accent, steel blue (text/icon on dark) | `#7fa9cf` | `--accent` |
| Accent (button fill, white text ≥4.5:1 at 5.6) | `#3d6a94` | `--accent-btn` |
| Accent glow ring | `rgba(72,110,148,0.22)` | `--accent-glow` |
| Claude / Codex / Copilot | `#d97757` / `#10a37f` / `#9a7bff` | `--claude` / `--codex` / `--copilot` |
| Branch blue | `#79b8ff` | `--branch` |
| PR open / merged / closed / draft | `#3fb950` / `#a371f7` / `#f85149` / `#8b949e` | `--pr-*` |
| Danger / OK / Warn | `#f85149` / `#2ea043` / `#d29922` | `--danger` / `--ok` / `--warn` |
| OK / danger button fills (white text ≥4.5:1) | `#238636` / `#da3633` | `--ok-btn` / `--danger-btn` |
| Text/icons on a filled button | `#fff` | `--white` |
| Codex mark (white-on-dark, like ChatGPT's own) | `#ececf1` | `--codex-mark` |

**Alpha companions.** Every color that also appears as a tint or border wash ships an
`-rgb` triplet so components write `rgba(var(--x-rgb), α)` and never re-type channels:
`--accent-rgb`, `--claude-rgb`, `--codex-rgb`, `--copilot-rgb`, `--danger-rgb`, `--ok-rgb`,
`--warn-rgb`, `--branch-rgb`. `--accent-rgb` is deliberately *not* either accent hex — it's the
deeper wash hue, so glows, selection gradients and user bubbles read as shadow-side accent
rather than a pale rinse of the button fill.

**Rules:**
- Never introduce raw hex or a bare `rgba(…)` in components — the `:root` block is the only
  place a literal color may appear. Everything below it composes tokens.
- Two accents exist on purpose: `--accent` for text/icons on dark (passes contrast), `--accent-btn` for filled buttons under white text. Don't swap them. The same split applies to OK/danger: `--ok`/`--danger` are text colors on dark, `--ok-btn`/`--danger-btn` are the darker button fills that keep white text at 4.5:1.
- Agent tints use `rgba(var(--*-rgb), 0.10–0.16)` backgrounds with a solid agent-color border/inset — never solid agent-color fills behind text.
- Codex logo renders `--codex-mark` white-on-dark (like ChatGPT's own mark); teal (`--codex`) is reserved for codex tints/borders.

## Typography

- **UI font:** `--sans` — **IBM Plex Sans**, bundled with the app (`src/renderer/src/assets/fonts/`, SIL OFL 1.1, license file beside it), falling back to the system stack. It is loaded from disk, never fetched: the rule is *nothing over the network*, and a desktop tool that borrows the OS UI face wears the OS's identity instead of its own. Plex was drawn for engineering documentation — a mechanical grotesque with humanist joints — which is the register this app speaks in. Only the weights the app sets ship (400/500/600/700 + one 400 italic), latin subset, ~160KB total. `body` carries `letter-spacing: -0.06px`: Plex sits a touch wide at 11–13px chrome sizes, and the hair of negative tracking keeps a dense row reading as one line.
- **Mono:** `--mono` — **IBM Plex Mono** (same bundle, falling back to `ui-monospace`/`SF Mono`) carries two registers, keep them distinct:
  - *machine identifiers* (normal case): account IDs, branches, paths, code — as always.
  - *placards* (the instrument voice): the home board's masthead (`.board-mast`,
    the one place this voice is set at display scale), home's greeting
    (`.home-greet`), the `COCKPIT` wordmark, view
    headings (`.ns-head h2`, `.empty-chat h2` — uppercase), tabs (`.pnl-pill`), the
    `.thinking` annunciator line, and every micro-label (`.ns-label`,
    `.board-agent`, `.section-row`, `.search-group`,
    `.repo-filter-head`, `.pv-stat dt`, `.pv-mix-label`) — re-voiced in the
    identity layer at the end of style.css. Session titles, body rows, buttons, and
    prose are user content and stay sans; mono display outside these two registers
    is a bug.
- **Scale:** `--fs-xs` 11 / `--fs-sm` 12 / `--fs-base` 13 / `--fs-prose` 14 / `--fs-md` 15 / `--fs-lg` 16 / `--fs-xl` 26. Body text never below `--fs-base` — a section's explanation (`.ns-prose`, `.scope-blurb`, `.pnl-blurb`, `.pnl-note`) is body text at `--fs-base`/1.5, one or two sentences, never a paragraph of mechanism; a row's second line (`.source-note`) is chrome at `--fs-sm`; `--fs-xs` is for metadata (chips, timestamps, counts, inline field notes such as `.ns-hint` under an input) only; `--fs-prose` (with 1.6 line-height) is for transcript prose and composer textareas only.
- **Icon scale** (keep to these four steps, don't invent in-between sizes): 10px minis (per-provider dots on repo/section rows), 12px footer/metadata glyphs, 13–14px row icons (session logos, repo icons, avatars), 16px toolbar glyphs inside 28px `.icon-btn`s.
- **Micro-labels:** uppercase labels (`.ns-label`) are 600 weight with 0.9px tracking; lowercase section headers (`.section-row`, `.search-group`, `.repo-filter-head`) use 0.6px. Wide tracking at tiny sizes is the refinement signal — keep it consistent.
- `tabular-nums` on `time` and counts.

## Spacing & Shape

- **Spacing:** `--s1` 4 / `--s2` 6 / `--s3` 8 / `--s4` 12 / `--s5` 16 / `--s6` 24. Tree indent tokens: `--indent-1` 14 / `--indent-15` 22 / `--indent-2` 30.
- **Radii:** `--radius-sm` 6 / `--radius` 8 / `--radius-lg` 14 / `--radius-pill` 999. Nothing off-scale (the one exception is the 5px scrollbar thumb, which is half its own 10px track — geometry, not a design radius).
- **Control heights — two steps only:** compact controls that share a row are **28px** (Select triggers, `.ns-opt`/`.source-add`/`.ns-branch-row` inputs — one shared recipe with an explicit `height`, because inputs don't inherit the body line-height and padding alone lands at ~24px, `.ns-account-single`, `.composer-identity`, `.btn-pr`, the composer bar's `.btn-primary`); standalone form buttons are **32px** (`.btn-primary`, `.btn-ghost`, `.btn-danger` in `.ns-actions`/composer footer). Never mix the two heights in one row — ragged bottom edges read as broken.
- **Shadows:** three tokens, no ad-hoc values — `--shadow-card` (floating cards), `--shadow-pop` (popovers/listboxes), `--shadow-fill` (contact shadow under a filled button). The only glow is `--accent-glow` on focus rings — filled buttons are flat (see Depth). Modal backdrops use `--scrim` (`--bg-deep`'s channels at 0.6) — the ⌘K palette is currently the only modal; a second one reuses the same scrim.
- **Depth without new colors:** cards (`.composer-card`, `.ns-card`) are top-lit — a `linear-gradient` from `--bg3`→`--bg2` — and filled buttons (`.btn-primary`, `.btn-pr`, `.btn-danger`) are **flat solid fills** (instrument keys, no gradients, no ambient glow), both finished with a 1px `inset` highlight: `--highlight` on cards/popovers, `--highlight-fill` on filled buttons, `--highlight-fill-off` when that button is disabled. Translucent chrome panes (chat header, composer, composer bar) are all `--pane`; the sidebar rail alone is darker glass (`color-mix` of `--bg-deep`). Reuse these; never invent new fill colors.

## Motion

- Single easing and single duration: `--ease: cubic-bezier(0.16, 1, 0.3, 1)` at `--dur: 160ms`, on background/border/color/box-shadow/opacity/filter only. Both are tokens — never re-type `160ms`.
- Never animate width/height/margin (layout thrash). Pressed = brightness filter, hover = background/color shift.
- The only keyframe animation is the 1.2s `pulse` dot while an agent is working (chat "working…" line + `LiveDot` in session/recent rows).
- `prefers-reduced-motion: reduce` kills all animation and transitions globally — keep that rule intact.

## Established Component Vocabulary

Reuse these; don't invent parallel variants:

- **`.acct-chip`** — the one account-identity component (mono pill, agent-tinted border; `.missing` = warn/italic).
- **`.pr-badge`** — PR state pill, GitHub colors, outline style. On an open PR it carries the checks verdict as a second glyph (`.pr-checks` — check / x / dot in `--ok` / `--danger` / `--warn`, so the shape carries the state), the unresolved review threads as the comment-discussion glyph plus their count (`.pr-threads`, in the badge's own color, only when there is at least one; a narrow sidebar row sheds the digits, `.pr-threads-n`, and keeps the glyph), and a 5px `.pr-review-mark` when changes were requested — in that order. All of them, plus approved / review required, are spelled out in the tooltip and `aria-label` ("3 unresolved threads"). Merged and closed PRs show none of them.
- **`.branch-chip`** — branch-blue mono pill (render via `BranchChip`: the constant `cockpit/` worktree prefix abbreviates to a dimmed `c/` so the distinguishing suffix wins truncation; full name in the tooltip).
- **`LiveDot`** (`.pulse.pulse-{agent}`) — 7px agent-colored pulse: "this session's agent is running right now". Occupies the row's exclusive meta slot (running beats landed beats PR badge beats timestamp) in sidebar session rows and board rows.
- **`LandingMark`** (`.landed-dot` / `.asks-mark` / `.fix-mark`) — the row's "needs you" mark, one per reason and three shapes so the reason never rides on colour: the same 7px solid, still dot in the agent's color ("its turn ended and you haven't looked yet"), the question glyph in the agent's livery ("it stopped to ask you something" — `asks you` / `needs permission`), and GitHub's x in `--danger` ("the pull request on its branch went red" — `#57 checks failing` / `changes requested`). Main owns the state (`attention-core.ts`) because it sees every turn end — Cockpit's own and the ones observed in terminal and desktop-app logs — and every PR refresh; the same set drives the Dock badge and desktop notifications, the renderer reports what the window shows (`setAttentionFocus`) so a watched session never lands, and `landed.ts` mirrors main's set for the rows, one reason per session (a question beats a red PR beats a landing). Always paired with a word (`landed <time>`, `asks you`, `#57 checks failing`, or the full reason as `aria-label` where the row has no meta text) — a mark alone would be a shape carrying state to sighted users only.
- **`.board`** — the app's signature element (home only): departure-board of sessions, flying first — livery-lit placard labels, branch chips, ticking elapsed time, under a masthead (`.board-mast`) whose **size is the alarm**: one quiet line while nothing needs you, the urgent phrase at `--fs-xl` the moment something does. Quiet `--surface` instrument panel; never give it the composer card's floating shadow. See `pages/home.md`.
- **`.pv-heat`** — activity heatmap (profile only): GitHub's week-column grid, but squares carry the **agent's** identity color (the agent that led that day) rather than the accent, so the grid doubles as an agent mix. The one sanctioned place agent tints exceed the 0.10–0.16 range — 11px squares hold no text. Every agent split on the profile paints the same three colors in one order, keyed once by the headline's `.pv-mix`. See `pages/profile.md`.
- **`FilterBar`** (`.fb-bar`) — the app's list-filtering surface: one row of dimension pills over a portaled include/exclude popover, with free text leftmost behind a hairline divider. The pill *is* the active-filter chip (it summarises its own selection: `Any` → `web` → `not docs` → `2 selected, 1 excluded`), so there is never a second row of filter tokens to keep in sync. Dimensions are pinned via a dashed `＋ Add filter`; one carrying a value is always shown whether pinned or not. OR within a dimension, AND across them. Generic over `FilterGroup` — reuse it rather than hand-rolling per-view filters. See `pages/cleanup.md`.
- **`.palette`** — the ⌘K jump surface (the app's one modal): combobox over sessions/repos/views on a `--scrim` backdrop, z 70 above every popover. Composer-card focus recipe for the frame; sidebar group/empty grammar for the list; empty query opens as the board in miniature (flying first). A jump surface, not an action executor. See `pages/palette.md`.
- **`.badge-{claude,codex,copilot}`** — solid agent badge (chat header).
- **Buttons:** `.btn-primary` (accent-btn fill + glow), `.btn-ghost` (bordered, quiet), `.btn-danger`, `.btn-pr` (green = GitHub merge-button semantics), `.icon-btn`, `.link-btn`. `.new-task-btn` is an icon-only `.btn-primary` square docked to the search row — the one always-visible entry point (mirrors ⌘N; `aria-label="New task"`); it is the rail's only filled control, keep it that way.
- **Lists are layout:** `ul, ol { padding: 0 }` is global — row lists sit flush with their section's left edge. Only transcript markdown restores an indent.
- **Rows:** `.section-row` (sticky, lowercase — the Chats header), `.repo-row`, `.session-row` (selected = agent-colored gradient + inset bar), `.board-row` (home), `.source-row` (settings/cards). Hover actions float absolutely over the row's right edge — nothing reflows.
- **`.rail-resizer`** (`RailResizer.tsx`) — the sash on the rail's right edge: the sidebar's width is the person's, dragged between 200px and what the deck can spare (`rail.ts`, remembered per machine in localStorage, never in config), invisible at rest and an accent hairline on hover, focus and while dragging. A `role=separator` whose value is the rail's *measured* width; ← → move it 16px (64 with ⇧), Home/End reach the bounds, double-click resets. Because the rail is dragged, anything that sheds *inside* it asks the rail (`@container rail`), never the window. See `pages/sidebar.md`.
- **Cards:** `.ns-card` — ONE width (`min(760px, 94%)`) shared by every card view (Settings, Agents, Profile, Cleanup, New session); navigating between them must never make the dialog jump sizes. `.composer-card` for the home prompt, in home's own `--home-col`.
- **Card tabs** (`TabList` + `TabPanel`, `Tabs.tsx`) — the one way a card view pages its content: a `.pnl-tabs.ns-tabs` row of `.pnl-pill` tabs (hairline under it) over **one** mounted panel. Settings, Agents, Profile and Cleanup all use it. **A tab replaces the panel; nothing in a card scrolls to a heading further down** — a jump row that scrolled took the title, the row and Close off screen with it, and a card of stacked sections read as one long page. Switching mounts the panel fresh (two panels built alike must never share internal state) and puts the card's scroller back at `scrollTop 0`. The row is one tab stop (roving `tabIndex`; ←/→ wrap, Home/End), only the selected tab carries `aria-controls`, and the panel is named by its tab — so a panel holding one group carries no heading that repeats the pill, and a panel holding several names each group with an `h3` that doesn't either. A tab may carry its count (`.pnl-pill-n`, left off at zero), a warn tone or an amber dot. Controls that govern every tab (Cleanup's threshold, Agents' scope, Profile's headline numbers) sit above the row; the pill row must hold in two rows at the 560px floor. A new card view that grows past a screen gets tabs, not a jump row.
- **Chat:** user bubbles right (accent tint), assistant left with avatar; `.tool-row` = collapsed `<details>` one-liners, or a `.tool-open` button when the call carries a plan, to-dos or an edit; `.sys-row` = dotted-left-border annotations; streaming = accent left border.
- **`.work-panel`** (`WorkPanel.tsx`) — the agent's plan, to-dos and edits beside the transcript (chat only, `.btn-work` / ⌘J, or one click on a `.tool-row.tool-open` row): card tabs over one scroller, the review's file blocks for edits, and under 720px of `@container chat-deck` it covers the conversation instead. See `pages/chat.md`.
- **`.review`** — the worktree's changes in the transcript's place (chat only, `.btn-review` / ⌘D): the instructions review's `.idiff-*` line grammar with line numbers, a scope switch, and line notes that go back to the agent through the composer. With an open PR it leads with `.review-pr` (what the PR waits on + "Fix with <Agent>") and shows reviewers' unresolved threads (`.review-thread`) under their lines. See `pages/chat.md`.
- **Semantic count pills:** bordered pill = "session count on a repo"; org counts are plain text.
- **`Select`** — the one dropdown (see Native Controls); never a raw `<select>`.
- **`.tint-{claude,codex,copilot}`** — rest-intensity agent identity for bordered rows (2px inset bar + faint gradient); used by settings source rows and ai-setup instruction files.

## Native Controls

Nothing renders with stock Chromium chrome:

- **Dropdowns are never native `<select>`** — OS popups can't be styled. Use the `Select` component (`Select.tsx`): trigger button + portaled fixed-position listbox (portal is load-bearing: `backdrop-filter` ancestors trap fixed positioning, `overflow: hidden` cards clip it). It carries the full keyboard contract (arrows/Home/End, Enter/Space, Escape-returns-focus, type-ahead) and ARIA listbox semantics — don't reimplement dropdowns. Variants: `mono` (machine identifiers), `quiet` (borderless, inside an already-bordered control). A read-only value next to Selects uses `.ns-account-single` (trigger-shaped, inert).
- `:root { color-scheme: dark }` keeps remaining native surfaces (autofill, fallback scrollbars) dark — never remove it.
- Custom scrollbars are **classic, not overlay** — two consequences, both handled globally and load-bearing: scrolling containers that center content reserve their gutters (`scrollbar-gutter: stable both-edges` on card views + home, `stable` on the transcript) so a scrollbar's arrival never shifts layout; and `::-webkit-scrollbar-corner` / `::-webkit-resizer` are repainted (Chromium defaults them to white squares once scrollbars are styled). A new scrolling view that centers content must reserve its gutter the same way.
- Checkboxes/radios use `accent-color: var(--accent)`; text inputs get `caret-color: var(--accent)`; placeholders are `--fg-dim`.
- Every `<summary>` draws its own ▸ indicator (UA markers are globally suppressed) — a new `<details>` must add one, or it will look inert.

## Vocabulary

- **One name per thing.** A directory an agent CLI keeps its sessions and sign-in in is a **config home** — in buttons, hints, empty states, aria labels, backups and the docs. ("Source" is the code's word, `SourceDir`, and stays in code.) A second word for the same object in the UI makes people wonder whether it is a second object.

- **A path a person reads is never raw.** Home directories collapse to `~` (`shortPath`), and a directory whose location carries no information — a worktree, a table's room — is named instead of spelled out (`cwdLabel`). Headers, prose and chips all follow this; the absolute path belongs in the tooltip, in what a click copies, and in text an agent reads (a handoff briefing). Applies wherever a cwd is shown: Chat, Roundtable, Handoff.

## Interaction Rules

- Focus: global `:focus-visible` 2px accent outline at `outline-offset: -1px`; **filled buttons** (`.btn-primary`, `.btn-pr`, `.btn-danger`) flip to `+2px` — inset, the accent ring sits on the button's own fill at 1.7–1.9:1 and fails 1.4.11. Inputs get accent border + 3px glow ring. Never remove.
- Every icon-only button needs `aria-label` or `title`; decorative SVGs **and glyphs** (`▸`, `⚙︎`) get `aria-hidden`.
- **Target size:** every control is ≥24×24 CSS px (WCAG 2.5.8) — that's the floor for `.icon-btn.small`, `.pr-badge`, `.btn-ghost.small`, `.mcp-remove`, `.tree-more`, `.archived-toggle`. Small type is fine; small hit areas are not. The one exception is the rail's sash (`.rail-resizer`, 8px wide): a sash *is* the edge it moves, and its keyboard path (← → Home End) is the wide target.
- **Never let color alone carry state.** Strikethrough-only (archived rows) and border-color-only (compact `.pr-badge`) both need the state word in an `sr-only` span or `aria-label`.
- `Select` names its trigger from label + value via `aria-labelledby` — an `aria-label` there would replace the contents and silence the chosen option.
- Loading: show feedback for anything >300ms (`.pulse` + "X is working…", `loading…` rows). Status changes announce via the `sr-only` `aria-live` region in ChatView.
- Long transcripts render only the last `RENDER_LAST` messages with an explicit "showing the last N of M" note; `Message` is memoized. Keep both when touching ChatView.
- Window drag regions: `.tree-top` and `.chat-header` are `-webkit-app-region: drag`; every interactive child must opt out with `no-drag`. Copyable text (paths, branches) must be `user-select: text` + `no-drag`.
- `.tree-top` top padding clears the macOS traffic lights (hiddenInset, y=14 and ~12 tall) — don't shrink it. It is `--traffic-clear`, the file's one length divided by `--zoom` (the live factor, written on `:root` by App.tsx): the lights are drawn by the OS at a fixed physical size while everything else here is in CSS pixels, so a flat 40px left only 2pt of margin at 70% and wasted 40 at 200%. Nothing else should need `--zoom` — reach for it only for something that has to meet OS chrome.
- `.app > * { min-width: 0 }` is load-bearing: grid items default to `min-width: auto`, and without the guard the chat pane's fixed header children push the 1fr column wider than the window. Any new fixed-width header content must still fit a 560px window.
- **Supported minimum window: 560×420 CSS pixels** — `WINDOW_FLOOR` in `src/shared/window.ts`, enforced as the BrowserWindow minimum in `src/main/index.ts` and gated by the e2e minimum-size audit (no horizontal overflow, chrome rows contained, key controls visible at exactly that size — home, palette, Agents, every Settings, Profile and Cleanup tab, and chat are audited). At that size `.source-row`s wrap their health readout and action under the label, and usage windows put the label on its own line over a flexing meter. Anything new must hold there; change the floor and the gate together. A window holds that many CSS pixels only at 100% — zoom divides them — so main raises the OS minimum with the zoom factor (`zoomedFloor`, bounded by the display's work area) rather than letting ⌘+ walk the layout through the floor. Write responsive rules down to the floor; below it there is exactly one tier (`≤559px`, for the display too small to grant the zoomed floor — a 1280-point screen at 200% can spare the width but not the height), and it exists so nothing escapes the window, not so the layout rearranges. Everything you design lives at the floor and above.
- Narrow windows (≤780px) shed decorative chips before anything truncates; short windows (≤600px) shed home's greeting and the masthead's sub-line, then the masthead's alarm scale; ≤559px — under the floor — the chat header's keys take a second line. Follow this "shed decoration first" pattern for new responsive cases. The shed rules live at the **end** of style.css on purpose — earlier in the file they'd lose the cascade to same-specificity component rules; keep new shed rules there.
- **Three widths and a zoom.** `npm run ui:tour` shoots every width-budgeted view at 1280×820, at an ordinary 900×700 window, at the 560×420 floor, and at 200% in a 1280×820 window. The middle width is not decoration: cards are the window minus a user-draggable sidebar, so a layout can be correct at both ends and wrong between them (the home board pushing the composer off the bottom edge, a Settings usage row painting over the session count — both invisible at 1280 and at the floor). The zoom pass is the fourth size nobody drags to — 640×410 of layout at type sizes none of the other three show, which is where a reader who needs 200% actually works. Check the mid and zoom shots before calling a layout change done.
- **A breakpoint is the last resort, not the first.** The window is only one of the widths in play — the sidebar is user-draggable, so a card's own width is not a function of the viewport. Where a row can say what it needs, it says it intrinsically (`flex-wrap: wrap` plus a flex-basis, `nowrap` on the phrases that must not break; `.source-row` is the worked example, see `pages/settings.md`) and gives way on its own at every width. Reach for a media query only for what is genuinely about the window.
- **And where the container is not the window, ask the container.** A `@media` width is a proxy, and zoom is what exposes the proxy: it divides the viewport by the zoom factor while a `clamp()`ed column hits its floor at a different point, so the two answers separate — and the rail is dragged, so its width is not a function of the window at all. The rail is the worked example — `.tree-sidebar` is a `container: rail / inline-size` and every shed inside it (the top row's tiers, the rows' chips, the footer's usage bars) is `@container rail (max-width: …)`, measured against the rail's own content box (one pixel less than the grid track). The profile's `.pv-heat-scroll`, `.pv-compare-wrap` and `.pv-accounts` are the others. Thresholds are the width the row *stops fitting at*, measured in the running app, not estimated — write the number in a comment so the next reader can re-derive it.
- Window drag: `.tree-top` and `.chat-header` are drag regions; every other view gets the fixed 22px `.drag-strip` along the top edge (rendered by App for non-chat views). Keep interactive content below 22px from the window top.
- Dev builds only: a 28px `.dev-banner` row spans the top of the grid naming the source branch (parallel worktree dev instances are otherwise identical). Branch-tinted, mono, also a drag region with selectable `no-drag` text; it absorbs the traffic-light clearance, so `.tree-top` sheds its 40px pad under it. Never renders in a packaged app.

## Anti-Patterns (Do NOT Use)

- ❌ Light-mode defaults or network-loaded assets — fonts ship *inside* the app (see Typography); nothing is ever fetched at runtime
- ❌ Raw hex in components (tokens only)
- ❌ Emojis as icons — SVG only (see `logos.tsx`); if a unicode glyph is unavoidable, force text presentation with U+FE0E
- ❌ Layout-shifting hover/pressed transforms (translate/scale on rows or buttons)
- ❌ Removing focus rings or the reduced-motion block
- ❌ New accent colors — agent colors + one steel-blue accent + GitHub semantic colors is the whole palette
- ❌ Spinner-less async operations
- ❌ Array-index keys for reorderable lists (ChatView's row keys are minted per row by `chat-log.ts` and survive a re-read — not indexes)

## Pre-Delivery Checklist

- [ ] Tokens only — no raw hex or bare `rgba()` outside `:root`, px spacing from the `--s*` scale, radii from `--radius*`, transitions at `--dur`/`--ease`
- [ ] Icon-only controls have `aria-label`/`title`; decorative SVGs `aria-hidden`
- [ ] Focus visible on every new interactive element
- [ ] Hover + pressed states via background/brightness, 160ms `--ease`
- [ ] Async >300ms shows feedback; status announced politely where it matters
- [ ] Text on `--surface`/`--bg*` meets 4.5:1 (use `--fg` or `--fg-dim`, nothing dimmer)
- [ ] New chips/pills reuse the existing vocabulary (acct-chip, pr-badge, branch-chip…)
- [ ] Markup deleted? Its rules go with it, and any mention of them here — `tests/style-reachability.test.ts` fails on a class nothing can emit
- [ ] Drag-region children marked `no-drag`; selectable text opted out
- [ ] Narrow/short window behavior: shed decoration, never horizontal-scroll
- [ ] `npm run typecheck` and `npm test` pass
- [ ] Looked at, not just tested: `npm run ui:tour`, and the affected views in `test-results/ui-tour/index.html` at all three sizes — the 900×700 shot especially, which is the one no breakpoint is written for
