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
under a static night-flight atmosphere — a whisper-faint instrument grid (`--grid-line`),
a strong indigo aurora above, a faint horizon glow below. The window reads as two
materials: the **rail** (sidebar — darker glass, `color-mix` of `--bg-deep`) and the
**deck** (content panes on `--pane`). Elevated translucent surfaces, hairline rgba
borders, one indigo accent, and **per-agent identity colors** used consistently
everywhere an agent appears. Micro-labels and the hero speak the mono *placard* voice;
the two command surfaces (home composer, ⌘K palette) carry HUD corner brackets — the
system's one decorative motif. Neutrals, surfaces, and borders all carry a subtle indigo
cast (tinted rgba, not pure white/grey) so the whole app harmonizes with the accent.
GitHub PR-state colors match github.com exactly.

- Dark mode only. Never add a light theme without a full contrast re-audit.
- Density is intentionally high (11–13px UI chrome, 28–30px rows). This is a pro desktop tool, not a marketing site. The one deliberate exception: transcript prose and composer text read at `--fs-prose` (14px/1.6) — chrome is scanned, prose is read.
- Motion is subtle: 160ms `--ease` transitions on background/border/color only. No entrance choreography, no scroll reveals, no layout-shifting transforms (pressed state = `filter: brightness(0.88)`).

## Color Tokens (actual values from style.css)

| Role | Value | Token |
|------|-------|-------|
| Background (gradient top) | `#0b0d16` | `--bg` |
| Background (gradient bottom) | `#020308` | `--bg-deep` |
| Instrument grid line (decorative) | `rgba(167,178,255,0.025)` | `--grid-line` |
| Elevated surface 1 / 2 | `#121521` / `#1b2031` | `--bg2` / `--bg3` |
| Translucent surface | `rgba(167,178,255,0.05)` | `--surface` |
| Border / strong border | `rgba(167,178,255,0.11)` / `0.19` | `--border` / `--border-strong` |
| Foreground / dim | `#eceef8` / `#9aa3bf` | `--fg` / `--fg-dim` |
| Accent (text/icon on dark) | `#8b95ff` | `--accent` |
| Accent (button fill, white text ≥4.5:1) | `#545ee0` | `--accent-btn` |
| Accent glow ring | `rgba(94,106,210,0.22)` | `--accent-glow` |
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

- **UI font:** system stack (`-apple-system, 'Inter', 'Segoe UI'`) — no webfont import; this is a desktop app, load nothing over the network.
- **Mono:** `--mono` (`ui-monospace, 'SF Mono', 'Fira Code'`) carries two registers, keep them distinct:
  - *machine identifiers* (normal case): account IDs, branches, paths, code — as always.
  - *placards* (the instrument voice): the hero h2, the `COCKPIT` wordmark, view
    headings (`.ns-head h2`, `.empty-chat h2` — uppercase), tabs (`.ext-tab`), the
    `.thinking` annunciator line, and every micro-label (`.ns-label`,
    `.board-eyebrow`, `.board-agent`, `.section-row`, `.search-group`,
    `.repo-filter-head`, `.inst-scope label`, `.pv-stat span`) — re-voiced in the
    identity layer at the end of style.css. Session titles, body rows, buttons, and
    prose are user content and stay sans; mono display outside these two registers
    is a bug.
- **Scale:** `--fs-xs` 11 / `--fs-sm` 12 / `--fs-base` 13 / `--fs-prose` 14 / `--fs-md` 15 / `--fs-lg` 16 / `--fs-xl` 26. Body text never below `--fs-base`; `--fs-xs` is for metadata (chips, timestamps, counts) only; `--fs-prose` (with 1.6 line-height) is for transcript prose and composer textareas only.
- **Icon scale** (keep to these four steps, don't invent in-between sizes): 10px minis (per-provider dots on repo/section rows), 12px footer/metadata glyphs, 13–14px row icons (session logos, repo icons, avatars), 16px toolbar glyphs inside 28px `.icon-btn`s.
- **Micro-labels:** uppercase labels (`.ns-label`, `.inst-scope label`) are 600 weight with 0.9px tracking; lowercase section headers (`.section-row`, `.search-group`, `.repo-filter-head`) use 0.6px. Wide tracking at tiny sizes is the refinement signal — keep it consistent.
- `tabular-nums` on `time` and counts.

## Spacing & Shape

- **Spacing:** `--s1` 4 / `--s2` 6 / `--s3` 8 / `--s4` 12 / `--s5` 16 / `--s6` 24. Tree indent tokens: `--indent-1` 14 / `--indent-15` 22 / `--indent-2` 30.
- **Radii:** `--radius-sm` 6 / `--radius` 8 / `--radius-lg` 14 / `--radius-pill` 999. Nothing off-scale (the one exception is the 5px scrollbar thumb, which is half its own 10px track — geometry, not a design radius).
- **Control heights — two steps only:** compact controls that share a row are **28px** (Select triggers, `.ns-opt`/`.source-add`/`.ns-branch-row` inputs, `.ns-account-single`, `.composer-identity`, `.btn-pr`, the composer bar's `.btn-primary`); standalone form buttons are **32px** (`.btn-primary`, `.btn-ghost`, `.btn-danger` in `.ns-actions`/composer footer). Never mix the two heights in one row — ragged bottom edges read as broken.
- **Shadows:** three tokens, no ad-hoc values — `--shadow-card` (floating cards), `--shadow-pop` (popovers/listboxes), `--shadow-fill` (contact shadow under a filled button). The only glow is `--accent-glow` on primary buttons and focus rings. Modal backdrops use `--scrim` (`--bg-deep`'s channels at 0.6) — the ⌘K palette is currently the only modal; a second one reuses the same scrim.
- **Depth without new colors:** cards (`.composer-card`, `.ns-card`) and filled buttons (`.btn-primary`, `.btn-pr`) are top-lit — a `linear-gradient` from `--bg3`→`--bg2` (or a `color-mix` of the fill with `--white`) plus a 1px `inset` highlight: `--highlight` on cards/popovers, `--highlight-fill` on filled buttons, `--highlight-fill-off` when that button is disabled. Translucent chrome panes (chat header, composer, composer bar) are all `--pane`; the sidebar rail alone is darker glass (`color-mix` of `--bg-deep`). Reuse these; never invent new fill colors.
- **HUD corner brackets** (`::after`, 8 corner-leg gradients at `rgba(--accent-rgb, 0.55)`): reserved for the two command surfaces — `.composer-card` and `.palette`. Don't spread them; one motif stays a signature, four become wallpaper.

## Motion

- Single easing and single duration: `--ease: cubic-bezier(0.16, 1, 0.3, 1)` at `--dur: 160ms`, on background/border/color/box-shadow/opacity/filter only. Both are tokens — never re-type `160ms`.
- Never animate width/height/margin (layout thrash). Pressed = brightness filter, hover = background/color shift.
- The only keyframe animation is the 1.2s `pulse` dot while an agent is working (chat "working…" line + `LiveDot` in session/recent rows).
- `prefers-reduced-motion: reduce` kills all animation and transitions globally — keep that rule intact.

## Established Component Vocabulary

Reuse these; don't invent parallel variants:

- **`.acct-chip`** — the one account-identity component (mono pill, agent-tinted border; `.missing` = warn/italic).
- **`.pr-badge`** — PR state pill, GitHub colors, outline style.
- **`.branch-chip`** — branch-blue mono pill (render via `BranchChip`: the constant `cockpit/` worktree prefix abbreviates to a dimmed `c/` so the distinguishing suffix wins truncation; full name in the tooltip).
- **`LiveDot`** (`.pulse.pulse-{agent}`) — 7px agent-colored pulse: "this session's agent is running right now". Occupies the row's exclusive meta slot (running beats PR badge beats timestamp) in sidebar session rows and board rows.
- **`.board`** — the app's signature element (home only): departure-board of sessions, flying first — livery-lit placard labels, branch chips, ticking elapsed time. Quiet `--surface` instrument panel; never give it the composer card's floating shadow. See `pages/home.md`.
- **`.pv-heat`** — activity heatmap (profile only): GitHub's week-column grid, but squares carry the **agent's** identity color (the agent that led that day) rather than the accent, so the grid doubles as an agent mix. The one sanctioned place agent tints exceed the 0.10–0.16 range — 11px squares hold no text. See `pages/profile.md`.
- **`.palette`** — the ⌘K jump surface (the app's one modal): combobox over sessions/repos/views on a `--scrim` backdrop, z 70 above every popover. Composer-card focus recipe for the frame; sidebar group/empty grammar for the list; empty query opens as the board in miniature (flying first). A jump surface, not an action executor. See `pages/palette.md`.
- **`.badge-{claude,codex,copilot}`** — solid agent badge (chat header).
- **Buttons:** `.btn-primary` (accent-btn fill + glow), `.btn-ghost` (bordered, quiet), `.btn-danger`, `.btn-pr` (green = GitHub merge-button semantics), `.icon-btn`, `.link-btn`. `.new-task-btn` is an icon-only `.btn-primary` square docked to the search row — the one always-visible entry point (mirrors ⌘N; `aria-label="New task"`); it is the rail's only filled control, keep it that way.
- **Rows:** `.section-row` (sticky, lowercase — the Chats header), `.repo-row`, `.session-row` (selected = agent-colored gradient + inset bar), `.recent-row`. Hover actions float absolutely over the row's right edge — nothing reflows.
- **Cards:** `.ns-card` (600px, `.wide` 760px) for forms; `.composer-card` for the home prompt.
- **Chat:** user bubbles right (accent tint), assistant left with avatar; `.tool-row` = collapsed `<details>` one-liners; `.sys-row` = dotted-left-border annotations; streaming = accent left border.
- **Semantic count pills:** bordered pill = "session count on a repo"; org counts are plain text.
- **`Select`** — the one dropdown (see Native Controls); never a raw `<select>`.
- **`.tint-{claude,codex,copilot}`** — rest-intensity agent identity for bordered rows (2px inset bar + faint gradient); used by settings source rows and ai-setup instruction files.

## Native Controls

Nothing renders with stock Chromium chrome:

- **Dropdowns are never native `<select>`** — OS popups can't be styled. Use the `Select` component (`Select.tsx`): trigger button + portaled fixed-position listbox (portal is load-bearing: `backdrop-filter` ancestors trap fixed positioning, `overflow: hidden` cards clip it). It carries the full keyboard contract (arrows/Home/End, Enter/Space, Escape-returns-focus, type-ahead) and ARIA listbox semantics — don't reimplement dropdowns. Variants: `mono` (machine identifiers), `quiet` (borderless, inside an already-bordered control). A read-only value next to Selects uses `.ns-account-single` (trigger-shaped, inert).
- `:root { color-scheme: dark }` keeps remaining native surfaces (autofill, fallback scrollbars) dark — never remove it.
- Checkboxes/radios use `accent-color: var(--accent)`; text inputs get `caret-color: var(--accent)`; placeholders are `--fg-dim`.
- Every `<summary>` draws its own ▸ indicator (UA markers are globally suppressed) — a new `<details>` must add one, or it will look inert.

## Interaction Rules

- Focus: global `:focus-visible` 2px accent outline at `outline-offset: -1px`; **filled buttons** (`.btn-primary`, `.btn-pr`, `.btn-danger`) flip to `+2px` — inset, the accent ring sits on the button's own fill at 1.7–1.9:1 and fails 1.4.11. Inputs get accent border + 3px glow ring. Never remove.
- Every icon-only button needs `aria-label` or `title`; decorative SVGs **and glyphs** (`▸`, `⚙︎`) get `aria-hidden`.
- **Target size:** every control is ≥24×24 CSS px (WCAG 2.5.8) — that's the floor for `.icon-btn.small`, `.pr-badge`, `.btn-ghost.small`, `.mcp-remove`, `.tree-more`, `.archived-toggle`. Small type is fine; small hit areas are not.
- **Never let color alone carry state.** Strikethrough-only (archived rows) and border-color-only (compact `.pr-badge`) both need the state word in an `sr-only` span or `aria-label`.
- `Select` names its trigger from label + value via `aria-labelledby` — an `aria-label` there would replace the contents and silence the chosen option.
- Loading: show feedback for anything >300ms (`.pulse` + "X is working…", `loading…` rows). Status changes announce via the `sr-only` `aria-live` region in ChatView.
- Long transcripts render only the last `RENDER_LAST` messages with an explicit "showing the last N of M" note; `Message` is memoized. Keep both when touching ChatView.
- Window drag regions: `.tree-top` and `.chat-header` are `-webkit-app-region: drag`; every interactive child must opt out with `no-drag`. Copyable text (paths, branches) must be `user-select: text` + `no-drag`.
- `.tree-top` top padding (40px) clears macOS traffic lights (hiddenInset) — don't shrink it.
- `.app > * { min-width: 0 }` is load-bearing: grid items default to `min-width: auto`, and without the guard the chat pane's fixed header children push the 1fr column wider than the window. Any new fixed-width header content must still fit a 560px window.
- Narrow windows (≤780px) shed decorative chips before anything truncates; short windows (≤600px) drop the home hero. Follow this "shed decoration first" pattern for new responsive cases. The shed media queries live at the **end** of style.css on purpose — earlier in the file they'd lose the cascade to same-specificity component rules; keep new shed rules there.
- Window drag: `.tree-top` and `.chat-header` are drag regions; every other view gets the fixed 22px `.drag-strip` along the top edge (rendered by App for non-chat views). Keep interactive content below 22px from the window top.
- Dev builds only: a 28px `.dev-banner` row spans the top of the grid naming the source branch (parallel worktree dev instances are otherwise identical). Branch-tinted, mono, also a drag region with selectable `no-drag` text; it absorbs the traffic-light clearance, so `.tree-top` sheds its 40px pad under it. Never renders in a packaged app.

## Anti-Patterns (Do NOT Use)

- ❌ Light-mode defaults, webfont imports, or network-loaded assets
- ❌ Raw hex in components (tokens only)
- ❌ Emojis as icons — SVG only (see `logos.tsx`); if a unicode glyph is unavoidable, force text presentation with U+FE0E
- ❌ Layout-shifting hover/pressed transforms (translate/scale on rows or buttons)
- ❌ Removing focus rings or the reduced-motion block
- ❌ New accent colors — agent colors + one indigo accent + GitHub semantic colors is the whole palette
- ❌ Spinner-less async operations
- ❌ Array-index keys for reorderable lists (append-only log offsets are the sanctioned exception in ChatView)

## Pre-Delivery Checklist

- [ ] Tokens only — no raw hex or bare `rgba()` outside `:root`, px spacing from the `--s*` scale, radii from `--radius*`, transitions at `--dur`/`--ease`
- [ ] Icon-only controls have `aria-label`/`title`; decorative SVGs `aria-hidden`
- [ ] Focus visible on every new interactive element
- [ ] Hover + pressed states via background/brightness, 160ms `--ease`
- [ ] Async >300ms shows feedback; status announced politely where it matters
- [ ] Text on `--surface`/`--bg*` meets 4.5:1 (use `--fg` or `--fg-dim`, nothing dimmer)
- [ ] New chips/pills reuse the existing vocabulary (acct-chip, pr-badge, branch-chip…)
- [ ] Drag-region children marked `no-drag`; selectable text opted out
- [ ] Narrow/short window behavior: shed decoration, never horizontal-scroll
- [ ] `npm run typecheck` and `npm test` pass
