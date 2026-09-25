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
- **Copilot** — premium request counts for the calendar month via the GitHub billing API, with the reset on the first of the next month (fails soft if unavailable).

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

The **Agent CLIs** group lists each CLI Cockpit runs: the version installed, where it lives, and where it gets updates — "via Homebrew", "via npm", or "via its own updater". Checked when the tab opens, at most once an hour; **Check for updates** asks again.

A CLI is compared against **the channel it can actually update from**, not against the newest release anywhere: a Homebrew install can only get what Homebrew has packaged. So the row offers an **Update…** only when that channel really has something newer, and hovering the button shows the exact command (`brew update && brew upgrade --cask claude-code`, `npm install -g @openai/codex@latest`, or `copilot update`, since Copilot updates itself in place). The row picks up the new version by itself once the update finishes.

When a newer version exists that your channel hasn't packaged yet, the row says so — "2.1.278 is out, but Homebrew hasn't packaged it yet" — and stays **up to date**, because there is nothing to run.

Homebrew only knows the releases its last `brew update` fetched, so such a row also offers **Refresh Homebrew**: it opens Terminal on `brew update` alone, which changes nothing that is installed. When Homebrew comes back with the newer version, the row turns into an **Update…** by itself. (A CLI that updates itself, like Copilot, has nothing to refresh, so it isn't offered.)

When Claude and Codex both have a Homebrew update, the group also offers **Update Claude and Codex together…**: one Terminal window, one `brew update`, then one upgrade of both (`brew update && brew upgrade --cask claude-code codex` — hover it to see the command).

Homebrew runs one thing at a time, so you can also update them back to back: the second Terminal window waits for the first to finish, then carries on by itself, and both rows say they are taking turns. A window also waits out a Homebrew run Cockpit didn't start, like one in another terminal. Closing a window lets the next one go.
