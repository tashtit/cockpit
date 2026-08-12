# Home — Mission Control (`HomeView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** mission control opens with **the board** — a departure-board of sessions,
flying first — then the task composer. The board is the app's signature element; the
composer is the action. This is the only view allowed hero-scale type (`--fs-xl`) and a
floating card shadow (the composer card — the board is deliberately a quiet instrument
surface, no shadow).

## Layout

- `.home-inner`: `min(700px, 94%)` column, vertically centered (`justify-content: center`),
  `--s5` gaps. Scrolls as a whole (`.home-view { overflow-y: auto }`). Centering is
  `justify-content: safe center` and children carry `flex-shrink: 0` — both load-bearing:
  unqualified centering clips the top out of scroll reach, and shrinkable children let the
  composer card collapse to a sliver on short windows.
- Order: `.board` (only when sessions exist) → hero (h2 + sub + kbd hints; no logo — the
  sidebar carries the mark) → `.composer-card` → error line.
- The hero h2 is flat `--fg` (no gradient-clip decoration); when `gh` reports a user the
  headline personalizes — "What should we ship`, Titan?`" — the login's first
  hyphen/dot/underscore segment, capitalized (`firstName()`), in dim `.hero-name`.
- Short windows (≤600px height): hero is dropped, content top-aligns — the board and
  composer are the priority, never the branding.

## The board (`.board`)

- Grammar per row (`.board-row`, a button that opens the session): status dot ·
  `.board-agent` placard (fixed 60px column, uppercase micro-caps) · `BranchChip` ·
  title (truncates) · `.board-repo` pill · `.board-meta` (mono, `tabular-nums`).
- **Flying** (session's provider process running, from the `useBusyMap()` store): `LiveDot`
  pulse + placard lit in the agent's livery color + elapsed time (`fmtElapsed`, ticks at
  1s only while ≥1 session is flying). **On the ground:** dim static dot, dim placard,
  last-activity `fmtTime`.
- Ordering: flying first (longest airborne on top), then idle by recency. Rows come from
  the same `pageSessions({ limit: 10 })` fetch as before — the sidebar is the exhaustive
  list; don't grow this.
- `.board-eyebrow` (h3): "**N flying** · M on the ground" (M from the page total), or
  "all on the ground" when idle. It is a polite `aria-live` region — turn starts and
  completions announce the new counts.
- ≤780px the row sheds `.board-repo` first — the branch chip carries more identity.

## Composer card

- `.composer-card` = borderless textarea on top, `.composer-bar` control strip below a
  hairline divider. Focus ring lives on the **card** (`:focus-within`), not the textarea.
- Bar order is fixed: repo icon + repo select · `.composer-identity` (agent picker +
  account select fused into one bordered control — they answer one question, "who runs
  this") · permission mode select · `.btn-primary` pushed right with `margin-left: auto`.
- `.home-more`: a right-aligned `.link-btn` line directly under the card — "All options —
  branch name, model, custom model provider…" — the discoverable path into the full New
  session form; it carries the typed draft over, so clicking it never loses work. Kept
  out of the bar on purpose: the bar is width-budgeted and must stay one line.
- Agent picker: `.composer-agent` logo buttons, `aria-pressed` + `aria-label`; active =
  agent-tinted background + 1.5px inset ring in the agent color. Signed-out agents get the
  `.no-acct` red dot — never disable them (clicking reveals the "not signed in" chip).
- ⌘Enter submits; the button label is the action: "Start with Claude Code", or "Starting…"
  while busy. Errors render in `.new-error` directly under the card, never a toast.
- Mode options and hints come from the shared `MODES` table (exported by NewSession);
  choosing YOLO shows the `.ns-hint.yolo` warning line under the card — the bypass mode is
  never silent.
- Prompt textarea autofocuses on mount — the user should be able to type immediately.

## Invariants

- Provider, mode, and per-provider account choices persist to
  `localStorage` (`cockpit:provider`, `cockpit:mode`, `cockpit:account:<provider>`) on
  start — HomeView, NewSession, and ChatView must stay in sync on these keys.
- Start is disabled until: prompt non-empty, a repo selected, and (once accounts have
  loaded) an account resolved. While `accounts === null` (still loading), don't flash the
  missing-account state.
- Keyboard hints in the hero use `.home-kbd` mono, and must match real bindings (⌘N, ⌘K).
