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
**Stack:** Electron + React 18 + Vite, hand-written CSS (no Tailwind, no component library)
**Design Dials:** Motion 2/10 (Subtle) | Density 8/10 (Dense / Dashboard)
**Product direction:** GitHub-first; agent/GitHub visual identity; always worktrees + PRs

---

## Design Language

Refined OLED dark: deep gradient base (`--bg` → `--bg-deep`) with a faint accent aurora at
the top of the window, elevated translucent surfaces, hairline rgba borders, one indigo
accent, and **per-agent identity colors** used consistently everywhere an agent appears.
Neutrals, surfaces, and borders all carry a subtle indigo cast (tinted rgba, not pure
white/grey) so the whole app harmonizes with the accent. GitHub PR-state colors match
github.com exactly.

- Dark mode only. Never add a light theme without a full contrast re-audit.
- Density is intentionally high (11–13px UI chrome, 28–30px rows). This is a pro desktop tool, not a marketing site. The one deliberate exception: transcript prose and composer text read at `--fs-prose` (14px/1.6) — chrome is scanned, prose is read.
- Motion is subtle: 160ms `--ease` transitions on background/border/color only. No entrance choreography, no scroll reveals, no layout-shifting transforms (pressed state = `filter: brightness(0.88)`).

## Color Tokens (actual values from style.css)

| Role | Value | Token |
|------|-------|-------|
| Background (gradient top) | `#0b0d16` | `--bg` |
| Background (gradient bottom) | `#05060b` | `--bg-deep` |
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

**Rules:**
- Never introduce raw hex in components — always tokens.
- Two accents exist on purpose: `--accent` for text/icons on dark (passes contrast), `--accent-btn` for filled buttons under white text. Don't swap them.
- Agent tints use `rgba(var(--*-rgb), 0.10–0.16)` backgrounds with a solid agent-color border/inset — never solid agent-color fills behind text.
- Codex logo renders white-on-dark (like ChatGPT's own mark); teal is reserved for codex tints/borders.

## Typography

- **UI font:** system stack (`-apple-system, 'Inter', 'Segoe UI'`) — no webfont import; this is a desktop app, load nothing over the network.
- **Mono:** `--mono` (`ui-monospace, 'SF Mono', 'Fira Code'`) — used for account IDs, branches, paths, code. Mono = "machine identifier" is a semantic signal, keep it.
- **Scale:** `--fs-xs` 11 / `--fs-sm` 12 / `--fs-base` 13 / `--fs-prose` 14 / `--fs-md` 15 / `--fs-lg` 16 / `--fs-xl` 26. Body text never below `--fs-base`; `--fs-xs` is for metadata (chips, timestamps, counts) only; `--fs-prose` (with 1.6 line-height) is for transcript prose and composer textareas only.
- **Icon scale** (keep to these four steps, don't invent in-between sizes): 10px minis (per-provider dots on repo/section rows), 12px footer/metadata glyphs, 13–14px row icons (session logos, repo icons, avatars), 16px toolbar glyphs inside 28px `.icon-btn`s.
- **Micro-labels:** uppercase labels (`.ns-label`, `.inst-scope label`) are 600 weight with 0.9px tracking; lowercase section headers (`.section-row`, `.search-group`, `.repo-filter-head`) use 0.6px. Wide tracking at tiny sizes is the refinement signal — keep it consistent.
- `tabular-nums` on `time` and counts.

## Spacing & Shape

- **Spacing:** `--s1` 4 / `--s2` 6 / `--s3` 8 / `--s4` 12 / `--s5` 16 / `--s6` 24. Tree indent tokens: `--indent-1` 14 / `--indent-15` 22 / `--indent-2` 30.
- **Radii:** `--radius-sm` 6 / `--radius` 8 / `--radius-lg` 14; pills are `999px`.
- **Shadows:** cards float with `0 8px 40px rgba(0,0,0,0.35–0.4)`; the only glow is `--accent-glow` on primary buttons and focus rings.
- **Depth without new colors:** cards (`.composer-card`, `.ns-card`) and filled buttons (`.btn-primary`, `.btn-pr`) are top-lit — a `linear-gradient` from `--bg3`→`--bg2` (or a `color-mix` of the fill with white) plus a 1px `inset` white-rgba highlight. Reuse this recipe for new elevated elements; never invent new fill colors.

## Motion

- Single easing: `--ease: cubic-bezier(0.16, 1, 0.3, 1)`, 160ms, on background/border/color/box-shadow/opacity/filter only.
- Never animate width/height/margin (layout thrash). Pressed = brightness filter, hover = background/color shift.
- The only keyframe animation is the 1.2s `pulse` dot while an agent is working.
- `prefers-reduced-motion: reduce` kills all animation and transitions globally — keep that rule intact.

## Established Component Vocabulary

Reuse these; don't invent parallel variants:

- **`.acct-chip`** — the one account-identity component (mono pill, agent-tinted border; `.missing` = warn/italic).
- **`.pr-badge`** — PR state pill, GitHub colors, outline style.
- **`.branch-chip`** — branch-blue mono pill.
- **`.badge-{claude,codex,copilot}`** — solid agent badge (chat header).
- **Buttons:** `.btn-primary` (accent-btn fill + glow), `.btn-ghost` (bordered, quiet), `.btn-danger`, `.btn-pr` (green = GitHub merge-button semantics), `.icon-btn`, `.link-btn`.
- **Rows:** `.org-row` (sticky, lowercase), `.repo-row`, `.session-row` (selected = agent-colored gradient + inset bar), `.recent-row`. Hover actions float absolutely over the row's right edge — nothing reflows.
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

- Focus: global `:focus-visible` 2px accent outline; inputs get accent border + 3px glow ring. Never remove.
- Every icon-only button needs `aria-label` or `title`; decorative SVGs get `aria-hidden`.
- Loading: show feedback for anything >300ms (`.pulse` + "X is working…", `loading…` rows). Status changes announce via the `sr-only` `aria-live` region in ChatView.
- Long transcripts render only the last `RENDER_LAST` messages with an explicit "showing the last N of M" note; `Message` is memoized. Keep both when touching ChatView.
- Window drag regions: `.tree-top` and `.chat-header` are `-webkit-app-region: drag`; every interactive child must opt out with `no-drag`. Copyable text (paths, branches) must be `user-select: text` + `no-drag`.
- `.tree-top` top padding (40px) clears macOS traffic lights (hiddenInset) — don't shrink it.
- `.app > * { min-width: 0 }` is load-bearing: grid items default to `min-width: auto`, and without the guard the chat pane's fixed header children push the 1fr column wider than the window. Any new fixed-width header content must still fit a 560px window.
- Narrow windows (≤780px) shed decorative chips before anything truncates; short windows (≤600px) drop the home hero. Follow this "shed decoration first" pattern for new responsive cases. The shed media queries live at the **end** of style.css on purpose — earlier in the file they'd lose the cascade to same-specificity component rules; keep new shed rules there.
- Window drag: `.tree-top` and `.chat-header` are drag regions; every other view gets the fixed 22px `.drag-strip` along the top edge (rendered by App for non-chat views). Keep interactive content below 22px from the window top.

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

- [ ] Tokens only — no raw hex, px spacing from the `--s*` scale
- [ ] Icon-only controls have `aria-label`/`title`; decorative SVGs `aria-hidden`
- [ ] Focus visible on every new interactive element
- [ ] Hover + pressed states via background/brightness, 160ms `--ease`
- [ ] Async >300ms shows feedback; status announced politely where it matters
- [ ] Text on `--surface`/`--bg*` meets 4.5:1 (use `--fg` or `--fg-dim`, nothing dimmer)
- [ ] New chips/pills reuse the existing vocabulary (acct-chip, pr-badge, branch-chip…)
- [ ] Drag-region children marked `no-drag`; selectable text opted out
- [ ] Narrow/short window behavior: shed decoration, never horizontal-scroll
- [ ] `npm run typecheck` and `npm test` pass
