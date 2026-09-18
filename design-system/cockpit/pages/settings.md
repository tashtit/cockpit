# Settings (`Settings.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** single `.ns-card` that is a *status readout first, config editor second* —
it answers "what is Cockpit watching, as whom, how much of each subscription is used,
and is it healthy" before anything is edited. Small surface — resist growth; new setting
groups get a new `.ns-label` section in the same card before they ever get tabs (current
sections, in order: Agent accounts & usage · GitHub · History · Display · Notifications ·
Model providers · ACP agents · Backup · About — the two account sections together, then
the preferences, then the occasional tasks).

- **The card has a map.** A jump row (`.ns-jumps` — the Agents `.pnl-pill`s inside a
  `<nav aria-label="Sections">`) sits under the title, one pill per entry of
  `SETTINGS_SECTIONS`; a pill scrolls its `h3` into view and focuses it, and a deep link
  (the `section` prop — the sidebar's usage meters land on `accounts`) does the same. It
  is a map of one page, never tabs: everything stays on the card.
- **Section prose is one or two sentences at body size** (`.ns-hint.ns-prose`): what the
  section is and the one consequence to know. Mechanism ("Claude is measured from session
  logs") moves onto the row it describes — a `title`, a `.source-note` — or into the form
  it concerns (the config-home form carries the `CLAUDE_CONFIG_DIR` example). Inline
  field notes inside a form stay plain `.ns-hint`.

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
- The section prose ends with the aggregate: "Currently N config homes · M sessions"
  (live via `getSourceStats()` + `onIndexUpdated`).
- Account list: `.source-row.source-<provider>` = rest-intensity agent tint (2px inset
  bar + faint gradient — the sidebar's selected recipe, quieter) · decorative logo
  (`aria-hidden`) · body: label row with the canonical `.acct-chip acct-<provider>`
  identity (`.missing` "not signed in" when unauthenticated — absence is not a signal),
  a dim "auto-detected" `.source-origin` on defaults, and the plan / "as of Xm ago"
  (past 15min) when usage reports them · selectable mono `.source-path` · the usage body
  (`.usage-windows` rows, or the human-readable reason as `.source-note` prose —
  absence is not an error state; the `.usage-windows` block carries where its numbers
  come from as its `title`) · `.source-health` (bordered `.repo-count` pill **followed by
  the word** "sessions" — a bare number is a mystery in a readout — then "· active Xh
  ago", or `--warn` "path missing" / "no sessions yet") · Remove.
- Remove is two-step, no modal: ghost `small` danger → armed `.btn-danger` "Remove?"
  (reverts on blur/Escape/4s; `aria-label` names the source; `title` states that
  defaults are only auto-detected on first run). After removal an `.ns-hint` Undo line
  offers one-click restore. Adds/removes announce via the card's `sr-only`
  `role="status"` region (ChatView's pattern).
- History section: one labeled `Select` ("Sessions to show" — preset day windows plus
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
- Notifications section (`NotificationsSection.tsx`): the `.ns-hint` must keep saying
  when Cockpit speaks (a turn finishing or failing, a roundtable concluding), that it never
  speaks about the session in front of a focused window, and that endings arriving together
  share one notification. Three switches, one `.source-row.attn-switch` each — the whole
  row is a `<label>` around a native checkbox (global `accent-color`, 14px box with a margin
  for the 24px target), a `.source-label` name and a `.source-note` saying what the switch
  does. The checkbox is named by the label span alone (`aria-labelledby`) and described by
  the note (`aria-describedby`) — a wrapping label would otherwise read the note as part of
  its name. Order: Desktop notifications · Sound · Dock badge. A flip saves at once,
  announces "<name> on/off" through the card's `role="status"` region, and reverts (with
  the error announced) if main refuses. Last, a "Try it" `.source-row` with one
  `.btn-ghost.small` "Send a test notification" ("Sending…", disabled, while macOS answers)
  whose `.source-note` readout says what macOS did: shown, refused (explained as the unsigned
  build, then a second note line `macOS said: <code>…</code>` verbatim), or no answer yet
  (the permission prompt). Before a test it says a development run starts the switches off.
  The test posts a sample regardless of the switch — pressing the button is the request.
- GitHub section: directly after the agent accounts — it is an account, and the sidebar
  footer already shows the two together. One row — `OrgIcon` · "gh CLI" · `@login`
  acct-chip (or `.missing`) · `.source-note` prose (NOT mono; mono is machine identifiers
  only). Copy references real commands in `<code>` (`gh auth login`).
- Model providers section (BYOK): `.source-row` per provider — `EndpointIcon` · display
  name · `.acct-chip` type (+ wire api) · `.repo-providers` agent logos (decorative, 12px)
  **and the words** "works with Claude and Copilot" as a `.source-origin` — agent
  applicability is per type, and it must be readable per row, not implied by 10px marks ·
  mono `.source-path` base URL · `.source-note` "key in keychain"/"no key" + cached model
  count · "Add key" opening an inline `.source-browse-row` form (password input with a
  placeholder, Save key, Cancel; Escape cancels) · two-step Remove (same recipe as
  sources; also deletes the stored key). The Type select's options carry the agents they
  serve as `hint` annotations.
  The hint must keep saying keys are encrypted with the OS keychain, never written to
  config, and sent only to the provider. Add form mirrors the config-home form: labeled
  `.ns-opt`s in **two rows of three** (one row wrapped "API key · optional" and dropped
  its input out of line) — Display name · Type · Base URL, then API key
  (`type="password"`, `autoComplete="off"`) · Wire API only for openai type (progressive
  disclosure) · Custom headers (JSON object, validated inline). Primary disabled until
  name + URL are non-empty. After add, the
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
  message is shown verbatim — those errors are already human-readable — once
  `ipcErrorText()` (`ipc-error.ts`) has stripped Electron's "Error invoking remote
  method" wrapper; every settings surface that shows a rejection goes through it. A path
  the card already lists is refused in the renderer ("Cockpit already watches …") rather
  than sent to main, which keeps a duplicate silently.
- ACP agents section (`AcpAgents.tsx`): borrows the Model providers grammar exactly —
  `.source-list` rows, a folded `Add an ACP agent…` affordance, `ConfirmRemove` per row.
  A row is tinted with the CLI it drives (`.tint-{provider}`) and carries that provider's
  logo: an ACP agent is a *way of running* one of the three agents, not a fourth agent,
  and the row has to say so at a glance. **Built-ins have no remove control** and read
  `built in` — they are defined in code, not config, so their `.source-health` states
  what is true of them ("used when this CLI supports it") rather than offering an action.
  The add form's **Test** button runs the real ACP handshake and reports what answered
  (name, version, protocol, whether it can resume, how to sign in), so a command is never
  stored on faith; a failure shows the agent's own reason in an `alert`. Field validation
  is the same function main enforces (`acpAgentRefusal` / `sanitizeAcpAgent` in
  `src/shared/acp.ts`) — a form explaining a rule the store does not apply would be worse
  than no explanation.
- Backup section: export is a real `<form>` of labeled `.ns-opt`s — optional passphrase
  plus a repeat field that only matters once the first is typed; the **ghost** "Export
  backup…" (an occasional task, not the page's one filled key) stays disabled until the
  two match and clear 8 characters, and the mismatch/too-short lines are `.ns-hint`
  prose, not errors (nothing is wrong yet). The section prose says what a backup holds;
  the passphrase's own `.ns-hint` under the fields must keep saying that secrets are left
  out without one, that MCP commands and URLs are written as they are, and that a lost
  passphrase is unrecoverable. Restore is
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
  downloading X · 42% / downloaded — it installs when you quit Cockpit / the error
  verbatim) · **one** `.btn-ghost.small` action at a time in `.source-health` (Check for
  updates → Download X → Restart now; a disabled "Checking…"/"Downloading…" while busy),
  so the row never mixes control heights. The ready line and the button say the same
  thing twice on purpose: quitting is what installs, and the button is only sooner — so
  it never reads as the one way to get the update. Transitions announce through the
  `role="status"` region; progress ticks stay silent.
  Under that row, two `.source-row.attn-switch` rows on the Notifications recipe exactly
  (whole row a `<label>`, `aria-labelledby` the label span alone, `aria-describedby` the
  note): Download updates automatically · Install when I quit. A flip saves at once,
  announces "<name> on/off" and reverts on refusal. They are the *whole* control surface
  for the automatic path — there is no third switch for checking, which always happens.
  An install that rolled back (`UpdateState.installFailure`) is a `.new-error
  role="alert"` under the list, before the hint: what was put back, verbatim why, and
  that nothing downloads on its own until Check for updates is pressed. The `.ns-hint`
  says Cockpit keeps itself current and installs its own updates so it can clear the
  quarantine flag, and links the GitHub release notes through a `link-btn`
  (`openExternal`) — notes are not rendered in-app. Beside it, "Open source licenses"
  (`link-btn`) opens the generated `THIRD_PARTY_NOTICES.txt` in the system text viewer
  (`openLicenseNotices`); the reason it could not open shows verbatim in a `.new-error
  role="alert"` under the hint. A development run shows the `unsupported` reason as prose
  and neither the action nor the switches — this build could not act on them.
- App-level: the global Escape handler blurs a focused field first and only closes the
  view on a second press — a habitual Escape must never discard a half-typed path.
