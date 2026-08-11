# New Session (`NewSession.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** focused form card (`.ns-card`, 600px) for starting a session in a chosen
repo with full control — the deliberate counterpart to Home's quick composer.

## Form grammar

- `.ns-label` uppercase micro-labels set the rhythm: far from the previous group
  (`margin-top: --s4`), close to their own field. Inside `.ns-opt` the label sits flush.
- Agent choice is the hero control: three `.ns-provider` cards (logo, name, one-line
  blurb, account chip). Active = agent-colored 1.5px border + tint + soft glow;
  `aria-pressed` on each. Blurbs are fixed copy (`AGENT_BLURB`) — keep them one line.
- Account: single account renders as static `.ns-account-single` (mono); multiple render
  a mono `<select>`. Same `savedAccount` resolution rule as Home — saved choice, else
  first configured.
- Model field is a free `<input>` with `<datalist>` suggestions (`MODEL_SUGGESTIONS`, or
  the chosen endpoint's own model list) — suggestions only, the field accepts anything
  the CLI accepts. Don't harden into a select.
- Endpoint: a `Select` ("default" + each configured BYOK endpoint the active agent can
  use) that appears only when at least one fits — progressive disclosure, like the Codex
  sandbox. Picking one shows an `.ns-hint` naming the base URL; Copilot + endpoint makes
  Model required (Start disabled until filled).
- Branch: `.ns-branch-row` shows the fixed prefix as dimmed mono with a mono input beside
  it — worktree branch naming is visible, not hidden (product rule: always worktrees + PRs).
- Hints are `.ns-hint`; the YOLO warning uses `.ns-hint.yolo` (danger color). Permission
  mode labels/hints come from the shared `MODES` table — identical wording in ChatView.
- Errors: `.new-error` inline under the actions. Actions right-align: ghost Cancel,
  primary Start.

## Invariants

- Persists the same `localStorage` keys as Home (`cockpit:provider`, `cockpit:mode`,
  `cockpit:account:<provider>`) — one memory across all entry points.
- Repo select lists only repos with a resolved root (`repos.filter(r => r.root)`).
- Codex-only options (sandbox) appear only when Codex is the active provider —
  progressive disclosure, never disabled-but-visible for other agents.
