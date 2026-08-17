# Getting started

Cockpit currently runs from source. It's an Electron app: clone, install, run.

## Prerequisites

- **macOS** — the primary target. Linux works for development and CI.
- **Node 22** — pinned in `.nvmrc`; run `nvm use` (or your version manager's equivalent) before installing.
- **npm** — the repo ships a `package-lock.json`; install with `npm ci` to match CI exactly.
- **git**, and the **GitHub CLI (`gh`)** if you want the PR features to work at runtime (not needed to build).
- Optional: the `claude` / `codex` / `copilot` CLIs. Without them Cockpit runs with an empty session index.

## Install and run

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

## First run

On first launch Cockpit auto-detects `~/.claude`, `~/.codex`, and `~/.copilot` and indexes every session it finds there, grouped by git repository. There's nothing to configure: if you've used any of the three CLIs before, your history appears immediately, and the index updates live as you keep working in any terminal.

If a provider directory doesn't exist yet, Cockpit simply shows an empty state for it. You can add further source directories — for example an isolated config home for a second account — in **Settings**; see [Accounts & usage](/guide/accounts-and-usage).

## Everyday commands

| Command | What |
| --- | --- |
| `npm run dev` | Electron app with HMR |
| `npm run dev:bg` | same, but relaunches never steal focus |
| `npm run typecheck` | `tsc --noEmit` — the static gate (there is no linter) |
| `npm test` | vitest: unit + component tiers |
| `npm run test:e2e` | Playwright against the built app — run `npm run build` first |
| `npm run build` | production build into `out/` |

For the full development workflow — including taming the dev window on multi-display setups — see [CONTRIBUTING.md](https://github.com/tashtit/cockpit/blob/main/CONTRIBUTING.md).
