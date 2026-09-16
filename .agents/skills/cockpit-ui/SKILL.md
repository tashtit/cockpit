---
name: cockpit-ui
description: Build, change or review Cockpit renderer UI — React components in src/renderer, views (sidebar, chat, home, new-session, settings, agents, profile, roundtable, cleanup, palette), CSS in style.css, design tokens, layout, colors, chips and badges, accessibility (aria, focus rings, reduced motion). Use before writing renderer code so it follows the in-repo design system. Not for main-process or IPC work (see add-ipc-capability).
---

# Cockpit UI work

Cockpit's design system is documented in-repo; read it before writing renderer code:

1. **`design-system/cockpit/MASTER.md`** — always read this first: tokens, typography, spacing, motion, component vocabulary, anti-patterns, and the pre-delivery checklist.
2. **`design-system/cockpit/pages/<view>.md`** — list that directory and open the file named for the view being changed (kebab-case: `new-session.md`, `roundtable.md`, `cleanup.md`, …). A page file's rules override MASTER. A new view gets a page file of its own.
3. Canonical token values live in the `:root` block of `src/renderer/src/style.css`. If docs and CSS disagree, CSS wins — then fix the doc.

## Hard rules (the ones agents break most)

- Tokens only — no raw hex and no bare `rgba(…)` outside `:root`; tints are `rgba(var(--x-rgb), α)`; spacing from the `--s*` scale, radii from `--radius*`.
- Dark mode only. No webfonts, no network-loaded assets, no emojis as icons (SVG in `logos.tsx`).
- Reuse the existing component vocabulary (`.acct-chip`, `.pr-badge`, `.branch-chip`, `.btn-*`, `FilterBar`, row/card classes) — don't invent parallel variants.
- Dropdowns are the `Select` component (`Select.tsx`), never a native `<select>`.
- Motion: the `--dur`/`--ease` tokens only (never re-type `160ms`), on background/border/color/box-shadow/opacity/filter; never animate layout; keep the `prefers-reduced-motion` blocks intact.
- Every icon-only control needs `aria-label`/`title`; every control is ≥24×24 CSS px; keep focus rings; never let color alone carry state (put the state word in an `sr-only` span or `aria-label`); async >300ms shows feedback.
- Drag regions (`.tree-top`, `.chat-header`): there is no `no-drag` class. Interactive descendants must be covered by a `-webkit-app-region: no-drag` selector in `style.css` (`.tree-top button, .chat-header button` is the pattern); copyable text also gets `user-select: text`.
- The window floor is 560×420: new chrome must hold there, and shed rules live at the end of `style.css`.

## Verify

Run through MASTER.md's pre-delivery checklist, then `npm run typecheck && npm test`. Layout-affecting changes must also pass the minimum-window audit: `npm run build && npm run test:e2e`.

Then look at it: `npm run ui:tour` (add `-- --only <view>` while iterating) and open `test-results/ui-tour/index.html`. It shows every view at desktop size and at the 560×420 floor, with sessions really running, landed, and a first launch — states no single dev window has at once. Compare against the previous run before calling a visual change done.
