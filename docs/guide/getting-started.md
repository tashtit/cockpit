# Getting started

## Install the app

::: warning Early access
Cockpit is pre-1.0, and its releases are not yet signed with an Apple Developer ID, so macOS blocks the first launch. The steps below get past that once; nothing about the download is wrong.
:::

1. **Download** the disk image for your Mac from the [latest release](https://github.com/tashtit/cockpit/releases/latest) — `Cockpit-<version>-arm64.dmg` on Apple silicon, `Cockpit-<version>-x64.dmg` on Intel (About This Mac says which). Open it and drag Cockpit into Applications.
2. **First launch** — open Cockpit from Applications. macOS refuses: "Apple could not verify Cockpit.app is free of malware" on macOS 15 and later, "damaged" or "unidentified developer" before. Click **Done**, not Move to Trash — the quarantine flag the browser put on the download is what Gatekeeper objects to.
3. **Allow it** — open System Settings › Privacy & Security, scroll to the notice that Cockpit was blocked, click **Open Anyway** and confirm with your password or Touch ID. Or clear the flag from Terminal and open it again:

   ```bash
   xattr -d com.apple.quarantine /Applications/Cockpit.app
   ```

Still blocked? See [Troubleshooting](/guide/troubleshooting#cockpit-is-damaged-and-can-t-be-opened).

::: tip Checking a download
Every release asset carries a build-provenance attestation. To confirm a disk image is the file the release workflow produced, before opening it:

```bash
gh attestation verify ~/Downloads/Cockpit-<version>-arm64.dmg --owner tashtit
```
:::

## Updating

After the first launch, updating takes nothing. Cockpit checks GitHub Releases on launch and every few hours, fetches a newer build in the background, and swaps it in the next time you quit — so the launch after that is the new version. Nothing is ever replaced under a running session.

**Settings › About** shows where it stands and holds both switches (*Download updates automatically*, *Install when I quit*) if you would rather do it by hand, plus **Restart now** to install a downloaded build immediately. **Check again** sits beside it: a build waiting to be installed never stops Cockpit looking for a newer one, and a check that finds the version you already have costs no second download. Only one build is ever kept on disk — a newer release replaces it, and a download that will not be installed is cleared at the next launch.

Cockpit installs its own updates rather than handing them to macOS. macOS only swaps in a bundle whose Developer ID signature matches the running one, which an early-access release does not have — so this is also what lets Cockpit clear the quarantine flag itself and hand you an app that opens without a second trip to Privacy & Security. Nothing you did once at install has to be done again.

If an update cannot be installed, the version you had is put back and About says why; nothing downloads on its own again until you press **Check for updates**. Your settings in `~/Library/Application Support/Cockpit` are untouched by any of this.

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

If a provider directory doesn't exist yet, Cockpit simply shows an empty state for it. You can add further config homes — for example an isolated one for a second account — in **Settings**; see [Accounts & usage](/guide/accounts-and-usage).

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
