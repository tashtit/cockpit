# Settings (`Settings.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** one `.ns-card` of *tabs* that is a *status readout first, config editor
second* — it answers "what is Cockpit watching, as whom, how much of each subscription
is used, and is it healthy" before anything is edited. Small surface — resist growth; a
new setting group joins the tab whose question it answers before it ever gets a tab of
its own (current tabs, in order: Accounts · View · Notifications · Providers · Backup ·
About — the accounts first, then what the app shows, then the occasional tasks). **The pill row must hold in two rows at the 560×420 floor** — every
old section as its own tab wrapped it to three, a fifth of the window spent on
navigation. History and Display share the View tab for that reason, and Model providers
and ACP agents share Providers — both answer "what backs my agents", one as an endpoint
you bring a key for and one as a CLI that speaks ACP. Measure the floor before adding a
seventh.

- **The card is tabs, one panel at a time** — the shared card tabs (`TabList` /
  `TabPanel`, see MASTER), a `role="tablist"` named "Settings sections", under the title,
  one `role="tab"` per entry of `SETTINGS_SECTIONS`, and a deep link (the `section`
  prop — the sidebar's usage meters land on `accounts`) opens on one. **Only the selected
  panel is mounted**, so a tab reads its own data when it is opened and nothing is
  fetched for someone who came to flip one switch. The whole card used to be a single
  2.5-screen scroll behind a jump row, and a jump scrolled the picked heading to the top
  — which took the title, the jump row and Close off screen with it. Nothing here may
  scroll a section into view: **switching tabs resets `.settings-view` to `scrollTop 0`**,
  so the head and its tabs can never be scrolled out of reach. `tests/e2e/pages.spec.ts`
  asserts that on every tab, and audits every tab at the 560×420 floor.
- **The selected tab is the panel's heading.** A panel holding one group carries no
  leading `<h3>` — repeating the pill directly under it is noise, and the panel is already
  named by its tab (`aria-labelledby`). A panel holding more than one group keeps an `h3`
  per group (Accounts: "Agent accounts & usage", then "GitHub"; View: "History", then
  "Display"; Providers: "Model providers", then "ACP agents").
- **The tab row is one tab stop.** Roving `tabIndex` (0 on the selected tab, -1 on the
  rest); ←/→ wrap, Home/End jump to the ends, and moving selects — `TabList` does this for
  every card view. The card's `h2` still takes focus on mount; picking a tab leaves
  focus on the tab, never on the panel. Only the **selected** tab carries
  `aria-controls`: the other panels are not in the DOM, and a tab naming one that is not
  there is a dead "go to the controlled element".
- **A deep link counts the asking, not just the section.** The usage meters name
  `accounts` every time they are pressed, so App carries an `openCount` beside the
  section and Settings watches both — otherwise re-pressing them after you had moved to
  another tab would name the same section, change no prop, and do nothing. Opening
  Settings with no section named leaves the open tab where it is.
- **The panel list is a `Record<SettingsSection, JSX.Element>`**, not a chain of
  `tab === '…' &&`: a tab added to `SETTINGS_SECTIONS` without a panel behind it must
  fail the typecheck rather than render a selected tab over an empty panel.
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
  list. `section="accounts"` (the sidebar footer's deep link) opens on this tab.
- **Add forms are folded.** `Add a config home…` and `Add a model provider…` are ghost
  buttons under the list each extends; the form opens in place, focuses its first field,
  and folds again once the thing is added (Cancel, too). A *refused* add keeps the form
  open with its values. A half-typed form is lost if you leave the tab — that is the cost
  of unmounting, and it is the same cost as pressing Close. Anything the add produced that outlives the form — the model
  probe's "N models found" / "couldn't list models" — renders outside it.

## Rules

- Files: `Settings.tsx` is the shell (head, tabs, the `role="status"` region every
  panel announces through, and the shared `appInfo` + update state that main pushes
  whatever tab is open) plus the two one-`Select` panels. Everything else is one file per
  panel — `AccountsSection` · `NotificationsSection` · `ModelProviders` · `BackupSection`
  · `AboutSection` — each owning its own reads.
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
- **The row decides when to wrap, not the window.** The card is as wide as the window
  minus a sidebar the user drags, so no viewport breakpoint can say when the health
  column stops fitting. `.source-row` is always `flex-wrap: wrap`; `.source-body` asks
  for `260px` (`400px` on a row carrying `.usage-windows` — enough for the 130px label,
  the 120px meter and the numbers beside them, via `:has()`), and `.source-health`
  carries `margin-left: auto` so it right-aligns whether it sits beside the body or on
  its own line under it. Give any new `.source-row` content a basis rather than a
  breakpoint.
- Remove is two-step, no modal: ghost `small` danger → armed `.btn-danger` "Remove?"
  (reverts on blur/Escape/4s; `aria-label` names the source; `title` states that
  defaults are only auto-detected on first run). After removal an `.ns-hint` Undo line
  offers one-click restore. Adds/removes announce via the card's `sr-only`
  `role="status"` region (ChatView's pattern).
- View tab, History section: one labeled `Select` ("Sessions to show" — preset day windows plus
  "All history"). The `.ns-hint` must keep saying that older sessions are only hidden,
  never touched on disk — this is a view filter, not a destructive setting.
- View tab, Display section: two labeled `Select`s. "Time format" (24-hour default vs 12-hour,
  each option shows a concrete example like `14:30`) applies live to session times in
  the sidebar and home view via the shared `time.ts` store. "Chat width" (narrow /
  comfortable / wide / full, px hints on the options) bounds the conversation column
  via the `chat-width.ts` store — localStorage, applies live to an open chat.
  Changes announce through the card's `role="status"` region like every other setting.
- Usage rows inside an account: window label · `.usage-meter` fill bar in the agent's
  identity color (`.hot` ≥90%) · `.usage-num` percentage (token detail in the `title`
  tooltip) · the reset time. Each of those is a phrase and wraps as one
  (`.usage-window` is `flex-wrap: wrap`, its numbers and its `<time>` `nowrap`): a
  reading squeezed into a sliver column wrapped a letter at a time and painted straight
  over `.source-health`. At the 560×420 floor the label takes its own line over a
  flexing meter.
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
- GitHub section: the second group on the Accounts tab — it is an account, and the
  sidebar footer already shows the two together; it never gets a tab of its own. One row — `OrgIcon` · "gh CLI" · `@login`
  acct-chip (or `.missing`) · `.source-note` prose (NOT mono; mono is machine identifiers
  only). Copy references real commands in `<code>` (`gh auth login`).
- Model providers section (BYOK): `.source-row` per provider — `EndpointIcon` · display
  name · `.acct-chip` type (+ wire api) · `.repo-providers` agent logos (decorative, 12px)
  **and the words** "works with Claude and Copilot" as a `.source-origin` — agent
  applicability is per type, and it must be readable per row, not implied by 10px marks ·
  mono `.source-path` base URL · `.source-note` "key in keychain"/"no key" + cached model
  count · "Add key" opening an inline `.source-browse-row` form (password input with a
  placeholder, Save key, Cancel; Escape cancels) · two-step Remove (same recipe as
  sources; also deletes the stored key). The chip reads `anthropic · bearer` when a
  gateway takes its key as a bearer token, the one setting that tells two anthropic rows apart.
  The hint must keep saying keys are encrypted with the OS keychain, never written to
  config, and sent only to the provider. **The add form starts from a provider, not a
  blank form**: its first field is a **Provider** `Select` (autofocused) of
  `ENDPOINT_PRESETS` (`src/shared/endpoints.ts`), which are Anthropic (the default), OpenAI,
  Azure OpenAI, Ollama, LM Studio, then "Anthropic-compatible" / "OpenAI-compatible" (its
  `.source-opt-provider` basis is what keeps the longest of those untruncated at 900px).
  Each option carries the agents it serves as its `hint`. A pick fills the fields with values
  that work. Display name and Base URL follow the pick only while they still hold the last
  pick's suggestion, so anything typed over one stays. A provider with no address of its own
  (Azure, a gateway) empties the URL and shows a concrete example as its placeholder.
  The fields are two rows of three at most (one row wrapped "API key · optional" and dropped
  its input out of line): Provider · Display name · Base URL, then API key (`type="password"`,
  `autoComplete="off"`, the vendor's key shape as placeholder) · whatever that provider leaves
  open (`preset.ask`: Wire API on OpenAI and OpenAI-compatible, **Send key as** (`Bearer` /
  `x-api-key`) on Anthropic-compatible, Headers on both -compatible entries, as a JSON object
  validated inline). Labels stay short enough for one line in a third of the row: "Custom
  headers · optional" wrapped and dropped its input out of line.
  A field the pick hides is cleared, never sent unseen. One `.ns-hint` line under the fields
  says what that provider needs that no field can (where the key comes from, "start Ollama
  first", "type the deployment name"). The key's label drops "· optional" for a hosted API,
  and the primary stays disabled until name, URL, and a required key are filled. Folding after
  an add resets to Anthropic. After add, the
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
- ACP agents section (second group on the Providers tab, `AcpAgents.tsx`): borrows the
  Model providers grammar exactly —
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
- About tab (last): one `.source-row` — `CockpitLogo` (decorative) · "Cockpit" · the
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
  The one row carrying two actions is `ready`: **Check again** sits before **Restart
  now**, both `.btn-ghost.small`, so the heights still match. A downloaded build is not
  the end of updating — a newer release has to stay reachable without installing this
  one first — and a check that came back with nothing usable (`UpdateState.message` on
  `ready`) is appended to that line rather than replacing it, because the build is still
  installable and losing Restart now to an offline moment would be the worse answer.
  Restart now shares the sidebar update bar's armed step (`useRestartToUpdate`). When
  Cockpit's own turns are running, the first press turns the button into
  `.btn-ghost.danger.small.armed` reading "Stop N turns and restart?", the same height
  and red at rest. The second press restarts; blur, Escape or 4s back it out.
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

## Sign-in and the agent CLIs (Accounts tab)

- A config home's row carries the CLI's own sign-in answer beside the remembered
  identity: **signed out** as an `.acct-chip.missing`, and a `.source-note.source-signin`
  line with the fix (`SignInFix`) over a `.signin-actions` line holding the
  `.btn-ghost.small` **Sign in…** that opens Terminal on the agent's sign-in
  (`accounts:login`) — the key never trails the sentence, whose command wraps wherever
  the row is narrow (the roundtable seat uses the same line). While it is pending the line says
  to finish in Terminal, and the row re-asks every few seconds and on window focus
  (`useWatchUntil`) — nothing to press when the person comes back.
- **Agent CLIs** is its own group (`h3`) between the accounts and GitHub: one
  `.source-row.tint-{agent}` per CLI — name, version chip, "via Homebrew / npm / its own
  updater", the real path (`shortPath`), and on the right *up to date*, *couldn't check
  <channel>*, *not installed*, or *x.y.z available* (`.source-warn`) with **Update…**
  whose tooltip is the exact command. **A version is judged against the channel it can
  update from**, never the newest release anywhere — a Homebrew install can only get
  what Homebrew packaged, and offering more would be an Update that does nothing. When
  the release is ahead of the channel, the row stays *up to date* and a `.source-note`
  says so ("2.1.278 is out, but Homebrew hasn't packaged it yet") — with a **Refresh
  Homebrew** `.link-btn` on a brew install, since Homebrew only knows what its last
  `brew update` fetched. Refreshing is its own step (`brew update`, which installs
  nothing) and the row picks the new answer up by itself, turning into an Update. Updating opens Terminal the same way and the row
  is watched until the version moves. The latest release is main's to fetch (npm
  registry, an hour's cache, fail soft); the ui-tour and e2e pin it with
  `COCKPIT_CLI_LATEST`, never the network.
