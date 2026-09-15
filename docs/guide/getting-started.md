# Getting started

## Install the app

Download the disk image for your Mac from the [latest release](https://github.com/tashtit/cockpit/releases/latest) — `Cockpit-<version>-arm64.dmg` on Apple silicon, `Cockpit-<version>-x64.dmg` on Intel — open it and drag Cockpit into Applications.

::: warning Unsigned builds
Until the release pipeline carries an Apple Developer ID certificate, macOS reports the app as damaged or from an unidentified developer on first launch. Clear the quarantine flag once:

```bash
xattr -d com.apple.quarantine /Applications/Cockpit.app
```

See [Troubleshooting](/guide/troubleshooting#cockpit-is-damaged-and-can-t-be-opened).
:::

## Updating

Cockpit checks GitHub Releases on launch and every few hours. **Settings › About** shows the installed version and, when a newer one exists, a download button; the update installs on the next quit or with **Restart to install**. Nothing downloads until you ask. While releases are unsigned the install step fails — download the new disk image instead and replace the app; your settings in `~/Library/Application Support/Cockpit` survive.

## Run from source

Cockpit is an Electron app: clone, install, run.

### Prerequisites

- **macOS** — the primary target. Linux works for development and CI.
- **Node 24** — pinned in `.nvmrc`; run `nvm use` (or your version manager's equivalent) before installing.
- **npm 11** — the one Node 24 bundles, pinned as `packageManager` in `package.json`. It is also the npm Dependabot regenerates the lockfile with, so CI, the bot and your machine all write the same lockfile shape (npm 10 reads that shape as out of sync). The repo ships a `package-lock.json`; install with `npm ci` to match CI exactly.
- **git**, and the **GitHub CLI (`gh`)** if you want the PR features to work at runtime (not needed to build).
- Optional: the `claude` / `codex` / `copilot` CLIs. Without them Cockpit runs with an empty session index.

### Install and run

```bash
git clone https://github.com/tashtit/cockpit.git
cd cockpit
nvm use
npm ci
npm run dev
```

`npm ci` installs only Electron's JS stub — the actual Electron binary (~200&nbsp;MB) downloads automatically the **first time you run `npm run dev`** ("Downloading Electron binary...") and is cached in `~/Library/Caches/electron`, so it only happens once per Electron version.

::: warning "Electron failed to install correctly"
That message means the first-run binary download failed — usually a proxy, firewall, or a corrupt cached download. See [Troubleshooting](/guide/troubleshooting#electron-failed-to-install-correctly) for the fix.
:::

### First run

On first launch Cockpit auto-detects `~/.claude`, `~/.codex`, and `~/.copilot` and indexes every session it finds there, grouped by git repository. There's nothing to configure: if you've used any of the three CLIs before, your history appears immediately, and the index updates live as you keep working in any terminal.

If a provider directory doesn't exist yet, Cockpit simply shows an empty state for it. You can add further source directories — for example an isolated config home for a second account — in **Settings**; see [Accounts & usage](/guide/accounts-and-usage).

### Everyday commands

| Command | What |
| --- | --- |
| `npm run dev` | Electron app with HMR — relaunches never steal focus |
| `npm run dev:fg` | same, but each relaunch fronts and focuses the window |
| `npm run typecheck` | `tsc --noEmit` — the static gate (there is no linter) |
| `npm test` | vitest: unit + component tiers |
| `npm run test:e2e` | Playwright against the built app — run `npm run build` first |
| `npm run build` | production build into `out/` |
| `npm run package` | macOS disk images into `dist/` (unsigned without Apple credentials) |

For the full development workflow — including taming the dev window on multi-display setups — see [CONTRIBUTING.md](https://github.com/tashtit/cockpit/blob/main/CONTRIBUTING.md).
