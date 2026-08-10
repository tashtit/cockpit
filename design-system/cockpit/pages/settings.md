# Settings (`Settings.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** single `.ns-card` that is a *status readout first, config editor second* —
it answers "what is Cockpit watching, as whom, how much of each subscription is used,
and is it healthy" before anything is edited. Small surface — resist growth; new setting
groups get a new `.ns-label` section in the same card before they ever get tabs (current
sections, in order: Agent accounts & sources · History · Subscription usage · GitHub ·
Add source).

## Rules

- Header: `.ns-head` h2 + ghost Close. The heading takes focus on mount
  (`tabIndex={-1}` + `.focus()`) so screen readers land in context after navigation —
  keep this pattern for any new full-view card. Section headings are real `<h3
  className="ns-label">` elements, never orphan `<label>`s.
- The section hint carries the aggregate: "currently N config homes · M sessions"
  (live via `getSourceStats()` + `onIndexUpdated`).
- Source list: `.source-row.source-<provider>` = rest-intensity agent tint (2px inset
  bar + faint gradient — the sidebar's selected recipe, quieter) · decorative logo
  (`aria-hidden`) · body: label row with the canonical `.acct-chip acct-<provider>`
  identity (`.missing` "not signed in" when unauthenticated — absence is not a signal)
  and a dim "auto-detected" `.source-origin` on defaults · selectable mono
  `.source-path` · `.source-health` (bordered `.repo-count` pill + "active Xh ago", or
  `--warn` "path missing" / "no sessions yet") · Remove.
- Remove is two-step, no modal: ghost `small` danger → armed `.btn-danger` "Remove?"
  (reverts on blur/Escape/4s; `aria-label` names the source; `title` states that
  defaults are only auto-detected on first run). After removal an `.ns-hint` Undo line
  offers one-click restore. Adds/removes announce via the card's `sr-only`
  `role="status"` region (ChatView's pattern).
- History section: one labeled `Select` ("Show sessions from" — preset day windows plus
  "All history"). The `.ns-hint` must keep saying that older sessions are only hidden,
  never touched on disk — this is a view filter, not a destructive setting.
- Subscription usage section: one `.source-row.tint-<provider>` per provider account —
  logo · label · `.acct-chip` identity · dim plan / "as of Xm ago" `.source-origin`
  (staleness only shown past 15min). Body is `.usage-windows` rows: window label ·
  `.usage-meter` fill bar in the agent's identity color (`.hot` ≥90%) · `.usage-num`
  percentage (token detail in the `title` tooltip). Unavailable usage shows the
  human-readable reason as `.source-note` prose — absence is not an error state.
- GitHub section: one row — `OrgIcon` · "gh CLI" · `@login` acct-chip (or `.missing`)
  · `.source-note` prose (NOT mono; mono is machine identifiers only). Copy references
  real commands in `<code>` (`gh auth login`).
- Add form: a real `<form>` (Enter submits) of labeled `.ns-opt`s — Agent select ·
  Config home (mono input + ghost "Browse…" calling `pickDirectory()`, a main-process
  `dialog.showOpenDialog` with `showHiddenFiles` — config homes are dotdirs) · optional
  Label. Placeholders are concrete examples (`/Users/you/.claude-work`), never
  templates. Primary "Add source" sits in `.ns-actions`, disabled until path is
  non-empty.
- Errors: `.new-error` with `role="alert"`, linked to the path input via
  `aria-describedby`/`aria-invalid`, cleared the moment the user edits. The main-process
  message is shown verbatim — those errors are already human-readable.
- App-level: the global Escape handler blurs a focused field first and only closes the
  view on a second press — a habitual Escape must never discard a half-typed path.
