# Contributing to Cockpit

## Prerequisites

- **macOS** — the primary target (the app indexes `~/.claude`, `~/.codex`, `~/.copilot` and is dark-mode-only). Linux works for development and CI.
- **Node 22** — pinned in [`.nvmrc`](.nvmrc); run `nvm use` (or your version manager's equivalent) before installing.
- **npm** — the repo ships a `package-lock.json`; install with `npm ci` to match CI exactly.
- **git**, and the **GitHub CLI (`gh`)** if you want the PR features to work at runtime (not needed to build or test).
- Optional: the `claude` / `codex` / `copilot` CLIs. Without them the app runs with an empty session index; tests don't need them — they run against fixtures written to a tmpdir.

## Setup

```bash
nvm use
npm ci
npm run dev
```

`npm ci` installs only Electron's JS stub — the actual Electron binary (~200 MB) downloads automatically the **first time you run `npm run dev`** ("Downloading Electron binary...") and is cached in `~/Library/Caches/electron`, so it only happens once per Electron version.

### "Electron failed to install correctly"

This message means that first-run binary download failed. Run the downloader directly to see the underlying error:

```bash
npx install-electron
```

Common causes:

- **Proxy or firewall** blocking the fetch from GitHub releases — set `ELECTRON_MIRROR` to a mirror you can reach, then re-run `npx install-electron`.
- **Corrupt cached download** — `rm -rf ~/Library/Caches/electron` and retry.

## Development workflow

| Command | What |
| --- | --- |
| `npm run dev` | Electron app with HMR |
| `npm run typecheck` | `tsc --noEmit` — the static gate (there is no linter) |
| `npm test` | vitest: unit + component tiers |
| `npm run test:e2e` | Playwright against the built app — run `npm run build` first |

`npm run typecheck` and `npm test` must both pass before a PR; CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck plus all three test tiers.

### Keeping the dev window out of your way

`electron-vite dev` relaunches the app on every main-process change, and by default each relaunch fronts and focuses the window. Two env vars (honored only in dev, never in a packaged app) tame that:

| | |
| --- | --- |
| `npm run dev:bg` | open the window **without stealing focus** (`COCKPIT_DEV_BACKGROUND=1`) |
| `COCKPIT_DEV_DISPLAY=1 npm run dev` | open centered on a specific display (0-based index into the OS display list) |

They compose: `COCKPIT_DEV_DISPLAY=1 npm run dev:bg` parks the app on your second screen and leaves your editor focused.

Display order is OS-assigned and won't necessarily match your mental "first/second screen" — when `COCKPIT_DEV_DISPLAY` is set, the dev console prints the table so you can pick:

```
[dev] display 0: 1920x1080 at (0,0) primary
[dev] display 1: 1728x1117 at (-1728,96) ← COCKPIT_DEV_DISPLAY
[dev] display 2: 1920x1080 at (1920,0)
[dev] window shown at {"x":-1414,"y":291,"width":1100,"height":760}
```

## Conventions

- **Conventional Commits** (`feat(indexer): …`, `fix(parser): …`, `docs: …`), matching existing history.
- **UI work**: read `design-system/cockpit/MASTER.md` first. Components use the design tokens from the `:root` block of `src/renderer/src/style.css` — never raw hex. Dark mode only.
- Session log parsers must stay failure-tolerant and bounded (≤256 KB per file read) — provider formats drift between releases; skip what you can't read rather than fail the scan.
