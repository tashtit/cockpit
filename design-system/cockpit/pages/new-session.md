# New Session (`NewSession.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** focused form card (`.ns-card`, 600px) for starting a session in a chosen
repo with full control — the deliberate counterpart to Home's quick composer. Reached
from Home's "Options…" (which passes the typed draft as `initialPrompt` and any pasted
images as `initialImages`) or the sidebar repo-row "+".

## Form grammar

- **Task first.** The field order is Task · Project · Agent · account/model/thinking/permissions ·
  Branch · actions — the same priority as Home's composer, where the task is the card and
  the rest is a strip underneath. What you want done is the reason the form is open; where
  it runs and who runs it are its settings. Focus lands in Task on mount.
- The Branch input's placeholder previews the name the task will produce
  (`branchHint(prompt)` → `add-changelog-entry-retry-fix`), falling back to
  "auto-generated" while the task is empty — the field shows what will happen, not a
  promise that something will.

- `.ns-label` uppercase micro-labels set the rhythm: far from the previous group
  (`margin-top: --s4`), close to their own field. Inside `.ns-opt` the label sits flush.
- Agent choice is the hero control: `.ns-provider` cards (logo, name, one-line blurb,
  account chip) — the three CLIs, then each agent Cockpit otherwise only reads that an ACP
  agent drives right now (`startableAgents`), which wrap onto the next row. Active =
  agent-colored 1.5px border + tint + soft glow (the monochrome brands share
  `--mono-mark`); `aria-pressed` on each. Blurbs are fixed copy (`AGENT_BLURB`) — keep them
  one line. An ACP-driven card's blurb and chip say how it runs ("over ACP"), never an
  account: Cockpit doesn't learn who that agent is signed in as, so picking one hides
  Account, Model and Thinking, and a hint says its model and account are its own.
- Account: single account renders as static `.ns-account-single` (mono, an `<output>` named
  by its label); multiple render a mono `Select` — never a native `<select>`. Both are
  `AccountField` (`agent-options.tsx`), shared with the handoff form. Same `savedAccount`
  resolution rule as Home — saved choice, else first configured.
- Model is a mono `Select` of every model the agent offers under the chosen account
  (`listAgentModels`, the list roundtable seats pick from; each option's hint is its
  description, or its id when the label differs), or of the BYOK provider's catalog when
  one is chosen — models are picked, not typed, so a stale guess can't reach the CLI.
  "loading models…" holds the empty value while the listing is in flight. The one
  exception is a catalog known to be empty (an Azure provider serves deployments and lists
  none): there Model is a plain `<input>`, since the name is only the person's to know.
- The account/model/thinking/permissions cells are `.ns-options.ns-agent-options`, a grid
  of `auto-fit` 130px-minimum columns: with a model provider or Codex's sandbox there are
  five, and the fifth wraps into the first column rather than stretching across the card.
- Thinking sits beside Model: `default` (or `default · <level>` when the model names its
  own) plus the levels that model takes (`effortsFor`). A model or level the current list
  doesn't offer — another agent, another account, another provider — is dropped rather
  than shown as `default` while it still runs.
- Model provider: a `Select` ("default" + each configured BYOK provider the active agent
  can use) that appears only when at least one fits — progressive disclosure, like the
  Codex sandbox. Picking one shows an `.ns-hint` naming the base URL; Copilot + provider
  makes Model required (Start disabled until chosen). When providers exist but none fits
  the active agent, an `.ns-hint` says why (Codex has no provider override; Claude needs
  anthropic-type) — the control disappearing silently reads as a bug.
- Branch: `.ns-branch-row` shows the person's branch prefix (Settings › Accounts,
  `useBranchPrefix`; `cockpit/` by default) as dimmed mono with a mono input beside it —
  worktree branch naming is visible, not hidden (product rule: always worktrees + PRs). A
  long prefix gives way (ellipsis, 45% at most) before the name field does.
  Left empty, the task's words name it (see above).
- Hints are `.ns-hint`; the Full access warning uses `.ns-hint.danger` (danger color).
  Permission mode labels come from the shared `MODES` table — Ask first · Accept edits ·
  Full access, one vocabulary for every agent — and each hint from `modeHint`, which says
  what the chosen agent itself calls the setting. Identical wording in ChatView.
- Errors: `.new-error` inline under the actions. Actions right-align: ghost Cancel,
  primary Start.
- Pasting an image into Task attaches it (shared `useImageAttachments` + `AttachRow`):
  the `.composer-attach` chip row renders between the Task label and the textarea, and
  an image-only start is allowed — same behavior as the chat and home composers.

## Invariants

- Persists the same `localStorage` keys as Home (`cockpit:provider`, `cockpit:mode`,
  `cockpit:account:<provider>`) — one memory across all entry points.
- Repo select lists only repos with a resolved root (`repos.filter(r => r.root)`).
- Codex-only options (sandbox) appear only when Codex is the active provider —
  progressive disclosure, never disabled-but-visible for other agents.
