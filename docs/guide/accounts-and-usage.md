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

A **source** is a provider config home Cockpit indexes. The defaults are `~/.claude`, `~/.codex`, and `~/.copilot`; you can add more in **Settings → Agent accounts & sources** — typically an isolated config home for a second account (e.g. work vs. personal).

Each source shows its own identity and health, and extra sources are stored in the app config (`~/Library/Application Support/cockpit/cockpit-config.json`) as `{path, provider, label}`.

## Subscription usage

**Settings → Usage** shows what each subscription is consuming, measured without credentials:

- **Claude Code** — measured locally from the session JSONLs: the current 5-hour block plus the trailing 7 days.
- **Codex** — read from the rate-limit snapshots the CLI itself persists.
- **Copilot** — premium request counts via the GitHub billing API (fails soft if unavailable).

::: tip Why credential-free matters
Cockpit never proxies your accounts and never holds tokens for them — it observes what the CLIs record locally, plus public APIs where available. Your authentication stays exactly where the providers put it.
:::
