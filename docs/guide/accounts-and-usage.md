# Accounts & usage

Cockpit knows who each agent CLI is signed in as, supports multiple accounts per provider, and shows what your subscriptions are consuming — all **without ever touching your credentials**.

## Agent accounts

Each provider records its signed-in identity in its config home, and Cockpit reads (never writes) it:

| Provider | Where identity lives |
| --- | --- |
| Claude Code | `.claude.json` (OAuth account) |
| Codex | `auth.json` (JWT) |
| Copilot CLI | `config.json` (native multi-account) |
| GitHub CLI | `gh` signed-in user — used for PR operations |

Identity chips appear throughout the app, so it's always visible which account a session ran under — and when a provider has several config homes, starting a task lets you pick the account.

## Sources: multiple config homes

A **source** is a provider config home Cockpit indexes. The defaults are `~/.claude`, `~/.codex`, and `~/.copilot`; you can add more in **Settings › Accounts** — typically an isolated config home for a second account (e.g. work vs. personal).

Each source shows its own identity and health, and extra sources are stored in the app config (`~/Library/Application Support/Cockpit/cockpit-config.json`) as `{path, provider, label}`.

## Subscription usage

The same rows in **Settings › Accounts** show what each subscription is consuming, measured without credentials:

- **Claude Code** — measured locally from the session JSONLs: the current 5-hour block plus the trailing 7 days.
- **Codex** — read from the rate-limit snapshots the CLI itself persists.
- **Copilot** — premium request counts via the GitHub billing API (fails soft if unavailable).

::: tip Why credential-free matters
Cockpit never proxies your accounts and never holds tokens for them — it observes what the CLIs record locally, plus public APIs where available. Your authentication stays exactly where the providers put it.
:::

## Signing in from Cockpit

Each config home's row checks, with the agent's own CLI, whether it is actually signed in — the email Cockpit shows is what the config file remembers, and that outlives an expired session. A home that is **signed out** (or has nobody signed in) says so, with the command that fixes it and a **Sign in…** button. The button opens Terminal on that agent's own sign-in (`claude auth login`, `codex login`, `copilot login`, with the home's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `COPILOT_HOME` when it isn't the default); you finish it there — in the browser, or with a device code — and the row updates by itself when you come back. Cockpit never sees your credentials.

The same **Sign in…** button appears on a roundtable seat that can't run.

::: tip The apps and the CLIs sign in separately
Cockpit runs the agents' command-line tools. The Codex app and the `codex` CLI share one sign-in, but the Claude app keeps its own — being signed in to the Claude app does not sign in the `claude` CLI.
:::

## Agent CLIs

The **Agent CLIs** group lists each CLI Cockpit runs: the version installed, how it was installed (Homebrew, npm, or its own installer), where it lives, and whether a newer release is out — checked against each CLI's published releases when the tab opens (at most once an hour; **Check for updates** asks again). A CLI that is behind shows the new version and an **Update…** button, which opens Terminal on the command that fits how it was installed — `brew update && brew upgrade --cask claude-code`, `npm install -g @openai/codex@latest`, or `copilot update` (Copilot updates itself in place). Hover the button to see the command first. The row picks up the new version by itself once the update finishes.
