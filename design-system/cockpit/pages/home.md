# Home — Mission Control (`HomeView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** GitHub Agent HQ-style mission control — a task composer front and center,
recent agent work below. This is the app's "what should we ship?" moment; it is the only
view allowed hero-scale type (`--fs-xl`) and a floating card shadow.

## Layout

- `.home-inner`: `min(700px, 94%)` column, vertically centered (`justify-content: center`),
  `--s5` gaps. Scrolls as a whole (`.home-view { overflow-y: auto }`). Centering is
  `justify-content: safe center` and children carry `flex-shrink: 0` — both load-bearing:
  unqualified centering clips the top out of scroll reach, and shrinkable children let the
  composer card collapse to a sliver on short windows.
- Order: hero (logo + h2 + sub + kbd hints) → `.composer-card` → error line → Recent activity.
- Short windows (≤600px height): hero is dropped, content top-aligns — composer is the
  priority, never the branding.

## Composer card

- `.composer-card` = borderless textarea on top, `.composer-bar` control strip below a
  hairline divider. Focus ring lives on the **card** (`:focus-within`), not the textarea.
- Bar order is fixed: repo icon + repo select · `.composer-identity` (agent picker +
  account select fused into one bordered control — they answer one question, "who runs
  this") · permission mode select · `.btn-primary` pushed right with `margin-left: auto`.
- Agent picker: `.composer-agent` logo buttons, `aria-pressed` + `aria-label`; active =
  agent-tinted background + 1.5px inset ring in the agent color. Signed-out agents get the
  `.no-acct` red dot — never disable them (clicking reveals the "not signed in" chip).
- ⌘Enter submits; the button label is the action: "Start with Claude Code", or "Starting…"
  while busy. Errors render in `.new-error` directly under the card, never a toast.
- Prompt textarea autofocuses on mount — the user should be able to type immediately.

## Recent activity

- `.recent-row` buttons: agent logo · title (truncates) · meta right-aligned
  (repo pill, branch chip max 120px, `tabular-nums` time). Border appears on hover only
  (`border: 1px solid transparent` reserved — no layout shift).
- Capped at 10 via `pageSessions({ limit: 10 })` — the sidebar is the full list; don't grow this.
- Section heading reuses `.ns-label` (uppercase micro-label), not a document heading size.

## Invariants

- Provider, mode, and per-provider account choices persist to
  `localStorage` (`cockpit:provider`, `cockpit:mode`, `cockpit:account:<provider>`) on
  start — HomeView, NewSession, and ChatView must stay in sync on these keys.
- Start is disabled until: prompt non-empty, a repo selected, and (once accounts have
  loaded) an account resolved. While `accounts === null` (still loading), don't flash the
  missing-account state.
- Keyboard hints in the hero use `.home-kbd` mono, and must match real bindings (⌘N, ⌘K).
