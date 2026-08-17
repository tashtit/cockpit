---
name: cockpit-ui
description: Build or change Cockpit UI — React components, views, styling, layout, colors, chips, badges, or anything in src/renderer. Use before writing or reviewing renderer code so the change follows the design system.
---

# Cockpit UI work

Cockpit's design system is documented in-repo; read it before writing renderer code:

1. **`design-system/cockpit/MASTER.md`** — always read this first: tokens, typography, spacing, motion, component vocabulary, anti-patterns, and the pre-delivery checklist.
2. **`design-system/cockpit/pages/<view>.md`** — if the view you're touching has a page file (`sidebar`, `chat`, `home`, `new-session`, `agents`, `settings`, `profile`, `palette`), its rules override MASTER.
3. Canonical token values live in the `:root` block of `src/renderer/src/style.css`. If docs and CSS disagree, CSS wins — then fix the doc.

## Hard rules (the ones agents break most)

- Tokens only — no raw hex in components; spacing from the `--s*` scale.
- Dark mode only. No webfonts, no network-loaded assets, no emojis as icons (SVG in `logos.tsx`).
- Reuse the existing component vocabulary (`.acct-chip`, `.pr-badge`, `.branch-chip`, `.btn-*`, row/card classes) — don't invent parallel variants.
- Motion: 160ms `--ease` on color/background/border only; never animate layout; keep the `prefers-reduced-motion` block intact.
- Every icon-only control needs `aria-label`/`title`; keep focus rings; async >300ms shows feedback.
- Drag regions (`.tree-top`, `.chat-header`): interactive children need `no-drag`; copyable text needs `user-select: text`.

## Verify

Run through MASTER.md's pre-delivery checklist, then `npm run typecheck && npm test`.
