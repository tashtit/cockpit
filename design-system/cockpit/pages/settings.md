# Settings (`Settings.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** single `.ns-card` that is a *status readout first, config editor second* —
it answers "what is Cockpit watching, as whom, how much of each subscription is used,
and is it healthy" before anything is edited. Small surface — resist growth; new setting
groups get a new `.ns-label` section in the same card before they ever get tabs (current
sections, in order: Agent accounts & usage · History · Display · GitHub · Model
providers · Backup · About).

- **One account is one row.** Identity, config home, what that subscription has spent and
  its health all live in the row for that config home — the view used to list the same
  four accounts twice, once for identity and once for usage, which made the card twice as
  long while answering half as much. Usage is matched to a home by path; Copilot reports
  no path (its quota belongs to the GitHub account, not a directory) so it matches on
  provider. Usage measured for a home that is no longer indexed still renders, after the
  list. `section="usage"` (the sidebar footer's deep link) lands on this heading.
- **Add forms are folded.** `Add a config home…` and `Add a model provider…` are ghost
  buttons under the list each extends; the form opens in place, focuses its first field,
  and folds again once the thing is added (Cancel, too). A *refused* add keeps the form
  open with its values. Anything the add produced that outlives the form — the model
  probe's "N models found" / "couldn't list models" — renders outside it.

## Rules

- Header: `.ns-head` h2 + ghost Close. The heading takes focus on mount
  (`tabIndex={-1}` + `.focus()`) so screen readers land in context after navigation —
  keep this pattern for any new full-view card. Section headings are real `<h3
  className="ns-label">` elements, never orphan `<label>`s.
- The section hint carries the aggregate: "currently N config homes · M sessions"
  (live via `getSourceStats()` + `onIndexUpdated`).
- Account list: `.source-row.source-<provider>` = rest-intensity agent tint (2px inset
  bar + faint gradient — the sidebar's selected recipe, quieter) · decorative logo
  (`aria-hidden`) · body: label row with the canonical `.acct-chip acct-<provider>`
  identity (`.missing` "not signed in" when unauthenticated — absence is not a signal),
  a dim "auto-detected" `.source-origin` on defaults, and the plan / "as of Xm ago"
  (past 15min) when usage reports them · selectable mono `.source-path` · the usage body
  (`.usage-windows` rows, or the human-readable reason as `.source-note` prose —
  absence is not an error state) · `.source-health` (bordered `.repo-count` pill +
  "active Xh ago", or `--warn` "path missing" / "no sessions yet") · Remove.
- Remove is two-step, no modal: ghost `small` danger → armed `.btn-danger` "Remove?"
  (reverts on blur/Escape/4s; `aria-label` names the source; `title` states that
  defaults are only auto-detected on first run). After removal an `.ns-hint` Undo line
  offers one-click restore. Adds/removes announce via the card's `sr-only`
  `role="status"` region (ChatView's pattern).
- History section: one labeled `Select` ("Show sessions from" — preset day windows plus
  "All history"). The `.ns-hint` must keep saying that older sessions are only hidden,
  never touched on disk — this is a view filter, not a destructive setting.
- Display section: two labeled `Select`s. "Time format" (24-hour default vs 12-hour,
  each option shows a concrete example like `14:30`) applies live to session times in
  the sidebar and home view via the shared `time.ts` store. "Chat width" (narrow /
  comfortable / wide / full, px hints on the options) bounds the conversation column
  via the `chat-width.ts` store — localStorage, applies live to an open chat.
  Changes announce through the card's `role="status"` region like every other setting.
- Usage rows inside an account: window label · `.usage-meter` fill bar in the agent's
  identity color (`.hot` ≥90%) · `.usage-num` percentage (token detail in the `title`
  tooltip). At ≤780px the label takes its own line over a flexing meter.
- GitHub section: one row — `OrgIcon` · "gh CLI" · `@login` acct-chip (or `.missing`)
  · `.source-note` prose (NOT mono; mono is machine identifiers only). Copy references
  real commands in `<code>` (`gh auth login`).
- Model providers section (BYOK): `.source-row` per provider — `EndpointIcon` · display
  name · `.acct-chip` type (+ wire api) · `.repo-providers` mini agent logos
  (`role="img"` with a "Works with …" title — agent applicability is per type, and it
  must be visible per row, not implied) · mono `.source-path` base URL · `.source-note`
  "key in keychain"/"no key" + cached model count · two-step Remove (same recipe as
  sources; also deletes the stored key). The Type select's options carry the agents they
  serve as `hint` annotations.
  The hint must keep saying keys are encrypted with the OS keychain, never written to
  config, and sent only to the provider. Add form mirrors the config-home form: labeled `.ns-opt`s
  — Display name · Type · Base URL · API key (`type="password"`, `autoComplete="off"`) ·
  Wire API only for openai type (progressive disclosure) · Custom headers (JSON object,
  validated inline). Primary disabled until name + URL are non-empty. After add, the
  provider's `/models` catalog is probed; the visible `.ns-hint` outcome line ("N models
  found" / why not) is mirrored to the sr-only status region.
- Add form (behind `Add a config home…`): a real `<form>` (Enter submits) of labeled
  `.ns-opt`s — Agent select · Config home (mono input, autofocused + ghost "Browse…"
  calling `pickDirectory()`, a main-process `dialog.showOpenDialog` with
  `showHiddenFiles` — config homes are dotdirs) · optional Label · ghost Cancel. Placeholders are concrete examples (`/Users/you/.claude-work`), never
  templates. Primary "Add config home" sits in `.ns-actions`, disabled until path is
  non-empty.
- Errors: `.new-error` with `role="alert"`, linked to the path input via
  `aria-describedby`/`aria-invalid`, cleared the moment the user edits. The main-process
  message is shown verbatim — those errors are already human-readable.
- Backup section: export is a real `<form>` of labeled `.ns-opt`s — optional passphrase
  plus a repeat field that only matters once the first is typed; the primary stays
  disabled until the two match and clear 8 characters, and the mismatch/too-short lines
  are `.ns-hint` prose, not errors (nothing is wrong yet). The hint must keep saying what
  a backup holds, that secrets are left out without a passphrase, that MCP commands and
  URLs are written as they are, and that a lost passphrase is unrecoverable. Restore is
  one `.source-row` with a single `.btn-ghost.small` ("Choose backup…" → "Opening…" →
  "Choose another…") whose `.source-note`s become the preview: date and counts, the MCP
  commands the file would introduce, and repos this Mac doesn't have. A sealed file grows
  a passphrase `.ns-opt`; the "Restore" primary sits in `.ns-actions` and is disabled
  until that is filled. A failed restore keeps the file open — the message is a
  `.new-error role="alert"`, verbatim. The summary is `.ns-hint` lines (what was added,
  what was kept, what was skipped, what needs values) ending in an Undo `link-btn`, and
  every outcome also goes through the card's `role="status"` region.
- About section (last): one `.source-row` — `CockpitLogo` (decorative) · "Cockpit" · the
  version as an `.acct-chip` (a machine identifier, mono) · dim `.source-origin`
  "installed · arm64" or "development run" · `.source-note` readout of the updater (not
  checked yet / checking… / up to date — checked Xm ago / version X is available /
  downloading X · 42% / downloaded — restart to install / the error verbatim) · **one**
  `.btn-ghost.small` action at a time in `.source-health` (Check for updates → Download X
  → Restart to install; a disabled "Checking…"/"Downloading…" while busy), so the row never
  mixes control heights. Transitions announce through the `role="status"` region; progress
  ticks stay silent. The `.ns-hint` states that nothing downloads until asked and links the
  GitHub release notes through a `link-btn` (`openExternal`) — notes are not rendered
  in-app. A development run shows the `unsupported` reason as prose and no control at all.
- App-level: the global Escape handler blurs a focused field first and only closes the
  view on a second press — a habitual Escape must never discard a half-typed path.
